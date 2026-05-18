import { store, TYPES, TYPE_FIELDS } from './store.js';
import { initSplash, showSplash } from './splash.js';
import { isAuthEnabled, isAuthenticated, handleCallback, login, logout, getUserEmail, getUserSub, isAdmin } from './auth.js';
import { renderAiView } from './ai-panel.js';
import { renderAdminView } from './admin.js';
import { initChat, wireChat, toggleChat, isChatOpen } from './chat.js';
import { renderProjectView, renderSettingsView } from './project.js';
import { renderStructureView } from './structure.js';
import { renderGraphView }     from './graph.js';
import { loadWorld, saveWorld } from './api.js';
import { initBoard, renderBoard } from './board.js';
import { initTheme, getTheme, setTheme } from './theme.js';
import { initLayout, isMobileLayout } from './layout.js';
import { generateKey, exportKey, importKey } from './crypto.js';
import { getFeatures, postTelemetry } from './api.js';
import { setAssistantModel } from './llm.js';

let _exportedKey = null; // cached JWK string for cloud saves

// ── State ──────────────────────────────────────────────
const state = {
  view:       'list',   // 'list' | 'timeline' | 'search'
  type:       'character',
  selectedId: null,
  editing:    false,
  query:      '',
};

let _mob = 'home'; // mobile nav state: 'home' | 'list' | 'detail' | 'fullscreen'

// ── DOM refs ───────────────────────────────────────────
const $       = id => document.getElementById(id);
const sidebar       = document.getElementById('sidebar');
const typeNav      = $('type-nav');
const listHeader   = $('list-header');
const entityList   = $('entity-list');
const detailContent = $('detail-content');
const searchInput  = $('search-input');
const statusText   = $('status-text');

// ── Sidebar ────────────────────────────────────────────
function renderSidebar() {
  const counts   = store.countByType();
  const config   = store.getConfig();
  const enabled  = new Set(config.enabledTypes || []);
  const proj     = store.getProject();
  let html = '';

  const projActive = state.view === 'project' ? 'active' : '';
  const projCount  = store.listProjects().length;
  html += `<button class="type-btn ${projActive}" id="btn-project">
    <span class="type-icon" style="color:var(--accent)">◈</span>
    <span class="type-label">${esc(proj.title) || 'Project'}</span>
    ${projCount > 1 ? `<span class="type-count">${projCount}</span>` : ''}
  </button>`;

  html += `<div class="nav-divider"></div>`;

  for (const [type, def] of Object.entries(TYPES)) {
    if (!enabled.has(type)) continue;
    const active = state.view === 'list' && state.type === type ? 'active' : '';
    html += `<button class="type-btn ${active}" data-type="${type}">
      <span class="type-icon" style="color:${def.color}">${def.icon}</span>
      <span class="type-label">${def.label}</span>
      <span class="type-count">${counts[type]}</span>
    </button>`;
  }

  html += `<div class="nav-divider"></div>`;
  const tlActive = state.view === 'timeline' ? 'active' : '';
  html += `<button class="type-btn ${tlActive}" id="btn-timeline">
    <span class="type-icon" style="color:#facc15">◫</span>
    <span class="type-label">Timeline</span>
    <span class="type-count">${counts.event}</span>
  </button>`;

  const boardActive = state.view === 'board' ? 'active' : '';
  html += `<button class="type-btn ${boardActive}" id="btn-board">
    <span class="type-icon" style="color:#60a5fa">&#9635;</span>
    <span class="type-label">Board</span>
    <span class="type-count">${counts.character}</span>
  </button>`;

  const graphActive = state.view === 'graph' ? 'active' : '';
  html += `<button class="type-btn ${graphActive}" id="btn-graph">
    <span class="type-icon" style="color:#34d399">◎</span>
    <span class="type-label">Graph</span>
  </button>`;

  const strActive = state.view === 'structure' ? 'active' : '';
  const strCount  = store.getStructure().length;
  html += `<button class="type-btn ${strActive}" id="btn-structure">
    <span class="type-icon" style="color:#c084fc">▤</span>
    <span class="type-label">Structure</span>
    ${strCount ? `<span class="type-count">${strCount}</span>` : ''}
  </button>`;

  if (isAuthEnabled) {
    const aiActive = state.view === 'ai' ? 'active' : '';
    html += `<button class="type-btn ${aiActive}" id="btn-ai">
      <span class="type-icon" style="color:#a78bfa">◈</span>
      <span class="type-label">AI Extract</span>
      ${isAuthenticated() ? '' : '<span class="type-lock">🔒</span>'}
    </button>`;
  }

  html += `<div class="nav-divider"></div>`;
  const settingsActive = state.view === 'settings' ? 'active' : '';
  html += `<button class="type-btn ${settingsActive}" id="btn-settings">
    <span class="type-icon" style="color:var(--text-muted)">⚙</span>
    <span class="type-label">Settings</span>
  </button>`;

  if (isAdmin()) {
    const adminActive = state.view === 'admin' ? 'active' : '';
    html += `<button class="type-btn ${adminActive}" id="btn-admin">
      <span class="type-icon" style="color:#f87171">⬡</span>
      <span class="type-label">Admin</span>
    </button>`;
  }

  typeNav.innerHTML = html;
  typeNav.querySelectorAll('[data-type]').forEach(btn =>
    btn.addEventListener('click', () => selectType(btn.dataset.type)));
  $('btn-project')?.addEventListener('click', showProject);
  $('btn-timeline')?.addEventListener('click', showTimeline);
  $('btn-board')?.addEventListener('click', showBoard);
  $('btn-graph')?.addEventListener('click', showGraph);
  $('btn-structure')?.addEventListener('click', showStructure);
  $('btn-ai')?.addEventListener('click', showAiPanel);
  $('btn-settings')?.addEventListener('click', showSettings);
  $('btn-admin')?.addEventListener('click', showAdmin);
}

function updateChatBtn() {
  $('btn-chat-toggle')?.classList.toggle('active', isChatOpen());
}

function updateAuthStatus() {
  const el = $('auth-status');
  if (!el || !isAuthEnabled) return;
  if (isAuthenticated()) {
    const email = getUserEmail() || 'signed in';
    el.innerHTML = `<div class="auth-user">
      <span class="auth-email" title="${esc(email)}">${esc(email)}</span>
      <button id="btn-signout">Sign Out</button>
    </div>`;
    $('btn-signout')?.addEventListener('click', logout);
  } else {
    el.innerHTML = `<button id="btn-signin">Sign In</button>`;
    $('btn-signin')?.addEventListener('click', login);
  }
}

// ── List Panel ─────────────────────────────────────────
function renderList() {
  const def      = TYPES[state.type];
  const entities = store.getAll(state.type).sort((a, b) => a.name.localeCompare(b.name));

  listHeader.innerHTML = `<div class="list-header-row">
    <span class="list-title">${def.label}</span>
    <button class="btn-new" id="btn-new">+ New</button>
  </div>`;
  $('btn-new').addEventListener('click', handleNew);

  if (!entities.length) {
    entityList.innerHTML = `<div class="empty-state">No ${def.label.toLowerCase()} yet.<br>Click + New to add one.</div>`;
    return;
  }

  entityList.innerHTML = entities.map(e => `
    <div class="entity-item${e.id === state.selectedId ? ' selected' : ''}" data-id="${e.id}">
      <div class="entity-name">${esc(e.name) || '<unnamed>'}</div>
      ${entitySubtitle(e)}
      ${e.tags.length ? `<div class="entity-tags">${e.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
    </div>`).join('');

  entityList.querySelectorAll('.entity-item').forEach(el =>
    el.addEventListener('click', () => selectEntity(el.dataset.id)));
}

function entitySubtitle(e) {
  const fields = TYPE_FIELDS[e.type] || [];
  if (!fields.length) return '';
  const f = fields[0];
  const val = e[f.key];
  return val ? `<div class="entity-subtitle">${esc(f.label)}: ${esc(val)}</div>` : '';
}

// ── Detail: View ───────────────────────────────────────
function renderDetail() {
  if (!state.selectedId) {
    detailContent.innerHTML = `<div class="empty-state detail-empty">Select an entry<br>or create a new one.</div>`;
    return;
  }

  const entity = store.get(state.selectedId);
  if (!entity) { state.selectedId = null; renderDetail(); return; }
  if (state.editing) { renderEditForm(entity); return; }

  const def        = TYPES[entity.type];
  const typeFields = TYPE_FIELDS[entity.type] || [];
  const incoming   = store.incomingLinks(entity.id);

  const specificHtml = typeFields
    .filter(f => entity[f.key])
    .map(f => `<div class="field-row"><span class="field-label">${esc(f.label)}</span><span class="field-value">${esc(entity[f.key])}</span></div>`)
    .join('');

  const outHtml = entity.links.map(link => {
    const t = store.get(link.targetId);
    if (!t) return '';
    const td = TYPES[t.type];
    return `<div class="link-item" data-id="${t.id}">
      <span class="link-icon" style="color:${td.color}">${td.icon}</span>
      <span class="link-label">${esc(link.label) || '—'}</span>
      <span class="link-name">${esc(t.name) || '<unnamed>'}</span>
    </div>`;
  }).filter(Boolean).join('');

  const inHtml = incoming.map(({ source, label }) => {
    const sd = TYPES[source.type];
    return `<div class="link-item" data-id="${source.id}">
      <span class="link-icon" style="color:${sd.color}">${sd.icon}</span>
      <span class="link-label">← ${esc(label) || '—'}</span>
      <span class="link-name">${esc(source.name) || '<unnamed>'}</span>
    </div>`;
  }).join('');

  const relHtml = outHtml || inHtml
    ? (outHtml ? `<div class="links-group"><div class="links-group-label">links to</div>${outHtml}</div>` : '')
    + (inHtml  ? `<div class="links-group"><div class="links-group-label">referenced by</div>${inHtml}</div>` : '')
    : `<div class="field-empty">No relations yet.</div>`;

  const worldStateHtml = state.view === 'timeline' && entity.type === 'event' && entity.date
    ? buildWorldStateHtml(entity.date)
    : '';

  detailContent.innerHTML = `
    <div class="detail-header">
      <div class="detail-type-badge" style="color:${def.color}">${def.icon}&nbsp;${def.label.slice(0,-1).toUpperCase()}</div>
      <div class="detail-title">${esc(entity.name) || '<unnamed>'}</div>
      <div class="detail-actions">
        <button class="btn-edit" id="btn-edit">Edit</button>
        <button class="btn-danger" id="btn-delete">Delete</button>
      </div>
    </div>
    ${entity.tags.length ? `<div class="tags-row">${entity.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
    ${specificHtml ? `<div class="specific-fields">${specificHtml}</div>` : ''}
    ${entity.description
      ? `<div class="description">${esc(entity.description)}</div>`
      : `<div class="field-empty">No description.</div>`}
    <div class="relations-section">
      <div class="section-title">Relations</div>
      ${relHtml}
    </div>
    <div class="detail-meta">Updated ${fmt(entity.updatedAt)} &nbsp;·&nbsp; Created ${fmt(entity.createdAt)}</div>
    ${worldStateHtml}`;

  $('btn-edit').addEventListener('click', () => { state.editing = true; renderDetail(); });
  $('btn-delete').addEventListener('click', () => handleDelete(entity.id));
  detailContent.querySelectorAll('.link-item').forEach(el =>
    el.addEventListener('click', () => jumpTo(el.dataset.id)));
  detailContent.querySelectorAll('.ws-item').forEach(el =>
    el.addEventListener('click', () => jumpTo(el.dataset.id)));
}

function buildWorldStateHtml(date) {
  const states = store.worldStateAt(date);
  const groups = {};
  for (const { entity: e, note } of states) {
    if (!groups[e.type]) groups[e.type] = [];
    groups[e.type].push({ e, note });
  }
  const inner = Object.entries(groups).map(([type, items]) => {
    const def = TYPES[type];
    return `<div class="ws-group">
      <div class="ws-group-label" style="color:${def.color}">${def.icon}&nbsp;${def.label.toUpperCase()}</div>
      ${items.map(({ e, note }) => `
        <div class="ws-item" data-id="${e.id}">
          <span class="ws-name">${esc(e.name) || '<unnamed>'}</span>
          <span class="ws-note">${esc(note.text)}</span>
        </div>`).join('')}
    </div>`;
  }).join('');
  return `<div class="world-state-section">
    <div class="section-title">World State &middot; ${esc(date)}</div>
    ${inner || `<div class="field-empty">No entity notes at this date yet.</div>`}
  </div>`;
}

// ── Detail: Edit Form ──────────────────────────────────
function renderEditForm(entity) {
  const def        = TYPES[entity.type];
  const typeFields = TYPE_FIELDS[entity.type] || [];
  const others     = store.getAll().filter(e => e.id !== entity.id).sort((a,b) => a.name.localeCompare(b.name));
  const isNew      = !entity.name;

  const specificHtml = typeFields.map(f => {
    if (f.type === 'select') {
      const opts = f.options.map(o =>
        `<option value="${o}"${entity[f.key] === o ? ' selected' : ''}>${o}</option>`).join('');
      return `<div class="form-row">
        <label>${f.label}</label>
        <select name="${f.key}"><option value="">—</option>${opts}</select>
      </div>`;
    }
    return `<div class="form-row">
      <label>${f.label}</label>
      <input type="text" name="${f.key}" value="${esc(entity[f.key] || '')}" placeholder="${f.placeholder || ''}">
    </div>`;
  }).join('');

  const linksHtml = entity.links.length
    ? entity.links.map((link, i) => {
        const t  = store.get(link.targetId);
        const td = t ? TYPES[t.type] : null;
        return `<div class="link-edit-item">
          <span class="link-icon" style="color:${td?.color || 'inherit'}">${td?.icon || '?'}</span>
          <input class="link-label-input" data-index="${i}" type="text" value="${esc(link.label)}" placeholder="relation label">
          <span class="link-target-name">${esc(t?.name) || '<deleted>'}</span>
          <button class="btn-remove-link" data-index="${i}" type="button">✕</button>
        </div>`;
      }).join('')
    : `<div class="field-empty">No relations yet.</div>`;

  const entityOpts = others.map(e => {
    const ed = TYPES[e.type];
    return `<option value="${e.id}">${ed.icon} [${ed.label.slice(0,-1)}] ${esc(e.name) || '<unnamed>'}</option>`;
  }).join('');

  detailContent.innerHTML = `
    <div class="detail-header">
      <div class="detail-type-badge" style="color:${def.color}">${def.icon}&nbsp;${def.label.slice(0,-1).toUpperCase()}</div>
      <div class="edit-form-title">${isNew ? 'New' : 'Edit'} ${def.label.slice(0,-1)}</div>
      <div class="detail-actions">
        <button class="btn-save" id="btn-save" type="button">Save</button>
        <button class="btn-cancel" id="btn-cancel" type="button">Cancel</button>
      </div>
    </div>
    <form id="entity-form" onsubmit="return false">
      <div class="form-row">
        <label>Name *</label>
        <input type="text" name="name" value="${esc(entity.name)}" placeholder="Enter name..." autocomplete="off">
      </div>
      ${specificHtml}
      <div class="form-row">
        <label>Tags &nbsp;<span style="color:var(--text-muted);font-style:italic">(comma separated)</span></label>
        <input type="text" name="tags" value="${esc(entity.tags.join(', '))}" placeholder="e.g. protagonist, hero, crew">
      </div>
      <div class="form-row">
        <label>Description</label>
        <textarea name="description" rows="7" placeholder="Notes, backstory, details...">${esc(entity.description)}</textarea>
      </div>
    </form>
    <div class="timeline-section">
      <div class="section-title">Timeline</div>
      <div id="timeline-notes-list"></div>
      <div class="timeline-note-add-form">
        <input id="tn-date" type="text" placeholder="Date..." autocomplete="off">
        <input id="tn-text" type="text" placeholder="Status at this date...">
        <button id="btn-add-tn" type="button">Add</button>
      </div>
    </div>
    <div class="relations-section">
      <div class="section-title">Relations</div>
      <div id="links-list">${linksHtml}</div>
      <div class="add-link-form">
        <select id="link-target">
          <option value="">Link to entity...</option>
          ${entityOpts}
        </select>
        <input id="link-label" type="text" placeholder="relation label">
        <button id="btn-add-link" type="button">Add</button>
      </div>
    </div>`;

  // Auto-focus name field
  detailContent.querySelector('[name="name"]')?.focus();

  renderTimelineNotesList(entity.id);

  $('btn-save').addEventListener('click', () => handleSave(entity.id));
  $('btn-cancel').addEventListener('click', () => handleCancel(entity.id, isNew));

  $('btn-add-tn').addEventListener('click', () => {
    const date = $('tn-date').value.trim();
    const text = $('tn-text').value.trim();
    if (!date && !text) return;
    store.addTimelineNote(entity.id, date, text);
    renderTimelineNotesList(entity.id);
    $('tn-date').value = '';
    $('tn-text').value = '';
    $('tn-date').focus();
  });
  [$('tn-date'), $('tn-text')].forEach(inp =>
    inp?.addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-add-tn').click(); }));

  detailContent.querySelectorAll('.link-label-input').forEach(input =>
    input.addEventListener('change', () =>
      store.updateLinkLabel(entity.id, parseInt(input.dataset.index), input.value)));

  detailContent.querySelectorAll('.btn-remove-link').forEach(btn =>
    btn.addEventListener('click', () => {
      store.removeLink(entity.id, parseInt(btn.dataset.index));
      renderEditForm(store.get(entity.id));
    }));

  $('btn-add-link').addEventListener('click', () => {
    const targetId = $('link-target').value;
    if (!targetId) return;
    store.addLink(entity.id, targetId, $('link-label').value.trim());
    renderEditForm(store.get(entity.id));
  });
}

// ── Timeline Notes List ─────────────────────────────────
function renderTimelineNotesList(entityId) {
  const el = $('timeline-notes-list');
  if (!el) return;
  const entity = store.get(entityId);
  const notes  = entity?.timelineNotes || [];

  if (!notes.length) {
    el.innerHTML = `<div class="field-empty">No notes yet.</div>`;
    return;
  }

  el.innerHTML = notes.map(note => `
    <div class="timeline-note-row">
      <input class="tn-date-input" data-id="${note.id}" type="text" value="${esc(note.date)}" placeholder="Date">
      <input class="tn-text-input" data-id="${note.id}" type="text" value="${esc(note.text)}" placeholder="Status...">
      <button class="btn-remove-tn" data-id="${note.id}" type="button">&#215;</button>
    </div>`).join('');

  el.querySelectorAll('.tn-date-input').forEach(inp =>
    inp.addEventListener('change', () => {
      const textInp = el.querySelector(`.tn-text-input[data-id="${inp.dataset.id}"]`);
      store.updateTimelineNote(entityId, inp.dataset.id, inp.value, textInp?.value || '');
    }));

  el.querySelectorAll('.tn-text-input').forEach(inp =>
    inp.addEventListener('change', () => {
      const dateInp = el.querySelector(`.tn-date-input[data-id="${inp.dataset.id}"]`);
      store.updateTimelineNote(entityId, inp.dataset.id, dateInp?.value || '', inp.value);
    }));

  el.querySelectorAll('.btn-remove-tn').forEach(btn =>
    btn.addEventListener('click', () => {
      store.deleteTimelineNote(entityId, btn.dataset.id);
      renderTimelineNotesList(entityId);
    }));
}

// ── Timeline ────────────────────────────────────────────
function renderTimeline() {
  const events = store.timeline();

  listHeader.innerHTML = `<div class="list-header-row">
    <span class="list-title">Timeline</span>
    <button class="btn-new" id="btn-new-event">+ Event</button>
  </div>`;
  $('btn-new-event').addEventListener('click', () => {
    state.view = 'list';
    state.type = 'event';
    renderAll();
    handleNew();
  });

  if (!events.length) {
    entityList.innerHTML = `<div class="empty-state">No events yet.<br>Add events with a Date field<br>to build your timeline.</div>`;
    detailContent.innerHTML = '';
    return;
  }

  const cursorIdx = state.selectedId ? events.findIndex(e => e.id === state.selectedId) : -1;

  entityList.innerHTML = `<div class="timeline">` + events.flatMap((e, i) => {
    const imp = (e.importance || 'minor').toLowerCase();
    const posClass = cursorIdx < 0 ? '' : i < cursorIdx ? ' past' : i === cursorIdx ? ' cursor-event' : ' future';
    const itemHtml = `<div class="timeline-item importance-${imp}${e.id === state.selectedId ? ' selected' : ''}${posClass}" data-id="${e.id}">
      <div class="timeline-marker"></div>
      <div>
        <div class="timeline-date">${esc(e.date) || '—'}</div>
        <div class="timeline-name">${esc(e.name) || '<unnamed>'}</div>
        ${e.description ? `<div class="timeline-desc">${esc(e.description.slice(0, 120))}${e.description.length > 120 ? '…' : ''}</div>` : ''}
      </div>
    </div>`;
    const cursorLine = i === cursorIdx
      ? `<div class="timeline-cursor-line"><span>&#9671;&nbsp;${esc(e.date) || '?'}</span></div>`
      : '';
    return [itemHtml, cursorLine];
  }).join('') + `</div>`;

  entityList.querySelectorAll('.timeline-item').forEach(el =>
    el.addEventListener('click', () => selectEntity(el.dataset.id)));
}

// ── Search ──────────────────────────────────────────────
function renderSearch() {
  const results = store.search(state.query);

  listHeader.innerHTML = `<div class="list-header-row">
    <span class="list-title">Search</span>
    <span class="list-count">${results.length} result${results.length !== 1 ? 's' : ''}</span>
  </div>`;

  if (!results.length) {
    entityList.innerHTML = `<div class="empty-state">No results for<br>"${esc(state.query)}"</div>`;
    return;
  }

  entityList.innerHTML = results.map(e => {
    const def = TYPES[e.type];
    return `<div class="entity-item${e.id === state.selectedId ? ' selected' : ''}" data-id="${e.id}" data-type="${e.type}">
      <div class="entity-type-badge" style="color:${def.color}">${def.icon} ${def.label.slice(0,-1)}</div>
      <div class="entity-name">${esc(e.name) || '<unnamed>'}</div>
      ${e.tags.length ? `<div class="entity-tags">${e.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
    </div>`;
  }).join('');

  entityList.querySelectorAll('.entity-item').forEach(el =>
    el.addEventListener('click', () => jumpTo(el.dataset.id)));
}

// ── Actions ─────────────────────────────────────────────
function selectType(type) {
  state.view = 'list';
  state.type = type;
  state.selectedId = null;
  state.editing = false;
  searchInput.value = '';
  state.query = '';
  if (isMobileLayout()) _mob = 'list';
  renderAll();
}

function selectEntity(id) {
  state.selectedId = id;
  state.editing = false;
  if (isMobileLayout()) {
    _mob = 'detail';
    renderAll();
    return;
  }
  // Highlight in list
  document.querySelectorAll('.entity-item, .timeline-item').forEach(el =>
    el.classList.toggle('selected', el.dataset.id === id));
  renderDetail();
}

function jumpTo(id) {
  const e = store.get(id);
  if (!e) return;
  state.view = 'list';
  state.type = e.type;
  state.selectedId = id;
  state.editing = false;
  searchInput.value = '';
  state.query = '';
  if (isMobileLayout()) _mob = 'detail';
  renderAll();
}

function showTimeline() {
  state.view = 'timeline';
  state.selectedId = null;
  state.editing = false;
  if (isMobileLayout()) _mob = 'fullscreen';
  renderAll();
}

function showAiPanel() {
  state.view = 'ai';
  state.selectedId = null;
  state.editing = false;
  if (isMobileLayout()) _mob = 'fullscreen';
  renderAll();
}

function showBoard() {
  state.view = 'board';
  state.selectedId = null;
  state.editing = false;
  if (isMobileLayout()) _mob = 'fullscreen';
  renderAll();
}

function showGraph() {
  state.view = 'graph';
  state.selectedId = null;
  state.editing = false;
  if (isMobileLayout()) _mob = 'fullscreen';
  renderAll();
}

function showStructure() {
  state.view = 'structure';
  state.selectedId = null;
  state.editing = false;
  if (isMobileLayout()) _mob = 'fullscreen';
  renderAll();
}

function showProject() {
  state.view = 'project';
  state.selectedId = null;
  state.editing = false;
  if (isMobileLayout()) _mob = 'fullscreen';
  renderAll();
}

function showSettings() {
  state.view = 'settings';
  state.selectedId = null;
  state.editing = false;
  if (isMobileLayout()) _mob = 'fullscreen';
  renderAll();
}

function showAdmin() {
  state.view = 'admin';
  state.selectedId = null;
  state.editing = false;
  if (isMobileLayout()) _mob = 'fullscreen';
  renderAll();
}

function handleNew() {
  const entity = store.create(state.type);
  state.selectedId = entity.id;
  state.editing = true;
  if (isMobileLayout()) {
    _mob = 'detail';
    renderAll();
    return;
  }
  renderList();
  renderDetail();
}

function handleSave(id) {
  const form   = $('entity-form');
  if (!form) return;
  const data   = new FormData(form);
  const fields = {};
  for (const [k, v] of data.entries()) fields[k] = v;
  fields.tags = fields.tags
    ? fields.tags.split(',').map(t => t.trim()).filter(Boolean)
    : [];
  store.update(id, fields);
  state.editing = false;
  renderAll();
}

function handleCancel(id, isNew) {
  state.editing = false;
  if (isNew) {
    store.delete(id);
    state.selectedId = null;
  }
  renderAll();
}

function handleDelete(id) {
  const e = store.get(id);
  if (!confirm(`Delete "${e?.name || 'this entry'}"? This cannot be undone.`)) return;
  store.delete(id);
  state.selectedId = null;
  state.editing = false;
  renderAll();
}

// ── Mobile home ─────────────────────────────────────────
function renderMobileHome() {
  const el = document.getElementById('mobile-home');
  if (!el) return;
  const counts  = store.countByType();
  const config  = store.getConfig();
  const enabled = new Set(config.enabledTypes || []);
  const proj    = store.getProject();
  const strCount = store.getStructure().length;

  let html = `<div class="mob-tiles">`;

  html += `<button class="mob-tile" id="mob-btn-project" style="grid-column:1/-1">
    <span class="mob-tile-icon" style="color:var(--accent)">◈</span>
    <span class="mob-tile-label">${esc(proj.title) || 'Project'}</span>
  </button>`;

  for (const [type, def] of Object.entries(TYPES)) {
    if (!enabled.has(type)) continue;
    html += `<button class="mob-tile" data-mob-type="${type}">
      <span class="mob-tile-icon" style="color:${def.color}">${def.icon}</span>
      <span class="mob-tile-count">${counts[type]}</span>
      <span class="mob-tile-label">${def.label}</span>
    </button>`;
  }

  html += `
    <button class="mob-tile" id="mob-btn-timeline">
      <span class="mob-tile-icon" style="color:#facc15">◫</span>
      <span class="mob-tile-count">${counts.event || 0}</span>
      <span class="mob-tile-label">Timeline</span>
    </button>
    <button class="mob-tile" id="mob-btn-board">
      <span class="mob-tile-icon" style="color:#60a5fa">&#9635;</span>
      <span class="mob-tile-count">${counts.character || 0}</span>
      <span class="mob-tile-label">Board</span>
    </button>
    <button class="mob-tile" id="mob-btn-graph">
      <span class="mob-tile-icon" style="color:#34d399">◎</span>
      <span class="mob-tile-label">Graph</span>
    </button>
    <button class="mob-tile" id="mob-btn-structure">
      <span class="mob-tile-icon" style="color:#c084fc">▤</span>
      ${strCount ? `<span class="mob-tile-count">${strCount}</span>` : ''}
      <span class="mob-tile-label">Structure</span>
    </button>`;

  if (isAuthEnabled) {
    html += `<button class="mob-tile" id="mob-btn-ai">
      <span class="mob-tile-icon" style="color:#a78bfa">◈</span>
      <span class="mob-tile-label">AI Extract</span>
    </button>`;
  }

  html += `<button class="mob-tile" id="mob-btn-settings">
    <span class="mob-tile-icon" style="color:var(--text-muted)">⚙</span>
    <span class="mob-tile-label">Settings</span>
  </button>`;

  if (isAdmin()) {
    html += `<button class="mob-tile" id="mob-btn-admin">
      <span class="mob-tile-icon" style="color:#f87171">⬡</span>
      <span class="mob-tile-label">Admin</span>
    </button>`;
  }

  html += `</div>`;
  el.innerHTML = html;

  el.querySelectorAll('[data-mob-type]').forEach(btn =>
    btn.addEventListener('click', () => selectType(btn.dataset.mobType)));
  document.getElementById('mob-btn-project')?.addEventListener('click', showProject);
  document.getElementById('mob-btn-timeline')?.addEventListener('click', showTimeline);
  document.getElementById('mob-btn-board')?.addEventListener('click', showBoard);
  document.getElementById('mob-btn-graph')?.addEventListener('click', showGraph);
  document.getElementById('mob-btn-structure')?.addEventListener('click', showStructure);
  document.getElementById('mob-btn-ai')?.addEventListener('click', showAiPanel);
  document.getElementById('mob-btn-settings')?.addEventListener('click', showSettings);
  document.getElementById('mob-btn-admin')?.addEventListener('click', showAdmin);
}

function updateMobileNav() {
  const backBtn = document.getElementById('mob-back');
  const titleEl = document.getElementById('mob-title');
  const authEl  = document.getElementById('mob-auth');
  if (!backBtn || !titleEl) return;

  backBtn.classList.toggle('hidden', _mob === 'home');

  const viewLabels = {
    timeline: 'Timeline', board: 'Board', graph: 'Graph',
    structure: 'Structure', ai: 'AI Extract', settings: 'Settings',
    admin: 'Admin', project: 'Projects',
  };

  if (_mob === 'home') {
    titleEl.textContent = 'LORE';
  } else if (_mob === 'list') {
    titleEl.textContent = TYPES[state.type]?.label || 'Entries';
  } else if (_mob === 'detail') {
    const entity = state.selectedId ? store.get(state.selectedId) : null;
    titleEl.textContent = entity?.name || TYPES[state.type]?.label || '';
  } else {
    titleEl.textContent = viewLabels[state.view] || '';
  }

  if (authEl && isAuthEnabled) {
    if (isAuthenticated()) {
      const email = getUserEmail() || '';
      authEl.innerHTML = `<button id="mob-signout" title="${esc(email)}">Sign Out</button>`;
      document.getElementById('mob-signout')?.addEventListener('click', logout);
    } else {
      authEl.innerHTML = `<button id="mob-signin">Sign In</button>`;
      document.getElementById('mob-signin')?.addEventListener('click', login);
    }
  }
}

function mobBack() {
  if (_mob === 'detail' && state.view === 'list') {
    _mob = 'list';
    state.editing = false;
  } else {
    _mob = 'home';
    state.selectedId = null;
    state.editing = false;
  }
  renderAll();
}

// ── Full re-render ──────────────────────────────────────
function renderAll() {
  // If in list mode with a now-disabled type, fall back to first enabled
  if (state.view === 'list') {
    const enabledTypes = store.getConfig().enabledTypes || [];
    if (!enabledTypes.includes(state.type) && enabledTypes.length) {
      state.type = enabledTypes[0];
    }
  }

  const isMob = isMobileLayout();

  // Apply mob-state classes
  ['mob-home', 'mob-list', 'mob-detail', 'mob-fullscreen'].forEach(c =>
    document.body.classList.remove(c));
  if (isMob) document.body.classList.add('mob-' + _mob);

  if (!isMob) renderSidebar();

  const isBoardMode = state.view === 'board';
  const isGraphMode = state.view === 'graph';
  document.body.classList.toggle('board-mode', isBoardMode);
  document.body.classList.toggle('graph-mode', isGraphMode);

  if (isMob && _mob === 'home') {
    renderMobileHome();
  } else if (isBoardMode) {
    renderBoard();
  } else if (state.view === 'timeline')  { renderTimeline(); renderDetail(); }
  else if   (state.view === 'search')    { renderSearch();   renderDetail(); }
  else if   (state.view === 'ai')        { renderAiView(listHeader, entityList, detailContent); }
  else if   (state.view === 'project')   { renderProjectView(listHeader, entityList, detailContent, renderAll, renderAll); }
  else if   (state.view === 'settings')  { renderSettingsView(listHeader, entityList, detailContent, renderAll); }
  else if   (state.view === 'admin')     { renderAdminView(listHeader, entityList, detailContent); }
  else if   (state.view === 'structure') { renderStructureView(listHeader, entityList, detailContent); }
  else if   (state.view === 'graph')     { renderGraphView(listHeader, entityList, detailContent); }
  else                                   { renderList();     renderDetail(); }

  if (isMob) updateMobileNav();
  updateStatus();
  updateAuthStatus();
  updateChatBtn();
}

let _cloudStatus = ''; // '' | 'saving' | 'synced' | 'error'

function updateStatus() {
  const total = store.totalCount();
  const base  = `${total} entr${total !== 1 ? 'ies' : 'y'}`;
  const cloud = _cloudStatus === 'saving' ? ' · syncing…'
              : _cloudStatus === 'synced' ? ' · cloud ✓'
              : _cloudStatus === 'error'  ? ' · sync failed'
              : '';
  statusText.textContent = base + (cloud || ' · saved');
}

// ── Cloud sync ──────────────────────────────────────────
let _cloudSaveTimer = null;

async function initCloudSync() {
  if (!isAuthenticated()) return;

  const userId = getUserSub();

  try {
    // Fetch cloud world — this is the authoritative source
    const cloud = await loadWorld(); // { data, content, cryptoKey, updatedAt } | null

    // Resolve or generate the encryption key
    let cryptoKey;
    if (cloud?.cryptoKey) {
      cryptoKey = await importKey(cloud.cryptoKey);
      _exportedKey = cloud.cryptoKey;
    } else {
      // New user — generate key, will be saved with first push
      cryptoKey = await generateKey();
      _exportedKey = await exportKey(cryptoKey);
    }

    // Cache key in sessionStorage so fast re-loads within the session work
    sessionStorage.setItem(`lore_key_${userId}`, _exportedKey);

    // Switch store to user-namespaced encrypted storage
    // (this loads cached local data if the key was already in sessionStorage)
    await store.setUser(userId, cryptoKey);

    if (cloud?.data) {
      // Cloud is authoritative — load it unconditionally
      store.loadData(cloud.data);
      store.mergeContent(cloud.content || {});
      renderAll();
    } else {
      // No cloud record yet — push whatever is in the local cache
      await saveWorld(store.exportDataWithoutContent(), store.extractContent(), _exportedKey);
      _cloudStatus = 'synced'; updateStatus();
    }

    // Migration prompt: legacy anonymous data found
    if (store.hasLegacyData()) {
      _showMigrationPrompt(cryptoKey);
    }

  } catch (err) {
    console.warn('Cloud sync init failed:', err);
  }

  // Auto-save on every local change
  store.onPersist(() => {
    _cloudStatus = 'saving'; updateStatus();
    clearTimeout(_cloudSaveTimer);
    _cloudSaveTimer = setTimeout(async () => {
      try {
        await saveWorld(store.exportDataWithoutContent(), store.extractContent(), _exportedKey);
        _cloudStatus = 'synced';
      } catch {
        _cloudStatus = 'error';
      }
      updateStatus();
    }, 2000);
  });
}

function _showMigrationPrompt() {
  if (sessionStorage.getItem('lore_migration_dismissed')) return;
  if ($('migration-banner')) return;

  const banner = document.createElement('div');
  banner.id = 'migration-banner';
  banner.className = 'migration-banner';
  banner.innerHTML = `
    <span class="mig-msg">Found unassociated local data. Move it to your account?</span>
    <button id="btn-mig-yes">Migrate</button>
    <button id="btn-mig-no">Discard</button>`;
  document.body.appendChild(banner);

  $('btn-mig-yes')?.addEventListener('click', async () => {
    const legacy = store.getLegacyData();
    if (legacy && !store.totalCount()) {
      store.loadData(legacy);
      await saveWorld(store.exportDataWithoutContent(), store.extractContent(), _exportedKey)
        .catch(() => {});
      renderAll();
      showBanner('Local data migrated to your account.', 5000);
    }
    store.clearLegacyData();
    banner.remove();
    sessionStorage.setItem('lore_migration_dismissed', '1');
  });

  $('btn-mig-no')?.addEventListener('click', () => {
    store.clearLegacyData();
    banner.remove();
    sessionStorage.setItem('lore_migration_dismissed', '1');
  });
}

function showBanner(msg, ms = 5000) {
  const el = $('sync-banner');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), ms);
}

// ── Utilities ───────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ── Saves Panel ─────────────────────────────────────────
function openSavesPanel() {
  sidebar.classList.add('saves-open');
  $('btn-saves').classList.add('active');
  const now = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  $('save-name-input').value = now;
  renderSavesList();
  $('save-name-input').focus();
  $('save-name-input').select();
}

function closeSavesPanel() {
  sidebar.classList.remove('saves-open');
  $('btn-saves').classList.remove('active');
}

function renderSavesList() {
  const snaps = store.listSnapshots();
  const el = $('saves-list-inner');
  if (!snaps.length) {
    el.innerHTML = `<div class="saves-empty">No saves yet.</div>`;
    return;
  }
  el.innerHTML = snaps.map(s => {
    const count = Object.keys(s.data.entities || {}).length;
    const date  = new Date(s.savedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    return `<div class="save-item">
      <div class="save-name">${esc(s.name)}</div>
      <div class="save-meta">
        <span>${count} entr${count !== 1 ? 'ies' : 'y'} · ${date}</span>
        <div class="save-actions">
          <button class="save-btn-restore" data-id="${s.id}" title="Restore">&#8629;</button>
          <button class="save-btn-delete"  data-id="${s.id}" title="Delete">&#215;</button>
        </div>
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('.save-btn-restore').forEach(btn =>
    btn.addEventListener('click', () => {
      const snap = snaps.find(s => s.id === btn.dataset.id);
      if (!confirm(`Restore "${snap?.name}"?\nCurrent state will be overwritten.`)) return;
      store.loadSnapshot(btn.dataset.id);
      state.selectedId = null;
      state.editing = false;
      closeSavesPanel();
      renderAll();
    }));

  el.querySelectorAll('.save-btn-delete').forEach(btn =>
    btn.addEventListener('click', () => {
      store.deleteSnapshot(btn.dataset.id);
      renderSavesList();
    }));
}

$('btn-saves').addEventListener('click', () =>
  sidebar.classList.contains('saves-open') ? closeSavesPanel() : openSavesPanel());

$('btn-do-save').addEventListener('click', () => {
  const name = $('save-name-input').value.trim() || new Date().toLocaleString();
  const ok = store.saveSnapshot(name);
  if (!ok) { alert('Save failed — localStorage may be full.'); return; }
  renderSavesList();
  $('save-name-input').value = '';
});

$('save-name-input').addEventListener('keydown', e => {
  if (e.key === 'Enter')  $('btn-do-save').click();
  if (e.key === 'Escape') closeSavesPanel();
});

// ── Init ────────────────────────────────────────────────
$('btn-about')?.addEventListener('click', showSplash);
$('btn-chat-toggle')?.addEventListener('click', () => toggleChat(state.selectedId));

// ── Layout ───────────────────────────────────────────────
initLayout(() => {
  if (!isMobileLayout()) _mob = 'home';
  renderAll();
});
document.getElementById('mob-back')?.addEventListener('click', mobBack);

// ── Theme toggle ─────────────────────────────────────────
initTheme();

function _syncThemeBtns() {
  const t = getTheme();
  ['light', 'system', 'dark'].forEach(k =>
    $(`btn-theme-${k}`)?.classList.toggle('active', k === t));
}

['light', 'system', 'dark'].forEach(k =>
  $(`btn-theme-${k}`)?.addEventListener('click', () => { setTheme(k); _syncThemeBtns(); }));

_syncThemeBtns();

initChat();
wireChat();
$('btn-export').addEventListener('click', () => store.exportJSON());
$('import-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    await store.importJSON(file);
    state.selectedId = null;
    state.editing = false;
    renderAll();
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
  e.target.value = '';
});
searchInput.addEventListener('input', e => {
  state.query = e.target.value.trim();
  if (!state.query) {
    state.view = 'list';
    renderAll();
  } else {
    state.view = 'search';
    state.selectedId = null;
    renderAll();
  }
});

function _fireTelemetry() {
  try {
    if (sessionStorage.getItem('lore_tel_sent')) return;
    let sid = sessionStorage.getItem('lore_sid');
    if (!sid) { sid = crypto.randomUUID(); sessionStorage.setItem('lore_sid', sid); }
    const uid  = getUserSub() || 'anon';
    const auth = isAuthenticated();
    postTelemetry(sid, uid, auth);
    sessionStorage.setItem('lore_tel_sent', '1');
  } catch { /* ignore */ }
}

async function init() {
  if (isAuthEnabled && window.location.search.includes('code=')) {
    await handleCallback().catch(console.error);
  }

  // If authenticated, try to pre-load the user's encrypted local cache from the
  // session key so the first render shows real data without waiting for cloud.
  if (isAuthenticated()) {
    const userId = getUserSub();
    const cachedKeyStr = userId && sessionStorage.getItem(`lore_key_${userId}`);
    if (cachedKeyStr) {
      try {
        const key = await importKey(cachedKeyStr);
        await store.setUser(userId, key);
      } catch { /* will be resolved by cloud sync */ }
    }
  }

  // Apply feature flags before rendering
  const features = await getFeatures();
  const assistantFlag = features.assistant;
  const assistantEnabled = assistantFlag?.enabled !== false;

  if (!assistantEnabled) {
    $('btn-chat-toggle').style.display = 'none';
  }
  if (assistantEnabled && assistantFlag?.model) {
    setAssistantModel(assistantFlag.model);
  }

  _fireTelemetry();
  initSplash();
  initBoard(entityId => {
    const e = store.get(entityId);
    if (!e) return;
    state.view      = 'list';
    state.type      = e.type;
    state.selectedId = entityId;
    state.editing   = true;
    searchInput.value = '';
    state.query = '';
    if (isMobileLayout()) _mob = 'detail';
    renderAll();
  });
  renderAll();
  await initCloudSync();
}
init();

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
import { getFeatures, postTelemetry } from './api.js';
import { setAssistantModel } from './llm.js';

// ── State ──────────────────────────────────────────────
const state = {
  view:       'list',   // 'list' | 'timeline' | 'search'
  type:       'character',
  selectedId: null,
  editing:    false,
  query:      '',
};

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
  renderAll();
}

function selectEntity(id) {
  state.selectedId = id;
  state.editing = false;
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
  renderAll();
}

function showTimeline() {
  state.view = 'timeline';
  state.selectedId = null;
  state.editing = false;
  renderAll();
}

function showAiPanel() {
  state.view = 'ai';
  state.selectedId = null;
  state.editing = false;
  renderAll();
}

function showBoard() {
  state.view = 'board';
  state.selectedId = null;
  state.editing = false;
  renderAll();
}

function showGraph() {
  state.view = 'graph';
  state.selectedId = null;
  state.editing = false;
  renderAll();
}

function showStructure() {
  state.view = 'structure';
  state.selectedId = null;
  state.editing = false;
  renderAll();
}

function showProject() {
  state.view = 'project';
  state.selectedId = null;
  state.editing = false;
  renderAll();
}

function showSettings() {
  state.view = 'settings';
  state.selectedId = null;
  state.editing = false;
  renderAll();
}

function showAdmin() {
  state.view = 'admin';
  state.selectedId = null;
  state.editing = false;
  renderAll();
}

function handleNew() {
  const entity = store.create(state.type);
  state.selectedId = entity.id;
  state.editing = true;
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

// ── Full re-render ──────────────────────────────────────
function renderAll() {
  // If in list mode with a now-disabled type, fall back to first enabled
  if (state.view === 'list') {
    const enabledTypes = store.getConfig().enabledTypes || [];
    if (!enabledTypes.includes(state.type) && enabledTypes.length) {
      state.type = enabledTypes[0];
    }
  }

  renderSidebar();
  const isBoardMode = state.view === 'board';
  const isGraphMode = state.view === 'graph';
  document.body.classList.toggle('board-mode', isBoardMode);
  document.body.classList.toggle('graph-mode', isGraphMode);

  if (isBoardMode) {
    renderBoard();
  } else if (state.view === 'timeline')  { renderTimeline(); renderDetail(); }
  else if   (state.view === 'search')    { renderSearch();   renderDetail(); }
  else if   (state.view === 'ai')        { renderAiView(listHeader, entityList, detailContent); }
  else if   (state.view === 'project')   { renderProjectView(listHeader, entityList, detailContent, renderSidebar, renderAll); }
  else if   (state.view === 'settings')  { renderSettingsView(listHeader, entityList, detailContent, renderSidebar); }
  else if   (state.view === 'admin')     { renderAdminView(listHeader, entityList, detailContent); }
  else if   (state.view === 'structure') { renderStructureView(listHeader, entityList, detailContent); }
  else if   (state.view === 'graph')     { renderGraphView(listHeader, entityList, detailContent); }
  else                                   { renderList();     renderDetail(); }
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

const LAST_USER_KEY = 'lore_last_user_sub';

async function initCloudSync() {
  if (!isAuthenticated()) return;

  // If a different user is now logged in, wipe the previous user's local data
  // so we never accidentally push User A's lore to User B's cloud.
  const currentSub = getUserSub();
  const lastSub    = localStorage.getItem(LAST_USER_KEY);
  if (currentSub && lastSub && currentSub !== lastSub) {
    store.clearLocalData();
    state.selectedId = null;
    state.editing    = false;
    renderAll();
  }
  if (currentSub) localStorage.setItem(LAST_USER_KEY, currentSub);

  // Load cloud world and resolve conflicts
  try {
    const cloud = await loadWorld();
    if (cloud?.data) {
      const localAt = store.dataUpdatedAt() || '';
      const cloudAt = cloud.updatedAt || '';

      if (!store.totalCount()) {
        // Nothing local — take cloud silently
        store.loadData(cloud.data);
        renderAll();
      } else if (cloudAt > localAt) {
        // Cloud is newer — load it
        store.loadData(cloud.data);
        renderAll();
        showBanner('Loaded your world from cloud.', 4000);
      } else if (localAt > cloudAt) {
        // Local is newer — push it up silently
        await saveWorld(store.exportData());
        _cloudStatus = 'synced'; updateStatus();
      }
      // If equal, do nothing
    } else if (store.totalCount()) {
      // No cloud save yet — push local up
      await saveWorld(store.exportData());
      _cloudStatus = 'synced'; updateStatus();
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
        await saveWorld(store.exportData());
        _cloudStatus = 'synced';
      } catch {
        _cloudStatus = 'error';
      }
      updateStatus();
    }, 2000);
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
    renderAll();
  });
  renderAll();
  await initCloudSync();
}
init();

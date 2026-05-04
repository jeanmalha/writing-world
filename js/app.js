import { store, TYPES, TYPE_FIELDS } from './store.js';

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
const typeNav      = $('type-nav');
const listHeader   = $('list-header');
const entityList   = $('entity-list');
const detailContent = $('detail-content');
const searchInput  = $('search-input');
const statusText   = $('status-text');

// ── Sidebar ────────────────────────────────────────────
function renderSidebar() {
  const counts = store.countByType();
  let html = '';

  for (const [type, def] of Object.entries(TYPES)) {
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

  typeNav.innerHTML = html;
  typeNav.querySelectorAll('[data-type]').forEach(btn =>
    btn.addEventListener('click', () => selectType(btn.dataset.type)));
  $('btn-timeline')?.addEventListener('click', showTimeline);
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
    <div class="detail-meta">Updated ${fmt(entity.updatedAt)} &nbsp;·&nbsp; Created ${fmt(entity.createdAt)}</div>`;

  $('btn-edit').addEventListener('click', () => { state.editing = true; renderDetail(); });
  $('btn-delete').addEventListener('click', () => handleDelete(entity.id));
  detailContent.querySelectorAll('.link-item').forEach(el =>
    el.addEventListener('click', () => jumpTo(el.dataset.id)));
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

  $('btn-save').addEventListener('click', () => handleSave(entity.id));
  $('btn-cancel').addEventListener('click', () => handleCancel(entity.id, isNew));

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

  entityList.innerHTML = `<div class="timeline">` + events.map(e => {
    const imp = (e.importance || 'minor').toLowerCase();
    return `<div class="timeline-item importance-${imp}${e.id === state.selectedId ? ' selected' : ''}" data-id="${e.id}">
      <div class="timeline-marker"></div>
      <div>
        <div class="timeline-date">${esc(e.date) || '—'}</div>
        <div class="timeline-name">${esc(e.name) || '<unnamed>'}</div>
        ${e.description ? `<div class="timeline-desc">${esc(e.description.slice(0, 120))}${e.description.length > 120 ? '…' : ''}</div>` : ''}
      </div>
    </div>`;
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
  renderSidebar();
  if      (state.view === 'timeline') renderTimeline();
  else if (state.view === 'search')   renderSearch();
  else                                renderList();
  renderDetail();
  updateStatus();
}

function updateStatus() {
  const total = store.totalCount();
  statusText.textContent = `${total} entr${total !== 1 ? 'ies' : 'y'} · saved`;
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

// ── Init ────────────────────────────────────────────────
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

renderAll();

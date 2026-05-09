import { store, TYPES } from './store.js';

const $ = id => document.getElementById(id);

export function renderProjectView(listHeader, entityList, detailContent, onSaved, onSwitch) {
  _renderProjectList(listHeader, entityList, detailContent, onSaved, onSwitch);
  _renderProjectDetail(detailContent, onSaved);
}

export function renderSettingsView(listHeader, entityList, detailContent, onUpdate) {
  listHeader.innerHTML = `<div class="list-header-row"><span class="list-title">Settings</span></div>`;

  const config     = store.getConfig();
  const enabledSet = new Set(config.enabledTypes || []);

  entityList.innerHTML = `<div class="settings-section">
    <div class="settings-section-label">Entity Types</div>
    ${Object.entries(TYPES).map(([type, def]) => `
      <label class="settings-check">
        <input type="checkbox" data-type="${type}" ${enabledSet.has(type) ? 'checked' : ''}>
        <span class="type-icon" style="color:${def.color}">${def.icon}</span>
        <span>${def.label}</span>
      </label>`).join('')}
  </div>`;

  entityList.querySelectorAll('input[data-type]').forEach(cb =>
    cb.addEventListener('change', () => {
      const enabled = [...entityList.querySelectorAll('input[data-type]')]
        .filter(c => c.checked).map(c => c.dataset.type);
      store.updateConfig({ enabledTypes: enabled });
      onUpdate?.();
    }));

  detailContent.innerHTML = `<div style="padding:18px 24px">
    <div class="section-title" style="margin-bottom:12px">Visibility</div>
    <p class="field-empty" style="line-height:2.2">
      Toggle entity types to show or hide them in the sidebar.<br>
      Hidden types still store data — they can be re-enabled at any time.
    </p>
  </div>`;
}

function _renderProjectList(listHeader, entityList, detailContent, onSaved, onSwitch) {
  listHeader.innerHTML = `<div class="list-header-row">
    <span class="list-title">Projects</span>
    <button class="btn-new" id="btn-new-project">+ New</button>
  </div>`;

  $('btn-new-project').addEventListener('click', () => {
    const name = prompt('Project name:', 'New Project');
    if (name === null) return;
    store.createProject(name.trim() || 'New Project');
    onSwitch?.();
  });

  const projects = store.listProjects();
  const activeId = store.getActiveProjectId();

  entityList.innerHTML = projects.map(p => {
    const isActive = p.id === activeId;
    const title    = esc(p.title) || '<untitled>';
    const sub      = [p.type, p.genre].filter(Boolean).join(' · ');
    return `<div class="entity-item proj-item${isActive ? ' selected' : ''}" data-id="${p.id}">
      <div class="entity-name">
        ${isActive ? '<span class="proj-active-dot">●</span> ' : ''}${title}
      </div>
      ${sub ? `<div class="entity-subtitle">${esc(sub)}</div>` : ''}
      <div class="entity-subtitle">${p.entityCount} entr${p.entityCount !== 1 ? 'ies' : 'y'}</div>
    </div>`;
  }).join('');

  entityList.querySelectorAll('.proj-item').forEach(el =>
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      if (id === activeId) return; // already active
      store.switchProject(id);
      onSwitch?.();
    }));
}

function _renderProjectDetail(detailContent, onSaved) {
  const proj     = store.getProject();
  const activeId = store.getActiveProjectId();
  const canDelete = store.listProjects().length > 1;

  detailContent.innerHTML = `
    <div class="detail-header">
      <div class="detail-type-badge" style="color:var(--accent)">◈&nbsp;PROJECT</div>
      <div class="detail-title">${esc(proj.title) || '<untitled>'}</div>
      ${canDelete ? `<div class="detail-actions">
        <button class="btn-danger" id="btn-delete-project">Delete Project</button>
      </div>` : ''}
    </div>
    <form id="project-form" onsubmit="return false">
      <div class="form-row">
        <label>Title</label>
        <input type="text" name="title" value="${esc(proj.title || '')}" placeholder="Project title..." autocomplete="off">
      </div>
      <div class="form-row">
        <label>Author</label>
        <input type="text" name="author" value="${esc(proj.author || '')}" placeholder="Author name..." autocomplete="off">
      </div>
      <div class="form-row">
        <label>Type</label>
        <select name="type">
          <option value="">—</option>
          ${['Novel','Short Story','Screenplay','Video Game','Comic','Other'].map(t =>
            `<option value="${t}"${proj.type === t ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
      </div>
      <div class="form-row">
        <label>Genre</label>
        <input type="text" name="genre" value="${esc(proj.genre || '')}" placeholder="e.g. Hard Sci-Fi, Fantasy, Thriller..." autocomplete="off">
      </div>
      <div class="form-row">
        <label>Status</label>
        <select name="status">
          <option value="">—</option>
          ${['Concept','Drafting','Revising','Beta Reading','Final Editing','Published'].map(s =>
            `<option value="${s}"${proj.status === s ? ' selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
      <div class="form-row">
        <label>Synopsis</label>
        <textarea name="synopsis" rows="5" placeholder="Brief synopsis...">${esc(proj.synopsis || '')}</textarea>
      </div>
      <div style="margin-top:10px">
        <button class="btn-save" id="btn-save-project" type="button">Save</button>
      </div>
    </form>
    <div class="proj-structure">
      <div class="section-title" style="margin-bottom:8px;margin-top:18px">Structure</div>
      <div id="proj-acts-list"></div>
      <button class="btn-new" id="btn-new-act" style="margin-top:6px;width:100%">+ Add Act</button>
    </div>`;

  $('btn-save-project').addEventListener('click', () => {
    const form = $('project-form');
    const data = new FormData(form);
    const fields = {};
    for (const [k, v] of data.entries()) fields[k] = v;
    store.updateProject(fields);
    _renderProjectDetail(detailContent, onSaved);
    onSaved?.();
  });

  if (canDelete) {
    $('btn-delete-project').addEventListener('click', () => {
      const title = store.getProject().title || 'this project';
      if (!confirm(`Delete "${title}" and all its content? This cannot be undone.`)) return;
      store.deleteProject(activeId);
      onSaved?.();  // triggers renderAll via the same chain
    });
  }

  $('btn-new-act').addEventListener('click', () => {
    store.addAct();
    _renderActsList(detailContent, onSaved);
  });

  _renderActsList(detailContent, onSaved);
}

function _renderActsList(detailContent, onSaved) {
  const el = $('proj-acts-list');
  if (!el) return;

  const structure = store.getStructure();
  if (!structure.length) {
    el.innerHTML = `<div class="field-empty">No acts yet.</div>`;
    return;
  }

  el.innerHTML = structure.map(act => `
    <div class="act-item">
      <div class="act-header">
        <span class="act-title">${esc(act.title)}</span>
        <div class="act-btns">
          <button class="act-btn act-btn-edit" data-act="${act.id}">✎</button>
          <button class="act-btn act-btn-add-ch" data-act="${act.id}">+</button>
          <button class="act-btn act-btn-del" data-act="${act.id}">✕</button>
        </div>
      </div>
      ${(act.chapters || []).map(ch => `
        <div class="chapter-item">
          <span class="ch-num">§</span>
          <span class="ch-title">${esc(ch.title)}</span>
          <div class="act-btns">
            <button class="act-btn ch-btn-edit" data-act="${act.id}" data-ch="${ch.id}">✎</button>
            <button class="act-btn ch-btn-del" data-act="${act.id}" data-ch="${ch.id}">✕</button>
          </div>
        </div>`).join('')}
    </div>`).join('');

  el.querySelectorAll('.act-btn-edit').forEach(btn =>
    btn.addEventListener('click', () => {
      const act  = store.getStructure().find(a => a.id === btn.dataset.act);
      const name = prompt('Rename act:', act?.title || '');
      if (name !== null) store.updateAct(btn.dataset.act, { title: name.trim() || 'Untitled Act' });
      _renderActsList(detailContent, onSaved);
    }));

  el.querySelectorAll('.act-btn-add-ch').forEach(btn =>
    btn.addEventListener('click', () => {
      store.addChapter(btn.dataset.act);
      _renderActsList(detailContent, onSaved);
    }));

  el.querySelectorAll('.act-btn-del').forEach(btn =>
    btn.addEventListener('click', () => {
      const act = store.getStructure().find(a => a.id === btn.dataset.act);
      if (!confirm(`Delete "${act?.title || 'this act'}" and all its chapters?`)) return;
      store.deleteAct(btn.dataset.act);
      _renderActsList(detailContent, onSaved);
    }));

  el.querySelectorAll('.ch-btn-edit').forEach(btn =>
    btn.addEventListener('click', () => {
      const act  = store.getStructure().find(a => a.id === btn.dataset.act);
      const ch   = act?.chapters?.find(c => c.id === btn.dataset.ch);
      const name = prompt('Rename chapter:', ch?.title || '');
      if (name !== null) store.updateChapter(btn.dataset.act, btn.dataset.ch, { title: name.trim() || 'Untitled Chapter' });
      _renderActsList(detailContent, onSaved);
    }));

  el.querySelectorAll('.ch-btn-del').forEach(btn =>
    btn.addEventListener('click', () => {
      store.deleteChapter(btn.dataset.act, btn.dataset.ch);
      _renderActsList(detailContent, onSaved);
    }));
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

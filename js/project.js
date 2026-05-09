import { store, TYPES } from './store.js';

const $ = id => document.getElementById(id);

export function renderProjectView(listHeader, entityList, detailContent, onSaved) {
  _renderStructureList(listHeader, entityList);
  _renderProjectDetail(detailContent, () => {
    _renderStructureList(listHeader, entityList);
    onSaved?.();
  });
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

function _renderStructureList(listHeader, entityList) {
  listHeader.innerHTML = `<div class="list-header-row">
    <span class="list-title">Structure</span>
    <button class="btn-new" id="btn-new-act">+ Act</button>
  </div>`;

  $('btn-new-act').addEventListener('click', () => {
    store.addAct();
    _renderStructureList(listHeader, entityList);
  });

  const structure = store.getStructure();
  if (!structure.length) {
    entityList.innerHTML = `<div class="empty-state">No acts yet.<br>Click + Act to add one.</div>`;
    return;
  }

  entityList.innerHTML = structure.map(act => `
    <div class="act-item">
      <div class="act-header">
        <span class="act-title">${esc(act.title)}</span>
        <div class="act-btns">
          <button class="act-btn act-btn-edit" data-act="${act.id}" title="Rename">✎</button>
          <button class="act-btn act-btn-add-ch" data-act="${act.id}" title="Add chapter">+</button>
          <button class="act-btn act-btn-del" data-act="${act.id}" title="Delete">✕</button>
        </div>
      </div>
      ${(act.chapters || []).map(ch => `
        <div class="chapter-item">
          <span class="ch-num">§</span>
          <span class="ch-title">${esc(ch.title)}</span>
          <div class="act-btns">
            <button class="act-btn ch-btn-edit" data-act="${act.id}" data-ch="${ch.id}" title="Rename">✎</button>
            <button class="act-btn ch-btn-del" data-act="${act.id}" data-ch="${ch.id}" title="Delete">✕</button>
          </div>
        </div>`).join('')}
    </div>`).join('');

  entityList.querySelectorAll('.act-btn-edit').forEach(btn =>
    btn.addEventListener('click', () => {
      const act  = store.getStructure().find(a => a.id === btn.dataset.act);
      const name = prompt('Rename act:', act?.title || '');
      if (name !== null) store.updateAct(btn.dataset.act, { title: name.trim() || 'Untitled Act' });
      _renderStructureList(listHeader, entityList);
    }));

  entityList.querySelectorAll('.act-btn-add-ch').forEach(btn =>
    btn.addEventListener('click', () => {
      store.addChapter(btn.dataset.act);
      _renderStructureList(listHeader, entityList);
    }));

  entityList.querySelectorAll('.act-btn-del').forEach(btn =>
    btn.addEventListener('click', () => {
      const act = store.getStructure().find(a => a.id === btn.dataset.act);
      if (!confirm(`Delete "${act?.title || 'this act'}" and all its chapters?`)) return;
      store.deleteAct(btn.dataset.act);
      _renderStructureList(listHeader, entityList);
    }));

  entityList.querySelectorAll('.ch-btn-edit').forEach(btn =>
    btn.addEventListener('click', () => {
      const act = store.getStructure().find(a => a.id === btn.dataset.act);
      const ch  = act?.chapters?.find(c => c.id === btn.dataset.ch);
      const name = prompt('Rename chapter:', ch?.title || '');
      if (name !== null) store.updateChapter(btn.dataset.act, btn.dataset.ch, { title: name.trim() || 'Untitled Chapter' });
      _renderStructureList(listHeader, entityList);
    }));

  entityList.querySelectorAll('.ch-btn-del').forEach(btn =>
    btn.addEventListener('click', () => {
      store.deleteChapter(btn.dataset.act, btn.dataset.ch);
      _renderStructureList(listHeader, entityList);
    }));
}

function _renderProjectDetail(detailContent, onSaved) {
  const proj = store.getProject();

  detailContent.innerHTML = `
    <div class="detail-header">
      <div class="detail-type-badge" style="color:var(--accent)">◈&nbsp;PROJECT</div>
      <div class="detail-title">${esc(proj.title) || '<untitled>'}</div>
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
        <textarea name="synopsis" rows="6" placeholder="Brief synopsis...">${esc(proj.synopsis || '')}</textarea>
      </div>
      <div style="margin-top:10px">
        <button class="btn-save" id="btn-save-project" type="button">Save</button>
      </div>
    </form>`;

  $('btn-save-project').addEventListener('click', () => {
    const form = $('project-form');
    const data = new FormData(form);
    const fields = {};
    for (const [k, v] of data.entries()) fields[k] = v;
    store.updateProject(fields);
    _renderProjectDetail(detailContent, onSaved);
    onSaved?.();
  });
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

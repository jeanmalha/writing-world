import { store, TYPES } from './store.js';
import { startExtraction, pollJob } from './api.js';

// ── Module state ───────────────────────────────────────────────────────────────
// sel = null | { type:'act'|'chapter'|'scene', actId, chapterId?, sceneId? }
let _sel  = null;
let _listEl = null;
let _detailEl = null;

// ── Public entry ───────────────────────────────────────────────────────────────

export function renderStructureView(listHeader, entityList, detailContent) {
  _listEl   = entityList;
  _detailEl = detailContent;

  const _isBlank = x => (!x.title || ['New Act','New Chapter','New Scene'].includes(x.title))
    && !x.content && !x.description && !(x.links||[]).length;
  const emptyCount = store.getStructure()
    .flatMap(a => [a, ...(a.chapters || []).flatMap(ch => [ch, ...(ch.scenes || [])])])
    .filter(_isBlank).length;

  listHeader.innerHTML = `<div class="list-header-row">
    <span class="list-title">Structure</span>
    <div style="display:flex;gap:4px">
      ${emptyCount ? `<button class="str-prune-btn" id="str-prune" title="Remove ${emptyCount} empty item${emptyCount !== 1 ? 's' : ''}">↻ Clean (${emptyCount})</button>` : ''}
      <button class="btn-new" id="str-add-act">+ Act</button>
    </div>
  </div>`;

  document.getElementById('str-add-act')?.addEventListener('click', () => {
    const act = store.addAct('New Act');
    _sel = { type: 'act', actId: act.id };
    _render();
  });

  document.getElementById('str-prune')?.addEventListener('click', () => {
    if (confirm('Remove all empty acts, chapters and scenes (those with default "New…" titles and no content)?')) {
      store.pruneStructure();
      _sel = null;
      _render();
    }
  });

  _render();
}

// ── Render ─────────────────────────────────────────────────────────────────────

function _render() {
  _renderTree(_listEl);
  _renderDetail(_detailEl);
}

function _renderTree(el) {
  const structure = store.getStructure();

  if (!structure.length) {
    el.innerHTML = `<div class="empty-state">No acts yet.<br>Click "+ Act" to begin.</div>`;
    return;
  }

  let html = '';
  structure.forEach((act, ai) => {
    const selAct = _sel?.actId === act.id;
    const actSel = selAct && _sel?.type === 'act' ? ' str-selected' : '';
    html += `<div class="str-act">
      <div class="str-row${actSel}" data-act="${act.id}" data-action="select-act">
        <button class="str-move" data-act="${act.id}" data-action="move-act-up" title="Move up" ${ai === 0 ? 'disabled' : ''}>↑</button>
        <button class="str-move" data-act="${act.id}" data-action="move-act-dn" title="Move down" ${ai === structure.length - 1 ? 'disabled' : ''}>↓</button>
        <span class="str-type-badge">Act ${_roman(ai + 1)}</span>
        <span class="str-row-title">${_esc(act.title)}</span>
        <button class="str-del" data-act="${act.id}" data-action="del-act" title="Delete act">✕</button>
      </div>`;

    (act.chapters || []).forEach((ch, ci) => {
      const selCh = selAct && _sel?.chapterId === ch.id;
      const chSel = selCh && _sel?.type === 'chapter' ? ' str-selected' : '';
      html += `<div class="str-chapter">
        <div class="str-row${chSel}" data-act="${act.id}" data-ch="${ch.id}" data-action="select-ch">
          <button class="str-move" data-act="${act.id}" data-ch="${ch.id}" data-action="move-ch-up" ${ci === 0 ? 'disabled' : ''}>↑</button>
          <button class="str-move" data-act="${act.id}" data-ch="${ch.id}" data-action="move-ch-dn" ${ci === act.chapters.length - 1 ? 'disabled' : ''}>↓</button>
          <span class="str-type-badge str-badge-ch">Ch ${ci + 1}</span>
          <span class="str-row-title">${_esc(ch.title)}</span>
          <button class="str-del" data-act="${act.id}" data-ch="${ch.id}" data-action="del-ch" title="Delete chapter">✕</button>
        </div>`;

      (ch.scenes || []).forEach((sc, si) => {
        const selSc = selCh && _sel?.sceneId === sc.id;
        const scSel = selSc && _sel?.type === 'scene' ? ' str-selected' : '';
        html += `<div class="str-scene">
          <div class="str-row${scSel}" data-act="${act.id}" data-ch="${ch.id}" data-sc="${sc.id}" data-action="select-sc">
            <button class="str-move" data-act="${act.id}" data-ch="${ch.id}" data-sc="${sc.id}" data-action="move-sc-up" ${si === 0 ? 'disabled' : ''}>↑</button>
            <button class="str-move" data-act="${act.id}" data-ch="${ch.id}" data-sc="${sc.id}" data-action="move-sc-dn" ${si === ch.scenes.length - 1 ? 'disabled' : ''}>↓</button>
            <span class="str-type-badge str-badge-sc">·</span>
            <span class="str-row-title">${_esc(sc.title)}</span>
            <button class="str-del" data-act="${act.id}" data-ch="${ch.id}" data-sc="${sc.id}" data-action="del-sc" title="Delete scene">✕</button>
          </div>
        </div>`;
      });

      html += `<div class="str-scene">
        <button class="str-add-child" data-act="${act.id}" data-ch="${ch.id}" data-action="add-sc">+ Scene</button>
      </div>
      </div>`;
    });

    html += `<div class="str-chapter">
      <button class="str-add-child" data-act="${act.id}" data-action="add-ch">+ Chapter</button>
    </div>
    </div>`;
  });

  el.innerHTML = html;

  el.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    e.stopPropagation();
    const { action, act: aId, ch: cId, sc: sId } = btn.dataset;

    if (action === 'select-act') { _sel = { type: 'act', actId: aId }; _render(); return; }
    if (action === 'select-ch')  { _sel = { type: 'chapter', actId: aId, chapterId: cId }; _render(); return; }
    if (action === 'select-sc')  { _sel = { type: 'scene', actId: aId, chapterId: cId, sceneId: sId }; _render(); return; }

    if (action === 'move-act-up') { store.moveAct(aId, 'up');              _renderTree(el); return; }
    if (action === 'move-act-dn') { store.moveAct(aId, 'down');            _renderTree(el); return; }
    if (action === 'move-ch-up')  { store.moveChapter(aId, cId, 'up');     _renderTree(el); return; }
    if (action === 'move-ch-dn')  { store.moveChapter(aId, cId, 'down');   _renderTree(el); return; }
    if (action === 'move-sc-up')  { store.moveScene(aId, cId, sId, 'up');  _renderTree(el); return; }
    if (action === 'move-sc-dn')  { store.moveScene(aId, cId, sId, 'down');_renderTree(el); return; }

    if (action === 'add-ch') {
      const ch = store.addChapter(aId);
      _sel = { type: 'chapter', actId: aId, chapterId: ch.id };
      _render(); return;
    }
    if (action === 'add-sc') {
      const sc = store.addScene(aId, cId);
      _sel = { type: 'scene', actId: aId, chapterId: cId, sceneId: sc.id };
      _render(); return;
    }

    if (action === 'del-act') {
      if (!confirm(`Delete this act and all its chapters and scenes?`)) return;
      if (_sel?.actId === aId) _sel = null;
      store.deleteAct(aId); _render(); return;
    }
    if (action === 'del-ch') {
      if (!confirm(`Delete this chapter and all its scenes?`)) return;
      if (_sel?.chapterId === cId) _sel = null;
      store.deleteChapter(aId, cId); _render(); return;
    }
    if (action === 'del-sc') {
      if (_sel?.sceneId === sId) _sel = null;
      store.deleteScene(aId, cId, sId); _render(); return;
    }
  });
}

// ── Detail panel ───────────────────────────────────────────────────────────────

function _renderDetail(el) {
  if (!_sel) {
    el.innerHTML = `<div class="str-empty">Select an act, chapter or scene to edit it.<br>
      Use the tree on the left to navigate and reorder.</div>`;
    return;
  }

  const { type, actId, chapterId, sceneId } = _sel;
  const structure = store.getStructure();
  const act = structure.find(a => a.id === actId);
  const ch  = act?.chapters?.find(c => c.id === chapterId);
  const sc  = ch?.scenes?.find(s => s.id === sceneId);

  let item, label, breadcrumb, hasNotes = true, hasLinks = false;

  if (type === 'act' && act) {
    item = act; label = 'ACT'; hasNotes = false;
    breadcrumb = _esc(act.title || 'New Act');
  } else if (type === 'chapter' && ch) {
    item = ch; label = 'CHAPTER'; hasLinks = true;
    breadcrumb = `${_esc(act.title)} › ${_esc(ch.title || 'New Chapter')}`;
  } else if (type === 'scene' && sc) {
    item = sc; label = 'SCENE'; hasLinks = true;
    breadcrumb = `${_esc(act.title)} › ${_esc(ch.title)} › ${_esc(sc.title || 'New Scene')}`;
  } else {
    el.innerHTML = `<div class="str-empty">Item not found.</div>`;
    return;
  }

  const wc = _wordCount(item.content || '');

  el.innerHTML = `<div class="str-detail-form">
    <div class="str-breadcrumb">${breadcrumb}</div>
    <div class="detail-type-badge" style="color:var(--accent)">${label}</div>

    <div class="str-field">
      <label class="str-label">Title</label>
      <input class="str-title-input" id="str-inp-title" type="text" value="${_esc(item.title)}" autocomplete="off">
    </div>

    <div class="str-field">
      <label class="str-label">Description</label>
      <textarea class="str-textarea" id="str-inp-desc" rows="3" placeholder="Summary or description…">${_esc(item.description || '')}</textarea>
    </div>

    <div class="str-field">
      <div class="str-content-header">
        <label class="str-label">Content</label>
        <span class="str-wordcount" id="str-wc">${wc ? `${wc.toLocaleString()} w` : ''}</span>
      </div>
      <textarea class="str-textarea str-content-area" id="str-inp-content" rows="18"
        placeholder="Write the prose here…">${_esc(item.content || '')}</textarea>
    </div>

    ${hasNotes ? `<div class="str-field">
      <label class="str-label">Notes</label>
      <textarea class="str-textarea" id="str-inp-notes" rows="3" placeholder="Working notes, reminders…">${_esc(item.notes || '')}</textarea>
    </div>` : ''}

    ${hasLinks ? _linksHtml(item.links || [], actId, chapterId, sceneId) : ''}

    ${item.content ? `<div class="str-extract-bar">
      <button class="str-extract-btn" id="str-btn-extract" title="Extract entities from this content">
        ◈ Extract entities
      </button>
      <span class="str-extract-status" id="str-extract-status"></span>
    </div>` : ''}
  </div>`;

  // Live word count while typing
  document.getElementById('str-inp-content')?.addEventListener('input', e => {
    const wc = _wordCount(e.target.value);
    const wcEl = document.getElementById('str-wc');
    if (wcEl) wcEl.textContent = wc ? `${wc.toLocaleString()} w` : '';
  });

  // Autosave on blur
  const save = () => {
    const fields = {
      title:       document.getElementById('str-inp-title')?.value   || '',
      description: document.getElementById('str-inp-desc')?.value    || '',
      content:     document.getElementById('str-inp-content')?.value || '',
      ...(hasNotes ? { notes: document.getElementById('str-inp-notes')?.value || '' } : {}),
    };
    if (type === 'act')     store.updateAct(actId, fields);
    if (type === 'chapter') store.updateChapter(actId, chapterId, fields);
    if (type === 'scene')   store.updateScene(actId, chapterId, sceneId, fields);
    _renderTree(_listEl); // refresh title in tree
  };

  el.querySelectorAll('input, textarea').forEach(inp =>
    inp.addEventListener('blur', save));

  if (hasLinks) _wireLinks(el, actId, chapterId, sceneId);

  document.getElementById('str-btn-extract')?.addEventListener('click', async () => {
    const btn     = document.getElementById('str-btn-extract');
    const status  = document.getElementById('str-extract-status');
    const content = document.getElementById('str-inp-content')?.value || item.content || '';
    if (!content.trim()) return;

    btn.disabled = true;
    status.textContent = 'Starting…';

    try {
      const existing = store.getAll().map(e => ({
        id: e.id, type: e.type, name: e.name, description: e.description || '',
        role: e.role || '', links: e.links || [],
      }));
      const { jobId } = await startExtraction(content, existing, 'simple');

      let dots = 0;
      const poll = setInterval(async () => {
        try {
          const job = await pollJob('extract', jobId);
          if (job.status === 'done' || job.status === 'error') {
            clearInterval(poll);
            btn.disabled = false;
            if (job.status === 'error') {
              status.textContent = `✗ ${job.error || 'Failed'}`;
              return;
            }
            const r = job.result || {};
            const creates = (r.creates || []).length;
            const updates = (r.updates || []).length;
            // Auto-import creates (new entities only — no UI needed for a quick extract)
            _importExtractResult(r);
            status.textContent = `✓ ${creates} new, ${updates} updated`;
            setTimeout(() => { status.textContent = ''; }, 5000);
          } else {
            dots = (dots + 1) % 4;
            status.textContent = 'Extracting' + '.'.repeat(dots + 1);
          }
        } catch { clearInterval(poll); btn.disabled = false; status.textContent = '✗ Poll failed'; }
      }, 3000);
    } catch (e) {
      btn.disabled = false;
      status.textContent = `✗ ${e.message}`;
    }
  });
}

// ── Links section ──────────────────────────────────────────────────────────────

function _linksHtml(links, actId, chapterId, sceneId) {
  const rows = links.map((l, i) => {
    const entity = store.get(l.entityId);
    const def    = entity ? TYPES[entity.type] : null;
    return `<div class="str-link-row">
      ${def ? `<span class="str-link-icon" style="color:${def.color}">${def.icon}</span>` : ''}
      <span class="str-link-name">${entity ? _esc(entity.name) : '<span class="str-deleted">deleted</span>'}</span>
      <input class="str-link-label-inp" type="text" value="${_esc(l.label)}" placeholder="relation…"
        data-link-index="${i}">
      <button class="str-link-del" data-link-index="${i}" title="Remove link">✕</button>
    </div>`;
  }).join('');

  return `<div class="str-links-section">
    <div class="section-title">Linked Entities</div>
    <div id="str-links-list">${rows || '<div class="str-links-empty">No links yet.</div>'}</div>
    <div class="str-link-add">
      <input id="str-link-q" type="text" placeholder="Search entities to link…" autocomplete="off">
      <input id="str-link-label" type="text" placeholder="Relation label (optional)">
      <div id="str-link-results" class="str-link-results"></div>
    </div>
  </div>`;
}

function _wireLinks(el, actId, chapterId, sceneId) {
  const re = () => {
    const item     = _getCurrentItem(actId, chapterId, sceneId);
    const listEl   = el.querySelector('#str-links-list');
    if (listEl && item) listEl.innerHTML = _linksHtml(item.links || [], actId, chapterId, sceneId)
      .match(/<div id="str-links-list">([\s\S]*?)<\/div>/)?.[1] || '';
    _wireLinks(el, actId, chapterId, sceneId);
  };

  // Remove link
  el.querySelectorAll('.str-link-del').forEach(btn =>
    btn.addEventListener('click', () => {
      store.removeStructureLink(actId, chapterId, sceneId, parseInt(btn.dataset.linkIndex));
      const item   = _getCurrentItem(actId, chapterId, sceneId);
      const listEl = el.querySelector('#str-links-list');
      if (listEl && item) {
        listEl.innerHTML = (item.links || []).map((l, i) => {
          const entity = store.get(l.entityId);
          const def    = entity ? TYPES[entity.type] : null;
          return `<div class="str-link-row">
            ${def ? `<span class="str-link-icon" style="color:${def.color}">${def.icon}</span>` : ''}
            <span class="str-link-name">${entity ? _esc(entity.name) : '<span class="str-deleted">deleted</span>'}</span>
            <input class="str-link-label-inp" type="text" value="${_esc(l.label)}" placeholder="relation…" data-link-index="${i}">
            <button class="str-link-del" data-link-index="${i}" title="Remove link">✕</button>
          </div>`;
        }).join('') || '<div class="str-links-empty">No links yet.</div>';
        _wireLinks(el, actId, chapterId, sceneId);
      }
    }));

  // Update link label
  el.querySelectorAll('.str-link-label-inp').forEach(inp => {
    inp.addEventListener('blur', () => {
      const item = _getCurrentItem(actId, chapterId, sceneId);
      const i    = parseInt(inp.dataset.linkIndex);
      if (!item?.links?.[i]) return;
      item.links[i].label = inp.value;
      store._persistDirect?.(); // fallback — handled below via direct store update
    });
  });

  // Live search
  const qInp     = el.querySelector('#str-link-q');
  const resDiv   = el.querySelector('#str-link-results');
  const labelInp = el.querySelector('#str-link-label');
  if (!qInp || !resDiv) return;

  let _hideTimeout = null;

  qInp.addEventListener('input', () => {
    const q = qInp.value.trim();
    if (!q) { resDiv.innerHTML = ''; resDiv.hidden = true; return; }
    const results = store.search(q).slice(0, 8);
    if (!results.length) { resDiv.innerHTML = ''; resDiv.hidden = true; return; }
    resDiv.innerHTML = results.map(e => {
      const def = TYPES[e.type];
      return `<div class="str-link-result" data-entity-id="${e.id}">
        <span style="color:${def?.color}">${def?.icon || ''}</span>
        <span class="str-link-result-type">${def?.label || e.type}</span>
        <span class="str-link-result-name">${_esc(e.name)}</span>
      </div>`;
    }).join('');
    resDiv.hidden = false;
  });

  resDiv.addEventListener('mousedown', e => {
    const row = e.target.closest('.str-link-result');
    if (!row) return;
    e.preventDefault();
    const entityId = row.dataset.entityId;
    const label    = labelInp?.value.trim() || '';
    store.addStructureLink(actId, chapterId, sceneId, entityId, label);
    qInp.value     = '';
    if (labelInp) labelInp.value = '';
    resDiv.innerHTML = ''; resDiv.hidden = true;
    const item   = _getCurrentItem(actId, chapterId, sceneId);
    const listEl = el.querySelector('#str-links-list');
    if (listEl && item) {
      listEl.innerHTML = (item.links || []).map((l, i) => {
        const entity = store.get(l.entityId);
        const def    = entity ? TYPES[entity.type] : null;
        return `<div class="str-link-row">
          ${def ? `<span class="str-link-icon" style="color:${def.color}">${def.icon}</span>` : ''}
          <span class="str-link-name">${entity ? _esc(entity.name) : '<span class="str-deleted">deleted</span>'}</span>
          <input class="str-link-label-inp" type="text" value="${_esc(l.label)}" placeholder="relation…" data-link-index="${i}">
          <button class="str-link-del" data-link-index="${i}" title="Remove link">✕</button>
        </div>`;
      }).join('') || '<div class="str-links-empty">No links yet.</div>';
      _wireLinks(el, actId, chapterId, sceneId);
    }
  });

  qInp.addEventListener('blur', () => {
    _hideTimeout = setTimeout(() => { resDiv.innerHTML = ''; resDiv.hidden = true; }, 200);
  });
  qInp.addEventListener('focus', () => clearTimeout(_hideTimeout));
  qInp.addEventListener('keydown', e => {
    if (e.key === 'Escape') { qInp.value = ''; resDiv.innerHTML = ''; resDiv.hidden = true; }
  });
}

function _getCurrentItem(actId, chapterId, sceneId) {
  const structure = store.getStructure();
  const act = structure.find(a => a.id === actId);
  const ch  = act?.chapters?.find(c => c.id === chapterId);
  if (!chapterId) return act;
  if (!sceneId)   return ch;
  return ch?.scenes?.find(s => s.id === sceneId);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const _ROMAN = ['', 'I','II','III','IV','V','VI','VII','VIII','IX','X',
                    'XI','XII','XIII','XIV','XV','XVI','XVII','XVIII','XIX','XX'];
function _roman(n) { return _ROMAN[n] || String(n); }

function _wordCount(text) {
  return text ? text.trim().split(/\s+/).filter(Boolean).length : 0;
}

function _importExtractResult(result) {
  const nameToId = {};
  store.getAll().forEach(e => { if (e.name) nameToId[e.name.toLowerCase()] = e.id; });

  for (const item of (result.creates || [])) {
    const entity = store.create(item.type, {
      name: item.name, description: item.description || '',
      role: item.role || '', locType: item.locType || '',
      date: item.date || '', importance: item.importance || '',
      gender: item.gender || '', skinTone: item.skinTone || '',
      hairStyle: item.hairStyle || '', hairColor: item.hairColor || '',
      eyeColor: item.eyeColor || '',
    });
    if (entity?.name) nameToId[entity.name.toLowerCase()] = entity.id;
  }
  for (const upd of (result.updates || [])) {
    if (store.get(upd.id)) store.update(upd.id, upd.changes);
  }
  for (const l of (result.links || [])) {
    const src = nameToId[l.sourceName?.toLowerCase()];
    const tgt = nameToId[l.targetName?.toLowerCase()];
    if (src && tgt && src !== tgt) store.addLink(src, tgt, l.label);
  }
}

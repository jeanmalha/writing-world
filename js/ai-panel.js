import { store, TYPES } from './store.js';
import { isAuthenticated, login } from './auth.js';
import { startExtraction, startAnalysis, pollJob } from './api.js';

// Module state — persists while AI view is active
let _mode    = 'extract';   // 'extract' | 'analyze'
let _model   = 'simple';    // 'simple'  | 'complex'
let _text    = '';
let _results = null;
let _status  = '';
let _loading = false;
let _polling = false;

const MODEL_LABEL = {
  simple:  { name: 'Simple',  hint: 'Fast · GPT OSS 20B' },
  complex: { name: 'Complex', hint: 'Thorough · Claude Sonnet' },
};

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Entry point ───────────────────────────────────────
export function renderAiView(listHeader, entityList, detailContent) {
  renderAiList(listHeader, entityList, detailContent);
  renderAiDetail(detailContent);
}

// ── List panel ────────────────────────────────────────
function renderAiList(listHeader, entityList, detailContent) {
  listHeader.innerHTML = `<div class="list-header-row">
    <span class="list-title">AI</span>
    ${_loading ? `<span class="list-count">processing…</span>` : ''}
  </div>`;

  if (!isAuthenticated()) {
    entityList.innerHTML = `<div class="ai-locked">
      <div class="ai-locked-icon">◈</div>
      <div class="ai-locked-msg">Sign in to use<br>AI features</div>
      <button id="btn-ai-signin">Sign In</button>
    </div>`;
    document.getElementById('btn-ai-signin')?.addEventListener('click', login);
    return;
  }

  const extractActive = _mode === 'extract' ? 'active' : '';
  const analyzeActive = _mode === 'analyze' ? 'active' : '';

  entityList.innerHTML = `
    <div class="ai-mode-toggle">
      <button class="ai-mode-btn ${extractActive}" id="btn-mode-extract">◈ Extract</button>
      <button class="ai-mode-btn ${analyzeActive}" id="btn-mode-analyze">◎ Analyze</button>
    </div>
    ${_mode === 'extract' ? renderExtractInput() : renderAnalyzeInput()}`;

  document.getElementById('btn-mode-extract')?.addEventListener('click', () => {
    if (_mode !== 'extract') { _mode = 'extract'; _results = null; _status = ''; rerender(listHeader, entityList, detailContent); }
  });
  document.getElementById('btn-mode-analyze')?.addEventListener('click', () => {
    if (_mode !== 'analyze') { _mode = 'analyze'; _results = null; _status = ''; rerender(listHeader, entityList, detailContent); }
  });

  entityList.querySelectorAll('.ai-model-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      if (_model !== btn.dataset.model) {
        _model = btn.dataset.model;
        rerender(listHeader, entityList, detailContent);
      }
    }));

  const ta  = document.getElementById('ai-textarea');
  const btn = document.getElementById('btn-ai-run');

  ta?.addEventListener('input', () => { _text = ta.value; });

  btn?.addEventListener('click', () => {
    if (_mode === 'extract') runExtract(listHeader, entityList, detailContent);
    else                     runAnalyze(listHeader, entityList, detailContent);
  });
}

function modelToggleHtml() {
  return `<div class="ai-model-toggle">
    ${['simple', 'complex'].map(m => `
      <button class="ai-model-btn${_model === m ? ' active' : ''}" data-model="${m}">
        <span class="ai-model-name">${MODEL_LABEL[m].name}</span>
        <span class="ai-model-hint">${MODEL_LABEL[m].hint}</span>
      </button>`).join('')}
  </div>`;
}

function renderExtractInput() {
  return `<div class="ai-input-area">
    ${modelToggleHtml()}
    <textarea id="ai-textarea" placeholder="Paste novel text here…&#10;&#10;The model will extract and match against your existing entities.">${esc(_text)}</textarea>
    <button id="btn-ai-run" ${_loading ? 'disabled' : ''}>
      ${_loading ? '◈ Extracting…' : '▶ Extract'}
    </button>
    ${_status ? `<div class="ai-status-msg">${esc(_status)}</div>` : ''}
  </div>`;
}

function renderAnalyzeInput() {
  const count = store.totalCount();
  return `<div class="ai-input-area">
    ${modelToggleHtml()}
    <div class="ai-analyze-desc">
      Analyzes your <strong>${count}</strong> existing entr${count !== 1 ? 'ies' : 'y'} and suggests missing links and potential duplicates.
    </div>
    <button id="btn-ai-run" ${_loading || count === 0 ? 'disabled' : ''}>
      ${_loading ? '◎ Analyzing…' : '▶ Analyze World'}
    </button>
    ${_status ? `<div class="ai-status-msg">${esc(_status)}</div>` : ''}
  </div>`;
}

// ── Run + poll ────────────────────────────────────────
async function runExtract(listHeader, entityList, detailContent) {
  _text = document.getElementById('ai-textarea')?.value.trim() || '';
  if (!_text || _loading) return;

  // Serialize existing entities for context/disambiguation
  const existingEntities = store.getAll().map(e => ({
    id:          e.id,
    type:        e.type,
    name:        e.name,
    description: e.description || '',
    ...(e.role     ? { role:    e.role    } : {}),
    ...(e.locType  ? { locType: e.locType } : {}),
    ...(e.date     ? { date:    e.date    } : {}),
  }));

  await runJob(() => startExtraction(_text, existingEntities, _model), 'extract',
               listHeader, entityList, detailContent);
}

async function runAnalyze(listHeader, entityList, detailContent) {
  if (_loading) return;

  const entities = store.getAll().map(e => ({
    id:          e.id,
    type:        e.type,
    name:        e.name,
    description: e.description || '',
    ...(e.role    ? { role:    e.role    } : {}),
    ...(e.locType ? { locType: e.locType } : {}),
    links:       e.links.map(l => ({ targetId: l.targetId, label: l.label })),
  }));

  if (!entities.length) return;
  await runJob(() => startAnalysis(entities, _model), 'analyze',
               listHeader, entityList, detailContent);
}

async function runJob(startFn, endpoint, listHeader, entityList, detailContent) {
  _loading = true;
  _status  = 'Starting…';
  _results = null;
  _polling = true;
  rerender(listHeader, entityList, detailContent);

  try {
    const { jobId } = await startFn();
    let dots = 0;
    while (_polling) {
      await sleep(3000);
      const job = await pollJob(endpoint, jobId);
      if (job.status === 'done')  { _results = job.result; _status = ''; break; }
      if (job.status === 'error') { _status = job.error || 'Failed'; break; }
      dots = (dots + 1) % 4;
      _status = (endpoint === 'extract' ? 'Extracting' : 'Analyzing') + '.'.repeat(dots + 1);
      rerender(listHeader, entityList, detailContent);
    }
  } catch (err) {
    _status = err.message;
  } finally {
    _loading = false;
    _polling = false;
    rerender(listHeader, entityList, detailContent);
  }
}

function rerender(listHeader, entityList, detailContent) {
  renderAiList(listHeader, entityList, detailContent);
  renderAiDetail(detailContent);
}

// ── Detail panel ──────────────────────────────────────
function renderAiDetail(detailContent) {
  if (!isAuthenticated()) { detailContent.innerHTML = ''; return; }

  if (_loading) {
    detailContent.innerHTML = `<div class="ai-working">
      <div class="ai-working-pulse">${_mode === 'extract' ? '◈' : '◎'}</div>
      <div>${esc(_status || 'Processing…')}</div>
      <div class="ai-working-sub">Claude is working</div>
    </div>`;
    return;
  }

  if (!_results) {
    detailContent.innerHTML = `<div class="empty-state detail-empty">
      ${_mode === 'extract'
        ? 'Paste novel text on the left<br>and click Extract.'
        : 'Click Analyze World to find<br>missing links and duplicates.'}
    </div>`;
    return;
  }

  if (_mode === 'extract') renderExtractResults(detailContent);
  else                     renderAnalyzeResults(detailContent);
}

// ── Extract results ───────────────────────────────────
function renderExtractResults(detailContent) {
  const { creates = [], updates = [], links = [] } = _results;
  const total = creates.length + updates.length + links.length;

  if (!total) {
    detailContent.innerHTML = `<div class="empty-state detail-empty">No entities found.</div>`;
    return;
  }

  const PHYSICAL_KEYS = ['gender', 'skinTone', 'hairColor', 'hairStyle', 'eyeColor'];

  const createsHtml = creates.length ? `
    <div class="ai-section">
      <div class="ai-section-title" style="color:var(--accent)">▸ NEW (${creates.length})</div>
      ${creates.map((item, i) => {
        const def     = TYPES[item.type] || TYPES.lore;
        const sub     = item.role || item.locType || item.date || '';
        const traits  = PHYSICAL_KEYS.map(k => item[k]).filter(Boolean);
        return `<label class="ai-item">
          <input type="checkbox" class="ai-cb ai-cb-create" data-index="${i}" checked>
          <div class="ai-item-body">
            <div class="ai-item-name">
              <span style="color:${def.color}">${def.icon}</span> ${esc(item.name || '?')}
            </div>
            ${sub ? `<div class="ai-item-sub">${esc(sub)}</div>` : ''}
            ${traits.length ? `<div class="ai-item-traits">${traits.map(t => `<span class="ai-trait">${esc(t)}</span>`).join('')}</div>` : ''}
            ${item.description ? `<div class="ai-item-desc">${esc(item.description)}</div>` : ''}
          </div>
        </label>`;
      }).join('')}
    </div>` : '';

  const updatesHtml = updates.length ? `
    <div class="ai-section">
      <div class="ai-section-title" style="color:var(--warning)">▸ UPDATES (${updates.length})</div>
      ${updates.map((upd, i) => {
        const entity = store.get(upd.id);
        if (!entity) return '';
        const def = TYPES[entity.type] || TYPES.lore;
        const changeLines = Object.entries(upd.changes || {})
          .map(([k, v]) => `<div class="ai-item-change"><span>${esc(k)}</span> → ${esc(String(v))}</div>`)
          .join('');
        return `<label class="ai-item">
          <input type="checkbox" class="ai-cb ai-cb-update" data-index="${i}" checked>
          <div class="ai-item-body">
            <div class="ai-item-name">
              <span style="color:${def.color}">${def.icon}</span> ${esc(entity.name)}
            </div>
            ${changeLines}
          </div>
        </label>`;
      }).filter(Boolean).join('')}
    </div>` : '';

  const linksHtml = links.length ? `
    <div class="ai-section">
      <div class="ai-section-title" style="color:var(--text-muted)">▸ LINKS (${links.length})</div>
      ${links.map((l, i) => `
        <label class="ai-item">
          <input type="checkbox" class="ai-cb ai-cb-link" data-index="${i}" checked>
          <div class="ai-item-body">
            <div class="ai-item-name">
              ${esc(l.sourceName)}
              <span class="ai-link-arrow"> —[${esc(l.label)}]→ </span>
              ${esc(l.targetName)}
            </div>
          </div>
        </label>`).join('')}
    </div>` : '';

  detailContent.innerHTML = `
    <div class="ai-results-header">
      <span>${total} change${total !== 1 ? 's' : ''}</span>
      <button id="btn-import-checked">Import Selected</button>
    </div>
    ${createsHtml}${updatesHtml}${linksHtml}`;

  document.getElementById('btn-import-checked')?.addEventListener('click', () => {
    // Build name → entity ID map (existing entities first)
    const nameToId = {};
    store.getAll().forEach(e => { if (e.name) nameToId[e.name.toLowerCase()] = e.id; });

    let applied = 0;
    detailContent.querySelectorAll('.ai-cb-create:checked').forEach(cb => {
      const item = creates[parseInt(cb.dataset.index)];
      if (item) {
        const entity = importCreate(item);
        if (entity?.name) nameToId[entity.name.toLowerCase()] = entity.id;
        applied++;
      }
    });
    detailContent.querySelectorAll('.ai-cb-update:checked').forEach(cb => {
      const upd = updates[parseInt(cb.dataset.index)];
      if (upd && store.get(upd.id)) { store.update(upd.id, upd.changes); applied++; }
    });
    detailContent.querySelectorAll('.ai-cb-link:checked').forEach(cb => {
      const l   = links[parseInt(cb.dataset.index)];
      if (!l)   return;
      const src = nameToId[l.sourceName?.toLowerCase()];
      const tgt = nameToId[l.targetName?.toLowerCase()];
      if (src && tgt && src !== tgt) { store.addLink(src, tgt, l.label); applied++; }
    });

    _results = null; _text = '';
    detailContent.innerHTML = `<div class="empty-state detail-empty">
      Applied ${applied} change${applied !== 1 ? 's' : ''}.<br>Paste more text to continue.
    </div>`;
  });
}

// ── Analyze results ───────────────────────────────────
function renderAnalyzeResults(detailContent) {
  const { links = [], merges = [] } = _results;
  const total = links.length + merges.length;

  if (!total) {
    detailContent.innerHTML = `<div class="empty-state detail-empty">No suggestions — world looks well-connected.</div>`;
    return;
  }

  const linksHtml = links.length ? `
    <div class="ai-section">
      <div class="ai-section-title" style="color:var(--accent)">▸ SUGGESTED LINKS (${links.length})</div>
      ${links.map((l, i) => {
        const src = store.get(l.sourceId);
        const tgt = store.get(l.targetId);
        if (!src || !tgt) return '';
        const srcDef = TYPES[src.type] || TYPES.lore;
        const tgtDef = TYPES[tgt.type] || TYPES.lore;
        return `<label class="ai-item">
          <input type="checkbox" class="ai-cb ai-cb-link" data-index="${i}" checked>
          <div class="ai-item-body">
            <div class="ai-item-name">
              <span style="color:${srcDef.color}">${srcDef.icon}</span> ${esc(src.name)}
              <span class="ai-link-arrow"> —[${esc(l.label)}]→ </span>
              <span style="color:${tgtDef.color}">${tgtDef.icon}</span> ${esc(tgt.name)}
            </div>
            <div class="ai-item-sub">${esc(l.reason)}</div>
          </div>
        </label>`;
      }).filter(Boolean).join('')}
    </div>` : '';

  const mergesHtml = merges.length ? `
    <div class="ai-section">
      <div class="ai-section-title" style="color:var(--danger)">▸ SUGGESTED MERGES (${merges.length})</div>
      <div class="ai-merge-warning">Merging is permanent. The discarded entity will be deleted.</div>
      ${merges.map((m, i) => {
        const keep  = store.get(m.keepId);
        const discard = store.get(m.mergeId);
        if (!keep || !discard) return '';
        const def = TYPES[keep.type] || TYPES.lore;
        return `<label class="ai-item">
          <input type="checkbox" class="ai-cb ai-cb-merge" data-index="${i}">
          <div class="ai-item-body">
            <div class="ai-item-name">
              <span style="color:${def.color}">${def.icon}</span>
              keep <strong>${esc(keep.name)}</strong>,
              discard <span class="ai-discard">${esc(discard.name)}</span>
            </div>
            <div class="ai-item-sub">${esc(m.reason)}</div>
          </div>
        </label>`;
      }).filter(Boolean).join('')}
    </div>` : '';

  detailContent.innerHTML = `
    <div class="ai-results-header">
      <span>${total} suggestion${total !== 1 ? 's' : ''}</span>
      <button id="btn-apply-suggestions">Apply Selected</button>
    </div>
    ${linksHtml}${mergesHtml}`;

  document.getElementById('btn-apply-suggestions')?.addEventListener('click', () => {
    let applied = 0;
    detailContent.querySelectorAll('.ai-cb-link:checked').forEach(cb => {
      const l = links[parseInt(cb.dataset.index)];
      if (l && store.get(l.sourceId) && store.get(l.targetId)) {
        store.addLink(l.sourceId, l.targetId, l.label);
        applied++;
      }
    });
    detailContent.querySelectorAll('.ai-cb-merge:checked').forEach(cb => {
      const m = merges[parseInt(cb.dataset.index)];
      if (!m) return;
      const keep    = store.get(m.keepId);
      const discard = store.get(m.mergeId);
      if (!keep || !discard) return;
      // Port discard's outgoing links to keep
      for (const link of discard.links) {
        if (!keep.links.some(l => l.targetId === link.targetId)) {
          store.addLink(m.keepId, link.targetId, link.label);
        }
      }
      // Merge description if keep has none
      if (!keep.description && discard.description) {
        store.update(m.keepId, { description: discard.description });
      }
      store.delete(m.mergeId);
      applied++;
    });
    _results = null;
    detailContent.innerHTML = `<div class="empty-state detail-empty">
      Applied ${applied} suggestion${applied !== 1 ? 's' : ''}.
    </div>`;
  });
}

// ── Import helpers ────────────────────────────────────
const TYPE_MAP = { character: 'character', location: 'location', faction: 'faction',
                   species: 'species', event: 'event', artifact: 'artifact', lore: 'lore' };

function importCreate(item) {
  const type   = TYPE_MAP[item.type] || 'lore';
  const entity = store.create(type);
  const fields = { name: item.name || '', description: item.description || '' };
  if (item.role)       fields.role       = item.role;
  if (item.locType)    fields.locType    = item.locType;
  if (item.date)       fields.date       = item.date;
  if (item.importance) fields.importance = item.importance;
  if (item.gender)     fields.gender     = item.gender;
  if (item.skinTone)   fields.skinTone   = item.skinTone;
  if (item.hairStyle)  fields.hairStyle  = item.hairStyle;
  if (item.hairColor)  fields.hairColor  = item.hairColor;
  if (item.eyeColor)   fields.eyeColor   = item.eyeColor;
  store.update(entity.id, fields);
  return store.get(entity.id);  // return with name set, for link resolution
}

import { store, TYPES } from './store.js';
import { isAuthenticated, login, getUserTier } from './auth.js';
import { startExtraction, startAnalysis, startPdfExtraction, startStructureExtraction, pollJob } from './api.js';

// Module state — persists while AI view is active
let _mode             = 'extract';   // 'extract' | 'analyze'
let _source           = 'text';      // 'text' | 'pdf'
let _model            = 'simple';    // 'simple' | 'medium' | 'complex'
let _includeStructure = false;
let _text    = '';
let _results = null;
let _status  = '';
let _loading = false;
let _polling = false;

// PDF state
let _pdfPages      = [];
let _pdfFileName   = '';
let _pdfExtracting = false;
let _pdfProgress   = 0;
let _pdfTotal      = 0;

const PDFJS_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.9.155/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.9.155/build/pdf.worker.min.mjs';

async function getPdfjsLib() {
  if (window._pdfjsLib) return window._pdfjsLib;
  const lib = await import(PDFJS_CDN);
  lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  window._pdfjsLib = lib;
  return lib;
}


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
  const auth = isAuthenticated();

  const extractActive = _mode === 'extract' ? ' active' : '';
  const analyzeActive = _mode === 'analyze' ? ' active' : '';

  listHeader.innerHTML = `<div class="admin-header">
    <div class="list-header-row">
      <span class="list-title">AI</span>
      ${_loading ? `<span class="list-count">processing…</span>` : ''}
    </div>
    ${auth ? `<div class="admin-tabs">
      <button class="admin-tab${extractActive}" id="btn-mode-extract">◈ Extract</button>
      <button class="admin-tab${analyzeActive}" id="btn-mode-analyze">◎ Analyze</button>
    </div>` : ''}
  </div>`;

  listHeader.querySelector('#btn-mode-extract')?.addEventListener('click', () => {
    if (_mode !== 'extract') { _mode = 'extract'; _results = null; _status = ''; rerender(listHeader, entityList, detailContent); }
  });
  listHeader.querySelector('#btn-mode-analyze')?.addEventListener('click', () => {
    if (_mode !== 'analyze') { _mode = 'analyze'; _results = null; _status = ''; rerender(listHeader, entityList, detailContent); }
  });

  if (!auth) {
    entityList.innerHTML = `<div class="ai-locked">
      <div class="ai-locked-icon">◈</div>
      <div class="ai-locked-msg">Sign in to use<br>AI features</div>
      <button id="btn-ai-signin">Sign In</button>
    </div>`;
    document.getElementById('btn-ai-signin')?.addEventListener('click', login);
    return;
  }

  entityList.innerHTML = _mode === 'extract' ? renderExtractInput() : renderAnalyzeInput();

  const ta  = document.getElementById('ai-textarea');
  const btn = document.getElementById('btn-ai-run');

  ta?.addEventListener('input', () => { _text = ta.value; });

  btn?.addEventListener('click', () => {
    if (_mode === 'analyze')    runAnalyze(listHeader, entityList, detailContent);
    else if (_source === 'pdf') runPdfExtract(listHeader, entityList, detailContent);
    else                        runExtract(listHeader, entityList, detailContent);
  });

  // Source toggle
  document.getElementById('btn-src-text')?.addEventListener('click', () => {
    if (_source !== 'text') { _source = 'text'; rerender(listHeader, entityList, detailContent); }
  });
  document.getElementById('btn-src-pdf')?.addEventListener('click', () => {
    if (_source !== 'pdf') { _source = 'pdf'; rerender(listHeader, entityList, detailContent); }
  });

  // Structure checkbox
  document.getElementById('ai-cb-structure')?.addEventListener('change', e => {
    _includeStructure = e.target.checked;
  });

  // Model toggle
  document.getElementById('btn-model-simple')?.addEventListener('click', () => {
    if (_model !== 'simple') { _model = 'simple'; rerender(listHeader, entityList, detailContent); }
  });
  document.getElementById('btn-model-medium')?.addEventListener('click', () => {
    if (_model !== 'medium') { _model = 'medium'; rerender(listHeader, entityList, detailContent); }
  });
  document.getElementById('btn-model-complex')?.addEventListener('click', () => {
    if (_model !== 'complex') { _model = 'complex'; rerender(listHeader, entityList, detailContent); }
  });

  // PDF file input
  document.getElementById('ai-pdf-input')?.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    await handlePdfFile(file, listHeader, entityList, detailContent);
  });

  // PDF drop zone
  const drop = document.getElementById('ai-pdf-drop');
  drop?.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag-over'); });
  drop?.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop?.addEventListener('drop', async e => {
    e.preventDefault();
    drop.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file?.type === 'application/pdf') {
      await handlePdfFile(file, listHeader, entityList, detailContent);
    }
  });
}

function _modelToggleHtml() {
  const tier    = getUserTier();
  const rank    = { simple: 0, medium: 1, complex: 2 };
  const maxRank = tier === 'uncharted' ? 2 : tier === 'trailblazer' ? 1 : 0;
  const blocked = rank[_model] > maxRank;
  const upgradeMsg = maxRank === 0
    ? `<div class="ai-upgrade-notice">◈ <strong>Trailblazer</strong> required for Medium · <strong>Uncharted</strong> for Complex.</div>`
    : maxRank === 1
    ? `<div class="ai-upgrade-notice">◈ <strong>Uncharted</strong> required for Complex.</div>`
    : '';
  return `
    <div class="ai-model-toggle">
      <button class="ai-model-btn${_model === 'simple'  ? ' active' : ''}" id="btn-model-simple">Simple</button>
      <button class="ai-model-btn${_model === 'medium'  ? ' active' : ''}" id="btn-model-medium">Medium</button>
      <button class="ai-model-btn${_model === 'complex' ? ' active' : ''}" id="btn-model-complex">Complex</button>
    </div>
    ${blocked ? upgradeMsg : ''}`;
}

function renderExtractInput() {
  const srcText = _source === 'text';
  const tier    = getUserTier();
  const blocked = ({ simple: 0, medium: 1, complex: 2 }[_model] || 0) > (tier === 'uncharted' ? 2 : tier === 'trailblazer' ? 1 : 0);
  return `<div class="ai-input-area">
    <div class="ai-source-toggle">
      <button class="ai-src-btn${srcText ? ' active' : ''}" id="btn-src-text">Text</button>
      <button class="ai-src-btn${!srcText ? ' active' : ''}" id="btn-src-pdf">PDF</button>
    </div>
    ${srcText ? `
      <textarea id="ai-textarea" placeholder="Paste novel text here…&#10;&#10;The model will extract and match against your existing entities.">${esc(_text)}</textarea>
    ` : renderPdfInput()}
    <label class="ai-struct-checkbox">
      <input type="checkbox" id="ai-cb-structure" ${_includeStructure ? 'checked' : ''}>
      Also extract book structure (acts, chapters, scenes)
    </label>
    ${_modelToggleHtml()}
    <button id="btn-ai-run" ${_loading || blocked || (_source === 'pdf' && !_pdfPages.length && !_pdfExtracting) ? 'disabled' : ''}>
      ${_loading ? (_source === 'pdf' ? '◈ Extracting PDF…' : '◈ Extracting…') : (_source === 'pdf' ? '▶ Extract PDF' : '▶ Extract')}
    </button>
    ${_status ? `<div class="ai-status-msg">${esc(_status)}</div>` : ''}
  </div>`;
}

function renderPdfInput() {
  if (_pdfExtracting) {
    return `<div class="ai-pdf-progress">
      <div class="ai-pdf-prog-bar">
        <div class="ai-pdf-prog-fill" style="width:${_pdfTotal ? Math.round(_pdfProgress/_pdfTotal*100) : 0}%"></div>
      </div>
      <div class="ai-pdf-prog-label">Reading page ${_pdfProgress} of ${_pdfTotal}…</div>
    </div>`;
  }

  if (_pdfPages.length) {
    const chunks = Math.ceil(_pdfPages.length / 5);
    return `<div class="ai-pdf-ready">
      <div class="ai-pdf-file">◈ ${esc(_pdfFileName)}</div>
      <div class="ai-pdf-meta">${_pdfPages.length} pages · ${chunks} chunk${chunks !== 1 ? 's' : ''} of 5</div>
      <button class="ai-pdf-clear" id="ai-pdf-clear-btn">✕ Clear</button>
    </div>`;
  }

  return `<label class="ai-pdf-drop" id="ai-pdf-drop">
    <input type="file" id="ai-pdf-input" accept=".pdf" style="display:none">
    <span class="ai-pdf-icon">⬆</span>
    <span class="ai-pdf-label">Drop PDF or click to browse</span>
    <span class="ai-pdf-hint">Text will be extracted page by page</span>
  </label>`;
}

function renderStructureInput() {
  const tier     = getUserTier();
  const blocked  = tier === 'explorer' && _model === 'complex';
  const actCount = store.getStructure().length;
  const charCount  = _text.length;
  const chunkCount = Math.ceil(charCount / 50000) || 1;
  return `<div class="ai-input-area">
    <div class="ai-analyze-desc">
      Paste text from your novel and the AI will identify acts, chapters, and scenes.
      ${actCount ? `You have <strong>${actCount}</strong> existing act${actCount !== 1 ? 's' : ''} — duplicates will be skipped.` : ''}
    </div>
    <textarea id="ai-textarea" placeholder="Paste novel text here…&#10;&#10;The AI will identify the narrative structure: acts, chapters, and scenes.">${esc(_text)}</textarea>
    ${charCount > 50000 ? `<div class="ai-status-msg" style="color:var(--text-muted)">◈ ${charCount.toLocaleString()} chars — will process in ${chunkCount} chunks of ~50,000 with rolling context.</div>` : ''}
    ${_modelToggleHtml()}
    <button id="btn-ai-run" ${_loading || blocked || !_text.trim() ? 'disabled' : ''}>
      ${_loading ? '▤ Extracting structure…' : '▶ Extract Structure'}
    </button>
    ${_status ? `<div class="ai-status-msg">${esc(_status)}</div>` : ''}
  </div>`;
}

async function runStructureExtract(listHeader, entityList, detailContent) {
  _text = document.getElementById('ai-textarea')?.value.trim() || '';
  if (!_text || _loading) return;

  const existingStructure = store.getStructure().map(a => ({
    title: a.title,
    chapters: (a.chapters || []).map(c => ({ title: c.title })),
  }));

  await runJob(() => startStructureExtraction(_text, existingStructure, _model),
               'extract-structure', listHeader, entityList, detailContent);
}

function renderAnalyzeInput() {
  const count   = store.totalCount();
  const tier    = getUserTier();
  const blocked = ({ simple: 0, medium: 1, complex: 2 }[_model] || 0) > (tier === 'uncharted' ? 2 : tier === 'trailblazer' ? 1 : 0);
  return `<div class="ai-input-area">
    <div class="ai-analyze-desc">
      Analyzes your <strong>${count}</strong> existing entr${count !== 1 ? 'ies' : 'y'} and suggests missing links and potential duplicates.
    </div>
    ${_modelToggleHtml()}
    <button id="btn-ai-run" ${_loading || blocked || count === 0 ? 'disabled' : ''}>
      ${_loading ? '◎ Analyzing…' : '▶ Analyze World'}
    </button>
    ${_status ? `<div class="ai-status-msg">${esc(_status)}</div>` : ''}
  </div>`;
}

// ── PDF extraction ────────────────────────────────────
async function handlePdfFile(file, listHeader, entityList, detailContent) {
  _pdfFileName   = file.name;
  _pdfPages      = [];
  _pdfExtracting = true;
  _pdfProgress   = 0;
  _pdfTotal      = 0;
  rerender(listHeader, entityList, detailContent);

  try {
    const pdfjsLib   = await getPdfjsLib();
    const buffer     = await file.arrayBuffer();
    const pdf        = await pdfjsLib.getDocument({ data: buffer }).promise;
    _pdfTotal        = pdf.numPages;

    for (let i = 1; i <= pdf.numPages; i++) {
      _pdfProgress = i;
      const page    = await pdf.getPage(i);
      const content = await page.getTextContent();
      _pdfPages.push(content.items.map(item => item.str).join(' ').trim());
      // Update progress every 5 pages
      if (i % 5 === 0) rerender(listHeader, entityList, detailContent);
    }
  } catch (err) {
    _status = `PDF read failed: ${err.message}`;
    _pdfPages = [];
  }

  _pdfExtracting = false;
  rerender(listHeader, entityList, detailContent);

  // Wire up clear button after re-render
  document.getElementById('ai-pdf-clear-btn')?.addEventListener('click', () => {
    _pdfPages = []; _pdfFileName = ''; _status = '';
    rerender(listHeader, entityList, detailContent);
  });
}

// ── Run + poll ────────────────────────────────────────

function _existingEntities() {
  return store.getAll().map(e => ({
    id: e.id, type: e.type, name: e.name, description: e.description || '',
    ...(e.role    ? { role:    e.role    } : {}),
    ...(e.locType ? { locType: e.locType } : {}),
    ...(e.date    ? { date:    e.date    } : {}),
  }));
}

function _existingStructure() {
  return store.getStructure().map(a => ({
    title: a.title, chapters: (a.chapters || []).map(c => ({ title: c.title })),
  }));
}

async function runExtract(listHeader, entityList, detailContent) {
  _text = document.getElementById('ai-textarea')?.value.trim() || '';
  if (!_text || _loading) return;

  if (!_includeStructure) {
    await runJob(() => startExtraction(_text, _existingEntities(), _model),
                 'extract', listHeader, entityList, detailContent);
    return;
  }

  await runParallelExtract(
    () => startExtraction(_text, _existingEntities(), _model),
    () => startStructureExtraction(_text, _existingStructure(), _model),
    listHeader, entityList, detailContent,
  );
}

async function runPdfExtract(listHeader, entityList, detailContent) {
  if (!_pdfPages.length || _loading) return;

  if (!_includeStructure) {
    await runJob(() => startPdfExtraction(_pdfPages, _existingEntities(), _model),
                 'extract-pdf', listHeader, entityList, detailContent);
    return;
  }

  const pdfText = _pdfPages.join('\n\n');
  await runParallelExtract(
    () => startPdfExtraction(_pdfPages, _existingEntities(), _model),
    () => startStructureExtraction(pdfText, _existingStructure(), _model),
    listHeader, entityList, detailContent,
    'extract-pdf',
  );
}

async function runParallelExtract(entityStartFn, structStartFn, listHeader, entityList, detailContent, entityEndpoint = 'extract') {
  _loading = true; _status = 'Starting…'; _results = null; _polling = true;
  rerender(listHeader, entityList, detailContent);

  try {
    const [entityJob, structJob] = await Promise.all([entityStartFn(), structStartFn()]);
    let dots = 0;
    while (_polling) {
      await sleep(3000);
      const [ep, sp] = await Promise.all([
        pollJob(entityEndpoint, entityJob.jobId),
        pollJob('extract-structure', structJob.jobId),
      ]);
      if (ep.status === 'error')  { _status = ep.error || 'Extraction failed'; break; }
      if (sp.status === 'error')  { _status = sp.error || 'Structure extraction failed'; break; }
      if (ep.status === 'done' && sp.status === 'done') {
        _results = { ...ep.result, structure: sp.result };
        _status = ''; break;
      }
      dots = (dots + 1) % 4;
      _status = 'Extracting' + '.'.repeat(dots + 1);
      rerender(listHeader, entityList, detailContent);
    }
  } catch (e) {
    _status = e.message;
  } finally {
    _loading = false; _polling = false;
    rerender(listHeader, entityList, detailContent);
  }
}

// (kept for potential future reuse)
async function runPdfExtractLegacy(listHeader, entityList, detailContent) {
  if (!_pdfPages.length || _loading) return;
  await runJob(() => startPdfExtraction(_pdfPages, _existingEntities(), _model),
               'extract-pdf', listHeader, entityList, detailContent);
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
      const verb = endpoint === 'analyze' ? 'Analyzing' : 'Extracting';
      _status = verb + '.'.repeat(dots + 1);
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
  // Wire clear button (only present when PDF is loaded)
  document.getElementById('ai-pdf-clear-btn')?.addEventListener('click', () => {
    _pdfPages = []; _pdfFileName = ''; _status = '';
    rerender(listHeader, entityList, detailContent);
  });
}

// ── Detail panel ──────────────────────────────────────
function renderAiDetail(detailContent) {
  if (!isAuthenticated()) { detailContent.innerHTML = ''; return; }

  if (_loading) {
    detailContent.innerHTML = `<div class="ai-working">
      <div class="ai-working-pulse">${_mode === 'extract' ? '◈' : '◎'}</div>
      <div>${esc(_status || 'Processing…')}</div>
      <div class="ai-working-sub">${_source === 'pdf' ? 'Lore is reading your PDF…' : 'Lore is looking at your piece.'}</div>
    </div>`;
    return;
  }

  if (!_results) {
    const hint = _mode === 'extract'   ? 'Paste novel text on the left<br>and click Extract.'
               : _mode === 'structure' ? 'Paste text on the left and click<br>Extract Structure.'
               :                        'Click Analyze World to find<br>missing links and duplicates.';
    detailContent.innerHTML = `<div class="empty-state detail-empty">${hint}</div>`;
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
    container.querySelectorAll('.ai-cb-create:checked').forEach(cb => {
      const item = creates[parseInt(cb.dataset.index)];
      if (item) {
        const entity = importCreate(item);
        if (entity?.name) nameToId[entity.name.toLowerCase()] = entity.id;
        applied++;
      }
    });
    container.querySelectorAll('.ai-cb-update:checked').forEach(cb => {
      const upd = updates[parseInt(cb.dataset.index)];
      if (upd && store.get(upd.id)) { store.update(upd.id, upd.changes); applied++; }
    });
    container.querySelectorAll('.ai-cb-link:checked').forEach(cb => {
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

  // Structure section (when checkbox was checked)
  if (_results?.structure?.acts?.length) {
    const structEl = document.createElement('div');
    structEl.className = 'ai-struct-inline';
    detailContent.appendChild(structEl);
    _renderStructureSection(structEl, _results.structure.acts);
  }
}

// ── Structure results ─────────────────────────────────
function _renderStructureSection(container, acts) {
  if (!acts?.length) {
    container.innerHTML = `<div class="empty-state detail-empty">No structure identified.</div>`;
    return;
  }

  const ROMAN = ['','I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII','XIII','XIV','XV'];
  const roman = n => ROMAN[n] || String(n);

  // Track added items: 'act-0' → store actId, 'act-0-ch-1' → storeChapterId
  const added = {};

  const actsHtml = acts.map((act, ai) => {
    const chsHtml = (act.chapters || []).map((ch, ci) => {
      const scHtml = (ch.scenes || []).map((sc, si) =>
        `<div class="ai-struct-scene">
          <span class="ai-struct-dot">·</span>
          <span class="ai-struct-title">${esc(sc.title)}</span>
          ${sc.description ? `<span class="ai-struct-desc"> — ${esc(sc.description)}</span>` : ''}
          <button class="ai-struct-add" data-type="scene" data-ai="${ai}" data-ci="${ci}" data-si="${si}">+ Add</button>
        </div>`).join('');
      return `<div class="ai-struct-chapter">
        <div class="ai-struct-row">
          <span class="ai-struct-badge-ch">Ch ${ci + 1}</span>
          <span class="ai-struct-title">${esc(ch.title)}</span>
          <button class="ai-struct-add" data-type="chapter" data-ai="${ai}" data-ci="${ci}">+ Add</button>
        </div>
        ${ch.description ? `<div class="ai-struct-desc-row">${esc(ch.description)}</div>` : ''}
        ${scHtml}
      </div>`;
    }).join('');

    return `<div class="ai-struct-act">
      <div class="ai-struct-row ai-struct-act-row">
        <span class="ai-struct-badge">Act ${roman(ai + 1)}</span>
        <span class="ai-struct-title">${esc(act.title)}</span>
        <button class="ai-struct-add ai-struct-add-act" data-type="act" data-ai="${ai}">+ Add all</button>
      </div>
      ${act.description ? `<div class="ai-struct-desc-row">${esc(act.description)}</div>` : ''}
      ${chsHtml}
    </div>`;
  }).join('');

  container.innerHTML = `<div class="ai-struct-results">
    <div class="ai-struct-header">
      <span>${acts.length} act${acts.length !== 1 ? 's' : ''} · ${acts.reduce((n,a)=>n+(a.chapters||[]).length,0)} chapters extracted</span>
      <button id="ai-struct-add-all">Add All to Structure</button>
    </div>
    ${actsHtml}
  </div>`;

  function addAct(ai) {
    if (added[`act-${ai}`]) return added[`act-${ai}`];
    const act    = acts[ai];
    const stored = store.addAct(act.title);
    store.updateAct(stored.id, { description: act.description || '' });
    added[`act-${ai}`] = stored.id;
    return stored.id;
  }

  function addChapter(ai, ci) {
    const key = `act-${ai}-ch-${ci}`;
    if (added[key]) return added[key];
    const actId = addAct(ai);
    const ch    = acts[ai].chapters[ci];
    const stored = store.addChapter(actId, ch.title);
    store.updateChapter(actId, stored.id, { description: ch.description || '' });
    added[key] = stored.id;
    return stored.id;
  }

  function addScene(ai, ci, si) {
    const key = `act-${ai}-ch-${ci}-sc-${si}`;
    if (added[key]) return;
    const actId = added[`act-${ai}`] || addAct(ai);
    const chId  = added[`act-${ai}-ch-${ci}`] || addChapter(ai, ci);
    const sc    = acts[ai].chapters[ci].scenes[si];
    const stored = store.addScene(actId, chId, sc.title);
    if (stored) store.updateScene(actId, chId, stored.id, { description: sc.description || '' });
    added[key] = stored?.id;
  }

  function markAdded(btn) {
    btn.textContent = '✓';
    btn.disabled = true;
    btn.classList.add('ai-struct-added');
  }

  container.querySelectorAll('.ai-struct-add').forEach(btn => {
    btn.addEventListener('click', () => {
      const { type, ai, ci, si } = btn.dataset;
      const aN = parseInt(ai), cN = parseInt(ci), sN = parseInt(si);
      if (type === 'act') {
        addAct(aN);
        (acts[aN].chapters || []).forEach((_, cI) => {
          addChapter(aN, cI);
          ((acts[aN].chapters[cI].scenes) || []).forEach((_, sI) => addScene(aN, cI, sI));
        });
        // Mark all children
        container.querySelectorAll(`[data-ai="${aN}"]`).forEach(b => markAdded(b));
      } else if (type === 'chapter') {
        addChapter(aN, cN);
        ((acts[aN].chapters[cN].scenes) || []).forEach((_, sI) => addScene(aN, cN, sI));
        container.querySelectorAll(`[data-ai="${aN}"][data-ci="${cN}"]`).forEach(b => markAdded(b));
      } else {
        addScene(aN, cN, sN);
        markAdded(btn);
      }
    });
  });

  document.getElementById('ai-struct-add-all')?.addEventListener('click', e => {
    acts.forEach((act, ai) => {
      addAct(ai);
      (act.chapters || []).forEach((_, ci) => {
        addChapter(ai, ci);
        ((acts[ai].chapters[ci].scenes) || []).forEach((_, si) => addScene(ai, ci, si));
      });
    });
    container.querySelectorAll('.ai-struct-add').forEach(b => markAdded(b));
    e.currentTarget.textContent = '✓ All Added';
    e.currentTarget.disabled = true;
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
    container.querySelectorAll('.ai-cb-link:checked').forEach(cb => {
      const l = links[parseInt(cb.dataset.index)];
      if (l && store.get(l.sourceId) && store.get(l.targetId)) {
        store.addLink(l.sourceId, l.targetId, l.label);
        applied++;
      }
    });
    container.querySelectorAll('.ai-cb-merge:checked').forEach(cb => {
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

import { store, TYPES, TYPE_FIELDS } from './store.js';

// ── Module state ──────────────────────────────────────
let _catFilter  = null;  // null = all
let _drag       = null;  // { id, offX, offY, el }
let _onNavigate = null;  // callback(entityId) to jump to entity in list view

const CARD_W = 200;
const CARD_H = 152;
const CARD_GAP = 20;

// ── Public entry point ────────────────────────────────

export function initBoard(onNavigate) {
  _onNavigate = onNavigate;
  document.getElementById('board-canvas').addEventListener('mousemove', onMouseMove);
  document.getElementById('board-canvas').addEventListener('mouseup',   onMouseUp);
  document.getElementById('board-canvas').addEventListener('mouseleave', onMouseUp);
  document.getElementById('btn-board-modal-close')
    ?.addEventListener('click', closeModal);
}

export function renderBoard() {
  renderToolbar();
  renderCards();
}

// ── Toolbar ───────────────────────────────────────────

function renderToolbar() {
  const toolbar = document.getElementById('board-toolbar');
  const cats    = store.getCategories();

  toolbar.innerHTML = `
    <div class="bt-cats">
      <button class="bt-filter-chip${_catFilter === null ? ' active' : ''}" data-filter="all">All</button>
      ${cats.map(c => `
        <span class="bt-filter-chip${_catFilter === c.id ? ' active' : ''}"
              style="--cc:${c.color}" data-filter="${c.id}">
          <span class="bt-cat-label" data-rename="${c.id}">${esc(c.name)}</span>
          <button class="bt-cat-del" data-del="${c.id}" title="Delete">&#215;</button>
        </span>`).join('')}
      <button class="bt-add-cat" id="btn-board-add-cat">+ Category</button>
    </div>
    <div class="bt-add-form" id="bt-add-form">
      <input id="bt-new-name" type="text" placeholder="Name…" autocomplete="off" maxlength="32">
      <input id="bt-new-color" type="color" value="#818cf8">
      <button id="bt-new-save">Add</button>
      <button id="bt-new-cancel">&#215;</button>
    </div>`;

  // Filter chips
  toolbar.querySelectorAll('[data-filter]').forEach(btn =>
    btn.addEventListener('click', () => {
      _catFilter = btn.dataset.filter === 'all' ? null : btn.dataset.filter;
      renderBoard();
    }));

  // Delete category
  toolbar.querySelectorAll('[data-del]').forEach(btn =>
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (!confirm(`Delete category "${store.getCategories().find(c=>c.id===btn.dataset.del)?.name}"?`)) return;
      if (_catFilter === btn.dataset.del) _catFilter = null;
      store.deleteCategory(btn.dataset.del);
      renderBoard();
    }));

  // Rename category (inline)
  toolbar.querySelectorAll('[data-rename]').forEach(span => {
    span.addEventListener('dblclick', e => {
      e.stopPropagation();
      const id  = span.dataset.rename;
      const old = span.textContent;
      const inp = document.createElement('input');
      inp.className = 'bt-rename-input';
      inp.value = old;
      span.replaceWith(inp);
      inp.focus(); inp.select();
      const commit = () => {
        const val = inp.value.trim();
        if (val && val !== old) store.updateCategory(id, { name: val });
        renderBoard();
      };
      inp.addEventListener('blur', commit);
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') renderBoard();
      });
    });
  });

  // Add-category form toggle
  const form = document.getElementById('bt-add-form');
  document.getElementById('btn-board-add-cat')?.addEventListener('click', () => {
    form.classList.toggle('open');
    document.getElementById('bt-new-name')?.focus();
  });

  document.getElementById('bt-new-save')?.addEventListener('click', () => {
    const name  = document.getElementById('bt-new-name')?.value.trim();
    const color = document.getElementById('bt-new-color')?.value || '#818cf8';
    if (!name) return;
    store.createCategory(name, color);
    form.classList.remove('open');
    renderBoard();
  });

  document.getElementById('bt-new-cancel')?.addEventListener('click', () =>
    form.classList.remove('open'));

  document.getElementById('bt-new-name')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('bt-new-save')?.click();
  });
}

// ── Cards ─────────────────────────────────────────────

function renderCards() {
  const canvas     = document.getElementById('board-canvas');
  const cats       = store.getCategories();
  const characters = store.getAll('character')
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  autoLayout(characters, canvas);

  const visible = _catFilter
    ? characters.filter(c => c.categoryId === _catFilter)
    : characters;

  canvas.innerHTML = visible.map(c => buildCard(c, cats)).join('');

  // Expand canvas height to fit all cards
  const maxY = Math.max(...characters.map(c => (c.boardPos?.y || 0) + CARD_H + CARD_GAP), 400);
  canvas.style.minHeight = maxY + 'px';

  canvas.querySelectorAll('.board-card').forEach(el => {
    el.addEventListener('mousedown', e => onMouseDown(e, el.dataset.id));
    el.addEventListener('dblclick',  e => { e.stopPropagation(); openModal(el.dataset.id); });
  });

  // Category assign button on each card
  canvas.querySelectorAll('.bc-cat-btn').forEach(btn =>
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openCatMenu(btn, btn.dataset.id);
    }));
}

function buildCard(entity, cats) {
  const cat  = cats.find(c => c.id === entity.categoryId);
  const pos  = entity.boardPos || { x: 0, y: 0 };
  const status = entity.status || '';
  const statusColor = { Active: '#34d399', Deceased: '#ef4444',
                         Missing: '#f59e0b', Unknown: '#6b7280' }[status] || 'var(--text-muted)';
  const desc = entity.description
    ? esc(entity.description.slice(0, 75)) + (entity.description.length > 75 ? '…' : '')
    : '';

  const avatar = generateAvatar(entity);

  return `<div class="board-card" data-id="${entity.id}"
               style="left:${pos.x}px;top:${pos.y}px;--cc:${cat?.color || 'var(--panel-border)'}">
    <div class="bc-top-bar"></div>
    <div class="bc-body">
      <div class="bc-text">
        <div class="bc-name">${esc(entity.name) || '<unnamed>'}</div>
        ${entity.role ? `<div class="bc-role">${esc(entity.role)}</div>` : ''}
        ${status      ? `<div class="bc-status" style="color:${statusColor}">&#9679; ${esc(status)}</div>` : ''}
        ${desc        ? `<div class="bc-desc">${desc}</div>` : ''}
      </div>
      <div class="bc-avatar">${avatar}</div>
    </div>
    <div class="bc-footer">
      <button class="bc-cat-btn" data-id="${entity.id}"
              style="color:${cat?.color || 'var(--text-muted)'}">
        ${cat ? esc(cat.name) : '+ category'}
      </button>
    </div>
  </div>`;
}

function autoLayout(characters, canvas) {
  const cols     = Math.max(1, Math.floor(((canvas?.clientWidth || 900) - CARD_GAP) / (CARD_W + CARD_GAP)));
  const cats     = store.getCategories();
  let   colIndex = 0, rowIndex = 0;

  // Group by category for cleaner auto-layout
  const catOrder = [null, ...cats.map(c => c.id)];
  const sorted   = [...characters].sort((a, b) => {
    const ai = catOrder.indexOf(a.categoryId ?? null);
    const bi = catOrder.indexOf(b.categoryId ?? null);
    return ai - bi;
  });

  let lastCatId = undefined;
  sorted.forEach(e => {
    if (e.boardPos) return; // already positioned
    if (e.categoryId !== lastCatId) {
      if (colIndex > 0) { rowIndex++; colIndex = 0; }
      lastCatId = e.categoryId;
    }
    store.updateBoardPosInMemory(e.id,
      CARD_GAP + colIndex * (CARD_W + CARD_GAP),
      CARD_GAP + rowIndex * (CARD_H + CARD_GAP));
    colIndex++;
    if (colIndex >= cols) { colIndex = 0; rowIndex++; }
  });
}

// ── Drag ──────────────────────────────────────────────

function onMouseDown(e, entityId) {
  if (e.target.closest('button')) return;
  e.preventDefault();
  const el  = e.currentTarget;
  const ent = store.get(entityId);
  if (!ent) return;
  _drag = {
    id:   entityId,
    el,
    offX: e.clientX - (ent.boardPos?.x || 0),
    offY: e.clientY - (ent.boardPos?.y || 0),
  };
  el.classList.add('dragging');
}

function onMouseMove(e) {
  if (!_drag) return;
  const x = Math.max(0, e.clientX - _drag.offX);
  const y = Math.max(0, e.clientY - _drag.offY);
  _drag.el.style.left = x + 'px';
  _drag.el.style.top  = y + 'px';
  store.updateBoardPosInMemory(_drag.id, x, y);
}

function onMouseUp() {
  if (!_drag) return;
  _drag.el.classList.remove('dragging');
  store.commitBoardPositions();
  _drag = null;
}

// ── Category context menu ─────────────────────────────

function openCatMenu(anchor, entityId) {
  document.querySelector('.bc-cat-menu')?.remove();

  const cats  = store.getCategories();
  const menu  = document.createElement('div');
  menu.className = 'bc-cat-menu';
  menu.innerHTML = `
    <button class="bc-cat-opt" data-assign="">None</button>
    ${cats.map(c => `
      <button class="bc-cat-opt" data-assign="${c.id}"
              style="--cc:${c.color}">
        <span class="bc-cat-dot"></span>${esc(c.name)}
      </button>`).join('')}`;

  menu.querySelectorAll('[data-assign]').forEach(btn =>
    btn.addEventListener('click', () => {
      const cid = btn.dataset.assign || undefined;
      store.update(entityId, { categoryId: cid });
      menu.remove();
      renderBoard();
    }));

  anchor.after(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

// ── Modal ─────────────────────────────────────────────

function openModal(entityId) {
  const entity  = store.get(entityId);
  if (!entity)  return;

  const def        = TYPES[entity.type];
  const typeFields = TYPE_FIELDS[entity.type] || [];
  const cats       = store.getCategories();
  const cat        = cats.find(c => c.id === entity.categoryId);
  const incoming   = store.incomingLinks(entityId);

  const specificHtml = typeFields
    .filter(f => entity[f.key])
    .map(f => `<div class="bm-field"><span>${esc(f.label)}</span>${esc(entity[f.key])}</div>`)
    .join('');

  const outLinks = entity.links.map(link => {
    const t  = store.get(link.targetId);
    if (!t)  return '';
    const td = TYPES[t.type];
    return `<div class="bm-link"><span style="color:${td.color}">${td.icon}</span>
      <em>${esc(link.label) || '—'}</em> ${esc(t.name)}</div>`;
  }).filter(Boolean).join('');

  const inLinks = incoming.map(({ source, label }) => {
    const sd = TYPES[source.type];
    return `<div class="bm-link"><span style="color:${sd.color}">${sd.icon}</span>
      ← <em>${esc(label) || '—'}</em> ${esc(source.name)}</div>`;
  }).join('');

  document.getElementById('board-modal-body').innerHTML = `
    <div class="bm-header">
      <div class="bm-badge" style="color:${def.color}">${def.icon}&nbsp;${def.label.slice(0,-1).toUpperCase()}</div>
      ${cat ? `<div class="bm-cat" style="--cc:${cat.color}">${esc(cat.name)}</div>` : ''}
      <div class="bm-title">${esc(entity.name) || '<unnamed>'}</div>
      <button class="bm-edit-btn" data-id="${entityId}">Edit in list view</button>
    </div>
    ${entity.tags.length ? `<div class="bm-tags">${entity.tags.map(t=>`<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
    ${specificHtml ? `<div class="bm-fields">${specificHtml}</div>` : ''}
    ${entity.description ? `<div class="bm-desc">${esc(entity.description)}</div>` : ''}
    ${outLinks || inLinks ? `<div class="bm-links-title">Relations</div>
      ${outLinks}${inLinks}` : ''}
    <div class="bm-meta">Updated ${fmt(entity.updatedAt)}</div>`;

  document.querySelector('.bm-edit-btn')?.addEventListener('click', () => {
    closeModal();
    _onNavigate?.(entityId);
  });

  document.getElementById('board-modal').classList.add('open');
}

function closeModal() {
  document.getElementById('board-modal')?.classList.remove('open');
}

// ── Avatar SVG generator ──────────────────────────────

const SKIN_TONES = {
  'very fair': '#FDE8D8', 'fair': '#F5D0B0', 'light': '#EEBC90',
  'medium':    '#D4956A', 'olive': '#C07840', 'brown': '#8B5030',
  'dark':      '#5C2E15', 'very dark': '#3A1A0A',
};
const HAIR_COLORS = {
  'black': '#111111', 'dark brown': '#2C1810', 'brown': '#5C3318',
  'light brown': '#8B5E3C', 'blonde': '#C8A84B', 'auburn': '#7A2E1E',
  'red': '#B83020', 'gray': '#888888', 'white': '#E8E8E8',
};
const EYE_COLORS = {
  'dark brown': '#3A1A08', 'brown': '#7A4020', 'hazel': '#8B6820',
  'amber': '#C87820', 'green': '#3A7848', 'blue': '#3870B8',
  'light blue': '#68A8D8', 'gray': '#708090',
};

function darken(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const c = v => Math.max(0, v - amt).toString(16).padStart(2, '0');
  return '#' + c(n >> 16) + c((n >> 8) & 0xff) + c(n & 0xff);
}

export function generateAvatar(entity) {
  const hasData = entity.skinTone || entity.hairColor || entity.eyeColor || entity.gender;
  if (!hasData) return silhouetteAvatar();

  const skin   = SKIN_TONES[(entity.skinTone  || '').toLowerCase()] || '#D4956A';
  const hair   = HAIR_COLORS[(entity.hairColor|| '').toLowerCase()] || '#3C2010';
  const eye    = EYE_COLORS[(entity.eyeColor  || '').toLowerCase()] || '#7A4020';
  const style  = (entity.hairStyle || 'short').toLowerCase();
  const gender = (entity.gender    || '').toLowerCase();

  // Face shape varies slightly by gender
  const isFemale = gender === 'female';
  const isMale   = gender === 'male';
  const W = 44, H = 54;
  const cx = 22, cy = 30;
  const frx = isMale ? 10 : 11;
  const fry = isMale ? 12 : 13;
  const skinDark = darken(skin, 28);

  // Hair
  let hairSVG = '';
  if (style !== 'bald') {
    // Top cap — always present for non-bald
    const capRx = frx + (isFemale ? 2 : 1);
    const capTop = cy - fry - (style === 'cropped' ? 4 : 7);
    hairSVG += `<ellipse cx="${cx}" cy="${cy - fry}" rx="${capRx}" ry="${style === 'cropped' ? 4 : 7}" fill="${hair}"/>
    <rect x="${cx - capRx}" y="${capTop}" width="${capRx * 2}" height="${cy - fry - capTop + 1}" fill="${hair}"/>`;

    // Side/back hair for longer styles
    if (style === 'medium') {
      hairSVG += `
      <rect x="${cx - capRx - 1}" y="${cy - fry}" width="5" height="20" rx="2.5" fill="${hair}"/>
      <rect x="${cx + capRx - 4}" y="${cy - fry}" width="5" height="20" rx="2.5" fill="${hair}"/>`;
    } else if (style === 'long') {
      hairSVG += `
      <rect x="${cx - capRx - 1}" y="${cy - fry}" width="5" height="30" rx="2.5" fill="${hair}"/>
      <rect x="${cx + capRx - 4}" y="${cy - fry}" width="5" height="30" rx="2.5" fill="${hair}"/>`;
    } else if (style === 'very long') {
      hairSVG += `
      <rect x="${cx - capRx - 1}" y="${cy - fry}" width="6" height="44" rx="3" fill="${hair}"/>
      <rect x="${cx + capRx - 5}" y="${cy - fry}" width="6" height="44" rx="3" fill="${hair}"/>`;
    }
  }

  // Eyebrows
  const browY = cy - 4;
  const browThick = isFemale ? 0.9 : 1.3;
  const browHtml = isMale
    ? `<path d="M${cx-6} ${browY} Q${cx-3} ${browY-1.5} ${cx} ${browY}" stroke="${skinDark}" stroke-width="${browThick}" fill="none" stroke-linecap="round"/>
       <path d="M${cx} ${browY} Q${cx+3} ${browY-1.5} ${cx+6} ${browY}" stroke="${skinDark}" stroke-width="${browThick}" fill="none" stroke-linecap="round"/>`
    : `<path d="M${cx-6} ${browY-1} Q${cx-3} ${browY-3} ${cx} ${browY-1.5}" stroke="${skinDark}" stroke-width="${browThick}" fill="none" stroke-linecap="round"/>
       <path d="M${cx} ${browY-1.5} Q${cx+3} ${browY-3} ${cx+6} ${browY-1}" stroke="${skinDark}" stroke-width="${browThick}" fill="none" stroke-linecap="round"/>`;

  const eyeY = cy + 0;
  const eSpread = isMale ? 3.8 : 4;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#F2EDE8" rx="4"/>
  ${hairSVG}
  <rect x="${cx - 4}" y="${cy + fry - 2}" width="8" height="9" rx="2" fill="${skin}"/>
  <ellipse cx="${cx}" cy="${cy}" rx="${frx}" ry="${fry}" fill="${skin}"/>
  ${browHtml}
  <ellipse cx="${cx - eSpread}" cy="${eyeY}" rx="2.8" ry="${isFemale ? 2.2 : 2}" fill="white"/>
  <ellipse cx="${cx + eSpread}" cy="${eyeY}" rx="2.8" ry="${isFemale ? 2.2 : 2}" fill="white"/>
  <circle cx="${cx - eSpread}" cy="${eyeY}" r="1.6" fill="${eye}"/>
  <circle cx="${cx + eSpread}" cy="${eyeY}" r="1.6" fill="${eye}"/>
  <circle cx="${cx - eSpread + 0.7}" cy="${eyeY - 0.6}" r="0.55" fill="white" opacity="0.85"/>
  <circle cx="${cx + eSpread + 0.7}" cy="${eyeY - 0.6}" r="0.55" fill="white" opacity="0.85"/>
  <path d="M${cx-2.5} ${eyeY+5} Q${cx} ${eyeY + (isFemale ? 8 : 7)} ${cx+2.5} ${eyeY+5}"
        fill="none" stroke="${skinDark}" stroke-width="1.1" stroke-linecap="round"/>
</svg>`;
}

function silhouetteAvatar() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 54" width="44" height="54">
  <rect width="44" height="54" fill="#F0F0F0" rx="4"/>
  <ellipse cx="22" cy="22" rx="12" ry="10" fill="#BBBBBB" opacity="0.6"/>
  <ellipse cx="22" cy="32" rx="11" ry="13" fill="#CCCCCC" opacity="0.5"/>
  <rect x="14" y="44" width="16" height="10" rx="3" fill="#CCCCCC" opacity="0.4"/>
</svg>`;
}

// ── Utilities ─────────────────────────────────────────

function esc(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmt(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
}

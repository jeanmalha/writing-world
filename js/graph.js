import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from 'd3';
import { drag }   from 'd3';
import { zoom }   from 'd3';
import { select } from 'd3';
import { store, TYPES } from './store.js';

// ── Persistent state across re-renders ────────────────────────────────────────
let _typeVis = {};   // type  → bool  (entity type visible)
let _relVis  = {};   // label → bool  (relationship label visible)
let _pinned  = {};   // entityId → {x, y}  (manually positioned nodes)
let _sim     = null;

// ── Public entry ───────────────────────────────────────────────────────────────
export function renderGraphView(listHeader, entityList, detailContent) {
  // Init type visibility (on by default for unseen types)
  Object.keys(TYPES).forEach(t => { if (_typeVis[t] === undefined) _typeVis[t] = true; });

  // Collect all relationship labels in use
  const labels = _allLabels();
  labels.forEach(l => { if (_relVis[l]  === undefined) _relVis[l]  = true; });

  _renderPanel(listHeader, entityList, detailContent);
  _renderGraph(detailContent);
}

// ── Left panel: filter toggles ─────────────────────────────────────────────────
function _renderPanel(listHeader, entityList, detailContent) {
  const counts = store.countByType();
  const labels = _allLabels();

  listHeader.innerHTML = `<div class="list-header-row">
    <span class="list-title">Graph</span>
    <button class="btn-new" id="btn-graph-reset" title="Release all pinned nodes">↺ Reset</button>
  </div>`;

  document.getElementById('btn-graph-reset')?.addEventListener('click', () => {
    _pinned = {};
    _renderGraph(detailContent);
  });

  entityList.innerHTML = `
    <div class="graph-section">
      <div class="graph-section-title">Entity types</div>
      ${Object.entries(TYPES).map(([type, def]) => `
        <label class="graph-toggle">
          <input type="checkbox" class="gtcb" data-t="${type}" ${_typeVis[type] !== false ? 'checked' : ''}>
          <span style="color:${def.color}">${def.icon}</span>
          <span class="graph-toggle-name">${def.label}</span>
          <span class="graph-toggle-count">${counts[type] || 0}</span>
        </label>`).join('')}
    </div>
    ${labels.length ? `
    <div class="graph-section">
      <div class="graph-section-title">Relationships</div>
      ${labels.map(l => `
        <label class="graph-toggle">
          <input type="checkbox" class="grcb" data-l="${_esc(l)}" ${_relVis[l] !== false ? 'checked' : ''}>
          <span class="graph-toggle-name">${_esc(l)}</span>
        </label>`).join('')}
    </div>` : ''}`;

  entityList.querySelectorAll('.gtcb').forEach(cb =>
    cb.addEventListener('change', e => { _typeVis[e.target.dataset.t] = e.target.checked; _applyVisibility(); }));
  entityList.querySelectorAll('.grcb').forEach(cb =>
    cb.addEventListener('change', e => { _relVis[e.target.dataset.l]  = e.target.checked; _applyVisibility(); }));
}

// ── Graph render ───────────────────────────────────────────────────────────────
function _renderGraph(container) {
  if (_sim) { _sim.stop(); _sim = null; }
  container.innerHTML = '';

  const entities = store.getAll();
  if (!entities.length) {
    container.innerHTML = `<div class="empty-state" style="padding:40px">No entities yet.</div>`;
    return;
  }

  const W = container.clientWidth  || 900;
  const H = container.clientHeight || 600;

  // Build node objects (carry over pinned positions as fx/fy)
  const nodes = entities.map(e => ({
    id: e.id, type: e.type, name: e.name || '',
    ...(_pinned[e.id] ? { fx: _pinned[e.id].x, fy: _pinned[e.id].y } : {}),
  }));
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));

  // Build edges from all entity links
  const edges = [];
  entities.forEach(e => (e.links || []).forEach(l => {
    if (byId[l.targetId]) edges.push({ source: e.id, target: l.targetId, label: l.label || '' });
  }));

  // Node radius scales with degree (number of connections)
  const deg = {};
  edges.forEach(({ source: s, target: t }) => {
    deg[s] = (deg[s] || 0) + 1;
    deg[t] = (deg[t] || 0) + 1;
  });
  const nr = d => Math.max(10, Math.min(24, 10 + (deg[d.id] || 0) * 0.7));

  // SVG
  const svg = select(container).append('svg')
    .attr('width', '100%').attr('height', '100%');

  // Arrow marker
  svg.append('defs').append('marker')
    .attr('id', 'garrow').attr('viewBox', '0 -5 10 10')
    .attr('refX', 26).attr('refY', 0)
    .attr('markerWidth', 5).attr('markerHeight', 5).attr('orient', 'auto')
    .append('path').attr('d', 'M0,-5L10,0L0,5').attr('fill', '#4b5563');

  const g = svg.append('g');

  // Pan/zoom
  svg.call(zoom().scaleExtent([0.1, 4])
    .on('zoom', e => g.attr('transform', e.transform)));

  // Force simulation
  const sim = forceSimulation(nodes)
    .force('link',    forceLink(edges).id(d => d.id).distance(100).strength(0.4))
    .force('charge',  forceManyBody().strength(-280))
    .force('center',  forceCenter(W / 2, H / 2))
    .force('collide', forceCollide().radius(d => nr(d) + 10));
  _sim = sim;

  // Edges
  const edgeSel = g.append('g').selectAll('line').data(edges).join('line')
    .attr('class', 'gedge')
    .attr('stroke', 'var(--panel-border)').attr('stroke-width', 1.2)
    .attr('marker-end', 'url(#garrow)')
    .attr('display', d => _edgeVisible(d) ? null : 'none');

  const edgeLabel = g.append('g').selectAll('text').data(edges).join('text')
    .attr('class', 'gedge-label').attr('text-anchor', 'middle')
    .attr('font-size', '8px').attr('fill', 'var(--text-muted)')
    .attr('pointer-events', 'none')
    .attr('display', d => _edgeVisible(d) ? null : 'none')
    .text(d => d.label);

  // Nodes
  const nodeSel = g.append('g').selectAll('g').data(nodes).join('g')
    .attr('class', 'gnode').attr('cursor', 'grab')
    .attr('display', d => _typeVis[d.type] !== false ? null : 'none')
    .call(drag()
      .on('start', (evt, d) => {
        if (!evt.active) sim.alphaTarget(0.2).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on('drag',  (evt, d) => { d.fx = evt.x; d.fy = evt.y; })
      .on('end',   (evt, d) => {
        if (!evt.active) sim.alphaTarget(0);
        _pinned[d.id] = { x: d.fx, y: d.fy }; // keep pinned where dropped
      }));

  // Node circle (fill: type color at low opacity, stroke: full color)
  nodeSel.append('circle')
    .attr('r', nr)
    .attr('fill',         d => (TYPES[d.type]?.color || '#6b7280') + '20')
    .attr('stroke',       d => TYPES[d.type]?.color || '#6b7280')
    .attr('stroke-width', 2);

  // Type icon centered in circle
  nodeSel.append('text')
    .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
    .attr('font-size', d => Math.max(10, nr(d) * 0.85) + 'px')
    .attr('fill', d => TYPES[d.type]?.color || '#6b7280')
    .attr('pointer-events', 'none')
    .text(d => TYPES[d.type]?.icon || '◆');

  // Name label below circle
  nodeSel.append('text')
    .attr('text-anchor', 'middle').attr('dy', d => nr(d) + 11)
    .attr('font-size', '9px').attr('font-family', 'Courier New, monospace')
    .attr('fill', 'var(--text)').attr('pointer-events', 'none')
    .text(d => d.name.length > 20 ? d.name.slice(0, 18) + '…' : d.name);

  // Double-click to unpin a node (release back to physics)
  nodeSel.on('dblclick', (evt, d) => {
    d.fx = null; d.fy = null;
    delete _pinned[d.id];
    sim.alphaTarget(0.1).restart();
    setTimeout(() => sim.alphaTarget(0), 800);
  });

  // Tick: update positions
  sim.on('tick', () => {
    edgeSel
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    edgeLabel
      .attr('x', d => (d.source.x + d.target.x) / 2)
      .attr('y', d => (d.source.y + d.target.y) / 2);
    nodeSel.attr('transform', d => `translate(${d.x ?? 0},${d.y ?? 0})`);
  });
}

// ── Visibility helpers ────────────────────────────────────────────────────────

function _edgeVisible(d) {
  const srcType = typeof d.source === 'object' ? d.source.type : null;
  const tgtType = typeof d.target === 'object' ? d.target.type : null;
  if (srcType && _typeVis[srcType] === false) return false;
  if (tgtType && _typeVis[tgtType] === false) return false;
  if (d.label && _relVis[d.label] === false)  return false;
  return true;
}

function _applyVisibility() {
  select(null).selectAll('.gnode').attr('display', d => _typeVis[d?.type] !== false ? null : 'none');
  select(document).selectAll('.gnode').attr('display', d => _typeVis[d?.type] !== false ? null : 'none');
  select(document).selectAll('.gedge,.gedge-label').attr('display', d => _edgeVisible(d) ? null : 'none');
}

function _allLabels() {
  const s = new Set();
  store.getAll().forEach(e => (e.links || []).forEach(l => { if (l.label) s.add(l.label); }));
  return [...s].sort();
}

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const LS_KEY   = 'writingworld_v1';
const SNAP_KEY = 'writingworld_snapshots';

function loadSnaps() {
  try { return JSON.parse(localStorage.getItem(SNAP_KEY) || '[]'); }
  catch { return []; }
}

export const TYPES = {
  character: { label: 'Characters', icon: '◉', color: '#818cf8' },
  location:  { label: 'Locations',  icon: '◈', color: '#34d399' },
  faction:   { label: 'Factions',   icon: '⬡', color: '#fb923c' },
  species:   { label: 'Species',    icon: '◬', color: '#f472b6' },
  event:     { label: 'Events',     icon: '◷', color: '#facc15' },
  artifact:  { label: 'Artifacts',  icon: '◆', color: '#60a5fa' },
  lore:      { label: 'Lore',       icon: '▣', color: '#a78bfa' },
};

export const TYPE_FIELDS = {
  character: [
    { key: 'role',      label: 'Role',       type: 'text',   placeholder: 'e.g. Pilot, Engineer, Captain' },
    { key: 'status',    label: 'Status',     type: 'select', options: ['Active', 'Deceased', 'Unknown', 'Missing'] },
    { key: 'gender',    label: 'Gender',     type: 'select', options: ['Female', 'Male', 'Non-binary'] },
    { key: 'skinTone',  label: 'Skin tone',  type: 'select', options: ['Very fair', 'Fair', 'Light', 'Medium', 'Olive', 'Brown', 'Dark', 'Very dark'] },
    { key: 'hairStyle', label: 'Hair style', type: 'select', options: ['Bald', 'Cropped', 'Short', 'Medium', 'Long', 'Very long'] },
    { key: 'hairColor', label: 'Hair color', type: 'select', options: ['Black', 'Dark brown', 'Brown', 'Light brown', 'Blonde', 'Auburn', 'Red', 'Gray', 'White'] },
    { key: 'eyeColor',  label: 'Eye color',  type: 'select', options: ['Dark brown', 'Brown', 'Hazel', 'Amber', 'Green', 'Blue', 'Light blue', 'Gray'] },
  ],
  location: [
    { key: 'locType', label: 'Type',        type: 'text', placeholder: 'e.g. Planet, Station, Ship, City' },
    { key: 'system',  label: 'Star System', type: 'text', placeholder: 'e.g. Alpha Centauri' },
  ],
  faction: [
    { key: 'factionType', label: 'Type',         type: 'text', placeholder: 'e.g. Government, Corporation, Cult' },
    { key: 'hq',          label: 'Headquarters', type: 'text', placeholder: '' },
  ],
  species: [
    { key: 'homeworld', label: 'Homeworld',  type: 'text', placeholder: '' },
    { key: 'traits',    label: 'Key Traits', type: 'text', placeholder: 'e.g. Telepathic, Silicon-based' },
  ],
  event: [
    { key: 'date',       label: 'Date',       type: 'text',   placeholder: 'e.g. Year 2347, Day 145' },
    { key: 'importance', label: 'Importance', type: 'select', options: ['Critical', 'Major', 'Minor', 'Background'] },
  ],
  artifact: [
    { key: 'artifactType', label: 'Type',   type: 'text', placeholder: 'e.g. Weapon, Device, Ship, Document' },
    { key: 'origin',       label: 'Origin', type: 'text', placeholder: 'e.g. Species, Manufacturer, Era' },
  ],
  lore: [
    { key: 'category', label: 'Category', type: 'text', placeholder: 'e.g. Physics, History, Culture, Technology' },
  ],
};

function load() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{"version":1,"entities":{}}'); }
  catch { return { version: 1, entities: {} }; }
}

const _persistCallbacks = [];

function persist(data) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(data));
    _persistCallbacks.forEach(fn => fn());
    return true;
  } catch (e) { console.error('Save failed', e); return false; }
}

let _data = load();

export const store = {

  // ── CRUD ────────────────────────────────────────────

  getAll(type) {
    const all = Object.values(_data.entities);
    return type ? all.filter(e => e.type === type) : all;
  },

  get(id) {
    return _data.entities[id] ?? null;
  },

  create(type) {
    const id   = crypto.randomUUID();
    const now  = new Date().toISOString();
    const entity = { id, type, name: '', description: '', tags: [], links: [], timelineNotes: [], createdAt: now, updatedAt: now };
    _data.entities[id] = entity;
    persist(_data);
    return entity;
  },

  update(id, fields) {
    const e = _data.entities[id];
    if (!e) return null;
    Object.assign(e, fields, { updatedAt: new Date().toISOString() });
    persist(_data);
    return e;
  },

  delete(id) {
    for (const e of Object.values(_data.entities))
      e.links = e.links.filter(l => l.targetId !== id);
    delete _data.entities[id];
    persist(_data);
  },

  // ── Links ───────────────────────────────────────────

  addLink(entityId, targetId, label) {
    const e = _data.entities[entityId];
    if (!e) return;
    e.links.push({ targetId, label: label || '' });
    e.updatedAt = new Date().toISOString();
    persist(_data);
  },

  removeLink(entityId, index) {
    const e = _data.entities[entityId];
    if (!e) return;
    e.links.splice(index, 1);
    e.updatedAt = new Date().toISOString();
    persist(_data);
  },

  updateLinkLabel(entityId, index, label) {
    const e = _data.entities[entityId];
    if (!e || !e.links[index]) return;
    e.links[index].label = label;
    e.updatedAt = new Date().toISOString();
    persist(_data);
  },

  incomingLinks(id) {
    const result = [];
    for (const e of Object.values(_data.entities))
      for (const link of e.links)
        if (link.targetId === id) result.push({ source: e, label: link.label });
    return result;
  },

  // ── Timeline Notes ──────────────────────────────────

  addTimelineNote(entityId, date, text) {
    const e = _data.entities[entityId];
    if (!e) return null;
    if (!e.timelineNotes) e.timelineNotes = [];
    const note = { id: crypto.randomUUID(), date, text };
    e.timelineNotes.push(note);
    e.timelineNotes.sort((a, b) => a.date.localeCompare(b.date));
    e.updatedAt = new Date().toISOString();
    persist(_data);
    return note;
  },

  updateTimelineNote(entityId, noteId, date, text) {
    const e = _data.entities[entityId];
    if (!e || !e.timelineNotes) return;
    const note = e.timelineNotes.find(n => n.id === noteId);
    if (!note) return;
    note.date = date;
    note.text = text;
    e.timelineNotes.sort((a, b) => a.date.localeCompare(b.date));
    e.updatedAt = new Date().toISOString();
    persist(_data);
  },

  deleteTimelineNote(entityId, noteId) {
    const e = _data.entities[entityId];
    if (!e || !e.timelineNotes) return;
    e.timelineNotes = e.timelineNotes.filter(n => n.id !== noteId);
    e.updatedAt = new Date().toISOString();
    persist(_data);
  },

  worldStateAt(date) {
    if (!date) return [];
    const result = [];
    for (const e of Object.values(_data.entities)) {
      const notes = (e.timelineNotes || [])
        .filter(n => n.date && n.date.localeCompare(date) <= 0)
        .sort((a, b) => b.date.localeCompare(a.date));
      if (notes.length) result.push({ entity: e, note: notes[0] });
    }
    result.sort((a, b) =>
      a.entity.type.localeCompare(b.entity.type) || a.entity.name.localeCompare(b.entity.name));
    return result;
  },

  // ── Queries ─────────────────────────────────────────

  search(query) {
    const q = query.toLowerCase().trim();
    if (!q) return [];
    return Object.values(_data.entities).filter(e =>
      e.name.toLowerCase().includes(q) ||
      (e.description || '').toLowerCase().includes(q) ||
      (e.tags || []).some(t => t.toLowerCase().includes(q))
    );
  },

  timeline() {
    return Object.values(_data.entities)
      .filter(e => e.type === 'event')
      .sort((a, b) => {
        const da = (a.date || '').trim();
        const db = (b.date || '').trim();
        return da !== db ? da.localeCompare(db) : a.name.localeCompare(b.name);
      });
  },

  countByType() {
    const counts = Object.fromEntries(Object.keys(TYPES).map(t => [t, 0]));
    for (const e of Object.values(_data.entities))
      if (counts[e.type] !== undefined) counts[e.type]++;
    return counts;
  },

  totalCount() { return Object.keys(_data.entities).length; },

  // ── Snapshots ────────────────────────────────────────

  saveSnapshot(name) {
    const snaps = loadSnaps();
    snaps.unshift({ id: crypto.randomUUID(), name, savedAt: new Date().toISOString(), data: JSON.parse(JSON.stringify(_data)) });
    if (snaps.length > 20) snaps.splice(20);
    try { localStorage.setItem(SNAP_KEY, JSON.stringify(snaps)); return true; }
    catch (e) { console.error('Snapshot save failed', e); return false; }
  },

  listSnapshots() { return loadSnaps(); },

  loadSnapshot(id) {
    const snap = loadSnaps().find(s => s.id === id);
    if (!snap) return false;
    _data = JSON.parse(JSON.stringify(snap.data));
    persist(_data);
    return true;
  },

  deleteSnapshot(id) {
    const snaps = loadSnaps().filter(s => s.id !== id);
    localStorage.setItem(SNAP_KEY, JSON.stringify(snaps));
  },

  // ── Import / Export ─────────────────────────────────

  exportJSON() {
    const blob = new Blob([JSON.stringify(_data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `writing-world-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  },

  importJSON(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          const data = JSON.parse(ev.target.result);
          if (data.version !== 1 || !data.entities) throw new Error('Unrecognised format');
          _data = data;
          persist(_data);
          resolve();
        } catch (err) { reject(err); }
      };
      reader.readAsText(file);
    });
  },

  // ── Character categories ─────────────────────────────

  getCategories() { return _data.characterCategories || []; },

  createCategory(name, color) {
    if (!_data.characterCategories) _data.characterCategories = [];
    const cat = { id: crypto.randomUUID(), name, color };
    _data.characterCategories.push(cat);
    persist(_data);
    return cat;
  },

  updateCategory(id, fields) {
    const cat = (_data.characterCategories || []).find(c => c.id === id);
    if (!cat) return;
    Object.assign(cat, fields);
    persist(_data);
  },

  deleteCategory(id) {
    _data.characterCategories = (_data.characterCategories || []).filter(c => c.id !== id);
    for (const e of Object.values(_data.entities))
      if (e.categoryId === id) delete e.categoryId;
    persist(_data);
  },

  // ── Board positions ───────────────────────────────────

  updateBoardPosInMemory(entityId, x, y) {
    const e = _data.entities[entityId];
    if (!e) return;
    if (!e.boardPos) e.boardPos = {};
    e.boardPos.x = Math.round(x);
    e.boardPos.y = Math.round(y);
  },

  commitBoardPositions() { persist(_data); },

  // ── Cloud sync ───────────────────────────────────────

  onPersist(fn) { _persistCallbacks.push(fn); },

  exportData() { return JSON.parse(JSON.stringify(_data)); },

  loadData(data) {
    if (data.version !== 1 || !data.entities) throw new Error('Unrecognised format');
    _data = data;
    localStorage.setItem(LS_KEY, JSON.stringify(_data));
    // Don't fire callbacks — this is an incoming sync, not a local mutation
  },

  dataUpdatedAt() {
    const entities = Object.values(_data.entities);
    if (!entities.length) return null;
    return entities.reduce((latest, e) =>
      (e.updatedAt || '') > latest ? (e.updatedAt || '') : latest, '');
  },
};

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

// ── Data model helpers ────────────────────────────────────────────────────────

// Natural (numeric-aware) string compare — handles "Year 2400, Day 3" correctly.
function _naturalCmp(a, b) {
  const re = /(\d+)|(\D+)/g;
  const ta  = String(a).match(re) || [];
  const tb  = String(b).match(re) || [];
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    if (i >= ta.length) return -1;
    if (i >= tb.length) return  1;
    const na = parseInt(ta[i], 10), nb = parseInt(tb[i], 10);
    if (!isNaN(na) && !isNaN(nb)) { if (na !== nb) return na - nb; }
    else { const c = ta[i].localeCompare(tb[i]); if (c !== 0) return c; }
  }
  return 0;
}

function _emptyProject() {
  return {
    metadata:            {},
    entities:            {},
    structure:           [],
    config:              { enabledTypes: ['character', 'location', 'event', 'artifact'] },
    characterCategories: [],
  };
}

function _defaultData() {
  const id = crypto.randomUUID();
  return { version: 2, activeProjectId: id, projects: { [id]: _emptyProject() } };
}

function _migrateV1(old) {
  const id = crypto.randomUUID();
  return {
    version: 2,
    activeProjectId: id,
    projects: {
      [id]: {
        metadata:            old.project || {},
        entities:            old.entities || {},
        structure:           old.structure || [],
        config:              old.config || { enabledTypes: ['character', 'location', 'event', 'artifact'] },
        characterCategories: old.characterCategories || [],
      },
    },
  };
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (!raw) return _defaultData();
    if (raw.version === 1) return _migrateV1(raw);
    if (raw.version === 2) return raw;
    return _defaultData();
  } catch { return _defaultData(); }
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

// Active project accessor — always returns the current project's sub-object
function _proj() {
  return _data.projects[_data.activeProjectId];
}

export const store = {

  // ── Projects ─────────────────────────────────────────

  listProjects() {
    return Object.entries(_data.projects).map(([id, proj]) => ({
      id,
      active:      id === _data.activeProjectId,
      entityCount: Object.keys(proj.entities || {}).length,
      ...(proj.metadata || {}),
    }));
  },

  getActiveProjectId() { return _data.activeProjectId; },

  createProject(name = 'New Project') {
    const id = crypto.randomUUID();
    _data.projects[id] = _emptyProject();
    if (name) _data.projects[id].metadata.title = name;
    _data.activeProjectId = id;
    persist(_data);
    return id;
  },

  switchProject(id) {
    if (!_data.projects[id]) return false;
    _data.activeProjectId = id;
    persist(_data);
    return true;
  },

  deleteProject(id) {
    if (Object.keys(_data.projects).length <= 1) return false;
    delete _data.projects[id];
    if (_data.activeProjectId === id)
      _data.activeProjectId = Object.keys(_data.projects)[0];
    persist(_data);
    return true;
  },

  // ── CRUD ─────────────────────────────────────────────

  getAll(type) {
    const all = Object.values(_proj().entities);
    return type ? all.filter(e => e.type === type) : all;
  },

  get(id) { return _proj().entities[id] ?? null; },

  create(type) {
    const id    = crypto.randomUUID();
    const now   = new Date().toISOString();
    const entity = { id, type, name: '', description: '', tags: [], links: [], timelineNotes: [], createdAt: now, updatedAt: now };
    _proj().entities[id] = entity;
    persist(_data);
    return entity;
  },

  update(id, fields) {
    const e = _proj().entities[id];
    if (!e) return null;
    Object.assign(e, fields, { updatedAt: new Date().toISOString() });
    persist(_data);
    return e;
  },

  delete(id) {
    const entities = _proj().entities;
    for (const e of Object.values(entities))
      e.links = e.links.filter(l => l.targetId !== id);
    delete entities[id];
    persist(_data);
  },

  // ── Links ─────────────────────────────────────────────

  addLink(entityId, targetId, label) {
    const e = _proj().entities[entityId];
    if (!e) return;
    e.links.push({ targetId, label: label || '' });
    e.updatedAt = new Date().toISOString();
    persist(_data);
  },

  removeLink(entityId, index) {
    const e = _proj().entities[entityId];
    if (!e) return;
    e.links.splice(index, 1);
    e.updatedAt = new Date().toISOString();
    persist(_data);
  },

  updateLinkLabel(entityId, index, label) {
    const e = _proj().entities[entityId];
    if (!e || !e.links[index]) return;
    e.links[index].label = label;
    e.updatedAt = new Date().toISOString();
    persist(_data);
  },

  incomingLinks(id) {
    const result = [];
    for (const e of Object.values(_proj().entities))
      for (const link of e.links)
        if (link.targetId === id) result.push({ source: e, label: link.label });
    return result;
  },

  // ── Timeline Notes ────────────────────────────────────

  addTimelineNote(entityId, date, text) {
    const e = _proj().entities[entityId];
    if (!e) return null;
    if (!e.timelineNotes) e.timelineNotes = [];
    const note = { id: crypto.randomUUID(), date, text };
    e.timelineNotes.push(note);
    e.timelineNotes.sort((a, b) => _naturalCmp(a.date, b.date));
    e.updatedAt = new Date().toISOString();
    persist(_data);
    return note;
  },

  updateTimelineNote(entityId, noteId, date, text) {
    const e = _proj().entities[entityId];
    if (!e || !e.timelineNotes) return;
    const note = e.timelineNotes.find(n => n.id === noteId);
    if (!note) return;
    note.date = date; note.text = text;
    e.timelineNotes.sort((a, b) => _naturalCmp(a.date, b.date));
    e.updatedAt = new Date().toISOString();
    persist(_data);
  },

  deleteTimelineNote(entityId, noteId) {
    const e = _proj().entities[entityId];
    if (!e || !e.timelineNotes) return;
    e.timelineNotes = e.timelineNotes.filter(n => n.id !== noteId);
    e.updatedAt = new Date().toISOString();
    persist(_data);
  },

  worldStateAt(date) {
    if (!date) return [];
    const result = [];
    for (const e of Object.values(_proj().entities)) {
      const notes = (e.timelineNotes || [])
        .filter(n => n.date && _naturalCmp(n.date, date) <= 0)
        .sort((a, b) => _naturalCmp(b.date, a.date));
      if (notes.length) result.push({ entity: e, note: notes[0] });
    }
    result.sort((a, b) =>
      a.entity.type.localeCompare(b.entity.type) || a.entity.name.localeCompare(b.entity.name));
    return result;
  },

  // ── Queries ───────────────────────────────────────────

  search(query) {
    const q = query.toLowerCase().trim();
    if (!q) return [];
    return Object.values(_proj().entities).filter(e =>
      e.name.toLowerCase().includes(q) ||
      (e.description || '').toLowerCase().includes(q) ||
      (e.tags || []).some(t => t.toLowerCase().includes(q))
    );
  },

  timeline() {
    return Object.values(_proj().entities)
      .filter(e => e.type === 'event')
      .sort((a, b) => {
        const da = (a.date || '').trim(), db = (b.date || '').trim();
        const dc = _naturalCmp(da, db);
        return dc !== 0 ? dc : a.name.localeCompare(b.name);
      });
  },

  countByType() {
    const counts = Object.fromEntries(Object.keys(TYPES).map(t => [t, 0]));
    for (const e of Object.values(_proj().entities))
      if (counts[e.type] !== undefined) counts[e.type]++;
    return counts;
  },

  totalCount() { return Object.keys(_proj().entities).length; },

  // ── Snapshots ─────────────────────────────────────────

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
    const snapData = JSON.parse(JSON.stringify(snap.data));
    _data = snapData.version === 2 ? snapData : _migrateV1(snapData);
    persist(_data);
    return true;
  },

  deleteSnapshot(id) {
    const snaps = loadSnaps().filter(s => s.id !== id);
    localStorage.setItem(SNAP_KEY, JSON.stringify(snaps));
  },

  // ── Import / Export ───────────────────────────────────

  exportJSON() {
    // Export active project in v1-compatible format
    const proj = _proj();
    const out = {
      version:             1,
      entities:            proj.entities,
      project:             proj.metadata,
      structure:           proj.structure,
      config:              proj.config,
      characterCategories: proj.characterCategories,
    };
    const title = (proj.metadata?.title || 'project').replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const blob  = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const url   = URL.createObjectURL(blob);
    const a     = document.createElement('a');
    a.href = url;
    a.download = `writing-world-${title}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  },

  importJSON(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          const data = JSON.parse(ev.target.result);
          if (data.version === 1) {
            // Import as a new project
            const id = crypto.randomUUID();
            _data.projects[id] = {
              metadata:            data.project || {},
              entities:            data.entities || {},
              structure:           data.structure || [],
              config:              data.config || { enabledTypes: ['character', 'location', 'event', 'artifact'] },
              characterCategories: data.characterCategories || [],
            };
            _data.activeProjectId = id;
          } else if (data.version === 2) {
            Object.assign(_data.projects, data.projects);
            _data.activeProjectId = data.activeProjectId;
          } else {
            throw new Error('Unrecognised format');
          }
          persist(_data);
          resolve();
        } catch (err) { reject(err); }
      };
      reader.readAsText(file);
    });
  },

  // ── Project metadata ──────────────────────────────────

  getProject() { return _proj().metadata || {}; },

  updateProject(fields) {
    if (!_proj().metadata) _proj().metadata = {};
    Object.assign(_proj().metadata, fields, { updatedAt: new Date().toISOString() });
    persist(_data);
  },

  // ── Acts & chapters ───────────────────────────────────

  getStructure() { return _proj().structure || []; },

  addAct(title = 'New Act') {
    if (!_proj().structure) _proj().structure = [];
    const act = { id: crypto.randomUUID(), title, description: '', chapters: [] };
    _proj().structure.push(act);
    persist(_data);
    return act;
  },

  updateAct(actId, fields) {
    const act = (_proj().structure || []).find(a => a.id === actId);
    if (!act) return;
    Object.assign(act, fields);
    persist(_data);
  },

  deleteAct(actId) {
    _proj().structure = (_proj().structure || []).filter(a => a.id !== actId);
    persist(_data);
  },

  addChapter(actId, title = 'New Chapter') {
    const act = (_proj().structure || []).find(a => a.id === actId);
    if (!act) return null;
    const ch = { id: crypto.randomUUID(), title, description: '', notes: '' };
    act.chapters.push(ch);
    persist(_data);
    return ch;
  },

  updateChapter(actId, chapterId, fields) {
    const act = (_proj().structure || []).find(a => a.id === actId);
    const ch  = act?.chapters?.find(c => c.id === chapterId);
    if (!ch) return;
    Object.assign(ch, fields);
    persist(_data);
  },

  deleteChapter(actId, chapterId) {
    const act = (_proj().structure || []).find(a => a.id === actId);
    if (!act) return;
    act.chapters = act.chapters.filter(c => c.id !== chapterId);
    persist(_data);
  },

  // ── Configuration ─────────────────────────────────────

  getConfig() {
    return _proj().config || { enabledTypes: ['character', 'location', 'event', 'artifact'] };
  },

  updateConfig(fields) {
    _proj().config = { ...(this.getConfig()), ...fields };
    persist(_data);
  },

  // ── Character categories ──────────────────────────────

  getCategories() { return _proj().characterCategories || []; },

  createCategory(name, color) {
    if (!_proj().characterCategories) _proj().characterCategories = [];
    const cat = { id: crypto.randomUUID(), name, color };
    _proj().characterCategories.push(cat);
    persist(_data);
    return cat;
  },

  updateCategory(id, fields) {
    const cat = (_proj().characterCategories || []).find(c => c.id === id);
    if (!cat) return;
    Object.assign(cat, fields);
    persist(_data);
  },

  deleteCategory(id) {
    _proj().characterCategories = (_proj().characterCategories || []).filter(c => c.id !== id);
    for (const e of Object.values(_proj().entities))
      if (e.categoryId === id) delete e.categoryId;
    persist(_data);
  },

  // ── Board positions ───────────────────────────────────

  updateBoardPosInMemory(entityId, x, y) {
    const e = _proj().entities[entityId];
    if (!e) return;
    if (!e.boardPos) e.boardPos = {};
    e.boardPos.x = Math.round(x);
    e.boardPos.y = Math.round(y);
  },

  commitBoardPositions() { persist(_data); },

  // ── Cloud sync ────────────────────────────────────────

  onPersist(fn) { _persistCallbacks.push(fn); },

  clearLocalData() {
    localStorage.removeItem(LS_KEY);
    localStorage.removeItem(SNAP_KEY);
    _data = _defaultData();
  },

  exportData() { return JSON.parse(JSON.stringify(_data)); },

  loadData(data) {
    if (!data.version) throw new Error('Unrecognised format');
    _data = data.version === 2 ? data : _migrateV1(data);
    localStorage.setItem(LS_KEY, JSON.stringify(_data));
    // Don't fire callbacks — this is an incoming sync, not a local mutation
  },

  dataUpdatedAt() {
    // Check across all projects for the most recent entity update
    let latest = '';
    for (const proj of Object.values(_data.projects || {}))
      for (const e of Object.values(proj.entities || {}))
        if ((e.updatedAt || '') > latest) latest = e.updatedAt;
    return latest || null;
  },
};

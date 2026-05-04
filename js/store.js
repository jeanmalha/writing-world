const LS_KEY = 'writingworld_v1';

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
    { key: 'role',   label: 'Role',   type: 'text',   placeholder: 'e.g. Pilot, Engineer, Captain' },
    { key: 'status', label: 'Status', type: 'select', options: ['Active', 'Deceased', 'Unknown', 'Missing'] },
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

function persist(data) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)); return true; }
  catch (e) { console.error('Save failed', e); return false; }
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
    const entity = { id, type, name: '', description: '', tags: [], links: [], createdAt: now, updatedAt: now };
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
};

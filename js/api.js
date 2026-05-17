import { AUTH_CONFIG } from './config.js';
import { getAccessToken } from './auth.js';

export async function getFeatures() {
  try {
    const resp = await fetch(`${AUTH_CONFIG.apiEndpoint}/features`);
    return resp.ok ? resp.json() : {};
  } catch { return {}; }
}

async function apiFetch(path, opts = {}) {
  const token = getAccessToken();
  if (!token) throw new Error('Not authenticated');
  return fetch(`${AUTH_CONFIG.apiEndpoint}${path}`, {
    ...opts,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
      ...opts.headers,
    },
  });
}

export async function startExtraction(text, existingEntities = [], model = 'simple') {
  const resp = await apiFetch('/extract', {
    method: 'POST',
    body:   JSON.stringify({ text, existingEntities, model }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();   // { jobId, status: 'processing' }
}

export async function startPdfExtraction(pages, existingEntities = [], model = 'simple') {
  const resp = await apiFetch('/extract-pdf', {
    method: 'POST',
    body:   JSON.stringify({ pages, existingEntities, model }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();   // { jobId, status: 'processing' }
}

export async function startAnalysis(entities, model = 'simple') {
  const resp = await apiFetch('/analyze', {
    method: 'POST',
    body:   JSON.stringify({ entities, model }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();   // { jobId, status: 'processing' }
}

export async function startStructureExtraction(text, existingStructure = [], model = 'simple') {
  const resp = await apiFetch('/extract-structure', {
    method: 'POST',
    body:   JSON.stringify({ text, existingStructure, model }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function submitInterest(name, email, subscriptionInterest) {
  const resp = await fetch(`${AUTH_CONFIG.apiEndpoint}/interest`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ name, email, subscriptionInterest }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

export async function loadWorld() {
  const resp = await apiFetch('/world');
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();   // { data, updatedAt } or null
}

export async function saveWorld(data, content = {}) {
  const resp = await apiFetch('/world', {
    method: 'PUT',
    body:   JSON.stringify({ data, content }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();   // { updatedAt }
}

export async function setAdminUserTier(username, tier) {
  const resp = await apiFetch(`/admin/users/${encodeURIComponent(username)}/tier`, {
    method: 'PUT',
    body:   JSON.stringify({ tier: tier || '' }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

export async function setAdminUserAdmin(username, admin) {
  const resp = await apiFetch(`/admin/users/${encodeURIComponent(username)}/admin-role`, {
    method: 'PUT',
    body:   JSON.stringify({ admin }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

export async function deleteAdminUser(email) {
  const resp = await apiFetch(`/admin/users/${encodeURIComponent(email)}`, { method: 'DELETE' });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

export async function getAdminTiers() {
  const resp = await apiFetch('/admin/tiers');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

export async function updateAdminTier(tierId, config) {
  const resp = await apiFetch(`/admin/tiers/${tierId}`, {
    method: 'PUT',
    body:   JSON.stringify(config),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

export async function getAdminUsers() {
  const resp = await apiFetch('/admin/users');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

export async function createAdminUser(email) {
  const resp = await apiFetch('/admin/users', {
    method: 'POST',
    body:   JSON.stringify({ email }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

export async function getAdminStatus() {
  const resp = await apiFetch('/admin/status');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

export async function getAdminUsage() {
  const resp = await apiFetch('/admin/usage');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

export async function getAdminInterest() {
  const resp = await apiFetch('/admin/interest');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

export async function getAdminModels() {
  const resp = await apiFetch('/admin/models');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

export async function updateAdminModels(config) {
  const resp = await apiFetch('/admin/models', {
    method: 'PUT',
    body:   JSON.stringify(config),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

export async function getAdminVisits() {
  const resp = await apiFetch('/admin/visits');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

export async function postTelemetry(sid, uid, auth) {
  try {
    await fetch(`${AUTH_CONFIG.apiEndpoint}/telemetry`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sid, uid, auth }),
    });
  } catch { /* fire and forget */ }
}

export async function updateAdminFeature(flagId, data) {
  const resp = await apiFetch(`/admin/features/${flagId}`, {
    method: 'PUT',
    body:   JSON.stringify(data),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

export async function pollJob(endpoint, jobId) {
  const resp = await apiFetch(`/${endpoint}/${jobId}`);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();   // { jobId, status, result? }
}

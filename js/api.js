import { AUTH_CONFIG } from './config.js';
import { getAccessToken } from './auth.js';

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

export async function loadWorld() {
  const resp = await apiFetch('/world');
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();   // { data, updatedAt } or null
}

export async function saveWorld(data) {
  const resp = await apiFetch('/world', {
    method: 'PUT',
    body:   JSON.stringify({ data }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();   // { updatedAt }
}

export async function pollJob(endpoint, jobId) {
  const resp = await apiFetch(`/${endpoint}/${jobId}`);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();   // { jobId, status, result? }
}

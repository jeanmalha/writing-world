import { AUTH_CONFIG } from './config.js';

export const isAuthEnabled = AUTH_CONFIG !== null;

const LS = {
  ACCESS:   'ww_at',
  ID:       'ww_it',
  EXPIRY:   'ww_exp',
  VERIFIER: 'ww_pkce',
};

// ── PKCE helpers (Web Crypto API, no library needed) ──
function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function pkceChallenge() {
  const verifier  = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const hashBuf   = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(hashBuf) };
}

// ── Public API ────────────────────────────────────────

export async function login() {
  if (!isAuthEnabled) return;
  const { verifier, challenge } = await pkceChallenge();
  sessionStorage.setItem(LS.VERIFIER, verifier);
  window.location.href = `${AUTH_CONFIG.cognitoDomain}/oauth2/authorize?` + new URLSearchParams({
    response_type:         'code',
    client_id:             AUTH_CONFIG.clientId,
    redirect_uri:          AUTH_CONFIG.redirectUri,
    scope:                 'openid email profile',
    code_challenge:        challenge,
    code_challenge_method: 'S256',
  });
}

export async function handleCallback() {
  if (!isAuthEnabled) return false;
  const code     = new URLSearchParams(window.location.search).get('code');
  const verifier = sessionStorage.getItem(LS.VERIFIER);
  if (!code || !verifier) return false;

  const resp = await fetch(`${AUTH_CONFIG.cognitoDomain}/oauth2/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     AUTH_CONFIG.clientId,
      code,
      redirect_uri:  AUTH_CONFIG.redirectUri,
      code_verifier: verifier,
    }),
  });

  const tokens = await resp.json();
  if (!tokens.access_token) return false;

  localStorage.setItem(LS.ACCESS, tokens.access_token);
  localStorage.setItem(LS.ID,     tokens.id_token || '');
  localStorage.setItem(LS.EXPIRY, String(Date.now() + (tokens.expires_in || 3600) * 1000));
  // Refresh token intentionally not stored — re-auth required when access token expires.
  sessionStorage.removeItem(LS.VERIFIER);
  window.history.replaceState({}, '', window.location.pathname);
  return true;
}

export function getAccessToken() {
  const exp = parseInt(localStorage.getItem(LS.EXPIRY) || '0');
  if (Date.now() > exp - 60_000) return null;
  return localStorage.getItem(LS.ACCESS);
}

export const isAuthenticated = () => isAuthEnabled && getAccessToken() !== null;

export function getUserEmail() {
  try {
    const payload = JSON.parse(atob(localStorage.getItem(LS.ID)?.split('.')[1] || ''));
    return payload.email || null;
  } catch { return null; }
}

export function getUserSub() {
  try {
    const payload = JSON.parse(atob(localStorage.getItem(LS.ID)?.split('.')[1] || ''));
    return payload.sub || null;
  } catch { return null; }
}

export function isAdmin() {
  try {
    const token = localStorage.getItem(LS.ACCESS);
    if (!token) return false;
    const payload = JSON.parse(atob(token.split('.')[1]));
    const groups  = payload['cognito:groups'];
    if (!groups) return false;
    return Array.isArray(groups) ? groups.includes('admins') : String(groups).split(',').includes('admins');
  } catch { return false; }
}

export function getUserTier() {
  try {
    const token = localStorage.getItem(LS.ACCESS);
    if (!token) return null;
    const payload = JSON.parse(atob(token.split('.')[1]));
    const raw     = payload['cognito:groups'];
    if (!raw) return null;
    const groups  = Array.isArray(raw)
      ? raw
      : String(raw).replace(/[\[\] ]/g, '').split(',').filter(Boolean);
    if (groups.includes('uncharted'))   return 'uncharted';
    if (groups.includes('trailblazer')) return 'trailblazer';
    if (groups.includes('explorer'))    return 'explorer';
    return null;
  } catch { return null; }
}

export function logout() {
  [LS.ACCESS, LS.ID, LS.EXPIRY].forEach(k => localStorage.removeItem(k));
  // Clear any cached encryption keys from the session
  for (const key of Object.keys(sessionStorage)) {
    if (key.startsWith('lore_key_')) sessionStorage.removeItem(key);
  }
  if (!isAuthEnabled) return;
  window.location.href = `${AUTH_CONFIG.cognitoDomain}/logout?` + new URLSearchParams({
    client_id:  AUTH_CONFIG.clientId,
    logout_uri: AUTH_CONFIG.redirectUri,
  });
}

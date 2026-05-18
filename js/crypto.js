// AES-256-GCM encryption using Web Crypto API

const ALG = { name: 'AES-GCM', length: 256 };

function _toB64(buf) {
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function _fromB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function generateKey() {
  return crypto.subtle.generateKey(ALG, true, ['encrypt', 'decrypt']);
}

export async function exportKey(key) {
  return JSON.stringify(await crypto.subtle.exportKey('jwk', key));
}

export async function importKey(jwkStr) {
  return crypto.subtle.importKey('jwk', JSON.parse(jwkStr), ALG, true, ['encrypt', 'decrypt']);
}

export async function encrypt(plaintext, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const buf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  const out = new Uint8Array(12 + buf.byteLength);
  out.set(iv);
  out.set(new Uint8Array(buf), 12);
  return _toB64(out.buffer);
}

export async function decrypt(b64, key) {
  const combined = _fromB64(b64);
  const iv = combined.slice(0, 12);
  const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, combined.slice(12));
  return new TextDecoder().decode(buf);
}

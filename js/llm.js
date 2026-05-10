/**
 * WebLLM engine singleton.
 * Swap this module for an API-backed implementation without touching chat.js.
 *
 * Public surface:
 *   isWebGPUSupported()  → bool
 *   isReady()            → bool
 *   isLoading()          → bool
 *   onProgress(fn)       → unsubscribe fn   — fn({progress, text})
 *   onReady(fn)          → unsubscribe fn   — fn(engine|null, err|null)
 *   initEngine()         → void (fire-and-forget)
 *   chat(messages, {onChunk, signal}) → Promise<string>
 */

import { CreateMLCEngine } from '@mlc-ai/web-llm';

const MODEL_ID = 'SmolLM2-1.7B-Instruct-q4f16_1-MLC';

let _engine  = null;
let _loading = false;
let _promise = null;

const _progressListeners = new Set();
const _readyListeners    = new Set();

export function isWebGPUSupported() {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

export function isReady()   { return _engine !== null; }
export function isLoading() { return _loading; }

export function onProgress(fn) {
  _progressListeners.add(fn);
  return () => _progressListeners.delete(fn);
}

export function onReady(fn) {
  if (_engine) { fn(_engine, null); return () => {}; }
  _readyListeners.add(fn);
  return () => _readyListeners.delete(fn);
}

export function initEngine() {
  _load().catch(() => {});
}

async function _load() {
  if (_engine || _loading) return _promise;

  if (!isWebGPUSupported()) {
    const err = new Error('WebGPU is not supported in this browser.');
    _readyListeners.forEach(fn => fn(null, err));
    _readyListeners.clear();
    throw err;
  }

  _loading = true;
  _promise = CreateMLCEngine(MODEL_ID, {
    initProgressCallback(p) {
      _progressListeners.forEach(fn => fn(p));
    },
  }).then(engine => {
    _engine  = engine;
    _loading = false;
    _readyListeners.forEach(fn => fn(engine, null));
    _readyListeners.clear();
    return engine;
  }).catch(err => {
    _loading = false;
    _readyListeners.forEach(fn => fn(null, err));
    _readyListeners.clear();
    _promise = null;
    throw err;
  });

  return _promise;
}

export async function chat(messages, { onChunk, signal } = {}) {
  if (!_engine) await _load();

  if (onChunk) {
    const stream = await _engine.chat.completions.create({
      messages,
      stream: true,
      temperature: 0.7,
      max_tokens: 512,
    });

    let full = '';
    try {
      for await (const chunk of stream) {
        if (signal?.aborted) break;
        const delta = chunk.choices[0]?.delta?.content || '';
        if (delta) { full += delta; onChunk(delta, full); }
      }
    } catch (e) {
      if (!signal?.aborted) throw e;
    }
    return full;
  }

  const resp = await _engine.chat.completions.create({
    messages,
    temperature: 0.7,
    max_tokens: 512,
  });
  return resp.choices[0].message.content;
}

/**
 * LLM engine singleton — Transformers.js backend.
 * Swap this module for a different backend without touching chat.js.
 *
 * Public surface (must stay stable across backend swaps):
 *   isWebGPUSupported()          → bool
 *   isReady()                    → bool
 *   isLoading()                  → bool
 *   onProgress(fn)               → unsubscribe fn  —  fn({progress:0-1, text:string})
 *   onReady(fn)                  → unsubscribe fn  —  fn(engine|null, err|null)
 *   initEngine()                 → void (fire-and-forget)
 *   chat(messages, {onChunk, signal}) → Promise<string>
 */

import { pipeline, TextStreamer, env } from '@huggingface/transformers';

// ── Configuration ─────────────────────────────────────────────────────────────

const MODEL_ID = 'HuggingFaceTB/SmolLM2-1.7B-Instruct';

// Point ORT WASM to our self-hosted binaries.
if (window.location.hostname !== 'localhost') {
  env.backends.onnx.wasm.wasmPaths = '/vendor/';
}
env.backends.onnx.wasm.proxy = false;

// ── State ─────────────────────────────────────────────────────────────────────

let _pipe    = null;
let _loading = false;
let _promise = null;

const _progressListeners = new Set();
const _readyListeners    = new Set();

// Per-file download progress aggregator
const _files = new Map(); // name → { loaded, total }

function _computeProgress() {
  let totalLoaded = 0, totalSize = 0;
  for (const { loaded, total } of _files.values()) {
    totalLoaded += loaded || 0;
    totalSize   += total  || 0;
  }
  const pct = totalSize > 0 ? totalLoaded / totalSize : 0;
  const mb  = (totalLoaded / 1e6).toFixed(0);
  const tot = (totalSize   / 1e6).toFixed(0);
  return {
    progress: pct,
    text: totalSize > 0
      ? `Downloading model… ${mb} / ${tot} MB`
      : 'Initialising model…',
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function isWebGPUSupported() {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

export function isReady()   { return _pipe !== null; }
export function isLoading() { return _loading; }

export function onProgress(fn) {
  _progressListeners.add(fn);
  return () => _progressListeners.delete(fn);
}

export function onReady(fn) {
  if (_pipe) { fn(_pipe, null); return () => {}; }
  _readyListeners.add(fn);
  return () => _readyListeners.delete(fn);
}

export function initEngine() {
  _load().catch(() => {});
}

async function _load() {
  if (_pipe || _loading) return _promise;

  _loading = true;

  const progressCallback = (p) => {
    if (p.status === 'initiate') {
      _files.set(p.name, { loaded: 0, total: 0 });
    } else if (p.status === 'download') {
      _files.set(p.name, { loaded: p.loaded || 0, total: p.total || 0 });
      _progressListeners.forEach(fn => fn(_computeProgress()));
    }
  };

  const _tryDevice = (device) => pipeline('text-generation', MODEL_ID, {
    dtype:             device === 'webgpu' ? 'q4f16' : 'q4',
    device,
    progress_callback: progressCallback,
  });

  _promise = (async () => {
    if (isWebGPUSupported()) {
      try { return await _tryDevice('webgpu'); }
      catch (e) {
        console.warn('[lore-ai] WebGPU failed, falling back to WASM:', e.message);
        _files.clear();
      }
    }
    return _tryDevice('wasm');
  })().then(pipe => {
    _pipe    = pipe;
    _loading = false;
    _readyListeners.forEach(fn => fn(pipe, null));
    _readyListeners.clear();
    return pipe;
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
  if (!_pipe) await _load();

  let full = '';

  if (onChunk) {
    const streamer = new TextStreamer(_pipe.tokenizer, {
      skip_prompt:         true,
      skip_special_tokens: true,
      callback_function(token) {
        if (signal?.aborted) return;
        full += token;
        onChunk(token, full);
      },
    });

    await _pipe(messages, {
      max_new_tokens: 512,
      temperature:    0.7,
      do_sample:      true,
      streamer,
    });
  } else {
    const result = await _pipe(messages, {
      max_new_tokens: 512,
      temperature:    0.7,
      do_sample:      true,
    });
    // generated_text is an array of messages; the last is the new assistant turn
    full = result[0].generated_text.at(-1)?.content ?? '';
  }

  return full;
}

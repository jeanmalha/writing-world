import { store, TYPES } from './store.js';
import {
  isWebGPUSupported, isReady, isLoading,
  onProgress, onReady, initEngine, chat as llmChat,
} from './llm.js';

// ── System prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
`You are a lore assistant for a worldbuilding knowledge base.

Answer questions concisely. Only output a JSON block when the user explicitly asks to make a change.

UPDATING AN ENTRY — output exactly this and nothing else:
\`\`\`json
{"action":"update","entityId":"PASTE_THE_ID_FROM_CURRENT_ENTRY","changes":{"fieldName":"new value"}}
\`\`\`
Rules:
- entityId must be the exact value of the "id" field shown in CURRENT ENTRY below. Never use a name.
- changes must be a flat object of field names and their new string values.
- Valid field names: name, description, role, locType, date, importance, gender, skinTone, hairStyle, hairColor, eyeColor.

ADDING A RELATIONSHIP — output exactly this:
\`\`\`json
{"action":"link","sourceId":"SOURCE_ID","targetId":"TARGET_ID","label":"relationship label"}
\`\`\`

For all other requests (questions, summaries, analysis), answer in plain text only.`;

// ── Module state ───────────────────────────────────────────────────────────

let _open       = false;
let _contextId  = null;   // entity ID injected as context
let _messages   = [];     // {role, content, applied?}
let _generating = false;
let _abort      = null;   // AbortController
let _progress   = null;
let _initDone   = false;
let _initErr    = null;
let _pendingMsg = null;   // message queued while model was loading

// ── Public API ─────────────────────────────────────────────────────────────

export function initChat() {
  if (!isWebGPUSupported()) return;

  onProgress(p => {
    _progress = p;
    if (_open) _renderBody();
  });

  onReady((engine, err) => {
    _initDone = !err;
    _initErr  = err ? (err.message || String(err)) : null;
    if (_open) _renderBody();
    if (_pendingMsg && _initDone) {
      const msg = _pendingMsg;
      _pendingMsg = null;
      _generate(msg);
    }
  });
}

export function isChatOpen() { return _open; }

export function openChat(entityId = null) {
  if (_open && entityId === _contextId) return;
  _contextId = entityId;
  _open = true;
  _applyOpenState();
  if (!isReady() && !isLoading()) initEngine();
}

export function closeChat() {
  _open = false;
  _stopGeneration();
  _applyOpenState();
}

export function toggleChat(entityId = null) {
  if (_open) { closeChat(); } else { openChat(entityId); }
}

// ── DOM wiring (called once from app.js after DOM is ready) ────────────────

export function wireChat() {
  document.getElementById('chat-close')?.addEventListener('click', closeChat);
  document.getElementById('chat-overlay')?.addEventListener('click', closeChat);
  document.getElementById('chat-clear')?.addEventListener('click', () => {
    _messages   = [];
    _pendingMsg = null;
    _stopGeneration();
    _renderBody();
  });

  const input = document.getElementById('chat-input');
  const send  = document.getElementById('chat-send');

  const submit = () => {
    const text = input?.value.trim();
    if (!text || _generating) return;
    if (input) input.value = '';
    _handleSend(text);
  };

  send?.addEventListener('click', submit);
  input?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });

  // Auto-grow textarea
  input?.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
}

// ── Internal ───────────────────────────────────────────────────────────────

function _applyOpenState() {
  document.getElementById('chat-panel')?.classList.toggle('open', _open);
  document.getElementById('chat-overlay')?.classList.toggle('visible', _open);
  if (_open) {
    _renderBody();
    requestAnimationFrame(() => document.getElementById('chat-input')?.focus());
  }
}

function _renderBody() {
  const body = document.getElementById('chat-body');
  if (!body) return;

  if (!isWebGPUSupported()) {
    body.innerHTML = `<div class="chat-notice">
      <div class="chat-notice-icon">⚠</div>
      <div class="chat-notice-title">WebGPU unavailable</div>
      <div class="chat-notice-sub">Chrome or Edge 113+ on desktop required.</div>
    </div>`;
    return;
  }

  if (_initErr) {
    body.innerHTML = `<div class="chat-notice">
      <div class="chat-notice-icon">✗</div>
      <div class="chat-notice-title">Model failed to load</div>
      <div class="chat-notice-sub">${_esc(_initErr)}</div>
    </div>`;
    return;
  }

  if (!_initDone) {
    const pct  = _progress ? Math.round((_progress.progress || 0) * 100) : 0;
    const text = _progress?.text || 'Initialising model…';
    body.innerHTML = `<div class="chat-loading">
      <div class="chat-loading-label">${_esc(text)}</div>
      <div class="chat-progress-bar">
        <div class="chat-progress-fill" style="width:${pct}%"></div>
      </div>
      <div class="chat-loading-sub">SmolLM2 1.7B · ~900 MB · cached after first load</div>
    </div>`;
    return;
  }

  if (!_messages.length) {
    const ctx  = _contextId ? store.get(_contextId) : null;
    const hint = ctx
      ? `Context: <strong style="color:${TYPES[ctx.type]?.color || 'var(--accent)'}">${TYPES[ctx.type]?.icon || ''} ${_esc(ctx.name)}</strong>`
      : 'Ask anything about your lore world.';
    body.innerHTML = `<div class="chat-empty">${hint}</div>`;
    return;
  }

  body.innerHTML = _messages
    .filter(m => m.role !== 'system')
    .map((m, i) => {
      const isUser = m.role === 'user';
      const parsed = isUser ? null : _parseAssistant(m.content);
      const html   = parsed ? parsed.html : _fmtText(m.content);
      return `<div class="chat-msg chat-msg-${m.role}">
        <div class="chat-bubble">${html}</div>
        ${parsed?.json && !m.applied
          ? `<button class="chat-apply-btn" data-index="${i}">Apply changes</button>` : ''}
        ${m.applied ? '<div class="chat-applied">✓ Applied</div>' : ''}
      </div>`;
    }).join('');

  body.querySelectorAll('.chat-apply-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const msg = _messages.filter(m => m.role !== 'system')[parseInt(btn.dataset.index)];
      if (!msg) return;
      const parsed = _parseAssistant(msg.content);
      if (parsed?.json && _applyJSON(parsed.json)) {
        msg.applied = true;
        _renderBody();
      }
    });
  });

  body.scrollTop = body.scrollHeight;
}

function _handleSend(text) {
  _messages.push({ role: 'user', content: text });

  if (!_initDone) {
    // Queue and show placeholder — model is loading
    _pendingMsg = text;
    _messages.push({ role: 'assistant', content: '…waiting for model to load' });
    _renderBody();
    return;
  }

  _renderBody();
  _generate(text);
}

async function _generate(_userText) {
  _generating = true;
  _abort      = new AbortController();

  // Remove any loading placeholder
  _messages = _messages.filter(m => m.content !== '…waiting for model to load');

  const assistantMsg = { role: 'assistant', content: '' };
  _messages.push(assistantMsg);
  _renderBody();
  _syncSendBtn();

  const apiMessages = [
    { role: 'system', content: _buildContext() },
    ..._messages
      .filter(m => m.role !== 'system' && m.content !== assistantMsg.content)
      .slice(-20),
  ];

  try {
    await llmChat(apiMessages, {
      signal: _abort.signal,
      onChunk: (_delta, full) => {
        assistantMsg.content = full;
        _renderBody();
      },
    });
  } catch (e) {
    if (!_abort?.signal.aborted) {
      assistantMsg.content = `Error: ${_esc(e.message)}`;
    }
  } finally {
    _generating = false;
    _abort      = null;
    _renderBody();
    _syncSendBtn();
  }
}

function _stopGeneration() {
  if (_abort) { _abort.abort(); _abort = null; }
  _generating = false;
  _syncSendBtn();
}

function _syncSendBtn() {
  const btn = document.getElementById('chat-send');
  if (btn) btn.disabled = _generating;
}

// ── Context building ────────────────────────────────────────────────────────

function _buildContext() {
  const lines = [SYSTEM_PROMPT, ''];

  const counts = store.countByType();
  const total  = Object.values(counts).reduce((a, b) => a + b, 0);
  lines.push(`WORLD: ${total} entries — ${Object.entries(counts).map(([t, n]) => `${n} ${t}`).join(', ')}.`);

  const entity = _contextId ? store.get(_contextId) : null;
  if (entity) {
    lines.push('', 'CURRENT ENTRY:', JSON.stringify(_serializeEntity(entity), null, 2));

    if (entity.links?.length) {
      lines.push('', 'LINKED TO:');
      entity.links.forEach(l => {
        const t = store.get(l.targetId);
        if (t) lines.push(`  [${l.label}] → ${t.type} "${t.name}" id:${t.id}`);
      });
    }

    // Incoming links
    const incoming = store.incomingLinks(entity.id);
    if (incoming.length) {
      lines.push('', 'REFERENCED BY:');
      incoming.forEach(({ source, label }) => {
        lines.push(`  [${label}] ← ${source.type} "${source.name}" id:${source.id}`);
      });
    }
  }

  return lines.join('\n');
}

function _serializeEntity(e) {
  return {
    id:   e.id,
    type: e.type,
    name: e.name,
    ...(e.description ? { description: e.description }  : {}),
    ...(e.tags?.length ? { tags: e.tags }                : {}),
    ...(e.role        ? { role:        e.role        }  : {}),
    ...(e.locType     ? { locType:     e.locType     }  : {}),
    ...(e.date        ? { date:        e.date        }  : {}),
    ...(e.importance  ? { importance:  e.importance  }  : {}),
    ...(e.gender      ? { gender:      e.gender      }  : {}),
    ...(e.skinTone    ? { skinTone:    e.skinTone    }  : {}),
    ...(e.hairStyle   ? { hairStyle:   e.hairStyle   }  : {}),
    ...(e.hairColor   ? { hairColor:   e.hairColor   }  : {}),
    ...(e.eyeColor    ? { eyeColor:    e.eyeColor    }  : {}),
  };
}

// ── JSON detection + apply ──────────────────────────────────────────────────

function _parseAssistant(text) {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  if (!match) return { html: _fmtText(text), json: null };

  let json = null;
  try { json = JSON.parse(match[1]); } catch { /* not valid JSON */ }

  const before = text.slice(0, match.index).trim();
  const after  = text.slice(match.index + match[0].length).trim();
  const html   = [
    before ? _fmtText(before) : '',
    `<pre class="chat-json">${_esc(match[1].trim())}</pre>`,
    after  ? _fmtText(after)  : '',
  ].filter(Boolean).join('');

  return { html, json };
}

function _resolveEntity(idOrName) {
  if (!idOrName) return null;
  // Try exact ID match first
  const byId = store.get(idOrName);
  if (byId) return byId;
  // Fall back to case-insensitive name match
  const lower = String(idOrName).toLowerCase();
  return store.getAll().find(e => e.name?.toLowerCase() === lower) || null;
}

function _flattenChanges(changes) {
  if (!changes || typeof changes !== 'object') return changes;
  // Model sometimes wraps: {type:"update", details:{...}} or {changes:{...}}
  if (changes.details && typeof changes.details === 'object') return changes.details;
  if (changes.changes && typeof changes.changes === 'object') return changes.changes;
  // Strip any non-string/non-primitive nested objects
  const flat = {};
  for (const [k, v] of Object.entries(changes)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      flat[k] = String(v);
    }
  }
  return Object.keys(flat).length ? flat : changes;
}

function _applyJSON(json) {
  try {
    if (json.action === 'update' && json.entityId) {
      const entity  = _resolveEntity(json.entityId);
      if (!entity) return false;
      const changes = _flattenChanges(json.changes);
      if (!changes || !Object.keys(changes).length) return false;
      store.update(entity.id, changes);
      return true;
    }
    if (json.action === 'link' && json.sourceId && json.targetId && json.label) {
      const src = _resolveEntity(json.sourceId);
      const tgt = _resolveEntity(json.targetId);
      if (!src || !tgt) return false;
      store.addLink(src.id, tgt.id, json.label);
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

// ── Text helpers ────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _fmtText(text) {
  return _esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
}

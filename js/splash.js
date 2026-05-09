import { AUTH_CONFIG } from './config.js';

const SEEN_KEY = 'lore_splash_seen';
const GITHUB_URL = 'https://github.com/jmalha/lore';   // update when repo is public

export function initSplash() {
  if (localStorage.getItem(SEEN_KEY)) return;
  _show();
}

export function showSplash() { _show(); }

function _show() {
  if (document.getElementById('splash-overlay')) return;

  const el = document.createElement('div');
  el.id = 'splash-overlay';
  el.innerHTML = `
    <div class="splash-box">

      <div class="splash-hero">
        <div class="splash-logo">◈ LORE</div>
        <div class="splash-tagline">Open-source world-building for writers</div>
      </div>

      <div class="splash-cols">

        <div class="splash-left">
          <div class="splash-section-title">Free — always</div>
          <ul class="splash-features">
            <li><span class="sf-icon" style="color:#818cf8">◉</span> Characters, locations, events, artifacts &amp; lore</li>
            <li><span class="sf-icon" style="color:#60a5fa">&#9635;</span> Visual character board with drag &amp; drop</li>
            <li><span class="sf-icon" style="color:#facc15">◷</span> Timeline with world-state cursor</li>
            <li><span class="sf-icon" style="color:#34d399">◈</span> Multi-project support</li>
            <li><span class="sf-icon" style="color:#a78bfa">▣</span> Acts &amp; chapters structure</li>
            <li><span class="sf-icon" style="color:#6b7280">↕</span> Export / import JSON</li>
          </ul>
          <div class="splash-section-title" style="margin-top:18px">Self-host with AI features</div>
          <ul class="splash-features">
            <li><span class="sf-icon" style="color:#a78bfa">◈</span> AI extraction from novel text &amp; PDFs</li>
            <li><span class="sf-icon" style="color:#34d399">☁</span> Cloud sync across devices (AWS)</li>
            <li><span class="sf-icon" style="color:#fb923c">⬡</span> Relationship analysis &amp; merge suggestions</li>
          </ul>
          <a class="splash-github" href="${GITHUB_URL}" target="_blank" rel="noopener">
            ↗ Deploy your own on GitHub
          </a>
        </div>

        <div class="splash-right">
          <div class="splash-section-title">Interested in a hosted version?</div>
          <p class="splash-pitch">
            We're considering a <strong>$3/month</strong> plan that includes AI extraction,
            PDF processing, and cloud sync — with no setup required.
            Let us know if you'd use it.
          </p>

          <div id="splash-form-area">
            <form id="splash-interest-form" autocomplete="off">
              <div class="splash-field">
                <label>Name</label>
                <input type="text" name="interest-name" placeholder="Your name" autocomplete="name">
              </div>
              <div class="splash-field">
                <label>Email <span style="color:var(--danger)">*</span></label>
                <input type="email" name="interest-email" placeholder="you@example.com" required autocomplete="email">
              </div>
              <label class="splash-check">
                <input type="checkbox" name="interest-sub">
                I'd pay $3/month for the hosted version
              </label>
              <div id="splash-form-error" class="splash-error"></div>
              <button class="splash-btn-submit" id="btn-submit-interest" type="submit">
                Submit Interest
              </button>
            </form>
          </div>
        </div>

      </div>

      <div class="splash-footer">
        <span class="splash-skip">Already know Lore?</span>
        <button class="splash-btn-enter" id="btn-enter-lore">Enter Lore →</button>
      </div>

    </div>`;

  document.body.appendChild(el);

  document.getElementById('btn-enter-lore')
    .addEventListener('click', _dismiss);

  document.getElementById('splash-interest-form')
    .addEventListener('submit', _handleSubmit);
}

function _dismiss() {
  localStorage.setItem(SEEN_KEY, '1');
  const el = document.getElementById('splash-overlay');
  if (!el) return;
  el.classList.add('splash-hiding');
  setTimeout(() => el.remove(), 280);
}

async function _handleSubmit(e) {
  e.preventDefault();
  const form  = e.target;
  const name  = form.elements['interest-name'].value.trim();
  const email = form.elements['interest-email'].value.trim();
  const sub   = form.elements['interest-sub'].checked;
  const btn   = document.getElementById('btn-submit-interest');
  const errEl = document.getElementById('splash-form-error');

  errEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Sending…';

  try {
    const endpoint = AUTH_CONFIG?.apiEndpoint;
    if (endpoint) {
      const resp = await fetch(`${endpoint}/interest`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name, email, subscriptionInterest: sub }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    }
    document.getElementById('splash-form-area').innerHTML = `
      <div class="splash-thankyou">
        ◈ Thanks! We'll reach out to <strong>${esc(email)}</strong> if we launch.<br>
        <button class="splash-btn-enter" id="btn-enter-after-thanks" style="margin-top:14px">
          Enter Lore →
        </button>
      </div>`;
    document.getElementById('btn-enter-after-thanks')
      ?.addEventListener('click', _dismiss);
  } catch (err) {
    errEl.textContent = 'Could not send — try again later.';
    btn.disabled = false;
    btn.textContent = 'Submit Interest';
  }
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

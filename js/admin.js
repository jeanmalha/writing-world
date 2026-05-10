import { isAdmin } from './auth.js';
import { getAdminUsers, createAdminUser, deleteAdminUser, setAdminUserTier, setAdminUserAdmin, getAdminStatus, getAdminUsage, getAdminTiers, updateAdminTier, getAdminInterest } from './api.js';

let _tab = 'users';

export async function renderAdminView(listHeader, entityList, detailContent) {
  if (!isAdmin()) {
    listHeader.innerHTML = '';
    entityList.innerHTML = '<div class="empty-state">Access denied.</div>';
    detailContent.innerHTML = '';
    return;
  }

  listHeader.innerHTML = `
    <div class="list-header-row">
      <span class="list-title">Admin</span>
      <div class="admin-tabs">
        <button class="admin-tab${_tab === 'users'    ? ' active' : ''}" data-tab="users">Users</button>
        <button class="admin-tab${_tab === 'tiers'    ? ' active' : ''}" data-tab="tiers">Tiers</button>
        <button class="admin-tab${_tab === 'status'   ? ' active' : ''}" data-tab="status">Status</button>
        <button class="admin-tab${_tab === 'usage'    ? ' active' : ''}" data-tab="usage">Usage</button>
        <button class="admin-tab${_tab === 'interest' ? ' active' : ''}" data-tab="interest">Interest</button>
      </div>
    </div>`;

  listHeader.querySelectorAll('.admin-tab').forEach(btn =>
    btn.addEventListener('click', () => {
      _tab = btn.dataset.tab;
      renderAdminView(listHeader, entityList, detailContent);
    }));

  entityList.innerHTML = '<div class="admin-loading">Loading…</div>';
  detailContent.innerHTML = '';

  try {
    if (_tab === 'users')    await _renderUsers(entityList, detailContent);
    if (_tab === 'tiers')    await _renderTiers(entityList, detailContent);
    if (_tab === 'status')   await _renderStatus(entityList, detailContent);
    if (_tab === 'usage')    await _renderUsage(entityList);
    if (_tab === 'interest') await _renderInterest(entityList);
  } catch (err) {
    entityList.innerHTML = `<div class="empty-state">Error: ${_esc(err.message)}</div>`;
  }
}

// ── Users tab ──────────────────────────────────────────────────────────────

const TIER_LABELS   = { explorer: 'Explorer', trailblazer: 'Trailblazer', uncharted: 'Uncharted' };
const TIER_GROUPS   = ['explorer', 'trailblazer', 'uncharted'];
let _selectedEmail  = null;

async function _renderUsers(entityList, detailContent) {
  const { users } = await getAdminUsers();
  _renderUserList(entityList, detailContent, users);
  _renderUserDetailOrCreate(detailContent, users, entityList);
}

function _renderUserList(entityList, detailContent, users) {
  entityList.innerHTML = `
    <div class="admin-user-list-header">
      <button class="admin-new-user-btn" id="btn-admin-new-user">+ New User</button>
    </div>
    ${users.length === 0 ? '<div class="empty-state">No users yet.</div>' : users.map(u => {
      const tier    = u.groups.find(g => TIER_GROUPS.includes(g));
      const isAdm   = u.groups.includes('admins');
      const sel     = u.email === _selectedEmail;
      return `<div class="admin-user-row${sel ? ' selected' : ''}" data-email="${_esc(u.email)}">
        <div class="admin-user-row-email">${_esc(u.email)}</div>
        <div class="admin-user-row-badges">
          ${tier ? `<span class="admin-tier-pill admin-tier-${tier}">${_esc(TIER_LABELS[tier])}</span>` : '<span class="admin-tier-pill admin-tier-none">—</span>'}
          ${isAdm ? '<span class="admin-admin-pill">admin</span>' : ''}
        </div>
      </div>`;
    }).join('')}`;

  entityList.querySelector('#btn-admin-new-user')?.addEventListener('click', () => {
    _selectedEmail = null;
    entityList.querySelectorAll('.admin-user-row').forEach(r => r.classList.remove('selected'));
    _renderCreateForm(detailContent, entityList, users);
  });

  entityList.querySelectorAll('.admin-user-row').forEach(row => {
    row.addEventListener('click', () => {
      _selectedEmail = row.dataset.email;
      entityList.querySelectorAll('.admin-user-row').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
      const user = users.find(u => u.email === _selectedEmail);
      if (user) _renderUserDetail(detailContent, user, entityList, users);
    });
  });

  // Re-select previously selected user if still in list
  if (_selectedEmail) {
    const user = users.find(u => u.email === _selectedEmail);
    if (user) _renderUserDetail(detailContent, user, entityList, users);
  }
}

function _renderUserDetailOrCreate(detailContent, users, entityList) {
  if (_selectedEmail) return; // already rendered by row click
  _renderCreateForm(detailContent, entityList, users);
}

function _renderCreateForm(detailContent, entityList, users) {
  detailContent.innerHTML = `
    <div class="admin-create-panel">
      <div class="admin-create-title">New User</div>
      <div class="admin-create-note">Cognito will send a temporary password to their email.</div>
      <div class="admin-create-form">
        <input id="admin-email-input" type="email" placeholder="user@example.com" autocomplete="off">
        <button id="admin-create-btn">Create</button>
      </div>
      <div id="admin-create-msg" class="admin-create-msg"></div>
    </div>`;

  const input = detailContent.querySelector('#admin-email-input');
  const btn   = detailContent.querySelector('#admin-create-btn');
  const msg   = detailContent.querySelector('#admin-create-msg');

  const doCreate = async () => {
    const email = input.value.trim();
    if (!email) return;
    btn.disabled = true;
    msg.textContent = '';
    try {
      await createAdminUser(email);
      msg.textContent = `✓ Invited ${email}`;
      msg.className   = 'admin-create-msg admin-msg-ok';
      input.value     = '';
      const { users: updated } = await getAdminUsers();
      _renderUserList(entityList, detailContent, updated);
    } catch (err) {
      msg.textContent = `✗ ${err.message}`;
      msg.className   = 'admin-create-msg admin-msg-err';
    }
    btn.disabled = false;
  };

  btn.addEventListener('click', doCreate);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doCreate(); });
  input.focus();
}

function _renderUserDetail(detailContent, user, entityList, users) {
  const tier   = user.groups.find(g => TIER_GROUPS.includes(g)) || '';
  const isAdm  = user.groups.includes('admins');

  detailContent.innerHTML = `
    <div class="admin-user-detail">
      <div class="admin-user-detail-email">${_esc(user.email)}</div>
      <div class="admin-user-detail-meta">
        <span class="admin-badge admin-badge-${user.status.toLowerCase()}">${_esc(user.status)}</span>
        ${user.created ? `<span class="admin-user-joined">Joined ${new Date(user.created).toLocaleDateString()}</span>` : ''}
      </div>

      <div class="admin-user-section">
        <div class="admin-user-section-label">TIER</div>
        <div class="admin-tier-assign-row">
          ${['', ...TIER_GROUPS].map(t => `
            <button class="admin-tier-assign-btn${tier === t ? ' active' : ''}"
                    data-tier="${t}" style="${t ? `--tc:${TIER_COLORS[t]}` : ''}">
              ${t ? _esc(TIER_LABELS[t]) : 'None'}
            </button>`).join('')}
        </div>
      </div>

      <div class="admin-user-section">
        <div class="admin-user-section-label">ADMIN ACCESS</div>
        <button class="admin-role-btn${isAdm ? ' active' : ''}" id="btn-toggle-admin-role">
          ${isAdm ? '✓ Admin — click to remove' : 'Grant admin access'}
        </button>
      </div>

      <div class="admin-user-section">
        <button class="admin-danger-btn" id="btn-delete-this-user">Delete user…</button>
      </div>

      <div class="admin-user-msg" id="admin-user-msg"></div>
    </div>`;

  const msg     = document.getElementById('admin-user-msg');
  const refresh = async () => {
    const { users: updated } = await getAdminUsers();
    _renderUserList(entityList, detailContent, updated);
    const updatedUser = updated.find(u => u.email === user.email);
    if (updatedUser) _renderUserDetail(detailContent, updatedUser, entityList, updated);
  };
  const setMsg  = (text, ok) => {
    msg.textContent = text;
    msg.className   = `admin-user-msg ${ok ? 'admin-msg-ok' : 'admin-msg-err'}`;
  };

  // Tier buttons
  detailContent.querySelectorAll('.admin-tier-assign-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.classList.contains('active')) return;
      btn.disabled = true;
      try {
        await setAdminUserTier(user.username || user.email, btn.dataset.tier);
        setMsg(`✓ Tier set to ${btn.dataset.tier || 'none'} — user must re-login`, true);
        await refresh();
      } catch (err) { setMsg(`✗ ${err.message}`, false); btn.disabled = false; }
    });
  });

  // Admin toggle
  document.getElementById('btn-toggle-admin-role')?.addEventListener('click', async () => {
    try {
      await setAdminUserAdmin(user.username || user.email, !isAdm);
      setMsg(`✓ Admin ${!isAdm ? 'granted' : 'removed'} — user must re-login`, true);
      await refresh();
    } catch (err) { setMsg(`✗ ${err.message}`, false); }
  });

  // Delete
  document.getElementById('btn-delete-this-user')?.addEventListener('click', async () => {
    if (!confirm(`Delete ${user.email}? This cannot be undone.`)) return;
    try {
      await deleteAdminUser(user.username || user.email);
      _selectedEmail = null;
      const { users: updated } = await getAdminUsers();
      _renderUserList(entityList, detailContent, updated);
      _renderCreateForm(detailContent, entityList, updated);
    } catch (err) { setMsg(`✗ ${err.message}`, false); }
  });
}

// ── Tiers tab ──────────────────────────────────────────────────────────────

const TIER_COLORS = { explorer: '#60a5fa', trailblazer: '#a78bfa', uncharted: '#f59e0b' };

async function _renderTiers(entityList, detailContent) {
  const { tiers } = await getAdminTiers();
  detailContent.innerHTML = '';

  entityList.innerHTML = tiers.map(t => `
    <div class="admin-tier-card" data-tier="${t.tierId}">
      <div class="admin-tier-header">
        <span class="admin-tier-name" style="color:${TIER_COLORS[t.tierId] || 'var(--accent)'}">${_esc(t.label)}</span>
        <div class="admin-tier-model-toggle">
          <button class="admin-model-btn${t.model === 'simple'  ? ' active' : ''}" data-tier="${t.tierId}" data-model="simple">Simple</button>
          <button class="admin-model-btn${t.model === 'complex' ? ' active' : ''}" data-tier="${t.tierId}" data-model="complex">Complex</button>
        </div>
      </div>
      <div class="admin-tier-limits">
        <div class="admin-limit-row">
          <label>Daily</label>
          <input class="admin-limit-input" data-tier="${t.tierId}" data-field="dailyLimit"
                 type="number" min="0" value="${t.dailyLimit}" placeholder="0 = unlimited">
          <span class="admin-limit-hint">tokens</span>
        </div>
        <div class="admin-limit-row">
          <label>Weekly</label>
          <input class="admin-limit-input" data-tier="${t.tierId}" data-field="weeklyLimit"
                 type="number" min="0" value="${t.weeklyLimit}" placeholder="0 = unlimited">
          <span class="admin-limit-hint">tokens</span>
        </div>
        <div class="admin-limit-row">
          <label>Monthly</label>
          <input class="admin-limit-input" data-tier="${t.tierId}" data-field="monthlyLimit"
                 type="number" min="0" value="${t.monthlyLimit}" placeholder="0 = unlimited">
          <span class="admin-limit-hint">tokens</span>
        </div>
      </div>
      <div class="admin-tier-footer">
        <span class="admin-tier-msg" id="tier-msg-${t.tierId}"></span>
        <button class="admin-tier-save" data-tier="${t.tierId}">Save</button>
      </div>
    </div>`).join('');

  // Model toggle
  entityList.querySelectorAll('.admin-model-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = entityList.querySelector(`.admin-tier-card[data-tier="${btn.dataset.tier}"]`);
      card.querySelectorAll('.admin-model-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Save
  entityList.querySelectorAll('.admin-tier-save').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tierId = btn.dataset.tier;
      const card   = entityList.querySelector(`.admin-tier-card[data-tier="${tierId}"]`);
      const msg    = document.getElementById(`tier-msg-${tierId}`);
      const model  = card.querySelector('.admin-model-btn.active')?.dataset.model || 'simple';
      const limits = {};
      card.querySelectorAll('.admin-limit-input').forEach(inp => {
        limits[inp.dataset.field] = parseInt(inp.value) || 0;
      });

      btn.disabled = true;
      msg.textContent = '';
      try {
        await updateAdminTier(tierId, { model, ...limits });
        msg.textContent = '✓ Saved';
        msg.className   = 'admin-tier-msg admin-msg-ok';
      } catch (err) {
        msg.textContent = `✗ ${err.message}`;
        msg.className   = 'admin-tier-msg admin-msg-err';
      }
      btn.disabled = false;
    });
  });
}

// ── Status tab ─────────────────────────────────────────────────────────────

async function _renderStatus(entityList, detailContent) {
  const data = await getAdminStatus();
  const { jobs, userCount, config } = data;

  const fmtLimit = v => v ? v.toLocaleString() : 'unlimited';
  const fmtModel = s => s.split('.').pop();

  entityList.innerHTML = `
    <div class="admin-status">
      <div class="admin-status-section">
        <div class="admin-status-label">USERS</div>
        <div class="admin-stat-row"><span>Total</span><span>${userCount >= 0 ? userCount : '—'}</span></div>
      </div>
      <div class="admin-status-section">
        <div class="admin-status-label">JOBS (last 24h)</div>
        <div class="admin-stat-row"><span>Processing</span><span class="admin-stat-processing">${jobs.processing ?? 0}</span></div>
        <div class="admin-stat-row"><span>Done</span><span class="admin-stat-done">${jobs.done ?? 0}</span></div>
        <div class="admin-stat-row"><span>Error</span><span class="admin-stat-error">${jobs.error ?? 0}</span></div>
      </div>
      <div class="admin-status-section">
        <div class="admin-status-label">MODELS</div>
        <div class="admin-stat-row"><span>Simple</span><span title="${_esc(config.simpleModel)}">${_esc(fmtModel(config.simpleModel))}</span></div>
        <div class="admin-stat-row"><span>Complex</span><span title="${_esc(config.complexModel)}">${_esc(fmtModel(config.complexModel))}</span></div>
      </div>
      <div class="admin-status-section">
        <div class="admin-status-label">TOKEN LIMITS</div>
        <div class="admin-stat-row"><span>Daily</span><span>${fmtLimit(config.dailyLimit)}</span></div>
        <div class="admin-stat-row"><span>Weekly</span><span>${fmtLimit(config.weeklyLimit)}</span></div>
        <div class="admin-stat-row"><span>Monthly</span><span>${fmtLimit(config.monthlyLimit)}</span></div>
      </div>
    </div>`;
}

// ── Usage tab ──────────────────────────────────────────────────────────────

async function _renderUsage(entityList) {
  const { rows } = await getAdminUsage();

  if (!rows.length) {
    entityList.innerHTML = '<div class="empty-state">No usage data yet.</div>';
    return;
  }

  entityList.innerHTML = `
    <table class="admin-table">
      <thead>
        <tr>
          <th>User ID</th>
          <th style="text-align:right">Today</th>
          <th style="text-align:right">7 days</th>
          <th style="text-align:right">30 days</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td class="admin-uid">${_esc(r.userId)}</td>
            <td style="text-align:right">${_fmtTok(r.tokens1d)}</td>
            <td style="text-align:right">${_fmtTok(r.tokens7d)}</td>
            <td style="text-align:right">${_fmtTok(r.tokens30d)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

// ── Interest tab ───────────────────────────────────────────────────────────

async function _renderInterest(entityList) {
  entityList.innerHTML = '<div class="admin-loading">Running Athena query…</div>';
  const data = await getAdminInterest();

  if (!data.total && !data.daily?.length) {
    entityList.innerHTML = '<div class="empty-state">No interest submissions yet.</div>';
    return;
  }

  const pct = data.total ? Math.round((data.interested / data.total) * 100) : 0;

  entityList.innerHTML = `
    <div class="admin-interest-wrap">

      <div class="admin-stat-row">
        <div class="admin-stat-card">
          <div class="admin-stat-value">${data.total}</div>
          <div class="admin-stat-label">Total signups</div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-value" style="color:var(--accent)">${data.interested}</div>
          <div class="admin-stat-label">Would pay $3/mo</div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-value">${pct}%</div>
          <div class="admin-stat-label">Conversion</div>
        </div>
      </div>

      ${data.daily?.length ? `
      <div class="admin-interest-section">
        <div class="admin-interest-heading">Daily signups</div>
        <table class="admin-table">
          <thead>
            <tr><th>Date</th><th style="text-align:right">Signups</th><th style="text-align:right">Interested</th></tr>
          </thead>
          <tbody>
            ${data.daily.slice(0, 30).map(d => `
              <tr>
                <td>${_esc(d.day)}</td>
                <td style="text-align:right">${d.total}</td>
                <td style="text-align:right">${d.interested || '—'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>` : ''}

      ${data.recent?.length ? `
      <div class="admin-interest-section">
        <div class="admin-interest-heading">Recent signups</div>
        <table class="admin-table">
          <thead>
            <tr><th>Date</th><th>Name</th><th>Email</th><th style="text-align:center">$3/mo</th></tr>
          </thead>
          <tbody>
            ${data.recent.map(r => `
              <tr>
                <td class="admin-uid">${_esc((r.timestamp || '').slice(0, 10))}</td>
                <td>${_esc(r.name) || '<span style="color:var(--text-muted)">—</span>'}</td>
                <td>${_esc(r.email)}</td>
                <td style="text-align:center;color:var(--accent)">${r.interested ? '✓' : ''}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>` : ''}

    </div>`;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _fmtTok(n) {
  if (!n) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

import { isAdmin } from './auth.js';
import { getAdminUsers, createAdminUser, getAdminStatus, getAdminUsage } from './api.js';

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
        <button class="admin-tab${_tab === 'users'  ? ' active' : ''}" data-tab="users">Users</button>
        <button class="admin-tab${_tab === 'status' ? ' active' : ''}" data-tab="status">Status</button>
        <button class="admin-tab${_tab === 'usage'  ? ' active' : ''}" data-tab="usage">Usage</button>
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
    if (_tab === 'users')  await _renderUsers(entityList, detailContent);
    if (_tab === 'status') await _renderStatus(entityList, detailContent);
    if (_tab === 'usage')  await _renderUsage(entityList);
  } catch (err) {
    entityList.innerHTML = `<div class="empty-state">Error: ${_esc(err.message)}</div>`;
  }
}

// ── Users tab ──────────────────────────────────────────────────────────────

async function _renderUsers(entityList, detailContent) {
  const { users } = await getAdminUsers();

  if (!users.length) {
    entityList.innerHTML = '<div class="empty-state">No users found.</div>';
  } else {
    entityList.innerHTML = `
      <table class="admin-table">
        <thead><tr><th>Email</th><th>Status</th><th>Created</th></tr></thead>
        <tbody>
          ${users.map(u => `
            <tr>
              <td>${_esc(u.email)}</td>
              <td><span class="admin-badge admin-badge-${u.status.toLowerCase()}">${_esc(u.status)}</span></td>
              <td>${u.created ? new Date(u.created).toLocaleDateString() : '—'}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  detailContent.innerHTML = `
    <div class="admin-create-panel">
      <div class="admin-create-title">Create User</div>
      <div class="admin-create-note">Cognito will send a temporary password via email.</div>
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
      msg.textContent = `✓ Created ${email}`;
      msg.className   = 'admin-create-msg admin-msg-ok';
      input.value     = '';
      // Refresh list
      const { users: updated } = await getAdminUsers();
      entityList.querySelector('tbody').innerHTML = updated.map(u => `
        <tr>
          <td>${_esc(u.email)}</td>
          <td><span class="admin-badge admin-badge-${u.status.toLowerCase()}">${_esc(u.status)}</span></td>
          <td>${u.created ? new Date(u.created).toLocaleDateString() : '—'}</td>
        </tr>`).join('');
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

// ── Helpers ────────────────────────────────────────────────────────────────

function _esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _fmtTok(n) {
  if (!n) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

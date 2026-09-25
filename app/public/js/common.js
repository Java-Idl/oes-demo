// Shared helpers used by every page.
'use strict';

// fetch wrapper: sends cookies, JSON, and the anti-CSRF header the server requires
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && !path.startsWith('/auth/login') && !path.includes('/publish')) {
    location.href = '/?expired=1';
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

// Build DOM safely: text always goes through textContent, never innerHTML (XSS defence)
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

const $ = sel => document.querySelector(sel);
const fmt = d => d ? new Date(d).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const num = n => Number(n) % 1 === 0 ? String(Number(n)) : Number(n).toFixed(2);
const badge = (state, label) => el('span', { class: `badge b-${String(state).toLowerCase()}` }, label || String(state).replace(/_/g, ' '));

function showAlert(container, message, type = 'error') {
  container.replaceChildren(el('div', { class: `alert ${type}`, role: 'alert' }, message));
}
function toast(message) {
  const t = el('div', { class: 'toast', role: 'status' }, message);
  document.body.append(t); setTimeout(() => t.remove(), 2800);
}

// Top navigation for signed-in pages
const NAV = {
  STUDENT: [['Dashboard', '/student.html']],
  FACULTY: [['My Exams', '/faculty.html']],
  ADMIN: [['Users & Courses', '/admin.html'], ['Audit Log', '/admin.html#audit']],
};
function renderTopbar(user) {
  const bar = el('header', { class: 'topbar' },
    el('span', { class: 'brand' }, 'ExamSecure'),
    el('nav', {}, NAV[user.role].map(([label, href]) =>
      el('a', { href, class: location.pathname === href.split('#')[0] && !href.includes('#') ? 'active' : null }, label))),
    el('span', { class: 'who' }, `${user.full_name} (${user.role.toLowerCase()})`),
    el('button', { onclick: async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); location.href = '/'; } }, 'Logout'));
  document.body.prepend(bar);
}

// Every protected page calls this first; wrong role -> back to the right home page.
async function requireUser(role) {
  let me;
  try { me = await api('/auth/me'); } catch { return null; }
  if (role && me.role !== role) { location.href = homeFor(me.role); return null; }
  return me;
}
function homeFor(role) { return { STUDENT: '/student.html', FACULTY: '/faculty.html', ADMIN: '/admin.html' }[role] || '/'; }
function param(name) { return new URLSearchParams(location.search).get(name); }

'use strict';
(async function () {
  const msg = $('#msg');
  if (param('expired')) showAlert(msg, 'Please sign in to continue.', 'info');

  // already signed in? go straight to the dashboard
  const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
  if (r.ok) { const me = await r.json(); location.href = homeFor(me.role); return; }

  $('#show-pw').addEventListener('change', e => { $('#password').type = e.target.checked ? 'text' : 'password'; });

  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const username = $('#username').value.trim();
    const password = $('#password').value;
    if (!username || !password) return showAlert(msg, 'Enter your ID and password.');
    const btn = $('#submit-btn'); btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      const res = await api('/auth/login', { method: 'POST', body: { username, password } });
      location.href = homeFor(res.role);
    } catch (err) {
      let text = err.message;
      if (err.data && err.data.attemptsLeft !== undefined) text += ` ${err.data.attemptsLeft} attempt(s) left before a 15-minute lock.`;
      showAlert(msg, text);
      $('#password').value = '';
    } finally { btn.disabled = false; btn.textContent = 'Sign In'; }
  });
})();

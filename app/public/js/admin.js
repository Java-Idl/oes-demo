'use strict';
(async function () {
  const me = await requireUser('ADMIN'); if (!me) return;
  renderTopbar(me);

  async function loadUsers() {
    const users = await api('/admin/users');
    $('#user-rows').replaceChildren(...users.map(u => {
      const actions = [];
      if (u.locked) actions.push(el('button', { class: 'link', onclick: () => act(`/admin/users/${u.user_id}/unlock`, {}, 'Account unlocked') }, 'Unlock'));
      if (u.user_id !== me.user_id) {
        const disable = u.status === 'ACTIVE';
        actions.push(el('button', { class: 'link', onclick: () => act(`/admin/users/${u.user_id}/status`,
          { status: disable ? 'DISABLED' : 'ACTIVE' }, disable ? 'User disabled' : 'User enabled') }, disable ? 'Disable' : 'Enable'));
      }
      return el('tr', {},
        el('td', {}, u.full_name), el('td', {}, u.email), el('td', {}, u.role),
        el('td', {}, [u.roll_no, u.department].filter(Boolean).join(' · ') || '—'),
        el('td', {}, u.locked ? badge('locked', 'Locked') : badge(u.status)),
        el('td', {}, fmt(u.last_login)), el('td', {}, actions.length ? actions.flatMap((a, i) => i ? [' · ', a] : [a]) : '—'));
    }));
    $('#c-fac').replaceChildren(...users.filter(u => u.role === 'FACULTY' && u.faculty_id)
      .map(u => el('option', { value: u.faculty_id }, u.full_name)));
    $('#e-stu').replaceChildren(...users.filter(u => u.role === 'STUDENT' && u.student_id)
      .map(u => el('option', { value: u.student_id }, `${u.roll_no} – ${u.full_name}`)));
  }

  async function loadCourses() {
    const courses = await api('/admin/courses');
    $('#course-rows').replaceChildren(...courses.map(c => el('tr', {},
      el('td', {}, c.course_code), el('td', {}, c.title), el('td', {}, c.faculty_name), el('td', {}, String(c.enrolled)))));
    $('#e-course').replaceChildren(...courses.map(c => el('option', { value: c.course_id }, `${c.course_code} – ${c.title}`)));
  }

  async function loadAudit() {
    const rows = await api('/admin/audit');
    $('#audit-rows').replaceChildren(...rows.map(r => el('tr', {},
      el('td', {}, String(r.log_id)), el('td', {}, new Date(r.ts).toLocaleString()), el('td', {}, r.email || 'system'),
      el('td', {}, el('strong', {}, r.action)), el('td', {}, [r.entity, r.entity_id].filter(Boolean).join(' ') || '—'),
      el('td', { class: 'small' }, r.details && Object.keys(r.details).length ? JSON.stringify(r.details) : ''),
      el('td', { class: 'small' }, r.ip_address || ''))));
  }

  async function act(path, body, okText) {
    try { await api(path, { method: 'POST', body }); toast(okText); await Promise.all([loadUsers(), loadAudit()]); }
    catch (e) { showAlert($('#msg'), e.message); }
  }

  const syncRole = () => document.querySelectorAll('.student-only').forEach(n => n.classList.toggle('hidden', $('#u-role').value !== 'STUDENT'));
  $('#u-role').addEventListener('change', syncRole); syncRole();

  $('#user-form').addEventListener('submit', async e => {
    e.preventDefault();
    const body = { role: $('#u-role').value, full_name: $('#u-name').value.trim(), email: $('#u-email').value.trim(),
                   password: $('#u-pass').value, roll_no: $('#u-roll').value.trim(), department: $('#u-dept').value.trim() };
    if (!body.full_name || !body.email) return showAlert($('#user-msg'), 'Name and email are required.');
    if (body.password.length < 10) return showAlert($('#user-msg'), 'Password must be at least 10 characters.');
    try {
      await api('/admin/users', { method: 'POST', body });
      e.target.reset(); syncRole(); $('#user-msg').replaceChildren(); toast('User created');
      await Promise.all([loadUsers(), loadAudit()]);
    } catch (err) { showAlert($('#user-msg'), err.message); }
  });

  $('#course-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('/admin/courses', { method: 'POST', body: { course_code: $('#c-code').value, title: $('#c-title').value, faculty_id: $('#c-fac').value } });
      e.target.reset(); $('#course-msg').replaceChildren(); toast('Course added'); await Promise.all([loadCourses(), loadAudit()]);
    } catch (err) { showAlert($('#course-msg'), err.message); }
  });

  $('#enroll-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('/admin/enrollments', { method: 'POST', body: { student_id: $('#e-stu').value, course_id: $('#e-course').value } });
      toast('Student enrolled'); $('#enroll-msg').replaceChildren(); await Promise.all([loadCourses(), loadAudit()]);
    } catch (err) { showAlert($('#enroll-msg'), err.message); }
  });

  $('#verify-btn').addEventListener('click', async () => {
    const r = await api('/admin/audit/verify');
    showAlert($('#verify-msg'), r.ok ? `Chain intact: ${r.checked} entries verified.` : `Chain BROKEN at entry #${r.brokenAt} – the log has been tampered with.`,
              r.ok ? 'ok' : 'error');
  });
  $('#refresh-audit').addEventListener('click', loadAudit);

  try { await Promise.all([loadUsers(), loadCourses(), loadAudit()]); } catch (e) { showAlert($('#msg'), e.message); }
})();

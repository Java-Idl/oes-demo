'use strict';
(async function () {
  const me = await requireUser('FACULTY'); if (!me) return;
  renderTopbar(me);

  async function loadExams() {
    const exams = await api('/faculty/exams');
    const body = $('#exam-rows');
    if (!exams.length) return body.replaceChildren(el('tr', {}, el('td', { colspan: 8, class: 'muted' }, 'No exams yet – create one below.')));
    body.replaceChildren(...exams.map(x => el('tr', {},
      el('td', {}, x.course_code), el('td', {}, x.title),
      el('td', {}, `${fmt(x.start_time)} – ${fmt(x.end_time)} (${x.duration_min} min)`),
      el('td', {}, String(x.question_count)), el('td', {}, num(x.total_marks)), el('td', {}, String(x.submitted)),
      el('td', {}, badge(x.phase)),
      el('td', {}, el('a', { class: 'btn', href: `/faculty-exam.html?id=${encodeURIComponent(x.exam_id)}` },
                     x.phase === 'CLOSED' ? 'Review & Publish' : 'Open')))));
  }

  async function loadCourses() {
    const courses = await api('/faculty/courses');
    $('#course').replaceChildren(...courses.map(c => el('option', { value: c.course_id }, `${c.course_code} – ${c.title}`)));
    // sensible defaults: opens in 1 hour, closes 2 hours later
    const toLocal = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const s = new Date(Date.now() + 3600e3); s.setMinutes(0, 0, 0);
    $('#start').value = toLocal(s); $('#end').value = toLocal(new Date(s.getTime() + 2 * 3600e3));
  }

  $('#create-form').addEventListener('submit', async e => {
    e.preventDefault();
    const msg = $('#create-msg');
    const start = new Date($('#start').value); const end = new Date($('#end').value);
    const duration = Number($('#duration').value);
    if (!$('#title').value.trim()) return showAlert(msg, 'Enter a title.');
    if (isNaN(start) || isNaN(end) || end <= start) return showAlert(msg, 'The window must close after it opens.');
    if (!(duration >= 1) || duration > (end - start) / 60000) return showAlert(msg, 'Duration must fit inside the exam window.');
    try {
      const r = await api('/faculty/exams', { method: 'POST', body: {
        course_id: $('#course').value, title: $('#title').value.trim(),
        start_time: start.toISOString(), end_time: end.toISOString(), duration_min: duration } });
      location.href = `/faculty-exam.html?id=${encodeURIComponent(r.exam_id)}`;
    } catch (err) { showAlert(msg, err.message); }
  });

  try { await Promise.all([loadExams(), loadCourses()]); } catch (e) { showAlert($('#msg'), e.message); }
})();

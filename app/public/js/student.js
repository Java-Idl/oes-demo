'use strict';
(async function () {
  const me = await requireUser('STUDENT'); if (!me) return;
  renderTopbar(me);

  const STATE_LABEL = { LIVE: 'LIVE', IN_PROGRESS: 'In progress', UPCOMING: 'Upcoming', SUBMITTED: 'Submitted',
                        RESULT_PUBLISHED: 'Result published', MISSED: 'Missed', CLOSED: 'Closed', PUBLISHED: 'Closed' };

  async function loadExams() {
    const { exams } = await api('/student/exams');
    const body = $('#exam-rows');
    if (!exams.length) return body.replaceChildren(el('tr', {}, el('td', { colspan: 7, class: 'muted' }, 'No exams yet.')));
    body.replaceChildren(...exams.map(x => {
      let action = el('span', { class: 'muted' }, '—');
      if (x.state === 'LIVE' || x.state === 'IN_PROGRESS') {
        action = el('a', { class: 'btn success', href: `/exam.html?id=${encodeURIComponent(x.exam_id)}` },
                    x.state === 'LIVE' ? 'Start Exam' : 'Resume');
      } else if (x.state === 'UPCOMING') {
        action = el('span', { class: 'muted small' }, 'Opens ' + fmt(x.start_time));
      } else if (x.state === 'SUBMITTED') {
        action = el('span', { class: 'muted small' }, 'Submitted ' + fmt(x.submitted_at));
      }
      return el('tr', {},
        el('td', {}, x.course_code), el('td', {}, x.title),
        el('td', {}, `${fmt(x.start_time)} – ${fmt(x.end_time)}`),
        el('td', {}, `${x.duration_min} min`), el('td', {}, num(x.total_marks)),
        el('td', {}, badge(x.state, STATE_LABEL[x.state])), el('td', {}, action));
    }));
  }

  async function loadResults() {
    const results = await api('/student/results');
    const body = $('#result-rows');
    if (!results.length) return body.replaceChildren(el('tr', {}, el('td', { colspan: 7, class: 'muted' }, 'No published results yet.')));
    const latest = results[0];
    showAlert($('#banner'), `Results for "${latest.course_code} – ${latest.title}" have been published.`, 'info');
    body.replaceChildren(...results.map(r => el('tr', {},
      el('td', {}, r.course_code), el('td', {}, r.title),
      el('td', {}, `${num(r.total_score)} / ${num(r.total_marks)}`), el('td', {}, el('strong', {}, r.grade)),
      el('td', {}, fmt(r.published_at)),
      el('td', {}, r.integrity_ok ? badge('evaluated', 'Verified') : badge('pending', 'TAMPERED')),
      el('td', {}, el('button', { class: 'link', onclick: () => openResult(r) }, 'View details')))));
  }

  async function openResult(r) {
    const d = await api(`/student/results/${encodeURIComponent(r.attempt_id)}`);
    $('#rd-title').textContent = `${r.course_code} · ${r.title}`;
    $('#rd-body').replaceChildren(
      el('p', {}, el('strong', {}, `Score: ${num(d.total_score)} / ${num(r.total_marks)}   Grade: ${d.grade}`)),
      d.integrity_ok ? el('div', { class: 'alert ok' }, 'Integrity check passed: this result has not been modified since publication.')
                     : el('div', { class: 'alert error' }, 'Integrity check FAILED: contact the exam cell.'),
      el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Q'), el('th', {}, 'Your answer'), el('th', {}, 'Marks'))),
        el('tbody', {}, d.breakdown.map(b => el('tr', {},
          el('td', {}, String(b.seq_no)),
          el('td', {}, b.response == null || b.response === '' ? el('span', { class: 'muted' }, 'Not answered')
                     : b.q_type === 'MCQ' ? (b.options || [])[Number(b.response)] : b.response),
          el('td', {}, `${num(b.marks_awarded ?? 0)} / ${num(b.marks)}`))))));
    $('#result-dialog').showModal();
  }
  $('#rd-close').addEventListener('click', () => $('#result-dialog').close());

  try { await Promise.all([loadExams(), loadResults()]); }
  catch (e) { showAlert($('#msg'), e.message); }
  setInterval(() => loadExams().catch(() => {}), 30000);   // exam status changes with time
})();

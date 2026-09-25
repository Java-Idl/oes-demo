'use strict';
(async function () {
  const me = await requireUser('FACULTY'); if (!me) return;
  renderTopbar(me);
  const examId = param('id');
  const msg = $('#msg');
  let exam;

  function stat(k, v, cls) { return el('div', { class: 'stat' }, el('div', { class: 'k' }, k), el('div', { class: 'v ' + (cls || '') }, v)); }

  async function load() {
    exam = await api(`/faculty/exams/${encodeURIComponent(examId)}`);
    $('#exam-title').textContent = `${exam.course_code} · ${exam.title}`;
    $('#crumb').textContent = exam.title;
    $('#stats').replaceChildren(
      stat('Status', badge(exam.phase)), stat('Window', `${fmt(exam.start_time)} – ${fmt(exam.end_time)}`),
      stat('Duration', `${exam.duration_min} min`), stat('Total marks', num(exam.total_marks)));

    const editable = exam.status === 'DRAFT' || (exam.status === 'SCHEDULED' && new Date() < new Date(exam.start_time));
    $('#q-form').classList.toggle('hidden', !editable);
    $('#questions').replaceChildren(...(exam.questions.length ? exam.questions.map(q => el('div', { class: 'card question-item' },
      el('div', { class: 'q-head' }, el('span', {}, `Q${q.seq_no} · ${q.q_type === 'MCQ' ? 'Multiple choice' : 'Descriptive'}`),
         el('span', {}, `${num(q.marks)} marks`)),
      el('div', { class: 'q-text' }, q.q_text),
      q.q_type === 'MCQ' ? el('ol', { type: 'A' }, q.options.map((o, i) =>
        el('li', { class: String(i) === q.answer_key ? 'correct' : null }, o + (String(i) === q.answer_key ? '  ✓ correct' : '')))) : null,
      editable ? el('button', { class: 'link', onclick: () => removeQ(q.question_id) }, 'Remove') : null))
      : [el('p', { class: 'muted' }, 'No questions yet.')]));

    const sa = $('#schedule-actions'); sa.replaceChildren();
    if (exam.status === 'DRAFT') {
      sa.append(el('button', { class: 'success', onclick: schedule }, 'Schedule exam (make visible to students)'));
      sa.append(el('span', { class: 'muted small' }, 'Draft exams are not visible to students.'));
    }

    const review = ['LIVE', 'CLOSED', 'PUBLISHED'].includes(exam.phase);
    $('#review-section').classList.toggle('hidden', !review);
    if (review) await loadAttempts();
  }

  async function removeQ(qid) {
    if (!confirm('Remove this question from the exam?')) return;
    try { await api(`/faculty/exams/${examId}/questions/${qid}`, { method: 'DELETE' }); await load(); }
    catch (e) { showAlert(msg, e.message); }
  }
  async function schedule() {
    try { await api(`/faculty/exams/${examId}/schedule`, { method: 'POST' }); toast('Exam scheduled'); await load(); }
    catch (e) { showAlert(msg, e.message); }
  }

  // ---------- add-question form ----------
  function optionRow(i, text = '') {
    const radio = el('input', { type: 'radio', name: 'correct', value: String(i), class: 'inline-check', 'aria-label': `Option ${i + 1} is correct` });
    const input = el('input', { maxlength: 300, placeholder: `Option ${'ABCDEF'[i]}` }); input.value = text;
    return el('div', { class: 'grade-row opt-row' }, radio, input);
  }
  function resetOptions() { $('#opt-list').replaceChildren(optionRow(0), optionRow(1), optionRow(2), optionRow(3)); }
  resetOptions();
  $('#add-opt').addEventListener('click', () => {
    const n = $('#opt-list').children.length; if (n < 6) $('#opt-list').append(optionRow(n));
  });
  $('#q-type').addEventListener('change', () => $('#mcq-fields').classList.toggle('hidden', $('#q-type').value !== 'MCQ'));

  $('#q-form').addEventListener('submit', async e => {
    e.preventDefault();
    const q_type = $('#q-type').value;
    const body = { q_type, q_text: $('#q-text').value.trim(), marks: Number($('#q-marks').value) };
    if (!body.q_text) return showAlert($('#q-msg'), 'Enter the question text.');
    if (!(body.marks > 0)) return showAlert($('#q-msg'), 'Marks must be greater than 0.');
    if (q_type === 'MCQ') {
      const rows = [...document.querySelectorAll('.opt-row')];
      const filled = rows.map(r => ({ text: r.querySelector('input:not([type=radio])').value.trim(), correct: r.querySelector('input[type=radio]').checked }))
                         .filter(o => o.text);
      if (filled.length < 2) return showAlert($('#q-msg'), 'Enter at least two options.');
      const k = filled.findIndex(o => o.correct);
      if (k < 0) return showAlert($('#q-msg'), 'Select the correct option.');
      body.options = filled.map(o => o.text); body.answer_key = k;
    }
    try {
      await api(`/faculty/exams/${examId}/questions`, { method: 'POST', body });
      $('#q-text').value = ''; resetOptions(); $('#q-msg').replaceChildren(); toast('Question added');
      await load();
    } catch (err) { showAlert($('#q-msg'), err.message); }
  });

  // ---------- review, grading, publish ----------
  async function loadAttempts() {
    const { attempts } = await api(`/faculty/exams/${examId}/attempts`);
    const pending = attempts.reduce((s, a) => s + a.pending, 0);
    const inProgress = attempts.filter(a => a.status === 'IN_PROGRESS').length;
    $('#attempt-rows').replaceChildren(...(attempts.length ? attempts.map(a => el('tr', {},
      el('td', {}, a.roll_no), el('td', {}, a.full_name),
      el('td', {}, a.submitted_at ? fmt(a.submitted_at) + (a.status === 'AUTO_SUBMITTED' ? ' (auto)' : '') : '—'),
      el('td', {}, a.status === 'IN_PROGRESS' ? '—' : `${num(a.total)} / ${num(exam.total_marks)}`),
      el('td', {}, a.status === 'IN_PROGRESS' ? badge('in_progress', 'In progress')
                 : a.pending ? badge('pending', 'Needs grading') : badge('evaluated', 'Evaluated')),
      el('td', {}, a.status !== 'IN_PROGRESS' ? el('button', { class: 'link', onclick: () => openAttempt(a.attempt_id) },
                                                  a.pending && exam.phase !== 'PUBLISHED' ? 'Grade' : 'View') : null)))
      : [el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'No submissions yet.'))]));

    const btn = $('#publish-btn'); const pm = $('#publish-msg');
    btn.classList.toggle('hidden', exam.phase === 'PUBLISHED');
    if (exam.phase === 'PUBLISHED') showAlert(pm, 'Results are published. Marks are now read-only.', 'ok');
    else if (exam.phase === 'LIVE') { btn.disabled = true; showAlert(pm, `The exam is still running (${inProgress} in progress). Publishing opens after the window closes.`, 'info'); }
    else if (pending) { btn.disabled = true; showAlert(pm, `${pending} answer(s) need manual grading – Publish is disabled until done.`, 'warn'); }
    else { btn.disabled = false; pm.replaceChildren(); }
  }

  async function openAttempt(attemptId) {
    const { attempt, answers } = await api(`/faculty/attempts/${encodeURIComponent(attemptId)}`);
    const frozen = exam.phase === 'PUBLISHED';
    const box = $('#grading');
    box.replaceChildren(el('h2', {}, `${attempt.roll_no} · ${attempt.full_name}`),
      el('p', { class: 'muted small' }, `Submission receipt: ${attempt.submission_hash}`),
      ...answers.map(a => {
        const card = el('div', { class: 'card question-item' },
          el('div', { class: 'q-head' }, el('span', {}, `Q${a.seq_no}`), el('span', {}, `${a.marks_awarded == null ? '?' : num(a.marks_awarded)} / ${num(a.marks)}`)),
          el('div', { class: 'q-text' }, a.q_text));
        if (a.q_type === 'MCQ') {
          const chosen = a.response == null ? 'Not answered' : a.options[Number(a.response)];
          card.append(el('p', {}, 'Answer: ', el('strong', {}, chosen)), el('p', { class: 'muted small' }, `Correct: ${a.options[Number(a.answer_key)]}`));
        } else {
          card.append(el('div', { class: 'pre' }, a.response || '(not answered)'));
          if (!frozen && a.response) {
            const input = el('input', { type: 'number', min: 0, max: a.marks, step: 0.5, 'aria-label': 'Marks' });
            if (a.marks_awarded != null) input.value = num(a.marks_awarded);
            const save = el('button', { class: 'primary', onclick: async () => {
              const m = Number(input.value);
              if (input.value === '' || m < 0 || m > Number(a.marks)) return toast(`Enter marks between 0 and ${num(a.marks)}`);
              try { await api(`/faculty/answers/${a.answer_id}/grade`, { method: 'POST', body: { marks: m } });
                    toast('Marks saved'); await loadAttempts(); await openAttempt(attemptId); }
              catch (e) { toast(e.message); }
            } }, 'Save marks');
            card.append(el('div', { class: 'grade-row' }, el('span', {}, 'Marks:'), input, el('span', { class: 'muted' }, `/ ${num(a.marks)}`), save));
          }
        }
        return card;
      }));
    box.scrollIntoView({ behavior: 'smooth' });
  }

  $('#publish-btn').addEventListener('click', () => { $('#pd-password').value = ''; $('#pd-msg').replaceChildren(); $('#publish-dialog').showModal(); });
  $('#pd-cancel').addEventListener('click', () => $('#publish-dialog').close());
  $('#pd-confirm').addEventListener('click', async () => {
    try {
      const r = await api(`/faculty/exams/${examId}/publish`, { method: 'POST', body: { password: $('#pd-password').value } });
      $('#publish-dialog').close(); toast(`Results published for ${r.published} student(s)`); await load();
    } catch (e) { showAlert($('#pd-msg'), e.message); }
  });

  try { await load(); } catch (e) { showAlert(msg, e.message); }
})();

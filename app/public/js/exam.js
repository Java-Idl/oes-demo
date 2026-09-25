'use strict';
(async function () {
  const me = await requireUser('STUDENT'); if (!me) return;
  const examId = param('id');
  const msg = $('#msg');

  let data;
  try { data = await api(`/student/exams/${encodeURIComponent(examId || '')}/start`, { method: 'POST' }); }
  catch (e) {
    showAlert(msg, e.message);
    msg.append(el('a', { class: 'btn', href: '/student.html' }, 'Back to dashboard'));
    $('#exam-title').textContent = 'Exam unavailable';
    return;
  }

  const attemptId = data.attempt_id;
  const questions = data.questions;
  const answers = {};                       // question_id -> response
  for (const a of data.answers) if (a.response !== null && a.response !== '') answers[a.question_id] = a.response;
  const marked = new Set();
  const dirty = new Set();                  // question ids waiting to be saved
  let current = 0; let finished = false;

  // The server's clock is the authority; we only correct for the offset to display the timer.
  const offset = new Date(data.serverTime).getTime() - Date.now();
  const deadline = new Date(data.deadline).getTime();

  $('#exam-title').textContent = `${data.exam.title} · ${num(data.exam.total_marks)} marks`;
  $('#layout').classList.remove('hidden');

  // ---------- saving ----------
  const saveState = $('#save-state');
  function setSave(text, bad = false) { saveState.textContent = text; saveState.classList.toggle('bad', bad); }

  async function saveOne(qid, tries = 3) {
    for (let i = 1; i <= tries; i++) {
      try {
        const r = await api(`/student/attempts/${attemptId}/answers`, { method: 'PUT',
          body: { question_id: qid, response: answers[qid] ?? null } });
        return r.saved_at;
      } catch (e) {
        if (e.status === 409 || e.status === 404) { endWith(e.message); throw e; }
        if (i === tries) throw e;
        await new Promise(r => setTimeout(r, 1000 * i));
      }
    }
  }
  let saving = false;
  async function flush() {
    if (saving || finished || !dirty.size) return;
    saving = true;
    try {
      for (const qid of [...dirty]) {
        const at = await saveOne(qid);
        dirty.delete(qid);
        setSave(`✓ All answers saved · ${new Date(at).toLocaleTimeString()}`);
      }
    } catch (e) {
      if (!finished) setSave('⚠ Not saved – retrying…', true);
    } finally { saving = false; }
  }
  let debounce;
  function changed(qid, value) {
    if (value === null || value === '') delete answers[qid]; else answers[qid] = value;
    dirty.add(qid); setSave('Saving…');
    clearTimeout(debounce); debounce = setTimeout(flush, 700);
    renderPalette();
  }
  setInterval(flush, 30000);               // periodic autosave (FR-08)

  // ---------- rendering ----------
  function renderQuestion() {
    const q = questions[current];
    $('#q-count').textContent = `Question ${current + 1} of ${questions.length}`;
    $('#q-marks').textContent = `${num(q.marks)} mark${Number(q.marks) === 1 ? '' : 's'}`;
    $('#q-text').textContent = q.q_text;
    const box = $('#q-answer');
    if (q.q_type === 'MCQ') {
      box.replaceChildren(...q.options.map((opt, i) => {
        const checked = answers[q.question_id] === String(i);
        const input = el('input', { type: 'radio', name: 'opt', value: String(i), checked });
        const label = el('label', { class: 'option' + (checked ? ' selected' : '') }, input, `${'ABCDEF'[i]}.  ${opt}`);
        input.addEventListener('change', () => { changed(q.question_id, String(i)); renderQuestion(); });
        return label;
      }));
    } else {
      const ta = el('textarea', { maxlength: 5000, 'aria-label': 'Your answer', placeholder: 'Type your answer here…' });
      ta.value = answers[q.question_id] || '';
      ta.addEventListener('input', () => changed(q.question_id, ta.value));
      box.replaceChildren(ta, el('div', { class: 'muted small' }, 'Max 5000 characters. Saved automatically.'));
    }
    $('#prev-btn').disabled = current === 0;
    $('#next-btn').textContent = current === questions.length - 1 ? 'Save' : 'Save & Next ▶';
    $('#mark-btn').textContent = marked.has(q.question_id) ? '⚑ Unmark' : '⚑ Mark for review';
    renderPalette();
  }

  function renderPalette() {
    $('#palette').replaceChildren(...questions.map((q, i) => {
      const cls = [answers[q.question_id] !== undefined ? 'answered' : '', marked.has(q.question_id) ? 'marked' : '',
                   i === current ? 'current' : ''].join(' ');
      return el('button', { class: cls, 'aria-label': `Question ${i + 1}`, onclick: () => { current = i; renderQuestion(); } }, String(i + 1));
    }));
    const answered = questions.filter(q => answers[q.question_id] !== undefined).length;
    $('#legend').replaceChildren(
      el('div', {}, el('span', { class: 'l-ans' }), `Answered (${answered})`),
      el('div', {}, el('span', { class: 'l-mark' }), `Marked for review (${marked.size})`),
      el('div', {}, el('span', { class: 'l-none' }), `Not answered (${questions.length - answered})`));
  }

  $('#prev-btn').addEventListener('click', () => { if (current > 0) { current--; renderQuestion(); } });
  $('#next-btn').addEventListener('click', () => { flush(); if (current < questions.length - 1) { current++; renderQuestion(); } });
  $('#clear-btn').addEventListener('click', () => { changed(questions[current].question_id, null); renderQuestion(); });
  $('#mark-btn').addEventListener('click', () => {
    const id = questions[current].question_id; marked.has(id) ? marked.delete(id) : marked.add(id); renderQuestion();
  });

  // ---------- timer ----------
  const timer = $('#timer');
  function tick() {
    const left = Math.max(0, deadline - (Date.now() + offset));
    const s = Math.floor(left / 1000);
    timer.textContent = `Time left ${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    timer.classList.toggle('low', s < 300);
    if (left <= 0 && !finished) submit(true);
  }
  const timerId = setInterval(tick, 1000); tick();

  // ---------- submit ----------
  $('#submit-btn').addEventListener('click', () => {
    const answered = questions.filter(q => answers[q.question_id] !== undefined).length;
    $('#confirm-text').textContent = `${answered} answered, ${marked.size} marked for review, ${questions.length - answered} unanswered.`;
    $('#confirm-dialog').showModal();
  });
  $('#go-back').addEventListener('click', () => $('#confirm-dialog').close());
  $('#confirm-submit').addEventListener('click', () => submit(false));

  async function submit(auto) {
    if (finished) return;
    $('#confirm-submit').disabled = true;
    try {
      clearTimeout(debounce);
      if (!auto) await flush();
      const r = await api(`/student/attempts/${attemptId}/submit`, { method: 'POST' });
      showReceipt(r, auto);
    } catch (e) {
      if (e.status === 409) endWith(e.message);
      else { showAlert(msg, e.message); $('#confirm-submit').disabled = false; }
    }
  }
  function showReceipt(r, auto) {
    finished = true; clearInterval(timerId);
    if ($('#confirm-dialog').open) $('#confirm-dialog').close();
    $('#receipt-body').replaceChildren(
      el('p', {}, auto ? 'Time is over – your answers were submitted automatically.' : 'Your answers have been recorded.'),
      el('p', {}, `Answered ${r.answered} of ${r.total} questions · ${new Date(r.submitted_at).toLocaleString()}`),
      el('p', { class: 'muted small' }, 'Submission receipt (keep this as proof):'),
      el('div', { class: 'receipt' }, r.submission_hash));
    $('#receipt-dialog').showModal();
  }
  function endWith(text) {
    if (finished) return;
    finished = true; clearInterval(timerId);
    $('#layout').classList.add('hidden');
    showAlert(msg, text, 'warn');
    msg.append(el('a', { class: 'btn primary', href: '/student.html' }, 'Back to dashboard'));
  }

  window.addEventListener('beforeunload', e => { if (!finished && dirty.size) { e.preventDefault(); e.returnValue = ''; } });
  renderQuestion();
})();

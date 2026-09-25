// Faculty API. Every exam/attempt/answer is checked against courses.faculty_id = me.
const express = require('express');
const db = require('../db');
const audit = require('../audit');
const { phase, finalize, grade } = require('../exams');
const { encrypt, decrypt, hmac, resultPayload } = require('../security');
const { verifyPassword, clientIp } = require('../auth');

const router = express.Router();
const UUID = /^[0-9a-f-]{36}$/i;

async function ownExam(examId, facultyId) {
  if (!UUID.test(examId)) return null;
  return (await db.query(
    `SELECT e.*, c.course_code, c.title AS course_title FROM exams e
       JOIN courses c ON c.course_id = e.course_id
      WHERE e.exam_id = $1 AND c.faculty_id = $2`, [examId, facultyId])).rows[0];
}
async function denied(req, entity, id) {
  await audit.log({ userId: req.user.user_id, action: 'ACCESS_DENIED', entity, entityId: id, ip: clientIp(req) });
}

router.get('/courses', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT course_id, course_code, title FROM courses WHERE faculty_id = $1 ORDER BY course_code',
                                    [req.user.faculty_id]);
    res.json(rows);
  } catch (e) { next(e); }
});

router.get('/exams', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT e.exam_id, e.title, e.start_time, e.end_time, e.duration_min, e.total_marks, e.status,
              c.course_code,
              (SELECT count(*) FROM exam_questions eq WHERE eq.exam_id = e.exam_id)::int AS question_count,
              (SELECT count(*) FROM attempts a WHERE a.exam_id = e.exam_id AND a.status <> 'IN_PROGRESS')::int AS submitted
         FROM exams e JOIN courses c ON c.course_id = e.course_id
        WHERE c.faculty_id = $1 ORDER BY e.start_time DESC`, [req.user.faculty_id]);
    res.json(rows.map(r => ({ ...r, phase: phase(r) })));
  } catch (e) { next(e); }
});

// FR-11: create exam (as DRAFT)
router.post('/exams', async (req, res, next) => {
  try {
    const { course_id, title, start_time, end_time, duration_min } = req.body;
    const course = (await db.query('SELECT course_id FROM courses WHERE course_id = $1 AND faculty_id = $2',
                                   [Number(course_id), req.user.faculty_id])).rows[0];
    if (!course) { await denied(req, 'course', course_id); return res.status(403).json({ error: 'You do not teach this course.' }); }
    const t = String(title || '').trim();
    const start = new Date(start_time); const end = new Date(end_time); const dur = Number(duration_min);
    if (!t || t.length > 150) return res.status(400).json({ error: 'Title is required (max 150 characters).' });
    if (isNaN(start) || isNaN(end) || end <= start) return res.status(400).json({ error: 'End time must be after start time.' });
    if (!Number.isInteger(dur) || dur < 1 || dur > (end - start) / 60000)
      return res.status(400).json({ error: 'Duration must be a whole number of minutes that fits inside the exam window.' });
    const exam = (await db.query(
      `INSERT INTO exams (course_id, created_by, title, start_time, end_time, duration_min)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING exam_id`,
      [course.course_id, req.user.faculty_id, t, start, end, dur])).rows[0];
    await audit.log({ userId: req.user.user_id, action: 'EXAM_CREATE', entity: 'exam', entityId: exam.exam_id, details: { title: t }, ip: clientIp(req) });
    res.status(201).json(exam);
  } catch (e) { next(e); }
});

// exam detail incl. answer keys (faculty only)
router.get('/exams/:examId', async (req, res, next) => {
  try {
    const exam = await ownExam(req.params.examId, req.user.faculty_id);
    if (!exam) { await denied(req, 'exam', req.params.examId); return res.status(404).json({ error: 'Exam not found.' }); }
    const questions = (await db.query(
      `SELECT q.question_id, q.q_type, q.q_text, q.options, q.marks, q.answer_key_enc, eq.seq_no
         FROM exam_questions eq JOIN questions q ON q.question_id = eq.question_id
        WHERE eq.exam_id = $1 ORDER BY eq.seq_no`, [exam.exam_id])).rows
      .map(({ answer_key_enc, ...q }) => ({ ...q, answer_key: decrypt(answer_key_enc) }));
    res.json({ ...exam, phase: phase(exam), questions });
  } catch (e) { next(e); }
});

function editable(exam) {
  return exam.status === 'DRAFT' || (exam.status === 'SCHEDULED' && new Date() < new Date(exam.start_time));
}

// FR-12: add question (only before the exam starts)
router.post('/exams/:examId/questions', async (req, res, next) => {
  try {
    const exam = await ownExam(req.params.examId, req.user.faculty_id);
    if (!exam) { await denied(req, 'exam', req.params.examId); return res.status(404).json({ error: 'Exam not found.' }); }
    if (!editable(exam)) return res.status(409).json({ error: 'Questions cannot be changed after the exam has started.' });
    const q_type = req.body.q_type === 'TEXT' ? 'TEXT' : 'MCQ';
    const q_text = String(req.body.q_text || '').trim();
    const marks = Number(req.body.marks);
    if (!q_text || q_text.length > 2000) return res.status(400).json({ error: 'Question text is required (max 2000 characters).' });
    if (!(marks > 0 && marks <= 100)) return res.status(400).json({ error: 'Marks must be between 0 and 100.' });
    let options = null; let key = null;
    if (q_type === 'MCQ') {
      options = (Array.isArray(req.body.options) ? req.body.options : []).map(o => String(o).trim()).filter(Boolean);
      if (options.length < 2 || options.length > 6) return res.status(400).json({ error: 'An MCQ needs 2 to 6 options.' });
      const k = Number(req.body.answer_key);
      if (!Number.isInteger(k) || k < 0 || k >= options.length) return res.status(400).json({ error: 'Choose the correct option.' });
      key = String(k);
    }
    const qid = await db.tx(async c => {
      const q = (await c.query(
        `INSERT INTO questions (course_id, q_type, q_text, options, answer_key_enc, marks)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING question_id`,
        [exam.course_id, q_type, q_text, options ? JSON.stringify(options) : null, key === null ? null : encrypt(key), marks])).rows[0];
      await c.query(`INSERT INTO exam_questions (exam_id, question_id, seq_no)
                     VALUES ($1,$2,(SELECT coalesce(max(seq_no),0)+1 FROM exam_questions WHERE exam_id = $1))`,
                    [exam.exam_id, q.question_id]);
      await c.query(`UPDATE exams SET total_marks = (SELECT coalesce(sum(q.marks),0) FROM exam_questions eq
                       JOIN questions q ON q.question_id = eq.question_id WHERE eq.exam_id = $1) WHERE exam_id = $1`, [exam.exam_id]);
      await audit.write(c, { userId: req.user.user_id, action: 'QUESTION_ADD', entity: 'exam', entityId: exam.exam_id, ip: clientIp(req) });
      return q.question_id;
    });
    res.status(201).json({ question_id: qid });
  } catch (e) { next(e); }
});

router.delete('/exams/:examId/questions/:qid', async (req, res, next) => {
  try {
    const exam = await ownExam(req.params.examId, req.user.faculty_id);
    if (!exam || !UUID.test(req.params.qid)) return res.status(404).json({ error: 'Not found.' });
    if (!editable(exam)) return res.status(409).json({ error: 'Questions cannot be changed after the exam has started.' });
    await db.tx(async c => {
      await c.query('DELETE FROM exam_questions WHERE exam_id = $1 AND question_id = $2', [exam.exam_id, req.params.qid]);
      await c.query(`UPDATE exams SET total_marks = (SELECT coalesce(sum(q.marks),0) FROM exam_questions eq
                       JOIN questions q ON q.question_id = eq.question_id WHERE eq.exam_id = $1) WHERE exam_id = $1`, [exam.exam_id]);
      await audit.write(c, { userId: req.user.user_id, action: 'QUESTION_REMOVE', entity: 'exam', entityId: exam.exam_id, ip: clientIp(req) });
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// DRAFT -> SCHEDULED (makes it visible to enrolled students)
router.post('/exams/:examId/schedule', async (req, res, next) => {
  try {
    const exam = await ownExam(req.params.examId, req.user.faculty_id);
    if (!exam) return res.status(404).json({ error: 'Exam not found.' });
    if (exam.status !== 'DRAFT') return res.status(409).json({ error: 'Only draft exams can be scheduled.' });
    const n = (await db.query('SELECT count(*)::int AS n FROM exam_questions WHERE exam_id = $1', [exam.exam_id])).rows[0].n;
    if (n === 0) return res.status(400).json({ error: 'Add at least one question first.' });
    await db.query(`UPDATE exams SET status = 'SCHEDULED' WHERE exam_id = $1`, [exam.exam_id]);
    await audit.log({ userId: req.user.user_id, action: 'EXAM_SCHEDULE', entity: 'exam', entityId: exam.exam_id, ip: clientIp(req) });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// submissions overview for review & publish (screen S4)
router.get('/exams/:examId/attempts', async (req, res, next) => {
  try {
    const exam = await ownExam(req.params.examId, req.user.faculty_id);
    if (!exam) return res.status(404).json({ error: 'Exam not found.' });
    const { rows } = await db.query(
      `SELECT a.attempt_id, a.status, a.submitted_at, s.roll_no, u.full_name,
              coalesce(sum(an.marks_awarded),0) AS total,
              count(an.answer_id) FILTER (WHERE an.marks_awarded IS NULL)::int AS pending
         FROM attempts a
         JOIN students s ON s.student_id = a.student_id
         JOIN users u ON u.user_id = s.user_id
         LEFT JOIN answers an ON an.attempt_id = a.attempt_id
        WHERE a.exam_id = $1
        GROUP BY a.attempt_id, s.roll_no, u.full_name ORDER BY s.roll_no`, [exam.exam_id]);
    res.json({ exam: { ...exam, phase: phase(exam) }, attempts: rows });
  } catch (e) { next(e); }
});

router.get('/attempts/:attemptId', async (req, res, next) => {
  try {
    const { attemptId } = req.params;
    if (!UUID.test(attemptId)) return res.status(404).json({ error: 'Not found.' });
    const a = (await db.query(
      `SELECT a.*, s.roll_no, u.full_name FROM attempts a
         JOIN exams e ON e.exam_id = a.exam_id JOIN courses c ON c.course_id = e.course_id
         JOIN students s ON s.student_id = a.student_id JOIN users u ON u.user_id = s.user_id
        WHERE a.attempt_id = $1 AND c.faculty_id = $2`, [attemptId, req.user.faculty_id])).rows[0];
    if (!a) { await denied(req, 'attempt', attemptId); return res.status(404).json({ error: 'Not found.' }); }
    const answers = (await db.query(
      `SELECT an.answer_id, eq.seq_no, q.q_type, q.q_text, q.options, q.marks, q.answer_key_enc, an.response, an.marks_awarded
         FROM exam_questions eq JOIN questions q ON q.question_id = eq.question_id
         LEFT JOIN answers an ON an.question_id = q.question_id AND an.attempt_id = $1
        WHERE eq.exam_id = $2 ORDER BY eq.seq_no`, [a.attempt_id, a.exam_id])).rows
      .map(({ answer_key_enc, ...r }) => ({ ...r, answer_key: decrypt(answer_key_enc) }));
    res.json({ attempt: { attempt_id: a.attempt_id, roll_no: a.roll_no, full_name: a.full_name, status: a.status,
                          submitted_at: a.submitted_at, submission_hash: a.submission_hash }, answers });
  } catch (e) { next(e); }
});

// FR-13: manual grading of descriptive answers (range-checked, audited, blocked after publish)
router.post('/answers/:answerId/grade', async (req, res, next) => {
  try {
    const { answerId } = req.params;
    if (!UUID.test(answerId)) return res.status(404).json({ error: 'Not found.' });
    const row = (await db.query(
      `SELECT an.answer_id, an.marks_awarded, q.marks, q.q_type, e.status AS exam_status, a.status AS attempt_status
         FROM answers an JOIN questions q ON q.question_id = an.question_id
         JOIN attempts a ON a.attempt_id = an.attempt_id JOIN exams e ON e.exam_id = a.exam_id
         JOIN courses c ON c.course_id = e.course_id
        WHERE an.answer_id = $1 AND c.faculty_id = $2`, [answerId, req.user.faculty_id])).rows[0];
    if (!row) { await denied(req, 'answer', answerId); return res.status(404).json({ error: 'Not found.' }); }
    if (row.exam_status === 'PUBLISHED') return res.status(409).json({ error: 'Results are published; marks are frozen.' });
    if (row.attempt_status === 'IN_PROGRESS') return res.status(409).json({ error: 'The attempt is still in progress.' });
    const m = Number(req.body.marks);
    if (!(m >= 0 && m <= Number(row.marks))) return res.status(400).json({ error: `Marks must be between 0 and ${row.marks}.` });
    await db.tx(async c => {
      await c.query('UPDATE answers SET marks_awarded = $2, graded_by = $3 WHERE answer_id = $1', [answerId, m, req.user.faculty_id]);
      await audit.write(c, { userId: req.user.user_id, action: 'GRADE', entity: 'answer', entityId: answerId,
                             details: { old: row.marks_awarded, new: m }, ip: clientIp(req) });
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// FR-14 / UC9: publish with re-authentication, HMAC per result, read-only afterwards
router.post('/exams/:examId/publish', async (req, res, next) => {
  try {
    const ip = clientIp(req);
    const exam = await ownExam(req.params.examId, req.user.faculty_id);
    if (!exam) { await denied(req, 'exam', req.params.examId); return res.status(404).json({ error: 'Exam not found.' }); }
    const p = phase(exam);
    if (p === 'PUBLISHED') return res.status(409).json({ error: 'Results are already published.' });
    if (p !== 'CLOSED') return res.status(409).json({ error: 'Results can be published only after the exam window closes.' });
    if (!(await verifyPassword(req.user.user_id, req.body.password))) {
      await audit.log({ userId: req.user.user_id, action: 'PUBLISH_REAUTH_FAILED', entity: 'exam', entityId: exam.exam_id, ip });
      return res.status(401).json({ error: 'Password incorrect. Results were not published.' });
    }
    // close any attempt whose deadline passed but was not yet auto-submitted
    const open = (await db.query(`SELECT attempt_id FROM attempts WHERE exam_id = $1 AND status = 'IN_PROGRESS'`, [exam.exam_id])).rows;
    for (const o of open) await finalize(o.attempt_id, { auto: true });

    const out = await db.tx(async c => {
      const locked = (await c.query('SELECT status FROM exams WHERE exam_id = $1 FOR UPDATE', [exam.exam_id])).rows[0];
      if (locked.status === 'PUBLISHED') return { error: 'Results are already published.', code: 409 };
      const pending = (await c.query(
        `SELECT count(*)::int AS n FROM answers an JOIN attempts a ON a.attempt_id = an.attempt_id
          WHERE a.exam_id = $1 AND an.marks_awarded IS NULL`, [exam.exam_id])).rows[0].n;
      if (pending > 0) return { error: `${pending} answer(s) still need manual grading.`, code: 409 };

      const attempts = (await c.query(
        `SELECT a.attempt_id, coalesce(sum(an.marks_awarded),0) AS total FROM attempts a
           LEFT JOIN answers an ON an.attempt_id = a.attempt_id WHERE a.exam_id = $1 GROUP BY a.attempt_id`, [exam.exam_id])).rows;
      const publishedAt = new Date();
      for (const a of attempts) {
        const pct = Number(exam.total_marks) > 0 ? (Number(a.total) / Number(exam.total_marks)) * 100 : 0;
        const r = { result_id: require('crypto').randomUUID(), attempt_id: a.attempt_id, total_score: Number(a.total),
                    grade: grade(pct), published_at: publishedAt, version: 1 };
        await c.query(
          `INSERT INTO results (result_id, attempt_id, total_score, grade, published_by, published_at, integrity_hash, version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [r.result_id, r.attempt_id, r.total_score, r.grade, req.user.faculty_id, publishedAt, hmac(resultPayload(r)), 1]);
      }
      await c.query(`UPDATE exams SET status = 'PUBLISHED' WHERE exam_id = $1`, [exam.exam_id]);
      await audit.write(c, { userId: req.user.user_id, action: 'RESULTS_PUBLISH', entity: 'exam', entityId: exam.exam_id,
                             details: { results: attempts.length }, ip });
      return { published: attempts.length };
    });
    if (out.error) return res.status(out.code).json({ error: out.error });
    // Simulated Notification Service (TB3): send only a link, never the marks.
    console.log(`[notification] Results published for exam ${exam.exam_id}: ${out.published} student(s) notified.`);
    res.json(out);
  } catch (e) { next(e); }
});

module.exports = router;

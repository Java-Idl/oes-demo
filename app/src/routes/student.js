// Student API. Every query is scoped to req.user.student_id (object-level authorization, V02).
const express = require('express');
const db = require('../db');
const config = require('../config');
const audit = require('../audit');
const { phase, finalize } = require('../exams');
const { hmac, resultPayload, safeEqual } = require('../security');
const { clientIp } = require('../auth');

const router = express.Router();
const UUID = /^[0-9a-f-]{36}$/i;

// FR-05: exams of enrolled courses only (drafts are never visible)
router.get('/exams', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT e.exam_id, e.title, e.start_time, e.end_time, e.duration_min, e.total_marks, e.status,
              c.course_code, c.title AS course_title,
              a.attempt_id, a.status AS attempt_status, a.submitted_at
         FROM exams e
         JOIN courses c ON c.course_id = e.course_id
         JOIN enrollments en ON en.course_id = c.course_id AND en.student_id = $1
         LEFT JOIN attempts a ON a.exam_id = e.exam_id AND a.student_id = $1
        WHERE e.status <> 'DRAFT'
        ORDER BY e.start_time DESC`, [req.user.student_id]);
    const now = new Date();
    res.json({
      serverTime: now,
      exams: rows.map(r => {
        const p = phase(r, now);
        let state = p;
        if (r.attempt_status === 'IN_PROGRESS' && p === 'LIVE') state = 'IN_PROGRESS';
        else if (r.attempt_status && r.attempt_status !== 'IN_PROGRESS') state = p === 'PUBLISHED' ? 'RESULT_PUBLISHED' : 'SUBMITTED';
        else if (!r.attempt_id && (p === 'CLOSED' || p === 'PUBLISHED')) state = 'MISSED';
        return { exam_id: r.exam_id, title: r.title, course_code: r.course_code, course_title: r.course_title,
                 start_time: r.start_time, end_time: r.end_time, duration_min: r.duration_min,
                 total_marks: r.total_marks, state, attempt_id: r.attempt_id, submitted_at: r.submitted_at };
      }),
    });
  } catch (e) { next(e); }
});

// FR-06/07: start or resume an attempt - only inside the window, only once
router.post('/exams/:examId/start', async (req, res, next) => {
  try {
    const { examId } = req.params;
    if (!UUID.test(examId)) return res.status(404).json({ error: 'Exam not found.' });
    const sid = req.user.student_id; const ip = clientIp(req);

    const exam = (await db.query(
      `SELECT e.* FROM exams e JOIN enrollments en ON en.course_id = e.course_id AND en.student_id = $2
        WHERE e.exam_id = $1`, [examId, sid])).rows[0];
    if (!exam) {
      await audit.log({ userId: req.user.user_id, action: 'EXAM_ACCESS_DENIED', entity: 'exam', entityId: examId, details: { reason: 'not enrolled' }, ip });
      return res.status(404).json({ error: 'Exam not found.' });
    }
    if (phase(exam) !== 'LIVE') return res.status(409).json({ error: 'This exam is not open right now.' });

    let attempt = (await db.query('SELECT * FROM attempts WHERE exam_id = $1 AND student_id = $2', [examId, sid])).rows[0];
    if (attempt && attempt.status !== 'IN_PROGRESS') return res.status(409).json({ error: 'You have already submitted this exam.' });
    if (attempt && new Date(attempt.deadline) < new Date()) {
      await finalize(attempt.attempt_id, { auto: true });
      return res.status(409).json({ error: 'Your time for this exam is over. It was submitted automatically.' });
    }
    if (!attempt) {
      attempt = (await db.query(
        `INSERT INTO attempts (exam_id, student_id, deadline, ip_address)
         VALUES ($1, $2, LEAST(now() + make_interval(mins => $3), $4), $5)
         ON CONFLICT (exam_id, student_id) DO NOTHING RETURNING *`,
        [examId, sid, exam.duration_min, exam.end_time, ip])).rows[0];
      if (!attempt) return res.status(409).json({ error: 'Attempt already exists. Reload the page.' });
      await audit.log({ userId: req.user.user_id, action: 'ATTEMPT_START', entity: 'attempt', entityId: attempt.attempt_id, ip });
    }

    // answer keys are NEVER selected here (V06)
    const questions = (await db.query(
      `SELECT q.question_id, q.q_type, q.q_text, q.options, q.marks, eq.seq_no
         FROM exam_questions eq JOIN questions q ON q.question_id = eq.question_id
        WHERE eq.exam_id = $1 ORDER BY eq.seq_no`, [examId])).rows;
    const saved = (await db.query('SELECT question_id, response, saved_at FROM answers WHERE attempt_id = $1',
                                  [attempt.attempt_id])).rows;
    res.json({
      attempt_id: attempt.attempt_id, exam: { title: exam.title, total_marks: exam.total_marks },
      deadline: attempt.deadline, serverTime: new Date(), questions, answers: saved,
    });
  } catch (e) { next(e); }
});

async function ownAttempt(attemptId, studentId) {
  if (!UUID.test(attemptId)) return null;
  return (await db.query('SELECT * FROM attempts WHERE attempt_id = $1 AND student_id = $2', [attemptId, studentId])).rows[0];
}

// FR-08: autosave one answer
router.put('/attempts/:attemptId/answers', async (req, res, next) => {
  try {
    const a = await ownAttempt(req.params.attemptId, req.user.student_id);
    if (!a) {
      await audit.log({ userId: req.user.user_id, action: 'IDOR_BLOCKED', entity: 'attempt', entityId: req.params.attemptId, ip: clientIp(req) });
      return res.status(404).json({ error: 'Attempt not found.' });
    }
    if (a.status !== 'IN_PROGRESS') return res.status(409).json({ error: 'This attempt is already submitted.' });
    if (Date.now() > new Date(a.deadline).getTime() + config.submitGraceSec * 1000) {
      await finalize(a.attempt_id, { auto: true });
      return res.status(409).json({ error: 'Time is over. Your exam was submitted automatically.' });
    }
    const { question_id } = req.body;
    let response = req.body.response == null ? null : String(req.body.response);
    if (!UUID.test(String(question_id))) return res.status(400).json({ error: 'Invalid question.' });
    const q = (await db.query(
      `SELECT q.q_type, q.options FROM exam_questions eq JOIN questions q ON q.question_id = eq.question_id
        WHERE eq.exam_id = $1 AND q.question_id = $2`, [a.exam_id, question_id])).rows[0];
    if (!q) return res.status(400).json({ error: 'Question is not part of this exam.' });
    if (response !== null && response.length > 5000) return res.status(400).json({ error: 'Answer is too long (max 5000 characters).' });
    if (q.q_type === 'MCQ' && response !== null && response !== '' &&
        !(Number.isInteger(Number(response)) && Number(response) >= 0 && Number(response) < (q.options || []).length)) {
      return res.status(400).json({ error: 'Invalid option.' });
    }
    const r = (await db.query(
      `INSERT INTO answers (attempt_id, question_id, response) VALUES ($1,$2,$3)
       ON CONFLICT (attempt_id, question_id) DO UPDATE SET response = EXCLUDED.response, saved_at = now()
       RETURNING saved_at`, [a.attempt_id, question_id, response])).rows[0];
    res.json({ saved_at: r.saved_at });
  } catch (e) { next(e); }
});

// FR-09: final submission with receipt
router.post('/attempts/:attemptId/submit', async (req, res, next) => {
  try {
    const a = await ownAttempt(req.params.attemptId, req.user.student_id);
    if (!a) return res.status(404).json({ error: 'Attempt not found.' });
    if (a.status !== 'IN_PROGRESS') return res.status(409).json({ error: 'This attempt is already submitted.' });
    const late = Date.now() > new Date(a.deadline).getTime() + config.submitGraceSec * 1000;
    const receipt = await finalize(a.attempt_id, { auto: late, userId: req.user.user_id, ip: clientIp(req) });
    if (!receipt) return res.status(409).json({ error: 'This attempt is already submitted.' });
    res.json(receipt);
  } catch (e) { next(e); }
});

// FR-17: own published results only; HMAC verified on every read (SR-08)
router.get('/results', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT r.*, e.title, e.total_marks, c.course_code
         FROM results r
         JOIN attempts a ON a.attempt_id = r.attempt_id
         JOIN exams e ON e.exam_id = a.exam_id
         JOIN courses c ON c.course_id = e.course_id
        WHERE a.student_id = $1 ORDER BY r.published_at DESC`, [req.user.student_id]);
    res.json(rows.map(r => ({
      result_id: r.result_id, attempt_id: r.attempt_id, course_code: r.course_code, title: r.title,
      total_score: r.total_score, total_marks: r.total_marks, grade: r.grade, published_at: r.published_at,
      integrity_ok: safeEqual(hmac(resultPayload(r)), r.integrity_hash),
    })));
  } catch (e) { next(e); }
});

router.get('/results/:attemptId', async (req, res, next) => {
  try {
    const a = await ownAttempt(req.params.attemptId, req.user.student_id);
    if (!a) {
      await audit.log({ userId: req.user.user_id, action: 'IDOR_BLOCKED', entity: 'result', entityId: req.params.attemptId, ip: clientIp(req) });
      return res.status(404).json({ error: 'Result not found.' });
    }
    const r = (await db.query('SELECT * FROM results WHERE attempt_id = $1', [a.attempt_id])).rows[0];
    if (!r) return res.status(404).json({ error: 'Result not published yet.' });
    const breakdown = (await db.query(
      `SELECT eq.seq_no, q.q_text, q.q_type, q.options, q.marks, an.response, an.marks_awarded
         FROM exam_questions eq JOIN questions q ON q.question_id = eq.question_id
         LEFT JOIN answers an ON an.question_id = q.question_id AND an.attempt_id = $1
        WHERE eq.exam_id = $2 ORDER BY eq.seq_no`, [a.attempt_id, a.exam_id])).rows;
    res.json({ total_score: r.total_score, grade: r.grade, published_at: r.published_at,
               integrity_ok: safeEqual(hmac(resultPayload(r)), r.integrity_hash), breakdown });
  } catch (e) { next(e); }
});

module.exports = router;

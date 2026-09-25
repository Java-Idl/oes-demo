// Shared exam logic: timing state, finalising attempts, grading helpers.
const db = require('./db');
const audit = require('./audit');
const { decrypt, sha256 } = require('./security');

// Exam phase is always computed from the SERVER clock (NFR-08).
function phase(exam, now = new Date()) {
  if (exam.status === 'PUBLISHED') return 'PUBLISHED';
  if (exam.status === 'DRAFT') return 'DRAFT';
  if (now < new Date(exam.start_time)) return 'UPCOMING';
  if (now < new Date(exam.end_time)) return 'LIVE';
  return 'CLOSED';
}

function grade(pct) {
  if (pct >= 90) return 'O'; if (pct >= 80) return 'A+'; if (pct >= 70) return 'A';
  if (pct >= 60) return 'B+'; if (pct >= 50) return 'B'; if (pct >= 40) return 'C';
  return 'F';
}

// Close an attempt: auto-grade MCQs, give 0 to blank answers, hash the submission.
async function finalize(attemptId, { auto = false, userId = null, ip = null } = {}) {
  return db.tx(async c => {
    const a = (await c.query('SELECT * FROM attempts WHERE attempt_id = $1 FOR UPDATE', [attemptId])).rows[0];
    if (!a || a.status !== 'IN_PROGRESS') return null;

    const qs = (await c.query(
      `SELECT q.question_id, q.q_type, q.answer_key_enc, q.marks, an.answer_id, an.response
         FROM exam_questions eq
         JOIN questions q ON q.question_id = eq.question_id
         LEFT JOIN answers an ON an.question_id = q.question_id AND an.attempt_id = $1
        WHERE eq.exam_id = $2 ORDER BY eq.seq_no`, [attemptId, a.exam_id])).rows;

    for (const q of qs) {
      const blank = q.response == null || String(q.response).trim() === '';
      let marks = null;
      if (blank) marks = 0;
      else if (q.q_type === 'MCQ') marks = String(q.response) === decrypt(q.answer_key_enc) ? Number(q.marks) : 0;
      // TEXT answers stay NULL = "needs manual grading"
      if (q.answer_id) {
        await c.query('UPDATE answers SET marks_awarded = $2 WHERE answer_id = $1', [q.answer_id, marks]);
      } else {
        await c.query('INSERT INTO answers (attempt_id, question_id, response, marks_awarded) VALUES ($1,$2,NULL,$3)',
                      [attemptId, q.question_id, marks]);
      }
    }

    const submittedAt = new Date();
    const hash = sha256(JSON.stringify({ attemptId, submittedAt: submittedAt.toISOString(),
      answers: qs.map(q => [q.question_id, q.response ?? '']) }));
    const status = auto ? 'AUTO_SUBMITTED' : 'SUBMITTED';
    await c.query('UPDATE attempts SET status = $2, submitted_at = $3, submission_hash = $4 WHERE attempt_id = $1',
                  [attemptId, status, submittedAt, hash]);
    await audit.write(c, { userId, action: auto ? 'AUTO_SUBMIT' : 'SUBMIT', entity: 'attempt', entityId: attemptId,
                           details: { submission_hash: hash }, ip });
    return { attempt_id: attemptId, status, submitted_at: submittedAt, submission_hash: hash,
             answered: qs.filter(q => q.response != null && String(q.response).trim() !== '').length, total: qs.length };
  });
}

// Background job: auto-submit attempts whose server deadline has passed (FR-10).
async function autoSubmitExpired(graceSec) {
  const { rows } = await db.query(
    `SELECT attempt_id FROM attempts WHERE status = 'IN_PROGRESS'
       AND deadline < now() - make_interval(secs => $1)`, [graceSec]);
  for (const r of rows) await finalize(r.attempt_id, { auto: true });
  return rows.length;
}

module.exports = { phase, grade, finalize, autoSubmitExpired };

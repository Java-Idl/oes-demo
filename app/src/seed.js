// Inserts demo users, courses and exams the first time the app starts
// (only when the users table is empty). Disable with SEED_DEMO_DATA=false.
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('./db');
const audit = require('./audit');
const { encrypt, hmac, resultPayload } = require('./security');

const MIN = 60 * 1000; const HOUR = 60 * MIN; const DAY = 24 * HOUR;

async function seed() {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM users');
  if (rows[0].n > 0) return false;
  console.log('Seeding demo data...');

  await db.tx(async c => {
    const role = async name => (await c.query('SELECT role_id FROM roles WHERE role_name = $1', [name])).rows[0].role_id;
    const R = { STUDENT: await role('STUDENT'), FACULTY: await role('FACULTY'), ADMIN: await role('ADMIN') };
    const hash = p => bcrypt.hash(p, 10);
    const user = async (r, name, email, pw) =>
      (await c.query('INSERT INTO users (role_id, full_name, email, password_hash) VALUES ($1,$2,$3,$4) RETURNING user_id',
                     [R[r], name, email, await hash(pw)])).rows[0].user_id;

    await user('ADMIN', 'Exam Cell Admin', 'admin@oes.local', 'Admin@12345');

    const fac = async (name, email, dept, desig) => {
      const uid = await user('FACULTY', name, email, 'Faculty@12345');
      return (await c.query('INSERT INTO faculty (user_id, department, designation) VALUES ($1,$2,$3) RETURNING faculty_id',
                            [uid, dept, desig])).rows[0].faculty_id;
    };
    const priya = await fac('Dr. K. Priya', 'priya@oes.local', 'CCE', 'Associate Professor');
    const ravi = await fac('Dr. S. Ravi', 'ravi@oes.local', 'CCE', 'Assistant Professor');

    const stu = async (name, email, roll) => {
      const uid = await user('STUDENT', name, email, 'Student@12345');
      return (await c.query('INSERT INTO students (user_id, roll_no, department, batch) VALUES ($1,$2,$3,$4) RETURNING student_id',
                            [uid, roll, 'CCE', '2022-26'])).rows[0].student_id;
    };
    const kavin = await stu('S. Kavin', 'kavin@oes.local', '22CCE1001');
    const arun = await stu('A. Arun', 'arun@oes.local', '22CCE1002');
    const bhavya = await stu('B. Bhavya', 'bhavya@oes.local', '22CCE1003');

    const course = async (fid, code, title) =>
      (await c.query('INSERT INTO courses (faculty_id, course_code, title) VALUES ($1,$2,$3) RETURNING course_id', [fid, code, title])).rows[0].course_id;
    const se = await course(priya, '19CCE301', 'Secure Software Engineering');
    const cn = await course(ravi, '19CCE305', 'Computer Networks');
    for (const s of [kavin, arun, bhavya]) await c.query('INSERT INTO enrollments (student_id, course_id) VALUES ($1,$2)', [s, se]);
    for (const s of [kavin, arun]) await c.query('INSERT INTO enrollments (student_id, course_id) VALUES ($1,$2)', [s, cn]);

    const now = Date.now();
    const exam = async (cid, fid, title, start, end, dur, status, qs) => {
      const e = (await c.query(
        `INSERT INTO exams (course_id, created_by, title, start_time, end_time, duration_min, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING exam_id`,
        [cid, fid, title, new Date(start), new Date(end), dur, status])).rows[0].exam_id;
      const ids = [];
      for (const [i, q] of qs.entries()) {
        const qid = (await c.query(
          `INSERT INTO questions (course_id, q_type, q_text, options, answer_key_enc, marks)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING question_id`,
          [cid, q.type, q.text, q.options ? JSON.stringify(q.options) : null,
           q.key === undefined ? null : encrypt(String(q.key)), q.marks])).rows[0].question_id;
        await c.query('INSERT INTO exam_questions (exam_id, question_id, seq_no) VALUES ($1,$2,$3)', [e, qid, i + 1]);
        ids.push({ qid, ...q });
      }
      await c.query(`UPDATE exams SET total_marks = $2 WHERE exam_id = $1`, [e, qs.reduce((s, q) => s + q.marks, 0)]);
      return { exam_id: e, qs: ids };
    };

    const secQs = [
      { type: 'MCQ', marks: 2, key: 1, text: 'Which STRIDE category describes an attacker replaying a stolen session token to act as another student?',
        options: ['Tampering', 'Spoofing', 'Repudiation', 'Elevation of Privilege'] },
      { type: 'MCQ', marks: 2, key: 2, text: 'Which control best prevents SQL injection?',
        options: ['Input length limits', 'Client-side validation', 'Parameterised queries', 'HTTPS'] },
      { type: 'MCQ', marks: 2, key: 0, text: 'A student changes /results/123 to /results/124 and sees another student\'s marks. This vulnerability is called:',
        options: ['IDOR (broken object-level authorization)', 'CSRF', 'XSS', 'Clickjacking'] },
      { type: 'MCQ', marks: 2, key: 3, text: 'Which cookie attribute stops JavaScript from reading the session cookie?',
        options: ['Secure', 'SameSite', 'Path', 'HttpOnly'] },
      { type: 'TEXT', marks: 5, text: 'Explain one way this system makes published marks tamper-evident.' },
    ];

    // 1) LIVE exam - students can take it right now
    await exam(se, priya, 'Mid-Term 2', now - 10 * MIN, now + 3 * HOUR, 30, 'SCHEDULED', secQs);

    // 2) UPCOMING exam
    await exam(cn, ravi, 'Quiz 3', now + DAY, now + DAY + HOUR, 20, 'SCHEDULED', [
      { type: 'MCQ', marks: 1, key: 2, text: 'Which layer does TLS mainly protect?', options: ['Physical', 'Network', 'Transport/Session', 'Data link'] },
      { type: 'MCQ', marks: 1, key: 0, text: 'Default HTTPS port?', options: ['443', '80', '22', '8080'] },
    ]);

    // helper: a finished attempt with given responses
    const finished = async (ex, sid, responses, submittedAgo) => {
      const at = new Date(now - submittedAgo);
      const a = (await c.query(
        `INSERT INTO attempts (exam_id, student_id, started_at, deadline, submitted_at, status, submission_hash)
         VALUES ($1,$2,$3,$4,$5,'SUBMITTED',$6) RETURNING attempt_id`,
        [ex.exam_id, sid, new Date(at - 20 * MIN), at, at, crypto.randomBytes(32).toString('hex')])).rows[0].attempt_id;
      let total = 0;
      for (const [i, q] of ex.qs.entries()) {
        const resp = responses[i];
        let marks = null;
        if (resp === null) marks = 0;
        else if (q.type === 'MCQ') marks = String(resp) === String(q.key) ? q.marks : 0;
        if (marks !== null) total += marks;
        await c.query('INSERT INTO answers (attempt_id, question_id, response, marks_awarded) VALUES ($1,$2,$3,$4)',
                      [a, q.qid, resp === null ? null : String(resp), marks]);
      }
      return { attempt_id: a, total };
    };

    // 3) CLOSED exam, not yet published - one descriptive answer waits for manual grading (demo for faculty)
    const mt1 = await exam(se, priya, 'Mid-Term 1', now - 3 * DAY, now - 3 * DAY + 2 * HOUR, 30, 'SCHEDULED', secQs);
    await finished(mt1, arun, [1, 2, 0, 3, null], 3 * DAY - HOUR);
    await finished(mt1, bhavya, [1, 0, 0, 3, 'Each result stores an HMAC, and every change is written to a hash-chained audit log.'], 3 * DAY - HOUR);

    // 4) CLOSED and PUBLISHED exam - students can view results
    const q1 = await exam(cn, ravi, 'Quiz 1', now - 10 * DAY, now - 10 * DAY + HOUR, 15, 'SCHEDULED', [
      { type: 'MCQ', marks: 5, key: 1, text: 'Which protocol resolves domain names to IP addresses?', options: ['DHCP', 'DNS', 'ARP', 'SMTP'] },
      { type: 'MCQ', marks: 5, key: 0, text: 'TCP is:', options: ['Connection-oriented', 'Connectionless', 'A link-layer protocol', 'Only used for email'] },
    ]);
    const publishedAt = new Date(now - 9 * DAY);
    for (const [sid, resp] of [[kavin, [1, 0]], [arun, [1, 1]]]) {
      const f = await finished(q1, sid, resp, 10 * DAY - 30 * MIN);
      const pct = (f.total / 10) * 100;
      const r = { result_id: crypto.randomUUID(), attempt_id: f.attempt_id, total_score: f.total,
                  grade: pct >= 90 ? 'O' : pct >= 50 ? 'B' : 'F', published_at: publishedAt, version: 1 };
      await c.query(
        `INSERT INTO results (result_id, attempt_id, total_score, grade, published_by, published_at, integrity_hash, version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,1)`,
        [r.result_id, r.attempt_id, r.total_score, r.grade, ravi, publishedAt, hmac(resultPayload(r))]);
    }
    await c.query(`UPDATE exams SET status = 'PUBLISHED' WHERE exam_id = $1`, [q1.exam_id]);

    await audit.write(c, { action: 'SEED_DEMO_DATA', details: { note: 'initial demo data' } });
  });
  console.log('Demo data ready.');
  return true;
}

module.exports = { seed };

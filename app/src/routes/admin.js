// Administrator API: users & roles, courses & enrollment, audit log (FR-18, FR-19).
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const audit = require('../audit');
const { clientIp } = require('../auth');

const router = express.Router();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.get('/users', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT u.user_id, u.full_name, u.email, u.status, u.last_login, r.role_name AS role,
              (u.locked_until IS NOT NULL AND u.locked_until > now()) AS locked,
              s.student_id, s.roll_no, f.faculty_id, coalesce(s.department, f.department) AS department
         FROM users u JOIN roles r ON r.role_id = u.role_id
         LEFT JOIN students s ON s.user_id = u.user_id LEFT JOIN faculty f ON f.user_id = u.user_id
        ORDER BY r.role_name, u.full_name`);
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/users', async (req, res, next) => {
  try {
    const role = String(req.body.role || '');
    const full_name = String(req.body.full_name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!['STUDENT', 'FACULTY', 'ADMIN'].includes(role)) return res.status(400).json({ error: 'Choose a role.' });
    if (!full_name || full_name.length > 100) return res.status(400).json({ error: 'Name is required.' });
    if (!EMAIL.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
    if (password.length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters (SR-01).' });
    if (role === 'STUDENT' && !String(req.body.roll_no || '').trim()) return res.status(400).json({ error: 'Roll number is required for students.' });

    const hash = await bcrypt.hash(password, 10);
    const id = await db.tx(async c => {
      const u = (await c.query(
        `INSERT INTO users (role_id, full_name, email, password_hash)
         VALUES ((SELECT role_id FROM roles WHERE role_name = $1), $2, $3, $4) RETURNING user_id`,
        [role, full_name, email, hash])).rows[0];
      if (role === 'STUDENT') {
        await c.query('INSERT INTO students (user_id, roll_no, department, batch) VALUES ($1,$2,$3,$4)',
                      [u.user_id, String(req.body.roll_no).trim().toUpperCase(), req.body.department || null, req.body.batch || null]);
      } else if (role === 'FACULTY') {
        await c.query('INSERT INTO faculty (user_id, department, designation) VALUES ($1,$2,$3)',
                      [u.user_id, req.body.department || null, req.body.designation || null]);
      }
      await audit.write(c, { userId: req.user.user_id, action: 'USER_CREATE', entity: 'user', entityId: u.user_id,
                             details: { role, email }, ip: clientIp(req) });
      return u.user_id;
    });
    res.status(201).json({ user_id: id });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email or roll number already exists.' });
    next(e);
  }
});

router.post('/users/:id/unlock', async (req, res, next) => {
  try {
    await db.query('UPDATE users SET locked_until = NULL, failed_attempts = 0 WHERE user_id = $1', [Number(req.params.id)]);
    await audit.log({ userId: req.user.user_id, action: 'USER_UNLOCK', entity: 'user', entityId: req.params.id, ip: clientIp(req) });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/users/:id/status', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const status = req.body.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE';
    if (id === req.user.user_id) return res.status(400).json({ error: 'You cannot disable your own account.' });
    await db.tx(async c => {
      await c.query('UPDATE users SET status = $2 WHERE user_id = $1', [id, status]);
      if (status === 'DISABLED') await c.query('DELETE FROM sessions WHERE user_id = $1', [id]);   // kill live sessions
      await audit.write(c, { userId: req.user.user_id, action: 'USER_STATUS', entity: 'user', entityId: id, details: { status }, ip: clientIp(req) });
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/courses', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT c.course_id, c.course_code, c.title, u.full_name AS faculty_name,
              (SELECT count(*) FROM enrollments e WHERE e.course_id = c.course_id)::int AS enrolled
         FROM courses c JOIN faculty f ON f.faculty_id = c.faculty_id JOIN users u ON u.user_id = f.user_id
        ORDER BY c.course_code`);
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/courses', async (req, res, next) => {
  try {
    const code = String(req.body.course_code || '').trim().toUpperCase();
    const title = String(req.body.title || '').trim();
    if (!code || !title) return res.status(400).json({ error: 'Course code and title are required.' });
    const c = (await db.query('INSERT INTO courses (faculty_id, course_code, title) VALUES ($1,$2,$3) RETURNING course_id',
                              [Number(req.body.faculty_id), code, title])).rows[0];
    await audit.log({ userId: req.user.user_id, action: 'COURSE_CREATE', entity: 'course', entityId: c.course_id, ip: clientIp(req) });
    res.status(201).json(c);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Course code already exists.' });
    if (e.code === '23503') return res.status(400).json({ error: 'Choose a valid faculty member.' });
    next(e);
  }
});

router.post('/enrollments', async (req, res, next) => {
  try {
    await db.query('INSERT INTO enrollments (student_id, course_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
                   [Number(req.body.student_id), Number(req.body.course_id)]);
    await audit.log({ userId: req.user.user_id, action: 'ENROLL', entity: 'course', entityId: req.body.course_id,
                      details: { student_id: Number(req.body.student_id) }, ip: clientIp(req) });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23503') return res.status(400).json({ error: 'Choose a valid student and course.' });
    next(e);
  }
});

router.get('/audit', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT l.log_id, l.ts, l.action, l.entity, l.entity_id, l.details, l.ip_address, u.email
         FROM audit_log l LEFT JOIN users u ON u.user_id = l.user_id
        ORDER BY l.log_id DESC LIMIT 200`);
    res.json(rows);
  } catch (e) { next(e); }
});

router.get('/audit/verify', async (req, res, next) => {
  try { res.json(await audit.verify()); } catch (e) { next(e); }
});

module.exports = router;

// Authentication, sessions and role-based access control (SR-01..SR-05).
const bcrypt = require('bcryptjs');
const express = require('express');
const db = require('./db');
const config = require('./config');
const audit = require('./audit');
const { sha256, randomToken } = require('./security');

const COOKIE = 'oes_sid';
// used so that "unknown user" takes as long as "wrong password" (no user enumeration by timing)
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

function clientIp(req) { return req.ip || req.socket.remoteAddress; }

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(p => p.trim().split('=')).filter(p => p[0])
    .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

function setCookie(res, token, maxAgeSec) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (config.cookieSecure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// ---- middleware: load the session (if any) into req.user
async function loadSession(req, res, next) {
  try {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return next();
    const { rows } = await db.query(
      `SELECT s.token_hash, u.user_id, u.full_name, u.email, u.status, r.role_name AS role,
              st.student_id, st.roll_no, f.faculty_id
         FROM sessions s
         JOIN users u ON u.user_id = s.user_id
         JOIN roles r ON r.role_id = u.role_id
         LEFT JOIN students st ON st.user_id = u.user_id
         LEFT JOIN faculty f  ON f.user_id  = u.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()
          AND s.last_seen > now() - make_interval(mins => $2)`,
      [sha256(token), config.sessionIdleMin]);
    const u = rows[0];
    if (!u || u.status !== 'ACTIVE') { setCookie(res, '', 0); return next(); }
    await db.query('UPDATE sessions SET last_seen = now() WHERE token_hash = $1', [u.token_hash]);
    req.user = u;
    next();
  } catch (e) { next(e); }
}

// ---- middleware: deny by default unless the role matches (V03)
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
    if (!roles.includes(req.user.role)) {
      audit.log({ userId: req.user.user_id, action: 'ACCESS_DENIED', entity: 'route',
                  entityId: req.originalUrl, ip: clientIp(req) }).catch(() => {});
      return res.status(403).json({ error: 'You do not have permission for this action.' });
    }
    next();
  };
}

// ---- middleware: CSRF defence for state-changing requests (V11)
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'fetch') return res.status(403).json({ error: 'Blocked (CSRF check).' });
  const origin = req.get('Origin');
  if (origin && new URL(origin).host !== req.get('Host')) return res.status(403).json({ error: 'Blocked (bad origin).' });
  next();
}

// ---- simple in-memory rate limit for the login endpoint (V10)
const hits = new Map();
function loginRateLimit(req, res, next) {
  const key = clientIp(req); const now = Date.now(); const windowMs = 15 * 60 * 1000;
  const list = (hits.get(key) || []).filter(t => now - t < windowMs);
  list.push(now); hits.set(key, list);
  if (list.length > 30) return res.status(429).json({ error: 'Too many login attempts from this network. Try again later.' });
  next();
}

async function verifyPassword(userId, password) {
  const { rows } = await db.query('SELECT password_hash FROM users WHERE user_id = $1', [userId]);
  return rows[0] ? bcrypt.compare(String(password || ''), rows[0].password_hash) : false;
}

// ---- routes
const router = express.Router();

router.post('/login', loginRateLimit, async (req, res, next) => {
  try {
    const id = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const generic = { error: 'Invalid ID or password.' };
    const ip = clientIp(req);

    const { rows } = await db.query(
      `SELECT u.*, r.role_name AS role FROM users u JOIN roles r ON r.role_id = u.role_id
        LEFT JOIN students s ON s.user_id = u.user_id
        WHERE lower(u.email) = $1 OR lower(s.roll_no) = $1`, [id]);
    const u = rows[0];

    if (!u) {
      await bcrypt.compare(password, DUMMY_HASH);
      await audit.log({ action: 'LOGIN_FAILED', entity: 'user', entityId: id.slice(0, 64), details: { reason: 'unknown' }, ip });
      return res.status(401).json(generic);
    }
    if (u.status !== 'ACTIVE') {
      await audit.log({ userId: u.user_id, action: 'LOGIN_FAILED', details: { reason: 'disabled' }, ip });
      return res.status(401).json(generic);
    }
    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      await audit.log({ userId: u.user_id, action: 'LOGIN_BLOCKED_LOCKED', ip });
      return res.status(423).json({ error: `Too many failed attempts. Try again after ${config.lockMinutes} minutes or contact the exam cell.` });
    }

    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) {
      const failed = u.failed_attempts + 1;
      if (failed >= config.maxFailedLogins) {
        await db.query(`UPDATE users SET failed_attempts = 0,
                          locked_until = now() + make_interval(mins => $2) WHERE user_id = $1`,
                       [u.user_id, config.lockMinutes]);
        await audit.log({ userId: u.user_id, action: 'ACCOUNT_LOCKED', ip });
        return res.status(423).json({ error: `Too many failed attempts. Account locked for ${config.lockMinutes} minutes.` });
      }
      await db.query('UPDATE users SET failed_attempts = $2 WHERE user_id = $1', [u.user_id, failed]);
      await audit.log({ userId: u.user_id, action: 'LOGIN_FAILED', details: { reason: 'password' }, ip });
      return res.status(401).json({ ...generic, attemptsLeft: config.maxFailedLogins - failed });
    }

    // success: always issue a brand-new session id (prevents session fixation)
    const token = randomToken();
    await db.tx(async c => {
      await c.query('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login = now() WHERE user_id = $1', [u.user_id]);
      await c.query(`INSERT INTO sessions (token_hash, user_id, ip_address, user_agent, expires_at)
                     VALUES ($1,$2,$3,$4, now() + make_interval(mins => $5))`,
                    [sha256(token), u.user_id, ip, String(req.get('User-Agent') || '').slice(0, 200), config.sessionAbsoluteMin]);
      await audit.write(c, { userId: u.user_id, action: 'LOGIN_SUCCESS', ip });
    });
    setCookie(res, token, config.sessionAbsoluteMin * 60);
    res.json({ role: u.role, name: u.full_name });
  } catch (e) { next(e); }
});

router.post('/logout', async (req, res, next) => {
  try {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
    if (req.user) await audit.log({ userId: req.user.user_id, action: 'LOGOUT', ip: clientIp(req) });
    setCookie(res, '', 0);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
  const { user_id, full_name, email, role, roll_no } = req.user;
  res.json({ user_id, full_name, email, role, roll_no });
});

module.exports = { router, loadSession, requireRole, csrfGuard, verifyPassword, clientIp };

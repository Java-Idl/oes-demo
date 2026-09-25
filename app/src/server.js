const express = require('express');
const path = require('path');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const { autoSubmitExpired } = require('./exams');
const { seed } = require('./seed');

const app = express();
app.disable('x-powered-by');

// Security headers (V07 XSS defence-in-depth, clickjacking, MIME sniffing)
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(express.json({ limit: '100kb' }));
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use('/api', auth.csrfGuard, auth.loadSession);
app.use('/api/auth', auth.router);
app.use('/api/student', auth.requireRole('STUDENT'), require('./routes/student'));
app.use('/api/faculty', auth.requireRole('FACULTY'), require('./routes/faculty'));
app.use('/api/admin', auth.requireRole('ADMIN'), require('./routes/admin'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

// Generic errors only - details go to the server log, never to the browser (V12)
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request body.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

(async () => {
  await db.waitForDb();
  if (config.seedDemoData) await seed();
  setInterval(() => autoSubmitExpired(config.submitGraceSec).catch(e => console.error('auto-submit', e)), 15000);
  app.listen(config.port, () => console.log(`OES demo running on port ${config.port}`));
})().catch(e => { console.error(e); process.exit(1); });

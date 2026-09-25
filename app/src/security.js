const crypto = require('crypto');
const config = require('./config');

const aesKey = crypto.createHash('sha256').update(config.answerKeySecret).digest();

// AES-256-GCM for answer keys at rest (SR-07).
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function decrypt(blob) {
  if (!blob) return null;
  const [iv, tag, enc] = blob.split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const hmac = s => crypto.createHmac('sha256', config.resultHmacSecret).update(s).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');   // 256-bit session id

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Canonical string that the result HMAC covers.
function resultPayload(r) {
  return [r.result_id, r.attempt_id, Number(r.total_score).toFixed(2), r.grade,
          new Date(r.published_at).toISOString(), r.version].join('|');
}

module.exports = { encrypt, decrypt, sha256, hmac, randomToken, safeEqual, resultPayload };

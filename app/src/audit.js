// Tamper-evident audit log (SR-10): every entry stores the hash of the previous
// entry, so editing or deleting any row breaks the chain and verify() reports it.
const db = require('./db');
const { sha256 } = require('./security');

const GENESIS = '0'.repeat(64);

// Stable JSON (sorted keys) - PostgreSQL JSONB reorders keys, so the hash
// must not depend on key order.
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v ?? null);
}

function entryHash(prev, e) {
  return sha256([prev, e.user_id ?? '', e.action, e.entity ?? '', e.entity_id ?? '',
                 canonical(e.details ?? {}), e.ip_address ?? '', new Date(e.ts).toISOString()].join('|'));
}

async function write(client, { userId = null, action, entity = null, entityId = null, details = {}, ip = null }) {
  // serialise writers so the chain has no forks
  await client.query('SELECT pg_advisory_xact_lock(424242)');
  const last = await client.query('SELECT entry_hash FROM audit_log ORDER BY log_id DESC LIMIT 1');
  const prev = last.rows[0]?.entry_hash || GENESIS;
  const ts = new Date();
  const e = { user_id: userId, action, entity, entity_id: entityId == null ? null : String(entityId), details, ip_address: ip, ts };
  await client.query(
    `INSERT INTO audit_log (user_id, action, entity, entity_id, details, ip_address, ts, prev_hash, entry_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [e.user_id, action, entity, e.entity_id, JSON.stringify(details), ip, ts, prev, entryHash(prev, e)]);
}

// Convenience wrapper when the caller has no open transaction.
function log(entry) {
  return db.tx(client => write(client, entry));
}

async function verify() {
  const { rows } = await db.query('SELECT * FROM audit_log ORDER BY log_id');
  let prev = GENESIS;
  for (const r of rows) {
    const expected = entryHash(prev, r);
    if (r.prev_hash !== prev || r.entry_hash !== expected) {
      return { ok: false, checked: rows.length, brokenAt: r.log_id };
    }
    prev = r.entry_hash;
  }
  return { ok: true, checked: rows.length };
}

module.exports = { write, log, verify };

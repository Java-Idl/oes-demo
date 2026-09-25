const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({ ...config.db, max: 10 });

// Parameterised queries only - never string-concatenated SQL (V01).
function query(text, params) {
  return pool.query(text, params);
}

// Run fn(client) inside a transaction.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function waitForDb(retries = 30) {
  for (let i = 1; i <= retries; i++) {
    try { await pool.query('SELECT 1'); return; }
    catch (e) {
      console.log(`Waiting for database (${i}/${retries})...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error('Database not reachable');
}

module.exports = { pool, query, tx, waitForDb };

// Central configuration, read from environment variables (see .env.example).
function required(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing environment variable ${name}`);
  return v;
}

const databaseUrl = process.env.DATABASE_URL;
const db = databaseUrl
  ? {
      connectionString: databaseUrl,
      ...(process.env.DB_SSL === 'true' ? { ssl: { rejectUnauthorized: false } } : {}),
    }
  : {
      host: required('DB_HOST', 'localhost'),
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: required('DB_NAME', 'oes'),
      user: required('DB_USER', 'oes_app'),
      password: required('DB_PASSWORD'),
    };

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  db,
  // Secrets used for encrypting answer keys and signing results (SR-07, SR-08).
  answerKeySecret: required('ANSWER_KEY_SECRET'),
  resultHmacSecret: required('RESULT_HMAC_SECRET'),
  cookieSecure: process.env.COOKIE_SECURE === 'true',   // set true behind HTTPS
  sessionIdleMin: parseInt(process.env.SESSION_IDLE_MIN || '15', 10),
  sessionAbsoluteMin: parseInt(process.env.SESSION_ABSOLUTE_MIN || '180', 10),
  maxFailedLogins: 5,
  lockMinutes: 15,
  submitGraceSec: 5,
  seedDemoData: process.env.SEED_DEMO_DATA !== 'false',
};

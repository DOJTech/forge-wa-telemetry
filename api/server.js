'use strict';
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy; needed for correct client IPs
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '20kb' }));

// --- CORS: only the origins listed in ALLOWED_ORIGIN (comma-separated) ---
const allowedOrigins = (process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);            // curl / server-to-server calls
    return cb(null, allowedOrigins.includes(origin)); // browsers from other sites get blocked
  },
  methods: ['POST', 'GET'],
  allowedHeaders: ['Content-Type'],
  maxAge: 600
}));

// --- Rate limiting ---
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests. Please slow down.' }
}));

// --- Database ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
pool.on('error', err => console.error('Database pool error:', err.message));

async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dispute_logs (
        id SERIAL PRIMARY KEY,
        case_id VARCHAR(100) NOT NULL,
        bank_code VARCHAR(20) NOT NULL,
        amount NUMERIC(15,2) NOT NULL,
        status VARCHAR(50) NOT NULL,
        scoring_result JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query('ALTER TABLE dispute_logs ADD COLUMN IF NOT EXISTS currency VARCHAR(3);');
    await pool.query('ALTER TABLE dispute_logs ADD COLUMN IF NOT EXISTS transaction_id VARCHAR(100);');
    console.log('Database online.');
  } catch (err) {
    console.error('Database initialisation failure:', err.message);
  }
}

// --- schema_wa_v1 validation ---
const MAX_AMOUNT = 9999999999999.99; // NUMERIC(15,2) limit

function validatePayload(p) {
  const errors = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    return ['Payload must be a JSON object.'];
  }

  if (typeof p.case_id !== 'string' || p.case_id.length < 1 || p.case_id.length > 100) {
    errors.push('case_id must be a string of 1-100 characters.');
  }
  if (typeof p.bank_code !== 'string' || !/^[0-9]{3,6}$/.test(p.bank_code)) {
    errors.push('bank_code must be a string of 3-6 digits (e.g. "011").');
  }
  if (p.telemetry_version !== undefined && p.telemetry_version !== 'schema_wa_v1') {
    errors.push('telemetry_version, if provided, must be "schema_wa_v1".');
  }

  const t = p.transaction_details;
  if (!t || typeof t !== 'object' || Array.isArray(t)) {
    errors.push('transaction_details must be an object.');
    return errors;
  }
  if (typeof t.amount !== 'number' || !Number.isFinite(t.amount) || t.amount <= 0 || t.amount > MAX_AMOUNT) {
    errors.push('transaction_details.amount must be a number greater than 0.');
  }
  if (t.currency !== undefined && !(typeof t.currency === 'string' && /^[A-Z]{3}$/.test(t.currency))) {
    errors.push('transaction_details.currency must be a 3-letter uppercase code (e.g. "NGN").');
  }
  if (t.is_chargeback_valid !== undefined && typeof t.is_chargeback_valid !== 'boolean') {
    errors.push('transaction_details.is_chargeback_valid must be true or false.');
  }
  if (t.transaction_id !== undefined && (typeof t.transaction_id !== 'string' || t.transaction_id.length > 100)) {
    errors.push('transaction_details.transaction_id must be a string of up to 100 characters.');
  }
  return errors;
}

// --- Health check (used by Render) ---
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'database_unavailable' });
  }
});

// --- Scoring endpoint ---
app.post('/api/v1/dispute/score', async (req, res) => {
  const errors = validatePayload(req.body);
  if (errors.length) {
    return res.status(400).json({
      success: false,
      error: 'Schema Validation Error: ' + errors.join(' ')
    });
  }

  const { case_id, bank_code, transaction_details } = req.body;
  const amount = transaction_details.amount;

  let decision = 'PENDING_MANUAL_REVIEW';
  let riskScore = 40;
  if (amount > 500000) {
    decision = 'FLAGGED_FOR_HIGH_VALUE_REVIEW';
    riskScore = 90;
  }

  const scoringResult = { decision, riskScore, processed_at: new Date().toISOString() };

  try {
    await pool.query(
      `INSERT INTO dispute_logs
         (case_id, bank_code, amount, status, scoring_result, currency, transaction_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        case_id,
        bank_code,
        amount,
        decision,
        JSON.stringify(scoringResult),
        transaction_details.currency || null,
        transaction_details.transaction_id || null
      ]
    );
    return res.status(200).json({
      success: true,
      schema: 'schema_wa_v1',
      data: { ...scoringResult, logged: true }
    });
  } catch (err) {
    console.error('Insert failure:', err.message); // never log the payload itself
    return res.status(500).json({ success: false, error: 'Internal database processing fault.' });
  }
});

// --- Malformed JSON and other errors ---
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: 'Request body is not valid JSON.' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: 'Payload too large.' });
  }
  console.error('Unhandled error:', err && err.message);
  return res.status(500).json({ success: false, error: 'Unexpected server error.' });
});

const PORT = process.env.PORT || 10000;
initDatabase().finally(() => {
  const server = app.listen(PORT, () => console.log(`API listening on ${PORT}`));
  process.on('SIGTERM', () => {
    server.close(() => pool.end().then(() => process.exit(0)));
  });
});

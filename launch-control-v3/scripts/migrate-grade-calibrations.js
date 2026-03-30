/**
 * Migration: Create grade_calibrations table
 *
 * Stores per-strategy grade thresholds derived from backtest performance.
 * Live system loads these at startup to use calibrated grades instead
 * of universal thresholds.
 *
 * Run: node scripts/migrate-grade-calibrations.js
 */

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS lc_v3.grade_calibrations (
        strategy TEXT PRIMARY KEY,
        thresholds JSONB NOT NULL,
        performance_at_grade JSONB,
        sample_size INT,
        calibration_quality TEXT,
        monotonic BOOLEAN,
        calibrated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('Created lc_v3.grade_calibrations table');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_grade_cal_quality
      ON lc_v3.grade_calibrations (calibration_quality)
    `);
    console.log('Created index on calibration_quality');

    console.log('Migration complete.');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});

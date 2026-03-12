/**
 * Migration: Create backtest_results table
 * Run: node scripts/migrate-backtest.js
 */
import { query } from '../src/data/db.js';

console.log('Creating lc_v3.backtest_results table...');

await query(`
  CREATE TABLE IF NOT EXISTS lc_v3.backtest_results (
    id SERIAL PRIMARY KEY,
    run_date DATE NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    results JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`);

await query(`
  CREATE INDEX IF NOT EXISTS idx_bt_run_date
  ON lc_v3.backtest_results(run_date DESC)
`);

console.log('Migration complete.');
process.exit(0);

/**
 * Migration: Multi-Strategy Backtest Results Table
 */
import { query } from '../src/data/db.js';

async function migrate() {
  console.log('[MIGRATE] Creating lc_v3.backtest_multi_results...');

  await query(`
    CREATE TABLE IF NOT EXISTS lc_v3.backtest_multi_results (
      id SERIAL PRIMARY KEY,
      run_date DATE NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      strategies JSONB NOT NULL,
      portfolio JSONB NOT NULL,
      cross_strategy JSONB,
      position_sizing JSONB,
      reality_checks JSONB,
      monte_carlo JSONB,
      walk_forward JSONB,
      out_of_sample JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_bt_multi_run_date
    ON lc_v3.backtest_multi_results(run_date DESC)
  `);

  console.log('[MIGRATE] backtest_multi_results table ready.');
}

migrate()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });

/**
 * Create lc_v3.paper_trades table for paper trading simulation
 * Run: node scripts/migrate-paper.js
 */
import 'dotenv/config';
import { query } from '../src/data/db.js';

async function main() {
  await query(`
    CREATE TABLE IF NOT EXISTS lc_v3.paper_trades (
      paper_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      signal_id UUID REFERENCES lc_v3.signals(signal_id),
      ticker VARCHAR(10),
      direction VARCHAR(4),
      grade VARCHAR(3),
      strategy VARCHAR(20),
      signal_tier VARCHAR(20),
      composite_score INTEGER,
      freshness VARCHAR(20),
      signal_type VARCHAR(30),
      regime VARCHAR(20),
      entry_time TIMESTAMPTZ DEFAULT NOW(),
      entry_stock_price DECIMAL(12,4),
      entry_contract_mid DECIMAL(10,4),
      entry_contract_symbol VARCHAR(30),
      entry_contract_strike DECIMAL(10,2),
      entry_contract_expiry VARCHAR(20),
      entry_contract_delta DECIMAL(5,3),
      entry_contract_iv DECIMAL(6,2),
      entry_t1 DECIMAL(10,4),
      entry_t2 DECIMAL(10,4),
      entry_t3 DECIMAL(10,4),
      entry_stop DECIMAL(10,4),
      position_size_pct DECIMAL(5,3),
      current_stock_price DECIMAL(12,4),
      current_contract_est DECIMAL(10,4),
      unrealized_pnl_pct DECIMAL(8,4),
      peak_pnl_pct DECIMAL(8,4),
      max_adverse_pnl_pct DECIMAL(8,4),
      last_updated TIMESTAMPTZ,
      status VARCHAR(20) DEFAULT 'OPEN',
      hit_t1 BOOLEAN DEFAULT FALSE,
      hit_t2 BOOLEAN DEFAULT FALSE,
      hit_t3 BOOLEAN DEFAULT FALSE,
      hit_stop BOOLEAN DEFAULT FALSE,
      exit_time TIMESTAMPTZ,
      exit_stock_price DECIMAL(12,4),
      exit_contract_est DECIMAL(10,4),
      exit_reason VARCHAR(20),
      final_pnl_pct DECIMAL(8,4),
      final_pnl_dollars DECIMAL(10,2),
      outcome VARCHAR(10),
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_paper_status ON lc_v3.paper_trades(status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_paper_ticker ON lc_v3.paper_trades(ticker)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_paper_grade ON lc_v3.paper_trades(grade)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_paper_strategy ON lc_v3.paper_trades(strategy)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_paper_outcome ON lc_v3.paper_trades(outcome)`);

  console.log('[MIGRATE] lc_v3.paper_trades created with 5 indexes');
  process.exit(0);
}

main().catch(err => {
  console.error('[MIGRATE] FATAL:', err.message);
  process.exit(1);
});

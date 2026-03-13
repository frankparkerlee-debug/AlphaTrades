/**
 * Migration: Create intelligence tables
 * Run: node scripts/migrate-intelligence.js
 */
import { query } from '../src/data/db.js';

console.log('Creating intelligence tables...');

// Ticker intelligence — earnings, IV, sentiment, analyst data
await query(`
  CREATE TABLE IF NOT EXISTS lc_v3.ticker_intelligence (
    ticker TEXT PRIMARY KEY,
    earnings_date DATE,
    earnings_days_away INT,
    earnings_avg_move_pct DECIMAL,
    earnings_beat_rate DECIMAL,
    iv_rank_30d DECIMAL,
    iv_percentile DECIMAL,
    put_call_skew DECIMAL,
    short_interest_pct DECIMAL,
    insider_net_30d DECIMAL,
    insider_signal VARCHAR(10),
    analyst_consensus VARCHAR(20),
    analyst_price_target DECIMAL,
    upside_to_target_pct DECIMAL,
    beta_30d DECIMAL,
    last_updated TIMESTAMPTZ DEFAULT NOW()
  )
`);
console.log('✓ lc_v3.ticker_intelligence');

// Contagion map — leader/follower relationships between tickers
await query(`
  CREATE TABLE IF NOT EXISTS lc_v3.contagion_map (
    contagion_id SERIAL PRIMARY KEY,
    leader_ticker TEXT NOT NULL,
    follower_ticker TEXT NOT NULL,
    follow_rate DECIMAL,
    avg_magnitude DECIMAL,
    avg_lag_minutes INT,
    divergence_rate DECIMAL,
    sample_count INT,
    last_computed TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (leader_ticker, follower_ticker)
  )
`);
console.log('✓ lc_v3.contagion_map');

// Macro sensitivity — how each ticker reacts to macro events
await query(`
  CREATE TABLE IF NOT EXISTS lc_v3.macro_sensitivity (
    id SERIAL PRIMARY KEY,
    ticker TEXT NOT NULL,
    event_type VARCHAR(20) NOT NULL,
    avg_move_pct DECIMAL,
    avg_move_direction VARCHAR(4),
    sample_count INT,
    UNIQUE (ticker, event_type)
  )
`);
console.log('✓ lc_v3.macro_sensitivity');

// IV history — track implied volatility over time
await query(`
  CREATE TABLE IF NOT EXISTS lc_v3.iv_history (
    id BIGSERIAL PRIMARY KEY,
    ticker TEXT NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL,
    iv_atm DECIMAL,
    iv_rank DECIMAL,
    put_call_skew DECIMAL,
    UNIQUE (ticker, captured_at)
  )
`);

await query(`CREATE INDEX IF NOT EXISTS idx_iv_history_ticker ON lc_v3.iv_history(ticker, captured_at DESC)`);
console.log('✓ lc_v3.iv_history');

console.log('Migration complete.');
process.exit(0);

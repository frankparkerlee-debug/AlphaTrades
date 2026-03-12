import { query } from '../src/data/db.js';

// First run the contract column migration
await query(`
  ALTER TABLE lc_v3.signals
    ADD COLUMN IF NOT EXISTS contract_symbol      TEXT,
    ADD COLUMN IF NOT EXISTS contract_strike      NUMERIC,
    ADD COLUMN IF NOT EXISTS contract_expiry      DATE,
    ADD COLUMN IF NOT EXISTS contract_expiry_label TEXT,
    ADD COLUMN IF NOT EXISTS contract_bid         NUMERIC,
    ADD COLUMN IF NOT EXISTS contract_ask         NUMERIC,
    ADD COLUMN IF NOT EXISTS contract_mid         NUMERIC,
    ADD COLUMN IF NOT EXISTS contract_entry_lo    NUMERIC,
    ADD COLUMN IF NOT EXISTS contract_entry_hi    NUMERIC,
    ADD COLUMN IF NOT EXISTS contract_delta       NUMERIC,
    ADD COLUMN IF NOT EXISTS contract_iv          NUMERIC,
    ADD COLUMN IF NOT EXISTS contract_t1          NUMERIC,
    ADD COLUMN IF NOT EXISTS contract_t2          NUMERIC,
    ADD COLUMN IF NOT EXISTS contract_t3          NUMERIC,
    ADD COLUMN IF NOT EXISTS contract_stop        NUMERIC,
    ADD COLUMN IF NOT EXISTS contract_estimated   BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS human_entry_price    NUMERIC,
    ADD COLUMN IF NOT EXISTS human_exit_price     NUMERIC,
    ADD COLUMN IF NOT EXISTS human_notes          TEXT
`);

console.log('✓ Contract columns ready');

// Delete old mock signals
await query(`DELETE FROM lc_v3.signals WHERE ticker = 'NVDA' AND news_headline LIKE '%JP Morgan%'`);

// Insert realistic mock A+ signal with full contract data
await query(`
  INSERT INTO lc_v3.signals (
    ticker, direction, grade, status,
    composite_raw, signal_tier,
    score_price_action, score_volume, score_news, score_market, score_timing,
    position_size_pct, position_size_dollars,
    confluence_score, news_headline,
    spy_change_pct, qqq_change_pct, sector_change_pct,
    relative_volume, atr_multiple,
    contract_symbol, contract_strike, contract_expiry, contract_expiry_label,
    contract_bid, contract_ask, contract_mid,
    contract_entry_lo, contract_entry_hi,
    contract_delta, contract_iv,
    contract_t1, contract_t2, contract_t3, contract_stop,
    contract_estimated,
    expires_at, created_at
  ) VALUES (
    'NVDA', 'CALL', 'A+', 'ACTIVE',
    87, 'primary',
    32, 27, 14, 12, 4,
    0.20, 1500,
    3, 'JP Morgan raises NVDA price target to $250, cites AI infrastructure supercycle',
    0.0082, 0.0134, 0.0198, 3.2, 1.8,
    'NVDA240312C00188000', 188, CURRENT_DATE, '0DTE',
    2.35, 2.65, 2.50,
    2.35, 2.68,
    0.48, 52.3,
    3.75, 5.00, 7.50, 1.50,
    false,
    NOW() + INTERVAL '5 minutes', NOW()
  )
`);

console.log('✓ Mock NVDA A+ signal with contract data inserted');
process.exit(0);

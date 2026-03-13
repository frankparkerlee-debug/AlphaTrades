import { query } from '../src/data/db.js';

// Delete old NVDA mock signals
const del = await query(`DELETE FROM lc_v3.signals WHERE ticker = 'NVDA' AND DATE(created_at AT TIME ZONE 'America/New_York') = CURRENT_DATE`);
console.log(`✓ Deleted ${del.rowCount} old NVDA signals`);

// Insert mock A+ signal with momentum note and full contract data
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
    first_seen_at, last_confirmed_at, confirmation_count,
    peak_composite, peak_grade, composite_history, momentum_trend,
    expires_at, created_at
  ) VALUES (
    'NVDA', 'CALL', 'A+', 'ACTIVE',
    89, 'primary',
    30, 28, 12, 14, 5,
    0.20, 1500,
    3, 'FRESH · Risk:LOW · Type:TREND_CONTINUATION · From Open:0.82%',
    0.0082, 0.0134, 0.0198, 3.2, 1.8,
    'NVDA260313C00118000', 118, CURRENT_DATE + 1, '1DTE',
    2.85, 3.15, 3.00,
    2.85, 3.18,
    0.52, 48.7,
    4.50, 6.00, 9.00, 1.80,
    false,
    NOW(), NOW(), 1,
    89, 'A+', '[]'::jsonb, 'NEW',
    NOW() + INTERVAL '10 minutes', NOW()
  )
`);

console.log('✓ Mock NVDA A+ signal inserted');
process.exit(0);

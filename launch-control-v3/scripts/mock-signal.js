/**
 * Insert a mock strategy signal + auto paper trade for UI testing.
 * Usage: node scripts/mock-signal.js [STRATEGY] [TICKER] [DIRECTION]
 * Defaults: GAP_REVERSAL NVDA CALL
 */
import { query } from '../src/data/db.js';

const strategy = process.argv[2] || 'GAP_REVERSAL';
const ticker   = process.argv[3] || 'NVDA';
const direction = process.argv[4] || 'CALL';

// Realistic mock data per strategy
const MOCKS = {
  GAP_REVERSAL: {
    confidence: 88, gap_pct: -3.2, entry: 118.50,
    t1: 121.30, t2: 123.80, stop: 116.90,
    hold: '90min', exitBy: '10:00 CT',
    contract: { symbol: `${ticker}260317C00119000`, strike: 119, expiry: '2026-03-17', expiry_label: '0DTE', delta: 0.52, iv: 42.5, bid: 2.15, ask: 2.35, mid: 2.25, t1: 3.10, t2: 3.85, t3: null, stop: 1.45 },
  },
  GAP_UP_REVERSAL: {
    confidence: 82, gap_pct: 2.8, entry: 122.40,
    t1: 120.10, t2: 118.50, stop: 124.20,
    hold: '90min', exitBy: '10:00 CT',
    contract: { symbol: `${ticker}260317P00122000`, strike: 122, expiry: '2026-03-17', expiry_label: '0DTE', delta: -0.48, iv: 45.1, bid: 1.80, ask: 2.00, mid: 1.90, t1: 2.65, t2: 3.30, t3: null, stop: 1.20 },
  },
  CAPITULATION_BOUNCE: {
    confidence: 76, intraday_drop: -5.1, entry: 165.20,
    t1: 169.50, t2: 172.80, stop: 162.40,
    hold: 'overnight',
    contract: { symbol: `${ticker}260318C00165000`, strike: 165, expiry: '2026-03-18', expiry_label: '1DTE', delta: 0.50, iv: 52.3, bid: 3.40, ask: 3.70, mid: 3.55, t1: 4.90, t2: 6.10, t3: null, stop: 2.30 },
  },
  VOL_DROP_PUT: {
    confidence: 71, intraday_drop: -4.8, entry: 145.60,
    t1: 142.30, t2: 139.80, stop: 148.20,
    hold: 'overnight',
    contract: { symbol: `${ticker}260318P00146000`, strike: 146, expiry: '2026-03-18', expiry_label: '1DTE', delta: -0.51, iv: 48.7, bid: 2.60, ask: 2.85, mid: 2.73, t1: 3.80, t2: 4.70, t3: null, stop: 1.75 },
  },
  CONSEC_BOUNCE: {
    confidence: 80, consecutive_days: 4, total_drop: -12.3, entry: 88.40,
    t1: 92.10, t2: 95.50, stop: 85.80,
    hold: 'multi-day', exit_within_days: 3,
    contract: { symbol: `${ticker}260319C00088000`, strike: 88, expiry: '2026-03-19', expiry_label: '2DTE', delta: 0.55, iv: 55.8, bid: 2.90, ask: 3.15, mid: 3.03, t1: 4.20, t2: 5.30, t3: null, stop: 1.95 },
  },
  SECTOR_ROTATION_BOUNCE: {
    confidence: 85, entry: 210.30,
    t1: 214.80, t2: 218.50, stop: 207.60,
    hold: 'same-day', exitBy: '2:00 PM CT',
    contract: { symbol: `${ticker}260317C00210000`, strike: 210, expiry: '2026-03-17', expiry_label: '0DTE', delta: 0.51, iv: 38.2, bid: 2.50, ask: 2.70, mid: 2.60, t1: 3.60, t2: 4.50, t3: null, stop: 1.70 },
  },
};

const mock = MOCKS[strategy];
if (!mock) {
  console.error(`Unknown strategy: ${strategy}. Options: ${Object.keys(MOCKS).join(', ')}`);
  process.exit(1);
}

const c = mock.contract;
const compositeRaw = Math.round(60 + mock.confidence * 0.4);

// Build news_headline with strategy metadata tags (same format as real signals)
const signalNote = [
  `strategy=${strategy}`,
  `confidence=${mock.confidence}%`,
  mock.gap_pct != null ? `gap=${mock.gap_pct}%` : null,
  mock.intraday_drop != null ? `drop=${mock.intraday_drop}%` : null,
  mock.t1 != null ? `T1=$${mock.t1}` : null,
  mock.t2 != null ? `T2=$${mock.t2}` : null,
  mock.stop != null ? `stop=$${mock.stop}` : null,
  mock.exitBy ? `exitBy=${mock.exitBy}` : null,
  mock.hold ? `hold=${mock.hold}` : null,
  mock.consecutive_days ? `consec=${mock.consecutive_days}d` : null,
  mock.total_drop != null ? `totalDrop=${mock.total_drop}%` : null,
  mock.exit_within_days ? `exitWithin=${mock.exit_within_days}d` : null,
  'FRESH · Risk:LOW · Type:GAP',
].filter(Boolean).join(' · ');

const signalStatus = strategy === 'VOL_DROP_PUT' ? 'PAPER_ONLY' : 'ACTIVE';
const expiryInterval = strategy === 'CONSEC_BOUNCE' ? '2 days' : '4 hours';

// Insert signal
const insertRes = await query(`
  INSERT INTO lc_v3.signals (
    ticker, direction, grade, status, composite_raw, signal_tier,
    price_at_signal, news_headline,
    score_price_action, score_volume, score_news, score_market, score_timing,
    position_size_pct, position_size_dollars,
    contract_symbol, contract_strike, contract_expiry, contract_expiry_label,
    contract_bid, contract_ask, contract_mid,
    contract_entry_lo, contract_entry_hi,
    contract_delta, contract_iv,
    contract_t1, contract_t2, contract_t3, contract_stop,
    contract_estimated,
    options_delta, options_gamma, options_theta, options_vega,
    options_iv, options_bid, options_ask, options_mid,
    first_seen_at, last_confirmed_at, confirmation_count,
    peak_composite, peak_grade, composite_history, momentum_trend,
    expires_at, created_at
  ) VALUES (
    $1, $2, 'A', $3, $4, 'primary',
    $5, $6,
    18, 16, 14, 12, 10,
    0.15, 1125,
    $7, $8, $9, $10,
    $11, $12, $13,
    $11, $12,
    $14, $15,
    $16, $17, $18, $19,
    false,
    $14, 0.0085, -0.045, 0.12,
    $15, $11, $12, $13,
    NOW(), NOW(), 1,
    $4, 'A', '[]'::jsonb, 'NEW',
    NOW() + INTERVAL '${expiryInterval}', NOW()
  ) RETURNING signal_id
`, [
  ticker, direction, signalStatus, compositeRaw,
  mock.entry, signalNote,
  c.symbol, c.strike, c.expiry, c.expiry_label,
  c.bid, c.ask, c.mid,
  c.delta, c.iv,
  c.t1, c.t2, c.t3, c.stop,
]);

const signalId = insertRes.rows[0].signal_id;
console.log(`[MOCK] Signal inserted: ${ticker} ${direction} ${strategy} signal_id=${signalId}`);
console.log(`[MOCK] Composite=${compositeRaw} Entry=$${mock.entry} T1=$${mock.t1} T2=$${mock.t2} Stop=$${mock.stop}`);
console.log(`[MOCK] Contract: ${c.symbol} mid=$${c.mid} delta=${c.delta} IV=${c.iv}%`);

// Auto-open paper trade
await query(`
  INSERT INTO lc_v3.paper_trades (
    signal_id, ticker, direction, grade, strategy,
    entry_stock_price, entry_contract_mid,
    entry_t1, entry_t2, entry_t3, entry_stop,
    position_size_pct,
    entry_contract_symbol, entry_contract_strike, entry_contract_expiry,
    entry_contract_delta, entry_contract_iv,
    status, auto_traded
  ) VALUES ($1,$2,$3,'A',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'OPEN',TRUE)
`, [
  signalId, ticker, direction, strategy,
  mock.entry, c.mid,
  c.t1, c.t2, c.t3, c.stop,
  0.15,
  c.symbol, c.strike, c.expiry,
  c.delta, c.iv,
]);
console.log(`[MOCK] Paper trade opened for ${ticker} ${strategy} (auto_traded=true)`);

process.exit(0);

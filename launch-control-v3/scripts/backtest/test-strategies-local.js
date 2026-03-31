#!/usr/bin/env node
/**
 * Local Strategy Test Harness
 *
 * Generates synthetic RTH minute bars and tests each strategy directly.
 * No database needed. Run: node scripts/backtest/test-strategies-local.js
 */

import {
  generateORBBreakoutSignals,
  generateVWAPBounceSignals,
  generateFirstPullbackSignals,
  generateGapFillSignals,
  generatePowerHourMomentumSignals,
  generateMacroReactionSignals,
  generateExtremeReversalSignals,
  generateEODMeanReversionSignals,
  generateHighRvolBreakoutSignals,
  generatePEADDriftSignals,
  generateSectorLaggardSignals,
  generateShortSqueezeSignals,
  generateOptionsFlowSignals,
  generateAnalystDriftSignals,
  generateVIXReversalSignals,
  generateZeroDTEScalpSignals,
} from './strategies/live-adapter.js';

// ── Generate synthetic minute bars ──────────────────────────────────────────

function generateRTHBars(ticker, date, scenario = 'trending_up') {
  const bars = {};
  // EDT: 13:30-20:00 UTC, EST: 14:30-21:00 UTC
  // Use EDT for simplicity (March date)
  const startHour = 13, startMin = 30;
  const basePrice = 150;
  const atrDaily = basePrice * 0.025; // 2.5% ATR
  let price = basePrice;
  const avgMinuteVol = 50000;

  for (let m = 0; m < 390; m++) {
    const totalMin = startHour * 60 + startMin + m;
    const h = Math.floor(totalMin / 60);
    const min = totalMin % 60;
    const key = `${date}T${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;

    let drift = 0, volMult = 1;

    switch (scenario) {
      case 'trending_up':
        drift = (atrDaily / 390) * 0.8; // slow grind up
        if (m < 30) volMult = 2.5; // high opening volume
        break;
      case 'trending_down':
        drift = -(atrDaily / 390) * 0.8;
        if (m < 30) volMult = 2.5;
        break;
      case 'gap_up_fill':
        price = m === 0 ? basePrice * 1.003 : price; // 0.3% gap up
        drift = -(atrDaily / 390) * 0.3; // drift back down
        break;
      case 'gap_down_fill':
        price = m === 0 ? basePrice * 0.997 : price; // 0.3% gap down
        drift = (atrDaily / 390) * 0.3;
        break;
      case 'extreme_drop':
        drift = m < 120 ? -(atrDaily / 120) * 1.2 : (atrDaily / 270) * 0.3;
        if (m < 60) volMult = 3;
        break;
      case 'vwap_bounce':
        // Oscillate around VWAP-like price
        drift = Math.sin(m / 30) * (atrDaily / 390) * 0.5;
        break;
      case 'pullback_then_resume':
        if (m < 20) drift = (atrDaily / 390) * 2; // strong up
        else if (m < 30) drift = -(atrDaily / 390) * 0.8; // pullback
        else drift = (atrDaily / 390) * 1.2; // resume
        if (m >= 20 && m < 30) volMult = 0.5; // declining vol on pullback
        break;
      case 'power_hour_continuation':
        drift = (atrDaily / 390) * 0.5; // moderate uptrend all day
        if (m > 300) volMult = 1.5; // volume picks up at 3PM
        break;
      case 'eod_loser':
        drift = -(atrDaily / 390) * 1.5; // down all day
        break;
      case 'high_rvol_breakout':
        drift = (atrDaily / 390) * 1.0;
        volMult = 3; // 3x normal volume all day
        break;
      default:
        drift = (Math.random() - 0.5) * atrDaily * 0.01;
    }

    const noise = (Math.random() - 0.5) * atrDaily * 0.02;
    const open = price;
    price += drift + noise;
    const close = price;
    const high = Math.max(open, close) + Math.random() * atrDaily * 0.005;
    const low = Math.min(open, close) - Math.random() * atrDaily * 0.005;
    const vol = Math.round(avgMinuteVol * volMult * (0.7 + Math.random() * 0.6));

    bars[key] = { o: +open.toFixed(2), h: +high.toFixed(2), l: +low.toFixed(2), c: +close.toFixed(2), v: vol };
  }
  return bars;
}

function generateDailyBar(ticker, date, minuteBars) {
  const keys = Object.keys(minuteBars[ticker] || {}).filter(k => k.startsWith(date)).sort();
  if (keys.length === 0) return null;
  const first = minuteBars[ticker][keys[0]];
  const last = minuteBars[ticker][keys[keys.length - 1]];
  let h = -Infinity, l = Infinity, v = 0;
  for (const k of keys) {
    const b = minuteBars[ticker][k];
    if (b.h > h) h = b.h;
    if (b.l < l) l = b.l;
    v += b.v;
  }
  return { o: first.o, h, l, c: last.c, v };
}

// ── Test each strategy ──────────────────────────────────────────────────────

const TICKERS = ['NVDA', 'AAPL', 'TSLA', 'AMZN', 'META', 'MSFT', 'GOOGL', 'AMD', 'NFLX', 'CRM'];
const DATE = '2026-03-15';
const PREV_DATE = '2026-03-14';

// Map of strategy name -> best scenario to test with
const STRATEGY_SCENARIOS = {
  ORB_BREAKOUT:          'trending_up',
  VWAP_BOUNCE:           'vwap_bounce',
  FIRST_PULLBACK:        'pullback_then_resume',
  GAP_FILL_REVERSION:    'gap_down_fill',
  POWER_HOUR_MOMENTUM:   'power_hour_continuation',
  MACRO_REACTION:        'trending_up',        // needs macroEvents
  EXTREME_REVERSAL:      'extreme_drop',
  EOD_MEAN_REVERSION:    'eod_loser',
  HIGH_RVOL_BREAKOUT:    'high_rvol_breakout',
  PEAD_DRIFT:            'trending_up',        // needs earningsCalendar
  ZERO_DTE_SCALP:        'trending_up',
};

const STRATEGIES = [
  { name: 'ORB_BREAKOUT',          fn: generateORBBreakoutSignals },
  { name: 'VWAP_BOUNCE',           fn: generateVWAPBounceSignals },
  { name: 'FIRST_PULLBACK',        fn: generateFirstPullbackSignals },
  { name: 'GAP_FILL_REVERSION',    fn: generateGapFillSignals },
  { name: 'POWER_HOUR_MOMENTUM',   fn: generatePowerHourMomentumSignals },
  { name: 'EXTREME_REVERSAL',      fn: generateExtremeReversalSignals },
  { name: 'EOD_MEAN_REVERSION',    fn: generateEODMeanReversionSignals },
  { name: 'HIGH_RVOL_BREAKOUT',    fn: generateHighRvolBreakoutSignals },
  { name: 'ZERO_DTE_SCALP',        fn: generateZeroDTEScalpSignals },
];

// Strategies that need external data (will always be 0 without it)
const DATA_DEPENDENT = ['MACRO_REACTION', 'PEAD_DRIFT', 'SECTOR_LAGGARD', 'SHORT_SQUEEZE_MOMENTUM', 'OPTIONS_FLOW', 'ANALYST_DRIFT', 'VIX_REVERSAL'];

console.log('=== LOCAL STRATEGY TEST HARNESS ===');
console.log(`Testing ${STRATEGIES.length} strategies with synthetic RTH bars`);
console.log(`Tickers: ${TICKERS.join(', ')}`);
console.log(`Date: ${DATE}`);
console.log(`Skipping ${DATA_DEPENDENT.length} data-dependent strategies\n`);

let totalSignals = 0;
let passing = 0;

for (const strat of STRATEGIES) {
  const scenario = STRATEGY_SCENARIOS[strat.name] || 'trending_up';

  // Build minute bars for all tickers with the right scenario
  const minuteBars = {};
  const etfMinuteBars = {};
  const dailyBars = {};

  for (const ticker of TICKERS) {
    minuteBars[ticker] = generateRTHBars(ticker, DATE, scenario);
    // Generate previous day bars for dailyBars
    const prevBars = generateRTHBars(ticker, PREV_DATE, 'trending_up');
    minuteBars[ticker] = { ...minuteBars[ticker] }; // keep current day only in minuteBars
    // But we need prev day in dailyBars
    dailyBars[ticker] = {};
    dailyBars[ticker][PREV_DATE] = generateDailyBar(ticker, PREV_DATE, { [ticker]: prevBars });
  }

  // SPY and QQQ for ETF checks
  for (const etf of ['SPY', 'QQQ', 'IWM']) {
    etfMinuteBars[etf] = generateRTHBars(etf, DATE, scenario);
  }

  const profiles = {};
  for (const ticker of TICKERS) {
    const firstKey = Object.keys(minuteBars[ticker]).sort()[0];
    const openPrice = minuteBars[ticker][firstKey]?.o || 150;
    profiles[ticker] = {
      ticker,
      atr_20d: 0.025,
      atr_5d: 0.025,
      avg_volume_20d: 50000 * 390, // ~19.5M daily
      avg_volume: 50000 * 390,
      beta_spy: 1.2,
      beta_qqq: 1.1,
      sector_etf: 'XLK',
      options_liquidity_score: 0.8,
    };
  }

  const dayData = {
    minuteBars,
    etfMinuteBars,
    dailyBars,
    vixByTime: {},
    tradingDays: [DATE],
  };

  const context = {
    profiles,
    intelligence: {},
    contagionMap: {},
    secFilings: {},
    ivHistory: {},
    earningsCalendar: {},
    tickers: TICKERS,
  };

  try {
    const signals = strat.fn(DATE, dayData, context);
    const count = signals.length;
    totalSignals += count;
    const status = count > 0 ? 'PASS' : 'FAIL';
    if (count > 0) passing++;

    console.log(`${status === 'PASS' ? 'PASS' : 'FAIL'} ${strat.name.padEnd(25)} ${String(count).padStart(3)} signals  (scenario: ${scenario})`);

    if (count > 0) {
      const sample = signals[0];
      console.log(`     -> ${sample.ticker} ${sample.direction} @ $${sample.entryPrice} stop=$${sample.stopCondition?.value} target=$${sample.targetCondition?.value} grade=${sample.grade}`);
    }
    if (count === 0) {
      // Run with verbose logging to diagnose
      console.log(`     -> 0 signals with ${TICKERS.length} tickers, ${Object.keys(minuteBars[TICKERS[0]]).length} bars/ticker`);
    }
  } catch (err) {
    console.log(`ERR  ${strat.name.padEnd(25)} ${err.message}`);
  }
}

console.log(`\n=== RESULTS: ${passing}/${STRATEGIES.length} strategies producing signals, ${totalSignals} total ===`);
if (passing < STRATEGIES.length) {
  console.log(`\nFailing strategies need investigation. The synthetic data should trigger every strategy.`);
}
console.log(`\nData-dependent strategies (not tested): ${DATA_DEPENDENT.join(', ')}`);

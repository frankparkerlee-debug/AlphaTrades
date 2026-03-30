/**
 * Strategy A10: Relative Strength Divergence
 *
 * On weak market days, stocks that are UP reveal institutional accumulation.
 * On strong market days, stocks that are DOWN reveal institutional distribution.
 * This divergence from the market is the strongest directional signal available.
 *
 * Key edge: When the market sells off and a stock holds green, someone
 * is buying aggressively against the tape. That conviction predicts
 * continuation. The live relative-weakness-put strategy confirms this
 * pattern works for the bearish side (80% base confidence).
 *
 * Bull: SPY < -0.3% but stock is UP (relative strength) → CALL
 * Bear: SPY > +0.3% but stock is DOWN (relative weakness) → PUT
 *
 * Direction: With the divergent stock (institutional conviction).
 * Structure: Debit vertical spread.
 * Hold: 60-120 min (divergence signals build throughout the day).
 *
 * Different from A8 (Beta Thrust): A8 trades WITH the market via high
 * beta. A10 trades AGAINST the market where stocks diverge — completely
 * opposite thesis.
 */

import { analyzeMomentum } from '../../../src/scoring/momentum.js';
import { analyzeTrend, classifyRegime } from '../../../src/scoring/intelligence.js';
import { getSpreadWidth, POSITION_SIZES } from '../execution-model.js';

const STRATEGY = 'A10_RELATIVE_STRENGTH';
const MIN_MARKET_MOVE_PCT   = 0.003;  // market must be moving >=0.3%
const MIN_DIVERGENCE_PCT    = 0.012;  // stock must diverge >=1.2% from market direction
const MIN_VWAP_CONFIRM      = true;   // stock must be on the "right side" of VWAP

/**
 * Generate A10 signals for a single trading day.
 */
export function generateA10Signals(date, dayData, context) {
  const { minuteBars, etfMinuteBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];
  const seen = new Set();

  // Scan window: 10:30 - 14:30 ET (need enough session for divergence to establish)
  const scanStart = `${date}T15:00`; // ~10:00 ET
  const scanEnd   = `${date}T19:00`; // ~14:00 ET

  const spyMinutes = etfMinuteBars?.SPY || {};
  const qqqMinutes = etfMinuteBars?.QQQ || {};

  const spyOpen = findSessionOpen(spyMinutes, date);
  const qqqOpen = findSessionOpen(qqqMinutes, date);
  if (!spyOpen || !qqqOpen) return signals;

  // Check every 15 minutes for divergence opportunities
  const checkKeys = Object.keys(spyMinutes)
    .filter(k => k >= scanStart && k <= scanEnd)
    .sort()
    .filter((_, i) => i % 15 === 0); // every 15 min

  for (const checkTime of checkKeys) {
    const spyBar = spyMinutes[checkTime];
    const qqqBar = qqqMinutes[checkTime];
    if (!spyBar || !qqqBar) continue;

    const spyPct = (spyBar.c - spyOpen) / spyOpen;
    const qqqPct = (qqqBar.c - qqqOpen) / qqqOpen;
    const avgMarketPct = (spyPct + qqqPct) / 2;

    // Market must be moving meaningfully
    if (Math.abs(avgMarketPct) < MIN_MARKET_MOVE_PCT) continue;

    const marketDown = avgMarketPct < 0;
    const marketUp = avgMarketPct > 0;

    // Scan tickers for divergence
    for (const ticker of tickers) {
      const profile = profiles[ticker];
      if (!profile) continue;

      const tickerMinutes = minuteBars[ticker] || {};
      const tickerBar = tickerMinutes[checkTime];
      if (!tickerBar) continue;

      const tickerOpen = findSessionOpen(tickerMinutes, date);
      if (!tickerOpen) continue;

      const atr = profile.atr_5d || profile.atr_20d || 0.025;
      const tickerPct = (tickerBar.c - tickerOpen) / tickerOpen;
      const vwap = tickerBar.vw;

      // Calculate divergence: how much is the stock bucking the market?
      const divergence = tickerPct - avgMarketPct;

      // ── Relative Strength: market down, stock up ────────────
      if (marketDown && divergence > MIN_DIVERGENCE_PCT) {
        const key = `${ticker}:CALL`;
        if (seen.has(key)) continue;

        // VWAP confirmation: stock should be above VWAP (accumulation)
        if (vwap && tickerBar.c < vwap) continue;

        const signal = buildDivergenceSignal(
          'CALL', ticker, date, checkTime, tickerBar, profile,
          tickerOpen, atr, divergence, avgMarketPct, tickerPct,
          tickerMinutes, etfMinuteBars, spyPct, qqqPct
        );
        if (signal) {
          seen.add(key);
          signals.push(signal);
        }
      }

      // ── Relative Weakness: market up, stock down ────────────
      if (marketUp && divergence < -MIN_DIVERGENCE_PCT) {
        const key = `${ticker}:PUT`;
        if (seen.has(key)) continue;

        // VWAP confirmation: stock should be below VWAP (distribution)
        if (vwap && tickerBar.c > vwap) continue;

        const signal = buildDivergenceSignal(
          'PUT', ticker, date, checkTime, tickerBar, profile,
          tickerOpen, atr, divergence, avgMarketPct, tickerPct,
          tickerMinutes, etfMinuteBars, spyPct, qqqPct
        );
        if (signal) {
          seen.add(key);
          signals.push(signal);
        }
      }
    }
  }

  // Cap: only take the strongest divergence signals (top 8 per day)
  signals.sort((a, b) => b.composite - a.composite);
  return signals.slice(0, 8);
}

function buildDivergenceSignal(
  direction, ticker, date, minuteKey, bar, profile,
  tickerOpen, atr, divergence, marketPct, tickerPct,
  tickerMinutes, etfMinuteBars, spyPct, qqqPct
) {
  const currentPrice = bar.c;

  // Get recent bars for trend/momentum
  const recentKeys = Object.keys(tickerMinutes)
    .filter(k => k.startsWith(date) && k <= minuteKey)
    .sort().slice(-15);
  const recentBars = recentKeys.map(k => tickerMinutes[k]).filter(Boolean);
  if (recentBars.length < 5) return null;

  // Trend should align with divergence direction
  const trend = analyzeTrend(recentBars, direction);
  if (trend.signalType === 'COUNTER_TREND_STRONG') return null;
  if (trend.signalType === 'REVERSAL_RISK') return null;

  // Momentum: divergence should be building, not fading
  const momentum = analyzeMomentum(
    recentBars, tickerOpen, tickerOpen, atr, direction
  );
  if (momentum.freshness === 'EXHAUSTED') return null;

  // Regime check (permissive — divergence trades work in most regimes)
  const regime = classifyRegime({ spyPct, qqqPct }, 18, []);
  if (regime.regime === 'MARKET_BREAKDOWN') return null;
  // For relative strength (CALL on down day): allow even in risk-off
  // For relative weakness (PUT on up day): allow even in risk-on
  // The divergence IS the signal — regime gates would filter the very edge we're trading

  const absDivergence = Math.abs(divergence);
  const spreadWidth = getSpreadWidth(currentPrice);
  const grade = divergenceToGrade(absDivergence, trend, momentum);
  // Size down slightly since we're trading against market direction
  const sizePct = (POSITION_SIZES[grade] || 0.075) * 0.85;

  return {
    strategy: STRATEGY,
    date,
    time: minuteKey,
    ticker,
    direction,
    grade,
    entryPrice: currentPrice,
    atr,
    spreadType: 'DEBIT_VERTICAL',
    spreadWidth,
    entryDebit: spreadWidth * 0.45,
    stopCondition:   { type: 'ATR', value: 0.5 },
    targetCondition: { type: 'ATR', value: 0.7 },
    maxHoldMinutes: 90,
    holdDays: 0,
    sizePct,
    oiEstimate: Math.round((profile.options_liquidity_score || 0.5) * 500),
    freshness: momentum.freshness,
    regime: regime.regime,
    signalType: direction === 'CALL' ? 'RELATIVE_STRENGTH' : 'RELATIVE_WEAKNESS',
    composite: Math.round(absDivergence * 2000 + (trend.trendAligned ? 15 : 0) + momentum.momentumScore),
    scores: {
      divergence: Math.round(absDivergence * 1000),
      trendAlignment: trend.trendAligned ? 10 : 0,
      momentum: momentum.momentumScore,
      volumeConfirm: Math.round(Math.min(10, (momentum.volSurge || 1) * 5)),
      vwapConfirm: 10, // already filtered for VWAP alignment
    },
    metadata: {
      divergencePct: parseFloat((divergence * 100).toFixed(2)),
      marketMovePct: parseFloat((marketPct * 100).toFixed(2)),
      stockMovePct: parseFloat((tickerPct * 100).toFixed(2)),
      divergenceType: direction === 'CALL' ? 'STRENGTH_ON_WEAK_DAY' : 'WEAKNESS_ON_STRONG_DAY',
      trendAligned: trend.trendAligned,
      trendStrength: trend.trendStrength,
      betaSpy: profile.beta_spy,
    },
  };
}

// -- Helpers ------------------------------------------------------------------

function findSessionOpen(minutes, date) {
  const keys = Object.keys(minutes).filter(k => k.startsWith(date)).sort();
  return keys.length > 0 ? minutes[keys[0]]?.o : null;
}

function divergenceToGrade(absDivergence, trend, momentum) {
  let score = 0;

  // Divergence magnitude: more divergence = stronger conviction
  if (absDivergence >= 0.025) score += 15;       // 2.5%+ divergence
  else if (absDivergence >= 0.018) score += 12;   // 1.8%+
  else score += 8;

  // Trend alignment
  if (trend.trendAligned && trend.trendStrength === 'STRONG') score += 12;
  else if (trend.trendAligned) score += 8;
  else score += 3;

  // Momentum quality
  if (momentum.freshness === 'FRESH') score += 8;
  else if (momentum.freshness === 'DEVELOPING') score += 6;
  else if (momentum.freshness === 'EXTENDED') score += 3;

  // Volume expanding = institutional conviction
  if (momentum.volSurge > 1.5) score += 5;
  else if (momentum.volSurge > 1.2) score += 3;

  if (score >= 38) return 'A+';
  if (score >= 30) return 'A';
  if (score >= 23) return 'A-';
  if (score >= 16) return 'B+';
  return 'B';
}

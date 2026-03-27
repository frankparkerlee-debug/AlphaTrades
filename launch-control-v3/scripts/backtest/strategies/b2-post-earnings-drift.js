/**
 * Strategy B2: Post-Earnings Drift
 *
 * After an earnings beat with gap > 1% in beat direction,
 * buy debit spread to capture the 2-3 day drift.
 *
 * Academic anomaly: markets underreact to earnings surprises.
 * Stocks drift in the gap direction for 2-5 days post-earnings.
 *
 * Structure: Debit vertical spread (defined risk, reduces IV crush).
 * Hold: 2-3 trading days.
 * Stop: Drift reverses > 50% of gap.
 */

import { classifyRegime } from '../../../src/scoring/intelligence.js';
import { getSpreadWidth, POSITION_SIZES } from '../execution-model.js';

const STRATEGY = 'B2_POST_EARNINGS_DRIFT';
const MIN_GAP_PCT      = 0.01;     // minimum 1% gap
const MIN_BEAT_RATE    = 0.55;     // ticker must beat > 55% of the time
const HOLD_DAYS        = 3;        // hold 3 trading days
const DEBIT_RATIO      = 0.50;     // pay ~50% of width (slightly more conservative)

/**
 * Generate B2 signals for a single trading day.
 * Checks if yesterday was an earnings date for any ticker.
 */
export function generateB2Signals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, dailyBars } = dayData;
  const { profiles, intelligence, earningsCalendar, tickers } = context;
  const signals = [];

  // Find yesterday's date (previous trading day)
  const prevDate = findPrevTradingDay(date, dayData.tradingDays || []);
  if (!prevDate) return signals;

  // Check which tickers had earnings yesterday
  const earningsTickers = earningsCalendar[prevDate] || [];
  if (earningsTickers.length === 0) return signals;

  const entryMinuteKey = `${date}T14:45`; // enter ~15min after open for price discovery

  for (const ticker of earningsTickers) {
    if (!tickers.includes(ticker)) continue;

    const profile = profiles[ticker];
    if (!profile) continue;

    const intel = intelligence[ticker];
    if (!intel) continue;

    // ── Beat rate filter ──────────────────────────────────────
    if ((intel.earnings_beat_rate || 0) < MIN_BEAT_RATE) continue;

    // ── Gap detection ─────────────────────────────────────────
    const prevDaily = dailyBars[ticker]?.[prevDate];
    const todayBars = minuteBars[ticker] || {};
    const entryBar = findNearestBar(todayBars, entryMinuteKey, date);

    if (!prevDaily || !entryBar) continue;

    const prevClose = prevDaily.c;
    const todayOpen = findSessionOpen(todayBars, date);
    if (!todayOpen) continue;

    const gapPct = (todayOpen - prevClose) / prevClose;
    const absGap = Math.abs(gapPct);

    if (absGap < MIN_GAP_PCT) continue;

    // ── Determine drift direction ─────────────────────────────
    // Gap up after earnings = likely beat → drift UP (buy call spread)
    // Gap down after earnings = likely miss → drift DOWN (buy put spread)
    const direction = gapPct > 0 ? 'CALL' : 'PUT';

    // Verify the gap is in the expected direction for a beat
    // If beat_rate > 0.55 and stock gapped down, it might be a miss → skip
    // We trust the gap direction as the market's assessment
    // But historical earnings data can confirm
    const historicalEarnings = intel.historical_earnings;
    const lastEarning = Array.isArray(historicalEarnings)
      ? historicalEarnings[0]
      : null;

    // ── Confirm drift hasn't already played out ───────────────
    // If today's price has already moved significantly from open, skip
    const intradayMove = Math.abs((entryBar.c - todayOpen) / todayOpen);
    if (intradayMove > 0.03) continue; // > 3% intraday move = drift may be done

    // ── Regime check ──────────────────────────────────────────
    const spyBars = getETFBarsUpto(etfMinuteBars?.SPY, entryMinuteKey);
    const qqqBars = getETFBarsUpto(etfMinuteBars?.QQQ, entryMinuteKey);
    const spyPct = spyBars.length >= 2
      ? (spyBars[spyBars.length-1].c - spyBars[0].c) / spyBars[0].c : 0;
    const qqqPct = qqqBars.length >= 2
      ? (qqqBars[qqqBars.length-1].c - qqqBars[0].c) / qqqBars[0].c : 0;

    const regime = classifyRegime({ spyPct, qqqPct }, 18, spyBars.slice(-3));
    if (regime.regime === 'MARKET_BREAKDOWN') continue;
    if (direction === 'CALL' && !regime.callsAllowed) continue;
    if (direction === 'PUT' && !regime.putsAllowed) continue;

    // ── Build signal ──────────────────────────────────────────
    const entryPrice = entryBar.c;
    const atr = profile.atr_5d || profile.atr_20d || 0.025;
    const spreadWidth = getSpreadWidth(entryPrice);

    // Grade based on gap size, beat rate, and historical avg move
    const grade = driftToGrade(absGap, intel.earnings_beat_rate, intel.earnings_avg_move_pct);
    const sizePct = (POSITION_SIZES[grade] || 0.075) * (regime.sizeMult || 1);

    // Stop: if price reverses past 50% of the gap
    const gapDollars = gapPct * prevClose;
    const stopReversalPct = Math.abs(gapDollars * 0.5) / entryPrice / atr;

    signals.push({
      strategy: STRATEGY,
      date,
      time: entryMinuteKey,
      ticker,
      direction,
      grade,
      entryPrice,
      atr,
      spreadType: 'DEBIT_VERTICAL',
      spreadWidth,
      entryDebit: spreadWidth * DEBIT_RATIO,
      stopCondition:   { type: 'ATR', value: Math.max(0.5, stopReversalPct) },
      targetCondition: { type: 'ATR', value: 1.5 }, // 1.5 ATR favorable = close
      maxHoldMinutes: 0,
      holdDays: HOLD_DAYS,
      sizePct,
      oiEstimate: Math.round((profile.options_liquidity_score || 0.5) * 500),
      // Metadata
      freshness: 'N/A',
      regime: regime.regime,
      signalType: 'POST_EARNINGS_DRIFT',
      composite: Math.round(absGap * 1000 + intel.earnings_beat_rate * 50),
      scores: {
        gapSize: Math.round(absGap * 100),
        beatRate: Math.round(intel.earnings_beat_rate * 20),
        avgMove: Math.round(intel.earnings_avg_move_pct * 2),
        regime: Math.round((regime.sizeMult || 1) * 5),
        liquidity: Math.round((profile.options_liquidity_score || 0.5) * 10),
      },
      metadata: {
        gapPct: parseFloat((gapPct * 100).toFixed(2)),
        prevClose,
        todayOpen,
        earningsBeatRate: intel.earnings_beat_rate,
        earningsAvgMove: intel.earnings_avg_move_pct,
        lastEarning,
      },
    });
  }

  return signals;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function findPrevTradingDay(date, tradingDays) {
  if (tradingDays.length === 0) {
    // Fallback: subtract 1-3 days to skip weekends
    const d = new Date(date);
    const dow = d.getDay();
    if (dow === 1) d.setDate(d.getDate() - 3); // Monday → Friday
    else if (dow === 0) d.setDate(d.getDate() - 2); // Sunday → Friday
    else d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
  }
  const idx = tradingDays.indexOf(date);
  return idx > 0 ? tradingDays[idx - 1] : null;
}

function findSessionOpen(tickerMinutes, date) {
  const keys = Object.keys(tickerMinutes).filter(k => k.startsWith(date)).sort();
  return keys.length > 0 ? tickerMinutes[keys[0]]?.o : null;
}

function findNearestBar(tickerMinutes, targetKey, date) {
  const keys = Object.keys(tickerMinutes)
    .filter(k => k.startsWith(date) && k >= targetKey)
    .sort();
  if (keys.length > 0) return tickerMinutes[keys[0]];
  const allKeys = Object.keys(tickerMinutes).filter(k => k.startsWith(date)).sort();
  return allKeys.length > 0 ? tickerMinutes[allKeys[0]] : null;
}

function getETFBarsUpto(etfMinutes, uptoKey) {
  if (!etfMinutes) return [];
  const date = uptoKey.slice(0, 10);
  return Object.entries(etfMinutes)
    .filter(([k]) => k.startsWith(date) && k <= uptoKey)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v);
}

function driftToGrade(absGap, beatRate, avgMove) {
  let score = 0;
  score += Math.min(15, absGap * 500);         // 1% gap = 5, 3% = 15
  score += Math.min(15, beatRate * 20);         // 0.75 = 15
  score += Math.min(10, (avgMove || 3) * 2);   // 5% avg move = 10

  if (score >= 32) return 'A+';
  if (score >= 26) return 'A';
  if (score >= 20) return 'A-';
  if (score >= 14) return 'B+';
  return 'B';
}

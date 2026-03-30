/**
 * Strategy A7: Power Hour Momentum
 *
 * The last 90 minutes of trading (14:30-16:00 ET) see institutional
 * closing flows. Stocks that have trended all day get a final push
 * as funds complete their orders before close.
 *
 * Key edge: Late-day volume is institutional. Stocks with persistent
 * momentum (profile.momentum_persistence) continue into close 60-70%
 * of the time. All other strategies target morning/midday — this
 * captures a completely different time window.
 *
 * Direction: Same as intraday trend (momentum continuation).
 * Structure: Debit vertical spread.
 * Hold: 30-60 min (into close, short theta exposure).
 *
 * Critical filter: Must have a clear intraday trend established.
 * Late entries into choppy stocks fail. Volume must still be healthy.
 */

import { analyzeMomentum } from '../../../src/scoring/momentum.js';
import { analyzeTrend, classifyRegime } from '../../../src/scoring/intelligence.js';
import { getSpreadWidth, POSITION_SIZES } from '../execution-model.js';

const STRATEGY = 'A7_POWER_HOUR';
const MIN_DAY_TREND_ATR  = 0.5;   // stock must have trended >= 0.5 ATR from open
const MIN_MOMENTUM_PERSIST = 0.3;  // profile.momentum_persistence minimum
const MIN_BARS_IN_TREND  = 3;     // need 3+ bars of consistent direction in recent window
const MAX_HOLD_MINUTES   = 60;    // exit before or at close

/**
 * Generate A7 signals for a single trading day.
 */
export function generateA7Signals(date, dayData, context) {
  const { minuteBars, etfMinuteBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];
  const seen = new Set();

  // Power hour: 14:30 - 15:30 ET = 19:00 - 20:00 UTC
  // Entry window: 14:30 - 15:15 ET (need time for the trade to work)
  const powerHourStart = `${date}T19:00`;  // ~14:00 ET
  const powerHourEnd   = `${date}T19:45`;  // ~14:45 ET (stop entries 15 min before close)

  for (const ticker of tickers) {
    const profile = profiles[ticker];
    if (!profile) continue;

    // Must have decent momentum persistence
    if ((profile.momentum_persistence || 0) < MIN_MOMENTUM_PERSIST) continue;

    const tickerMinutes = minuteBars[ticker] || {};
    const atr = profile.atr_5d || profile.atr_20d || 0.025;

    const sessionOpen = findSessionOpen(tickerMinutes, date);
    if (!sessionOpen) continue;

    // Get full day's bars for trend context
    const allKeys = Object.keys(tickerMinutes).filter(k => k.startsWith(date)).sort();
    if (allKeys.length < 30) continue; // need enough day history

    // Check intraday trend: price vs open
    const latestBeforePowerHour = allKeys.filter(k => k < powerHourStart);
    if (latestBeforePowerHour.length < 20) continue;

    const lastPrePH = tickerMinutes[latestBeforePowerHour[latestBeforePowerHour.length - 1]];
    const dayMoveFromOpen = (lastPrePH.c - sessionOpen) / sessionOpen;
    const dayMoveATRs = Math.abs(dayMoveFromOpen) / atr;

    // Must have established intraday trend
    if (dayMoveATRs < MIN_DAY_TREND_ATR) continue;

    const dayDirection = dayMoveFromOpen > 0 ? 'CALL' : 'PUT';
    const key = `${ticker}:${dayDirection}`;
    if (seen.has(key)) continue;

    // Now scan power hour bars for continuation entry
    const phKeys = allKeys.filter(k => k >= powerHourStart && k <= powerHourEnd);
    if (phKeys.length < 3) continue;

    // Build recent bars from pre-PH context + PH bars
    const contextBars = latestBeforePowerHour.slice(-10).map(k => tickerMinutes[k]);
    let recentBars = [...contextBars];

    for (const minuteKey of phKeys) {
      const bar = tickerMinutes[minuteKey];
      recentBars.push(bar);
      if (recentBars.length > 20) recentBars = recentBars.slice(-20);

      const currentPrice = bar.c;

      // Confirm direction still holds in power hour
      const phMoveFromOpen = (currentPrice - sessionOpen) / sessionOpen;
      const phDirection = phMoveFromOpen > 0 ? 'CALL' : 'PUT';
      if (phDirection !== dayDirection) continue; // direction flipped, skip

      // Trend analysis on recent bars
      const trend = analyzeTrend(recentBars, dayDirection);
      if (!trend.trendAligned) continue;
      if (trend.signalType === 'FADING_MOMENTUM') continue;
      if (trend.signalType === 'REVERSAL_RISK') continue;

      // Momentum check: want FRESH or DEVELOPING in the power hour context
      // (even if the overall day move is extended, the PH leg can be fresh)
      const momentum = analyzeMomentum(
        recentBars.slice(-8), // just recent bars for freshness
        lastPrePH.c,          // use pre-PH price as reference (not session open)
        sessionOpen,
        atr,
        dayDirection
      );

      // Don't enter if PH momentum is already exhausted
      if (momentum.freshness === 'EXHAUSTED') continue;

      // Volume check: power hour should have decent volume
      if (momentum.volSurge < 0.8) continue; // volume dropping off = no institutional flow

      // Regime check
      const spyBars = getETFBarsUpto(etfMinuteBars?.SPY, minuteKey);
      const qqqBars = getETFBarsUpto(etfMinuteBars?.QQQ, minuteKey);
      const spyPct = spyBars.length >= 2
        ? (spyBars[spyBars.length-1].c - spyBars[0].c) / spyBars[0].c : 0;
      const qqqPct = qqqBars.length >= 2
        ? (qqqBars[qqqBars.length-1].c - qqqBars[0].c) / qqqBars[0].c : 0;

      const regime = classifyRegime({ spyPct, qqqPct }, 18, spyBars.slice(-3));
      if (regime.sizeMult === 0) continue;
      if (dayDirection === 'CALL' && !regime.callsAllowed) continue;
      if (dayDirection === 'PUT' && !regime.putsAllowed) continue;

      // Build signal
      const spreadWidth = getSpreadWidth(currentPrice);
      const persistence = profile.momentum_persistence || 0.5;
      const grade = powerHourToGrade(dayMoveATRs, persistence, trend, momentum);
      const sizePct = (POSITION_SIZES[grade] || 0.075) * (regime.sizeMult || 1);

      seen.add(key);
      signals.push({
        strategy: STRATEGY,
        date,
        time: minuteKey,
        ticker,
        direction: dayDirection,
        grade,
        entryPrice: currentPrice,
        atr,
        spreadType: 'DEBIT_VERTICAL',
        spreadWidth,
        entryDebit: spreadWidth * 0.45,
        stopCondition:   { type: 'ATR', value: 0.35 }, // tight stop; PH should work fast
        targetCondition: { type: 'ATR', value: 0.5 },  // target 0.5 ATR (modest, realistic for 30-60 min)
        maxHoldMinutes: MAX_HOLD_MINUTES,
        holdDays: 0,
        sizePct,
        oiEstimate: Math.round((profile.options_liquidity_score || 0.5) * 500),
        freshness: momentum.freshness,
        regime: regime.regime,
        signalType: 'POWER_HOUR_CONTINUATION',
        composite: Math.round(dayMoveATRs * 15 + persistence * 20 + (trend.trendAligned ? 10 : 0)),
        scores: {
          dayTrend: Math.round(dayMoveATRs * 10),
          persistence: Math.round(persistence * 20),
          trendQuality: trend.trendAligned ? (trend.volExpanding ? 10 : 7) : 0,
          phMomentum: momentum.momentumScore,
          regime: Math.round((regime.sizeMult || 1) * 5),
        },
        metadata: {
          dayMoveATRs: parseFloat(dayMoveATRs.toFixed(2)),
          dayMoveDirection: dayDirection === 'CALL' ? 'UP' : 'DOWN',
          momentumPersistence: persistence,
          trendStrength: trend.trendStrength,
          volExpanding: trend.volExpanding,
          phVolSurge: parseFloat((momentum.volSurge || 1).toFixed(2)),
        },
      });

      break; // one entry per ticker per direction
    }
  }

  return signals;
}

// -- Helpers ------------------------------------------------------------------

function findSessionOpen(tickerMinutes, date) {
  const keys = Object.keys(tickerMinutes).filter(k => k.startsWith(date)).sort();
  return keys.length > 0 ? tickerMinutes[keys[0]]?.o : null;
}

function getETFBarsUpto(etfMinutes, uptoKey) {
  if (!etfMinutes) return [];
  const date = uptoKey.slice(0, 10);
  return Object.entries(etfMinutes)
    .filter(([k]) => k.startsWith(date) && k <= uptoKey)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v);
}

function powerHourToGrade(dayMoveATRs, persistence, trend, momentum) {
  let score = 0;

  // Day trend strength: 0.5-1.5 ATR is ideal
  score += Math.min(15, dayMoveATRs * 10);

  // Momentum persistence from profile
  score += Math.min(15, persistence * 25);

  // Trend quality
  if (trend.trendAligned && trend.trendStrength === 'STRONG') score += 10;
  else if (trend.trendAligned) score += 7;

  // Volume expanding = institutional still buying/selling
  if (trend.volExpanding) score += 5;

  // PH freshness
  if (momentum.freshness === 'FRESH') score += 5;
  else if (momentum.freshness === 'DEVELOPING') score += 3;

  if (score >= 38) return 'A+';
  if (score >= 30) return 'A';
  if (score >= 23) return 'A-';
  if (score >= 16) return 'B+';
  return 'B';
}

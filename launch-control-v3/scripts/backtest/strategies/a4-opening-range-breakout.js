/**
 * Strategy A4: Opening Range Breakout (ORB)
 *
 * The first 15-30 minutes of trading establish institutional supply/demand.
 * A decisive breakout of this range with volume predicts the day's direction
 * 60-70% of the time.
 *
 * Key edge: Opening range is where institutions reveal their hand.
 * equity_profiles.opening_chop_minutes tells us when the range is "set."
 *
 * Direction: Same as breakout (momentum follow-through).
 * Structure: Debit vertical spread.
 * Hold: 30-90 min (ORB momentum exhausts by midday).
 *
 * Critical filter: Range must be meaningful (>0.3 ATR) but not too wide
 * (>2.0 ATR means already volatile/random).
 */

import { analyzeMomentum } from '../../../src/scoring/momentum.js';
import { classifyRegime } from '../../../src/scoring/intelligence.js';
import { getSpreadWidth, POSITION_SIZES } from '../execution-model.js';

const STRATEGY = 'A4_OPENING_RANGE_BREAKOUT';
const DEFAULT_RANGE_MINUTES  = 30;   // default opening range if profile doesn't specify
const MIN_RANGE_ATR          = 0.3;  // range must be at least 0.3 ATR (meaningful)
const MAX_RANGE_ATR          = 2.0;  // range > 2 ATR = already chaotic, skip
const BREAKOUT_THRESHOLD     = 0.15; // must exceed range by 15% of range width (not just touch)
const MIN_VOL_SURGE          = 1.2;  // breakout bar volume must be 1.2x recent avg

/**
 * Generate A4 signals for a single trading day.
 */
export function generateA4Signals(date, dayData, context) {
  const { minuteBars, etfMinuteBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];
  const seen = new Set();

  // Market open ~9:30 ET = 14:30 UTC (approximate)
  const sessionStart = `${date}T14:30`;

  for (const ticker of tickers) {
    const profile = profiles[ticker];
    if (!profile) continue;

    const tickerMinutes = minuteBars[ticker] || {};
    const atr = profile.atr_5d || profile.atr_20d || 0.025;

    // Determine how long the opening range takes to establish
    const chopMinutes = profile.opening_chop_minutes || DEFAULT_RANGE_MINUTES;
    const rangeMinutes = Math.max(15, Math.min(45, chopMinutes));

    // Collect opening range bars
    const allKeys = Object.keys(tickerMinutes).filter(k => k.startsWith(date)).sort();
    if (allKeys.length < rangeMinutes + 5) continue; // need enough bars

    const sessionOpen = tickerMinutes[allKeys[0]]?.o;
    if (!sessionOpen) continue;

    // Build opening range (first N minutes)
    const rangeBars = [];
    const rangeEndTime = addMinutes(sessionStart, rangeMinutes);
    for (const key of allKeys) {
      if (key > rangeEndTime) break;
      rangeBars.push(tickerMinutes[key]);
    }
    if (rangeBars.length < 5) continue;

    const rangeHigh = Math.max(...rangeBars.map(b => b.h));
    const rangeLow = Math.min(...rangeBars.map(b => b.l));
    const rangeWidth = rangeHigh - rangeLow;
    const rangeATRs = rangeWidth / (atr * sessionOpen);

    // Range quality filters
    if (rangeATRs < MIN_RANGE_ATR) continue; // too tight, no conviction
    if (rangeATRs > MAX_RANGE_ATR) continue;  // too wide, random

    // Now scan post-range bars for breakout
    const breakoutStart = rangeEndTime;
    const breakoutEnd = `${date}T18:30`; // stop looking at ~13:30 ET (ORB works in morning)
    const breakoutKeys = allKeys.filter(k => k > breakoutStart && k <= breakoutEnd);

    let recentBars = [...rangeBars.slice(-5)]; // seed with end-of-range bars
    let recentVols = rangeBars.map(b => b.v).filter(v => v > 0);

    for (const minuteKey of breakoutKeys) {
      const bar = tickerMinutes[minuteKey];
      recentBars.push(bar);
      if (recentBars.length > 20) recentBars = recentBars.slice(-20);
      if (bar.v > 0) recentVols.push(bar.v);
      if (recentVols.length > 10) recentVols = recentVols.slice(-10);

      const currentPrice = bar.c;

      // Check for breakout above range high
      const aboveBreakout = currentPrice > rangeHigh + rangeWidth * BREAKOUT_THRESHOLD;
      // Check for breakdown below range low
      const belowBreakout = currentPrice < rangeLow - rangeWidth * BREAKOUT_THRESHOLD;

      if (!aboveBreakout && !belowBreakout) continue;

      const direction = aboveBreakout ? 'CALL' : 'PUT';
      const key = `${ticker}:${direction}`;
      if (seen.has(key)) continue;

      // Volume confirmation: breakout bar should have elevated volume
      const avgVol = recentVols.length > 0
        ? recentVols.reduce((a, b) => a + b, 0) / recentVols.length : 0;
      const volSurge = avgVol > 0 ? bar.v / avgVol : 1;
      if (volSurge < MIN_VOL_SURGE) continue;

      // Momentum check: want fresh/developing, not already exhausted
      const momentum = analyzeMomentum(
        recentBars, sessionOpen, sessionOpen, atr, direction
      );
      if (momentum.freshness === 'EXHAUSTED' || momentum.freshness === 'LATE') continue;

      // Regime check
      const spyBars = getETFBarsUpto(etfMinuteBars?.SPY, minuteKey);
      const qqqBars = getETFBarsUpto(etfMinuteBars?.QQQ, minuteKey);
      const spyPct = spyBars.length >= 2
        ? (spyBars[spyBars.length-1].c - spyBars[0].c) / spyBars[0].c : 0;
      const qqqPct = qqqBars.length >= 2
        ? (qqqBars[qqqBars.length-1].c - qqqBars[0].c) / qqqBars[0].c : 0;

      const regime = classifyRegime({ spyPct, qqqPct }, 18, spyBars.slice(-3));
      if (regime.sizeMult === 0) continue;
      if (direction === 'CALL' && !regime.callsAllowed) continue;
      if (direction === 'PUT' && !regime.putsAllowed) continue;

      // Build signal
      const spreadWidth = getSpreadWidth(currentPrice);
      const grade = orbToGrade(rangeATRs, volSurge, momentum.freshness);
      const sizePct = (POSITION_SIZES[grade] || 0.075) * (regime.sizeMult || 1);

      // Breakout distance from range edge
      const breakoutDistance = aboveBreakout
        ? (currentPrice - rangeHigh) / (atr * sessionOpen)
        : (rangeLow - currentPrice) / (atr * sessionOpen);

      seen.add(key);
      signals.push({
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
        stopCondition:   { type: 'ATR', value: 0.4 }, // tight: if breakout fails fast, exit
        targetCondition: { type: 'ATR', value: 0.8 }, // ORB moves can run 0.8+ ATR
        maxHoldMinutes: 90,  // ORB thesis expires by midday
        holdDays: 0,
        sizePct,
        oiEstimate: Math.round((profile.options_liquidity_score || 0.5) * 500),
        freshness: momentum.freshness,
        regime: regime.regime,
        signalType: 'OPENING_RANGE_BREAKOUT',
        composite: Math.round(rangeATRs * 15 + volSurge * 10 + breakoutDistance * 20),
        scores: {
          rangeQuality: Math.round(rangeATRs * 10),
          volumeConfirm: Math.round(Math.min(10, volSurge * 5)),
          breakoutStrength: Math.round(breakoutDistance * 15),
          momentum: momentum.momentumScore,
          regime: Math.round((regime.sizeMult || 1) * 5),
        },
        metadata: {
          rangeHigh,
          rangeLow,
          rangeWidthATRs: parseFloat(rangeATRs.toFixed(2)),
          rangeMinutes,
          breakoutDirection: aboveBreakout ? 'UP' : 'DOWN',
          breakoutDistanceATRs: parseFloat(breakoutDistance.toFixed(2)),
          volSurge: parseFloat(volSurge.toFixed(2)),
        },
      });
    }
  }

  return signals;
}

// -- Helpers ------------------------------------------------------------------

function addMinutes(timeStr, minutes) {
  // timeStr format: YYYY-MM-DDTHH:MM
  const [datePart, timePart] = timeStr.split('T');
  const [h, m] = timePart.split(':').map(Number);
  const totalMin = h * 60 + m + minutes;
  const newH = String(Math.floor(totalMin / 60)).padStart(2, '0');
  const newM = String(totalMin % 60).padStart(2, '0');
  return `${datePart}T${newH}:${newM}`;
}

function getETFBarsUpto(etfMinutes, uptoKey) {
  if (!etfMinutes) return [];
  const date = uptoKey.slice(0, 10);
  return Object.entries(etfMinutes)
    .filter(([k]) => k.startsWith(date) && k <= uptoKey)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v);
}

function orbToGrade(rangeATRs, volSurge, freshness) {
  let score = 0;
  // Range quality: 0.5-1.0 ATR is ideal
  if (rangeATRs >= 0.5 && rangeATRs <= 1.0) score += 15;
  else if (rangeATRs >= 0.3 && rangeATRs <= 1.5) score += 10;
  else score += 5;

  // Volume confirmation
  score += Math.min(15, (volSurge - 1) * 15);

  // Freshness
  if (freshness === 'FRESH') score += 15;
  else if (freshness === 'DEVELOPING') score += 10;
  else if (freshness === 'EXTENDED') score += 5;

  if (score >= 38) return 'A+';
  if (score >= 30) return 'A';
  if (score >= 23) return 'A-';
  if (score >= 16) return 'B+';
  return 'B';
}

/**
 * Live Strategy Adapter for Backtest Engine
 *
 * Adapts the 7 live strategy scanners to work with the backtest engine's
 * historical data format. Instead of calling the live scanners directly
 * (which depend on new Date() for time gates), we reimplement the core
 * signal logic using the shared indicator infrastructure but operating
 * on historical minute/daily bars.
 *
 * Each exported generateXxxSignals function follows the standard backtest
 * interface: (date, dayData, context) => signals[]
 *
 * Strategies covered:
 *   ORB_BREAKOUT, VWAP_BOUNCE, FIRST_PULLBACK, GAP_FILL_REVERSION,
 *   POWER_HOUR_MOMENTUM, SR_BOUNCE, MACRO_REACTION
 */

import { checkConfluence } from '../../../src/indicators/confluence.js';
import { analyzeCandle, detectBullishEngulfing, detectBearishEngulfing } from '../../../src/indicators/candle-patterns.js';
import { checkBounceStructure, detectFlushAndHold } from '../../../src/strategies/support-check.js';
import { POSITION_SIZES } from '../execution-model.js';
import { applyCalibration } from '../grade-calibrator.js';

// ── Shared Helpers ───────────────────────────────────────────────────────────

// Per-strategy grade calibrations loaded from DB at startup (live mode).
// In backtest mode, these are computed after the run and stored for next time.
let _gradeCalibrations = {};

/**
 * Set grade calibrations for live usage (loaded from DB at startup).
 */
export function setGradeCalibrations(calibrations) {
  _gradeCalibrations = calibrations || {};
}

/**
 * Convert confidence score to letter grade.
 * Uses per-strategy calibration if available, otherwise universal thresholds.
 */
function confidenceToGrade(confidence, strategy) {
  if (_gradeCalibrations[strategy]) {
    return applyCalibration(confidence, _gradeCalibrations[strategy]);
  }
  if (confidence >= 95) return 'A+';
  if (confidence >= 90) return 'A';
  if (confidence >= 84) return 'A-';
  if (confidence >= 74) return 'B+';
  return 'B';
}

/**
 * Hold time configuration per strategy.
 */
const HOLD_CONFIG = {
  ORB_BREAKOUT:          { maxHoldMinutes: 60,  holdDays: 0 },
  VWAP_BOUNCE:           { maxHoldMinutes: 90,  holdDays: 0 },
  FIRST_PULLBACK:        { maxHoldMinutes: 90,  holdDays: 0 },
  GAP_FILL_REVERSION:    { maxHoldMinutes: 120, holdDays: 0 },
  POWER_HOUR_MOMENTUM:   { maxHoldMinutes: 45,  holdDays: 0 },
  SR_BOUNCE:             { maxHoldMinutes: 90,  holdDays: 0 },
  MACRO_REACTION:        { maxHoldMinutes: 180, holdDays: 0 },
};

/**
 * Find the previous day's daily bar for a ticker.
 */
function findPrevDayBar(dailyBars, ticker, date) {
  const tickerBars = dailyBars[ticker];
  if (!tickerBars) return null;
  const dates = Object.keys(tickerBars).sort();
  const idx = dates.indexOf(date);
  if (idx > 0) return tickerBars[dates[idx - 1]];
  if (dates.length > 0 && dates[dates.length - 1] < date) {
    return tickerBars[dates[dates.length - 1]];
  }
  return null;
}

/**
 * Get sorted minute bar keys for a ticker on a given date.
 */
function getMinuteKeys(minuteBars, ticker, date) {
  const tickerMinutes = minuteBars[ticker] || {};
  return Object.keys(tickerMinutes).filter(k => k.startsWith(date)).sort();
}

/**
 * Build an array of bar objects from minuteBars up to (and including) a given time key.
 * Returns [{o, h, l, c, v, t}, ...] sorted chronologically.
 */
function getBarsUpTo(minuteBars, ticker, date, upToKey) {
  const tickerMinutes = minuteBars[ticker] || {};
  const keys = Object.keys(tickerMinutes)
    .filter(k => k.startsWith(date) && k <= upToKey)
    .sort();
  return keys.map(k => ({ ...tickerMinutes[k], t: k }));
}

/**
 * Compute VWAP from an array of bars [{o, h, l, c, v}, ...].
 * VWAP = cumSum(typicalPrice * volume) / cumSum(volume)
 */
function computeVWAP(bars) {
  let cumPV = 0;
  let cumV = 0;
  for (const bar of bars) {
    const tp = (bar.h + bar.l + bar.c) / 3;
    cumPV += tp * (bar.v || 0);
    cumV += bar.v || 0;
  }
  return cumV > 0 ? cumPV / cumV : 0;
}

/**
 * Get ETF bars up to a specific time key and compute the change from open.
 */
function getETFChange(etfMinuteBars, etfTicker, date, upToKey) {
  if (!etfMinuteBars || !etfMinuteBars[etfTicker]) return 0;
  const bars = getBarsUpTo(etfMinuteBars, etfTicker, date, upToKey);
  if (bars.length < 2) return 0;
  const openPrice = bars[0].o;
  const currentPrice = bars[bars.length - 1].c;
  return openPrice > 0 ? (currentPrice - openPrice) / openPrice : 0;
}

/**
 * Convert a time offset (minutes from 9:30 ET, i.e. minutes from midnight - 570)
 * to a minute bar key string. Minute bars use UTC keys like `2026-03-15T14:30`
 * (9:30 ET = 14:30 UTC during EST, 13:30 UTC during EDT).
 *
 * Since we don't know DST state, we use the actual keys present in the data.
 * We find the key closest to the desired offset from session open.
 */
function findKeyAtOffset(allKeys, offsetFromOpen) {
  if (allKeys.length === 0) return null;
  if (offsetFromOpen <= 0) return allKeys[0];
  const idx = Math.min(offsetFromOpen, allKeys.length - 1);
  return allKeys[idx] || allKeys[allKeys.length - 1];
}

/**
 * Compute cumulative volume from an array of bars.
 */
function cumulativeVolume(bars) {
  return bars.reduce((sum, b) => sum + (b.v || 0), 0);
}

/**
 * Build a standardized backtest signal from live-style signal data.
 */
function buildSignal(strategy, date, timeKey, ticker, direction, confidence, entryPrice, stopPrice, targetPrice, profile, liveSignal = {}) {
  const grade = confidenceToGrade(confidence, strategy);
  const hold = HOLD_CONFIG[strategy] || { maxHoldMinutes: 120, holdDays: 0 };
  const atr = profile.atr_5d || profile.atr_20d || 0.025;

  return {
    strategy,
    date,
    time: timeKey,
    ticker,
    direction,
    grade,
    entryPrice,
    atr,
    spreadType: 'SINGLE_LEG',
    spreadWidth: null,
    entryDebit: null,
    premium: null,
    stopCondition: { type: 'PRICE', value: stopPrice },
    targetCondition: { type: 'PRICE', value: targetPrice },
    maxHoldMinutes: hold.maxHoldMinutes,
    holdDays: hold.holdDays,
    sizePct: POSITION_SIZES[grade] || 0.10,
    oiEstimate: Math.round((profile.options_liquidity_score || 0.5) * 500),
    freshness: 'FRESH',
    regime: 'NORMAL',
    signalType: strategy,
    composite: confidence,
    scores: { confluence: liveSignal.confluence || 0 },
    metadata: { ...liveSignal },
  };
}

// ── New Helper Functions ─────────────────────────────────────────────────────

/**
 * Compute the opening range from the first N bars of the session.
 * Returns {high, low, width, avgVolume} or null if insufficient data.
 */
function computeOpeningRange(minuteBars, ticker, date, numBars = 5) {
  const allKeys = getMinuteKeys(minuteBars, ticker, date);
  if (allKeys.length < numBars) return null;

  const tickerMinutes = minuteBars[ticker] || {};
  let high = -Infinity;
  let low = Infinity;
  let totalVol = 0;

  for (let i = 0; i < numBars; i++) {
    const bar = tickerMinutes[allKeys[i]];
    if (!bar) return null;
    if (bar.h > high) high = bar.h;
    if (bar.l < low) low = bar.l;
    totalVol += bar.v || 0;
  }

  if (!isFinite(high) || !isFinite(low) || high <= low) return null;

  return {
    high,
    low,
    width: high - low,
    avgVolume: totalVol / numBars,
  };
}

/**
 * Returns true if volume is decreasing -- the volume ratio of the last
 * `lookback` bars vs the `lookback` bars before that is < 0.8.
 */
function isVolumeDecreasing(bars, lookback = 5) {
  if (bars.length < lookback * 2) return false;

  const recent = bars.slice(-lookback);
  const prior = bars.slice(-(lookback * 2), -lookback);

  const recentVol = recent.reduce((s, b) => s + (b.v || 0), 0);
  const priorVol = prior.reduce((s, b) => s + (b.v || 0), 0);

  if (priorVol <= 0) return false;
  return (recentVol / priorVol) < 0.8;
}

/**
 * Detect first orderly pullback after momentum.
 * Look for 3-8 consecutive bars moving against direction (declining volume,
 * no bar with wick > 60% of range).
 * Returns {detected, pullbackLow, pullbackHigh, pullbackBars, triggerBar}
 * where triggerBar is the bar that breaks the pullback trendline.
 */
function detectPullback(bars, direction, atr) {
  const result = { detected: false, pullbackLow: 0, pullbackHigh: 0, pullbackBars: 0, triggerBar: null };
  if (bars.length < 6) return result;

  // Find the momentum extreme
  let extremeIdx = -1;
  let extremeVal = direction === 'CALL' ? -Infinity : Infinity;

  for (let i = 0; i < bars.length - 3; i++) {
    if (direction === 'CALL' && bars[i].h > extremeVal) {
      extremeVal = bars[i].h;
      extremeIdx = i;
    }
    if (direction === 'PUT' && bars[i].l < extremeVal) {
      extremeVal = bars[i].l;
      extremeIdx = i;
    }
  }

  if (extremeIdx < 2 || extremeIdx >= bars.length - 3) return result;

  // Look for pullback bars after the extreme
  let pullbackStart = extremeIdx + 1;
  let pullbackCount = 0;
  let pullbackHigh = -Infinity;
  let pullbackLow = Infinity;
  let prevVol = bars[pullbackStart]?.v || 0;
  let volumeDecreasing = true;

  for (let i = pullbackStart; i < bars.length - 1 && pullbackCount < 8; i++) {
    const bar = bars[i];
    const barRange = bar.h - bar.l;
    if (barRange <= 0) break;

    // Check direction: pullback bars should move against the trend
    const barMove = bar.c - bar.o;
    const isAgainst = (direction === 'CALL' && barMove <= 0) || (direction === 'PUT' && barMove >= 0);
    if (!isAgainst && pullbackCount < 3) break; // need at least 3 bars against

    // Check wick ratio -- no bar with wick > 60% of range
    const upperWick = bar.h - Math.max(bar.o, bar.c);
    const lowerWick = Math.min(bar.o, bar.c) - bar.l;
    const maxWick = Math.max(upperWick, lowerWick);
    if (maxWick / barRange > 0.60) break;

    // Track volume declining
    if ((bar.v || 0) > prevVol * 1.1 && pullbackCount > 0) {
      volumeDecreasing = false;
    }
    prevVol = bar.v || 0;

    if (bar.h > pullbackHigh) pullbackHigh = bar.h;
    if (bar.l < pullbackLow) pullbackLow = bar.l;
    pullbackCount++;
  }

  if (pullbackCount < 3) return result;

  // Check trigger: the last bar should break the pullback trendline
  const lastBar = bars[bars.length - 1];
  const triggerBreaks = direction === 'CALL'
    ? lastBar.c > pullbackHigh
    : lastBar.c < pullbackLow;

  if (!triggerBreaks) return result;

  result.detected = true;
  result.pullbackLow = pullbackLow;
  result.pullbackHigh = pullbackHigh;
  result.pullbackBars = pullbackCount;
  result.triggerBar = lastBar;
  return result;
}

/**
 * Find key support/resistance levels from various sources.
 * Returns array of {level, source} for: prev day high, prev day low, VWAP,
 * session high, session low, opening range high, opening range low.
 */
function findKeyLevels(prevBar, sessionBars, vwap, openingRange) {
  const levels = [];

  if (prevBar) {
    if (prevBar.h > 0) levels.push({ level: prevBar.h, source: 'prev_day_high' });
    if (prevBar.l > 0) levels.push({ level: prevBar.l, source: 'prev_day_low' });
  }

  if (vwap > 0) {
    levels.push({ level: vwap, source: 'vwap' });
  }

  if (sessionBars && sessionBars.length > 0) {
    const sessionHigh = Math.max(...sessionBars.map(b => b.h));
    const sessionLow = Math.min(...sessionBars.map(b => b.l));
    if (isFinite(sessionHigh)) levels.push({ level: sessionHigh, source: 'session_high' });
    if (isFinite(sessionLow)) levels.push({ level: sessionLow, source: 'session_low' });
  }

  if (openingRange) {
    levels.push({ level: openingRange.high, source: 'or_high' });
    levels.push({ level: openingRange.low, source: 'or_low' });
  }

  return levels;
}

/**
 * Check how many levels converge near a given price.
 * Returns {converging, count, levels: [...]} -- converging = true if count >= 2.
 */
function levelsConverging(levels, price, tolerance = 0.001) {
  if (!levels || levels.length === 0 || !price || price <= 0) {
    return { converging: false, count: 0, levels: [] };
  }

  const nearby = levels.filter(l => {
    const dist = Math.abs(l.level - price) / price;
    return dist <= tolerance;
  });

  return {
    converging: nearby.length >= 2,
    count: nearby.length,
    levels: nearby,
  };
}

// ── Strategy Implementations ─────────────────────────────────────────────────

/**
 * ORB_BREAKOUT
 *
 * Edge: Institutional order flow at open. First 5 min reveals overnight order imbalance.
 * Time: Bars 5-60 from open (9:35-10:30 AM). FIRST breakout only.
 * Range: First 5 bars. Min width 0.2%, max 1.5% of price.
 */
export function generateORBBreakoutSignals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, dailyBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];
  const seen = new Set();

  const RANGE_BARS = 5;

  for (const ticker of tickers) {
    if (seen.has(ticker)) continue;
    const profile = profiles[ticker];
    if (!profile) continue;

    const allKeys = getMinuteKeys(minuteBars, ticker, date);
    if (allKeys.length < RANGE_BARS + 10) continue;

    const tickerMinutes = minuteBars[ticker] || {};
    const sessionOpen = tickerMinutes[allKeys[0]]?.o;
    if (!sessionOpen) continue;

    // Compute opening range from first 5 bars
    const or = computeOpeningRange(minuteBars, ticker, date, RANGE_BARS);
    if (!or) continue;

    const rangeWidthPct = or.width / sessionOpen;
    if (rangeWidthPct < 0.002 || rangeWidthPct > 0.015) continue;

    // Scan bars 5-60 for FIRST breakout
    const maxOffset = Math.min(60, allKeys.length - 1);
    for (let i = RANGE_BARS; i <= maxOffset; i++) {
      if (seen.has(ticker)) break;

      const checkKey = allKeys[i];
      const bar = tickerMinutes[checkKey];
      if (!bar) continue;

      const breakAbove = bar.c > or.high;
      const breakBelow = bar.c < or.low;
      if (!breakAbove && !breakBelow) continue;

      const direction = breakAbove ? 'CALL' : 'PUT';

      // Volume check: current bar volume vs range avg
      const volRatio = or.avgVolume > 0 ? (bar.v || 0) / or.avgVolume : 0;
      if (volRatio < 1.3) continue;

      // Candle quality
      const candleAnalysis = analyzeCandle(bar);
      if (candleAnalysis.bodyRatio < 0.50) continue;

      // VWAP alignment
      const bars = getBarsUpTo(minuteBars, ticker, date, checkKey);
      const vwap = computeVWAP(bars);
      if (direction === 'CALL' && bar.c <= vwap) continue;
      if (direction === 'PUT' && bar.c >= vwap) continue;

      // SPY alignment
      const spyChange = getETFChange(etfMinuteBars, 'SPY', date, checkKey);
      const spyAligned = (direction === 'CALL' && spyChange > 0) || (direction === 'PUT' && spyChange < 0);

      // Confluence
      const confluenceResult = checkConfluence(bars, direction, { vwap, currentPrice: bar.c }, { minFactors: 3 });
      if (!confluenceResult.pass) continue;

      // Engulfing
      let engulfing = false;
      if (bars.length >= 2) {
        const engulfResult = direction === 'CALL'
          ? detectBullishEngulfing(bars.slice(-2))
          : detectBearishEngulfing(bars.slice(-2));
        engulfing = engulfResult.detected;
      }

      // Confidence scoring
      let confidence = 60;
      if (candleAnalysis.type.includes('MARUBOZU')) confidence += 6;
      else if (candleAnalysis.type.includes('STRONG')) confidence += 4;
      else confidence += 2;
      if (engulfing) confidence += 4;
      if (volRatio >= 1.5) confidence += 5;
      else confidence += 3; // already passed 1.3x gate
      if (spyAligned) confidence += 3;
      confidence += 3; // VWAP aligned (already passed gate)
      confidence += Math.max(0, confluenceResult.confirming * 2);
      confidence -= confluenceResult.opposing * 2;
      confidence += 5; // first breakout bonus
      confidence = Math.max(60, Math.min(95, confidence));

      // Stop: opposite edge of opening range. Target: 1.5x risk.
      const stopPrice = direction === 'CALL' ? +or.low.toFixed(2) : +or.high.toFixed(2);
      const risk = Math.abs(bar.c - (direction === 'CALL' ? or.low : or.high));
      const targetPrice = direction === 'CALL'
        ? +(bar.c + risk * 1.5).toFixed(2)
        : +(bar.c - risk * 1.5).toFixed(2);

      seen.add(ticker);
      signals.push(buildSignal('ORB_BREAKOUT', date, checkKey, ticker, direction, confidence, bar.c, stopPrice, targetPrice, profile, {
        range_high: +or.high.toFixed(2),
        range_low: +or.low.toFixed(2),
        range_width_pct: +(rangeWidthPct * 100).toFixed(2),
        volume_ratio: +volRatio.toFixed(2),
        candle_type: candleAnalysis.type,
        engulfing,
        spy_aligned: spyAligned,
        vwap_aligned: true,
        confluence: confluenceResult.confirming,
      }));
      break; // FIRST breakout only
    }
  }

  return signals;
}

/**
 * VWAP_BOUNCE
 *
 * Edge: Institutional fair-value anchor. Price deviating then reverting = institutional gravity.
 * Time: Offsets 15-270 (9:45 AM - 2:00 PM). Check every 30 bars.
 */
export function generateVWAPBounceSignals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, dailyBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];
  const seen = new Set();

  const CHECK_OFFSETS = [15, 45, 75, 105, 135, 165, 195, 225, 255, 270];

  for (const ticker of tickers) {
    const profile = profiles[ticker];
    if (!profile) continue;

    const prevBar = findPrevDayBar(dailyBars, ticker, date);
    const allKeys = getMinuteKeys(minuteBars, ticker, date);
    if (allKeys.length < 20) continue;

    const tickerMinutes = minuteBars[ticker] || {};

    for (const offset of CHECK_OFFSETS) {
      if (offset >= allKeys.length) continue;
      if (seen.has(ticker)) break;

      const checkKey = allKeys[offset];
      const bars = getBarsUpTo(minuteBars, ticker, date, checkKey);
      if (bars.length < 15) continue;

      const currentPrice = bars[bars.length - 1].c;
      const vwap = computeVWAP(bars);
      if (!vwap || vwap <= 0) continue;

      const distPct = Math.abs(currentPrice - vwap) / vwap;
      if (distPct < 0.001 || distPct > 0.003) continue;

      // Direction: if price is just above VWAP after being below = CALL bounce
      // If price is just below VWAP after being above = PUT bounce
      const aboveVwap = currentPrice > vwap;
      const recentBars = bars.slice(-10);

      // Check if price was recently on the other side
      const wasBelow = recentBars.some(b => b.c < vwap);
      const wasAbove = recentBars.some(b => b.c > vwap);

      let direction;
      if (aboveVwap && wasBelow) direction = 'CALL';
      else if (!aboveVwap && wasAbove) direction = 'PUT';
      else continue;

      // Volume declining on pullback
      if (!isVolumeDecreasing(bars, 5)) continue;

      // Reversal candle check
      const lastBar = bars[bars.length - 1];
      const candleAnalysis = analyzeCandle(lastBar);
      const isHammer = candleAnalysis.type === 'HAMMER' || candleAnalysis.type === 'INVERTED_HAMMER';
      let engulfing = false;
      if (bars.length >= 2) {
        const engulfResult = direction === 'CALL'
          ? detectBullishEngulfing(bars.slice(-2))
          : detectBearishEngulfing(bars.slice(-2));
        engulfing = engulfResult.detected;
      }
      const hasReversal = isHammer || engulfing || candleAnalysis.bodyRatio >= 0.50;
      if (!hasReversal) continue;

      // Confluence
      const confluenceResult = checkConfluence(bars, direction, { vwap, currentPrice }, { minFactors: 3 });
      if (!confluenceResult.pass) continue;

      // SPY alignment
      const spyChange = getETFChange(etfMinuteBars, 'SPY', date, checkKey);
      const spyAligned = (direction === 'CALL' && spyChange > 0) || (direction === 'PUT' && spyChange < 0);

      // Confidence
      let confidence = 60;
      if (candleAnalysis.type.includes('MARUBOZU')) confidence += 6;
      else if (candleAnalysis.type.includes('STRONG')) confidence += 4;
      else confidence += 2;
      if (isHammer || engulfing) confidence += 4;
      // Volume decline bonus (already passed gate)
      const volBars = bars.slice(-10);
      const firstHalf = volBars.slice(0, 5);
      const secondHalf = volBars.slice(-5);
      const firstVol = firstHalf.reduce((s, b) => s + (b.v || 0), 0);
      const secondVol = secondHalf.reduce((s, b) => s + (b.v || 0), 0);
      const volDeclineRatio = firstVol > 0 ? secondVol / firstVol : 1;
      if (volDeclineRatio < 0.6) confidence += 5;
      else confidence += 3;
      if (spyAligned) confidence += 3;
      if (distPct >= 0.0015 && distPct <= 0.0025) confidence += 3;
      confidence += Math.max(0, confluenceResult.confirming * 2);
      confidence -= confluenceResult.opposing * 2;
      confidence += 3; // strategy bonus
      confidence = Math.max(60, Math.min(95, confidence));

      // Stop: beyond VWAP
      const stopDistance = 0.12; // $0.10-0.15 average
      const stopPrice = direction === 'CALL'
        ? +(vwap - stopDistance).toFixed(2)
        : +(vwap + stopDistance).toFixed(2);

      // Target: 1.5x risk or prior session H/L
      const risk = Math.abs(currentPrice - stopPrice);
      let targetPrice = direction === 'CALL'
        ? +(currentPrice + risk * 1.5).toFixed(2)
        : +(currentPrice - risk * 1.5).toFixed(2);
      // Use prev session H/L if available and gives better target
      if (prevBar) {
        const levelTarget = direction === 'CALL' ? prevBar.h : prevBar.l;
        const levelDist = Math.abs(levelTarget - currentPrice);
        if (levelDist > risk * 1.5) {
          targetPrice = +levelTarget.toFixed(2);
        }
      }

      seen.add(ticker);
      signals.push(buildSignal('VWAP_BOUNCE', date, checkKey, ticker, direction, confidence, currentPrice, stopPrice, targetPrice, profile, {
        vwap_price: +vwap.toFixed(2),
        vwap_distance_pct: +(distPct * 100).toFixed(2),
        volume_declining: true,
        volume_decline_ratio: +volDeclineRatio.toFixed(2),
        candle_type: candleAnalysis.type,
        engulfing,
        is_hammer: isHammer,
        spy_aligned: spyAligned,
        confluence: confluenceResult.confirming,
      }));
      break;
    }
  }

  return signals;
}

/**
 * FIRST_PULLBACK
 *
 * Edge: Momentum continuation after profit-taking pause. First pullback has highest follow-through.
 * Time: Offsets 15-90 (9:45-11:00 AM).
 */
export function generateFirstPullbackSignals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, dailyBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];
  const seen = new Set();

  const CHECK_OFFSETS = [15, 20, 25, 30, 40, 50, 60, 75, 90];

  for (const ticker of tickers) {
    if (seen.has(ticker)) continue;
    const profile = profiles[ticker];
    if (!profile) continue;

    const allKeys = getMinuteKeys(minuteBars, ticker, date);
    if (allKeys.length < 20) continue;

    const tickerMinutes = minuteBars[ticker] || {};
    const sessionOpen = tickerMinutes[allKeys[0]]?.o;
    if (!sessionOpen) continue;

    const atr = profile.atr_20d || 0.025;
    const atrDollar = atr * sessionOpen;

    for (const offset of CHECK_OFFSETS) {
      if (offset >= allKeys.length) continue;
      if (seen.has(ticker)) break;

      const checkKey = allKeys[offset];
      const bars = getBarsUpTo(minuteBars, ticker, date, checkKey);
      if (bars.length < 10) continue;

      const currentPrice = bars[bars.length - 1].c;

      // Momentum check: need >= 0.5 ATR move from open
      const moveFromOpen = currentPrice - sessionOpen;
      const moveATRs = Math.abs(moveFromOpen) / atrDollar;
      if (moveATRs < 0.5) continue;

      const direction = moveFromOpen > 0 ? 'CALL' : 'PUT';

      // Detect first pullback
      const pullback = detectPullback(bars, direction, atrDollar);
      if (!pullback.detected) continue;

      // VWAP alignment
      const vwap = computeVWAP(bars);
      if (direction === 'CALL' && currentPrice <= vwap) continue;
      if (direction === 'PUT' && currentPrice >= vwap) continue;

      // SPY alignment
      const spyChange = getETFChange(etfMinuteBars, 'SPY', date, checkKey);
      const spyAligned = (direction === 'CALL' && spyChange > 0) || (direction === 'PUT' && spyChange < 0);

      // Confluence
      const confluenceResult = checkConfluence(bars, direction, { vwap, currentPrice }, { minFactors: 3 });
      if (!confluenceResult.pass) continue;

      // Candle quality on trigger bar
      const candleAnalysis = analyzeCandle(bars[bars.length - 1]);

      // Engulfing
      let engulfing = false;
      if (bars.length >= 2) {
        const engulfResult = direction === 'CALL'
          ? detectBullishEngulfing(bars.slice(-2))
          : detectBearishEngulfing(bars.slice(-2));
        engulfing = engulfResult.detected;
      }

      // Volume on trigger bar vs pullback avg
      const pbBars = bars.slice(-(pullback.pullbackBars + 1), -1);
      const pbAvgVol = pbBars.length > 0 ? pbBars.reduce((s, b) => s + (b.v || 0), 0) / pbBars.length : 1;
      const triggerVol = bars[bars.length - 1].v || 0;
      const triggerVolRatio = pbAvgVol > 0 ? triggerVol / pbAvgVol : 1;

      // Confidence
      let confidence = 60;
      if (candleAnalysis.type.includes('MARUBOZU')) confidence += 6;
      else if (candleAnalysis.type.includes('STRONG')) confidence += 4;
      else confidence += 2;
      if (engulfing) confidence += 4;
      if (triggerVolRatio >= 1.3) confidence += 5;
      else confidence += 3;
      if (spyAligned) confidence += 3;
      confidence += 3; // VWAP aligned (passed gate)
      confidence += Math.max(0, confluenceResult.confirming * 2);
      confidence -= confluenceResult.opposing * 2;
      confidence += 4; // first pullback bonus
      confidence = Math.max(60, Math.min(95, confidence));

      // Stop: below pullback low/high. Target: momentum extreme + 0.3 ATR.
      const momentumExtreme = direction === 'CALL'
        ? Math.max(...bars.map(b => b.h))
        : Math.min(...bars.map(b => b.l));
      const stopPrice = direction === 'CALL'
        ? +pullback.pullbackLow.toFixed(2)
        : +pullback.pullbackHigh.toFixed(2);
      const targetPrice = direction === 'CALL'
        ? +(momentumExtreme + 0.3 * atrDollar).toFixed(2)
        : +(momentumExtreme - 0.3 * atrDollar).toFixed(2);

      seen.add(ticker);
      signals.push(buildSignal('FIRST_PULLBACK', date, checkKey, ticker, direction, confidence, currentPrice, stopPrice, targetPrice, profile, {
        move_from_open_atrs: +moveATRs.toFixed(2),
        pullback_bars: pullback.pullbackBars,
        pullback_low: +pullback.pullbackLow.toFixed(2),
        pullback_high: +pullback.pullbackHigh.toFixed(2),
        trigger_vol_ratio: +triggerVolRatio.toFixed(2),
        candle_type: candleAnalysis.type,
        engulfing,
        spy_aligned: spyAligned,
        confluence: confluenceResult.confirming,
      }));
      break;
    }
  }

  return signals;
}

/**
 * GAP_FILL_REVERSION
 *
 * Edge: Small gaps = overnight noise (89-93% fill rate). Large gaps = real news (momentum continues).
 * Time: Single check at offset 10-15 (9:40-9:45 AM).
 */
export function generateGapFillSignals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, dailyBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];
  const seen = new Set();

  const CHECK_OFFSET = 12;

  for (const ticker of tickers) {
    if (seen.has(ticker)) continue;
    const profile = profiles[ticker];
    if (!profile) continue;

    const prevBar = findPrevDayBar(dailyBars, ticker, date);
    if (!prevBar) continue;
    const prevClose = prevBar.c;
    if (!prevClose || prevClose <= 0) continue;

    const allKeys = getMinuteKeys(minuteBars, ticker, date);
    if (allKeys.length < CHECK_OFFSET + 5) continue;

    const tickerMinutes = minuteBars[ticker] || {};
    const sessionOpen = tickerMinutes[allKeys[0]]?.o;
    if (!sessionOpen) continue;

    const gapPct = (sessionOpen - prevClose) / prevClose;
    const absGap = Math.abs(gapPct);

    // Determine direction and logic type
    let direction, logicType;
    if (gapPct < 0 && absGap >= 0.0015 && absGap <= 0.006) {
      direction = 'CALL'; logicType = 'REVERSION';
    } else if (gapPct < 0 && absGap > 0.01) {
      direction = 'PUT'; logicType = 'CONTINUATION';
    } else if (gapPct > 0 && absGap >= 0.0015 && absGap <= 0.006) {
      direction = 'PUT'; logicType = 'REVERSION';
    } else if (gapPct > 0 && absGap > 0.01) {
      direction = 'CALL'; logicType = 'CONTINUATION';
    } else {
      continue; // dead zone (0.6-1.0%) or too small
    }

    const checkKey = allKeys[CHECK_OFFSET];
    const bars = getBarsUpTo(minuteBars, ticker, date, checkKey);
    if (bars.length < 5) continue;

    const currentPrice = bars[bars.length - 1].c;
    const atr = profile.atr_20d || 0.025;
    const atrDollar = atr * currentPrice;
    const vwap = computeVWAP(bars);

    // VWAP alignment
    if (vwap > 0) {
      if (direction === 'CALL' && currentPrice < vwap * 0.998) continue;
      if (direction === 'PUT' && currentPrice > vwap * 1.002) continue;
    }

    // Confirmation candle
    const candleAnalysis = analyzeCandle(bars[bars.length - 1]);
    if (candleAnalysis.bodyRatio < 0.40) continue;

    // Confluence
    const confluenceResult = checkConfluence(bars, direction, { vwap, currentPrice }, { minFactors: 3 });
    if (!confluenceResult.pass) continue;

    // SPY alignment
    const spyChange = getETFChange(etfMinuteBars, 'SPY', date, checkKey);
    const spyAligned = (direction === 'CALL' && spyChange > 0) || (direction === 'PUT' && spyChange < 0);

    // Engulfing
    let engulfing = false;
    if (bars.length >= 2) {
      const engulfResult = direction === 'CALL'
        ? detectBullishEngulfing(bars.slice(-2))
        : detectBearishEngulfing(bars.slice(-2));
      engulfing = engulfResult.detected;
    }

    // Volume check
    const avgBarVol = bars.reduce((s, b) => s + (b.v || 0), 0) / bars.length;
    const lastBarVol = bars[bars.length - 1].v || 0;
    const volRatio = avgBarVol > 0 ? lastBarVol / avgBarVol : 1;

    // Confidence
    let confidence = 60;
    if (candleAnalysis.type.includes('MARUBOZU')) confidence += 6;
    else if (candleAnalysis.type.includes('STRONG')) confidence += 4;
    else confidence += 2;
    if (engulfing) confidence += 4;
    if (volRatio >= 1.5) confidence += 5;
    else if (volRatio >= 1.0) confidence += 3;
    if (spyAligned) confidence += 3;
    if (vwap > 0) confidence += 3;
    confidence += Math.max(0, confluenceResult.confirming * 2);
    confidence -= confluenceResult.opposing * 2;
    // Gap size bonus
    if (logicType === 'REVERSION' && absGap >= 0.003) confidence += 3;
    if (logicType === 'CONTINUATION' && absGap >= 0.015) confidence += 3;
    confidence = Math.max(60, Math.min(95, confidence));

    // Stop: 0.5 ATR from entry
    const stopPrice = direction === 'CALL'
      ? +(currentPrice - 0.5 * atrDollar).toFixed(2)
      : +(currentPrice + 0.5 * atrDollar).toFixed(2);

    // Target: gap fill (prev close) or 2:1 R:R
    const risk = 0.5 * atrDollar;
    let targetPrice;
    if (logicType === 'REVERSION') {
      // Target is gap fill (prev close)
      targetPrice = +prevClose.toFixed(2);
      // But ensure at least 1.5:1 R:R
      const gapDist = Math.abs(prevClose - currentPrice);
      if (gapDist < risk * 1.5) {
        targetPrice = direction === 'CALL'
          ? +(currentPrice + risk * 2).toFixed(2)
          : +(currentPrice - risk * 2).toFixed(2);
      }
    } else {
      targetPrice = direction === 'CALL'
        ? +(currentPrice + risk * 2).toFixed(2)
        : +(currentPrice - risk * 2).toFixed(2);
    }

    seen.add(ticker);
    signals.push(buildSignal('GAP_FILL_REVERSION', date, checkKey, ticker, direction, confidence, currentPrice, stopPrice, targetPrice, profile, {
      gap_pct: +(gapPct * 100).toFixed(2),
      logic_type: logicType,
      candle_type: candleAnalysis.type,
      engulfing,
      volume_ratio: +volRatio.toFixed(2),
      spy_aligned: spyAligned,
      vwap_aligned: vwap > 0,
      confluence: confluenceResult.confirming,
    }));
  }

  return signals;
}

/**
 * POWER_HOUR_MOMENTUM
 *
 * Edge: Academic -- first 30 min predicts last 30 min (6.02% annualized, 1.33 Sharpe).
 * Time: Single check at offset 330 (3:00 PM).
 */
export function generatePowerHourMomentumSignals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, dailyBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];

  const CHECK_OFFSET = 330;

  for (const ticker of tickers) {
    const profile = profiles[ticker];
    if (!profile) continue;

    const allKeys = getMinuteKeys(minuteBars, ticker, date);
    if (allKeys.length <= CHECK_OFFSET) continue;

    const tickerMinutes = minuteBars[ticker] || {};
    const sessionOpen = tickerMinutes[allKeys[0]]?.o;
    if (!sessionOpen) continue;

    const checkKey = allKeys[CHECK_OFFSET];
    const bars = getBarsUpTo(minuteBars, ticker, date, checkKey);
    if (bars.length < 30) continue;

    const currentPrice = bars[bars.length - 1].c;
    const atr = profile.atr_20d || 0.025;
    const atrDollar = atr * currentPrice;

    // Intraday trend check: >= 0.3 ATR
    const intradayMove = currentPrice - sessionOpen;
    const moveATRs = Math.abs(intradayMove) / atrDollar;
    if (moveATRs < 0.3) continue;

    const direction = intradayMove > 0 ? 'CALL' : 'PUT';

    // VWAP confirming
    const vwap = computeVWAP(bars);
    if (!vwap || vwap <= 0) continue;
    if (direction === 'CALL' && currentPrice <= vwap) continue;
    if (direction === 'PUT' && currentPrice >= vwap) continue;

    // No reversal bars in last 30 bars
    const last30 = bars.slice(-30);
    const reversalThreshold = 0.15 * atrDollar;
    let hasReversal = false;
    for (const bar of last30) {
      const barMove = bar.c - bar.o;
      if (direction === 'CALL' && barMove < -reversalThreshold) { hasReversal = true; break; }
      if (direction === 'PUT' && barMove > reversalThreshold) { hasReversal = true; break; }
    }
    if (hasReversal) continue;

    // Consolidation/flag pattern: last 15 bars range < 0.3 ATR
    const last15 = bars.slice(-15);
    const consolHigh = Math.max(...last15.map(b => b.h));
    const consolLow = Math.min(...last15.map(b => b.l));
    const consolRange = consolHigh - consolLow;
    const hasConsolidation = consolRange < 0.3 * atrDollar;
    // Not a hard gate, but used for confidence

    // Volume increasing: compare last 15 bars avg to prior 15 bars avg
    const prior15 = bars.slice(-30, -15);
    const last15Vol = last15.reduce((s, b) => s + (b.v || 0), 0) / last15.length;
    const prior15Vol = prior15.length > 0 ? prior15.reduce((s, b) => s + (b.v || 0), 0) / prior15.length : last15Vol;
    const volTrend = prior15Vol > 0 ? last15Vol / prior15Vol : 1;

    // SPY alignment
    const spyChange = getETFChange(etfMinuteBars, 'SPY', date, checkKey);
    const spyAligned = (direction === 'CALL' && spyChange > 0) || (direction === 'PUT' && spyChange < 0);
    if (!spyAligned) continue; // hard gate for power hour

    // Confluence
    const confluenceResult = checkConfluence(bars, direction, { vwap, currentPrice }, { minFactors: 3 });
    if (!confluenceResult.pass) continue;

    // Engulfing
    let engulfing = false;
    if (bars.length >= 2) {
      const engulfResult = direction === 'CALL'
        ? detectBullishEngulfing(bars.slice(-2))
        : detectBearishEngulfing(bars.slice(-2));
      engulfing = engulfResult.detected;
    }

    // Candle quality
    const candleAnalysis = analyzeCandle(bars[bars.length - 1]);

    // Confidence
    let confidence = 60;
    if (candleAnalysis.type.includes('MARUBOZU')) confidence += 6;
    else if (candleAnalysis.type.includes('STRONG')) confidence += 4;
    else confidence += 2;
    if (engulfing) confidence += 4;
    if (volTrend >= 1.3) confidence += 5;
    else if (volTrend >= 1.0) confidence += 3;
    confidence += 3; // SPY aligned (hard gate)
    confidence += 3; // VWAP aligned (hard gate)
    confidence += Math.max(0, confluenceResult.confirming * 2);
    confidence -= confluenceResult.opposing * 2;
    if (moveATRs >= 0.5) confidence += 4;
    else confidence += 3;
    if (hasConsolidation) confidence += 3;
    confidence = Math.max(60, Math.min(95, confidence));

    // Stop: below consolidation low/high. Target: 2:1 R:R.
    const stopPrice = direction === 'CALL'
      ? +consolLow.toFixed(2)
      : +consolHigh.toFixed(2);
    const risk = Math.abs(currentPrice - (direction === 'CALL' ? consolLow : consolHigh));
    const targetPrice = direction === 'CALL'
      ? +(currentPrice + Math.max(risk, 0.1 * atrDollar) * 2).toFixed(2)
      : +(currentPrice - Math.max(risk, 0.1 * atrDollar) * 2).toFixed(2);

    signals.push(buildSignal('POWER_HOUR_MOMENTUM', date, checkKey, ticker, direction, confidence, currentPrice, stopPrice, targetPrice, profile, {
      move_from_open_pct: +((intradayMove / sessionOpen) * 100).toFixed(2),
      move_in_atrs: +moveATRs.toFixed(2),
      consolidation_range_atr: +(consolRange / atrDollar).toFixed(2),
      has_consolidation: hasConsolidation,
      volume_trend: +volTrend.toFixed(2),
      candle_type: candleAnalysis.type,
      engulfing,
      spy_aligned: spyAligned,
      confluence: confluenceResult.confirming,
    }));
  }

  // Cap at top 5
  signals.sort((a, b) => b.composite - a.composite);
  return signals.slice(0, 5);
}

/**
 * SR_BOUNCE
 *
 * Edge: Level convergence. When 2+ independent levels converge, multiple participants see the same level.
 * Time: Offsets 15-360 (9:45 AM - 3:30 PM). Check every 30 bars.
 */
export function generateSRBounceSignals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, dailyBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];
  const tickerCounts = {};

  const CHECK_OFFSETS = [15, 45, 75, 105, 135, 165, 195, 225, 255, 285, 315, 345, 360];

  for (const ticker of tickers) {
    const profile = profiles[ticker];
    if (!profile) continue;

    const prevBar = findPrevDayBar(dailyBars, ticker, date);
    if (!prevBar) continue;

    const allKeys = getMinuteKeys(minuteBars, ticker, date);
    if (allKeys.length < 20) continue;

    const tickerMinutes = minuteBars[ticker] || {};

    // Compute opening range once
    const or = computeOpeningRange(minuteBars, ticker, date, 5);

    for (const offset of CHECK_OFFSETS) {
      if (offset >= allKeys.length) continue;
      if ((tickerCounts[ticker] || 0) >= 3) break;

      const checkKey = allKeys[offset];
      const bars = getBarsUpTo(minuteBars, ticker, date, checkKey);
      if (bars.length < 10) continue;

      const currentPrice = bars[bars.length - 1].c;
      const vwap = computeVWAP(bars);

      // Find key levels
      const levels = findKeyLevels(prevBar, bars, vwap, or);

      // Check level convergence near current price
      const convergence = levelsConverging(levels, currentPrice, 0.001);
      if (!convergence.converging) continue;

      // Determine direction based on whether price is bouncing off support or resistance
      // If most converging levels are below price -> support -> CALL
      // If most converging levels are above price -> resistance -> PUT
      const belowCount = convergence.levels.filter(l => l.level <= currentPrice).length;
      const aboveCount = convergence.levels.filter(l => l.level > currentPrice).length;
      const direction = belowCount >= aboveCount ? 'CALL' : 'PUT';

      // Reversal candle
      const lastBar = bars[bars.length - 1];
      const candleAnalysis = analyzeCandle(lastBar);
      const isHammer = candleAnalysis.type === 'HAMMER' || candleAnalysis.type === 'INVERTED_HAMMER';
      let engulfing = false;
      if (bars.length >= 2) {
        const engulfResult = direction === 'CALL'
          ? detectBullishEngulfing(bars.slice(-2))
          : detectBearishEngulfing(bars.slice(-2));
        engulfing = engulfResult.detected;
      }
      if (!isHammer && !engulfing && candleAnalysis.bodyRatio < 0.50) continue;

      // Volume rising
      const recentVol = bars.slice(-5).reduce((s, b) => s + (b.v || 0), 0) / 5;
      const priorVol = bars.slice(-10, -5).reduce((s, b) => s + (b.v || 0), 0) / 5;
      const volRatio = priorVol > 0 ? recentVol / priorVol : 1;
      if (volRatio < 1.2) continue;

      // Confluence
      const confluenceResult = checkConfluence(bars, direction, { vwap, currentPrice }, { minFactors: 3 });
      if (!confluenceResult.pass) continue;

      // SPY alignment
      const spyChange = getETFChange(etfMinuteBars, 'SPY', date, checkKey);
      const spyAligned = (direction === 'CALL' && spyChange > 0) || (direction === 'PUT' && spyChange < 0);

      // Confidence
      let confidence = 60;
      if (candleAnalysis.type.includes('MARUBOZU')) confidence += 6;
      else if (candleAnalysis.type.includes('STRONG')) confidence += 4;
      else confidence += 2;
      if (engulfing || isHammer) confidence += 4;
      if (volRatio >= 1.5) confidence += 5;
      else confidence += 3;
      if (spyAligned) confidence += 3;
      if (vwap > 0 && ((direction === 'CALL' && currentPrice >= vwap) || (direction === 'PUT' && currentPrice <= vwap))) confidence += 3;
      confidence += Math.max(0, confluenceResult.confirming * 2);
      confidence -= confluenceResult.opposing * 2;
      // Bonus for extra converging levels
      confidence += Math.max(0, (convergence.count - 2) * 3);
      confidence = Math.max(60, Math.min(95, confidence));

      // Stop: beyond the level cluster
      const avgLevel = convergence.levels.reduce((s, l) => s + l.level, 0) / convergence.levels.length;
      const stopPrice = direction === 'CALL'
        ? +(avgLevel - 0.12).toFixed(2)
        : +(avgLevel + 0.12).toFixed(2);

      // Target: VWAP or next level, min 1.5:1 R:R
      const risk = Math.abs(currentPrice - stopPrice);
      let targetPrice;
      if (direction === 'CALL') {
        // Target: VWAP if above, or next resistance level
        const candidateTargets = levels
          .filter(l => l.level > currentPrice + risk)
          .sort((a, b) => a.level - b.level);
        targetPrice = candidateTargets.length > 0
          ? +candidateTargets[0].level.toFixed(2)
          : +(currentPrice + risk * 1.5).toFixed(2);
      } else {
        const candidateTargets = levels
          .filter(l => l.level < currentPrice - risk)
          .sort((a, b) => b.level - a.level);
        targetPrice = candidateTargets.length > 0
          ? +candidateTargets[0].level.toFixed(2)
          : +(currentPrice - risk * 1.5).toFixed(2);
      }
      // Ensure min 1.5:1 R:R
      const reward = Math.abs(targetPrice - currentPrice);
      if (reward < risk * 1.5) {
        targetPrice = direction === 'CALL'
          ? +(currentPrice + risk * 1.5).toFixed(2)
          : +(currentPrice - risk * 1.5).toFixed(2);
      }

      tickerCounts[ticker] = (tickerCounts[ticker] || 0) + 1;
      signals.push(buildSignal('SR_BOUNCE', date, checkKey, ticker, direction, confidence, currentPrice, stopPrice, targetPrice, profile, {
        converging_levels: convergence.count,
        level_sources: convergence.levels.map(l => l.source).join(','),
        volume_ratio: +volRatio.toFixed(2),
        candle_type: candleAnalysis.type,
        engulfing,
        is_hammer: isHammer,
        spy_aligned: spyAligned,
        confluence: confluenceResult.confirming,
      }));
    }
  }

  // Cap at top 5 global
  signals.sort((a, b) => b.composite - a.composite);
  return signals.slice(0, 5);
}

/**
 * MACRO_REACTION
 *
 * Edge: Post-event drift in second wave (15-30 min), not algo noise.
 * Time: Offsets 45-60 (15-30 min after open). Only on macro days. HALF position size.
 */
export function generateMacroReactionSignals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, dailyBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];

  // Check if this is a macro day
  const macroEvent = context.macroEvents?.[date] || null;
  if (!macroEvent) return signals;

  const CHECK_OFFSETS = [45, 60]; // 15-30 min after open

  const refTicker = tickers.find(t => getMinuteKeys(minuteBars, t, date).length > 60);
  if (!refTicker) return signals;
  const refKeys = getMinuteKeys(minuteBars, refTicker, date);

  for (const checkOffset of CHECK_OFFSETS) {
    if (refKeys.length <= checkOffset) continue;
    const refCheckKey = refKeys[checkOffset];

    const spyChange = getETFChange(etfMinuteBars, 'SPY', date, refCheckKey);
    const qqqChange = getETFChange(etfMinuteBars, 'QQQ', date, refCheckKey);

    // Consensus direction >= 0.3%
    let consensusDirection = null;
    if (spyChange >= 0.003 && qqqChange >= 0.003) consensusDirection = 'CALL';
    else if (spyChange <= -0.003 && qqqChange <= -0.003) consensusDirection = 'PUT';
    else continue;

    const consensusPct = (Math.abs(spyChange) + Math.abs(qqqChange)) / 2;

    for (const ticker of tickers) {
      const profile = profiles[ticker];
      if (!profile) continue;

      const beta = Math.max(profile.beta_spy || 0, profile.beta_qqq || 0);
      if (beta < 1.0) continue;

      const allKeys = getMinuteKeys(minuteBars, ticker, date);
      if (allKeys.length <= checkOffset) continue;

      const tickerMinutes = minuteBars[ticker] || {};
      const sessionOpen = tickerMinutes[allKeys[0]]?.o;
      if (!sessionOpen) continue;

      const checkKey = allKeys[checkOffset];
      const bars = getBarsUpTo(minuteBars, ticker, date, checkKey);
      if (bars.length < 10) continue;

      const currentPrice = bars[bars.length - 1].c;
      const atr = profile.atr_20d || 0.025;
      const atrDollar = atr * currentPrice;

      // VWAP alignment
      const vwap = computeVWAP(bars);
      if (!vwap || vwap <= 0) continue;
      if (consensusDirection === 'CALL' && currentPrice <= vwap) continue;
      if (consensusDirection === 'PUT' && currentPrice >= vwap) continue;

      // Confluence
      const confluenceResult = checkConfluence(bars, consensusDirection, { vwap, currentPrice }, { minFactors: 3 });
      if (!confluenceResult.pass) continue;

      // Candle quality
      const candleAnalysis = analyzeCandle(bars[bars.length - 1]);

      // Engulfing
      let engulfing = false;
      if (bars.length >= 2) {
        const engulfResult = consensusDirection === 'CALL'
          ? detectBullishEngulfing(bars.slice(-2))
          : detectBearishEngulfing(bars.slice(-2));
        engulfing = engulfResult.detected;
      }

      // Confidence
      let confidence = 60;
      if (candleAnalysis.type.includes('MARUBOZU')) confidence += 6;
      else if (candleAnalysis.type.includes('STRONG')) confidence += 4;
      else confidence += 2;
      if (engulfing) confidence += 4;
      if (consensusPct >= 0.005) confidence += 5;
      else confidence += 3;
      confidence += 3; // SPY+QQQ agree (hard gate)
      confidence += 3; // VWAP aligned (hard gate)
      confidence += Math.max(0, confluenceResult.confirming * 2);
      confidence -= confluenceResult.opposing * 2;
      if (beta >= 1.5) confidence += 3;
      confidence = Math.max(60, Math.min(95, confidence));

      // Stop: VWAP opposite. Target: 0.7 ATR.
      const stopPrice = consensusDirection === 'CALL'
        ? +(vwap * 0.997).toFixed(2)
        : +(vwap * 1.003).toFixed(2);
      const targetPrice = consensusDirection === 'CALL'
        ? +(currentPrice + 0.7 * atrDollar).toFixed(2)
        : +(currentPrice - 0.7 * atrDollar).toFixed(2);

      // Build signal with HALF position size
      const sig = buildSignal('MACRO_REACTION', date, checkKey, ticker, consensusDirection, confidence, currentPrice, stopPrice, targetPrice, profile, {
        macro_event: macroEvent,
        beta: +beta.toFixed(2),
        spy_change_pct: +(spyChange * 100).toFixed(2),
        qqq_change_pct: +(qqqChange * 100).toFixed(2),
        consensus_pct: +(consensusPct * 100).toFixed(2),
        candle_type: candleAnalysis.type,
        engulfing,
        confluence: confluenceResult.confirming,
      });
      sig.sizePct = (sig.sizePct || 0.10) * 0.5; // HALF position size
      signals.push(sig);
    }
    break; // only use first valid offset
  }

  // Cap at top 3
  signals.sort((a, b) => b.composite - a.composite);
  return signals.slice(0, 3);
}

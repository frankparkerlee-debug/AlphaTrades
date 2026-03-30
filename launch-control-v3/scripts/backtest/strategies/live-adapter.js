/**
 * Live Strategy Adapter for Backtest Engine
 *
 * Adapts the 13 live strategy scanners to work with the backtest engine's
 * historical data format. Instead of calling the live scanners directly
 * (which depend on new Date() for time gates), we reimplement the core
 * signal logic using the shared indicator infrastructure but operating
 * on historical minute/daily bars.
 *
 * Each exported generateXxxSignals function follows the standard backtest
 * interface: (date, dayData, context) => signals[]
 *
 * Strategies covered:
 *   GAP_REVERSAL, GAP_UP_REVERSAL, OPENING_RANGE_BREAKOUT, VWAP_RECLAIM,
 *   POWER_HOUR, CORRELATION_CASCADE, POST_MACRO, FAILED_BREAKDOWN,
 *   CAPITULATION_BOUNCE, BREAKDOWN_PUT, SECTOR_ROTATION_BOUNCE,
 *   RELATIVE_WEAKNESS_PUT, CONSEC_BOUNCE, VOL_DROP_PUT, PRE_EARNINGS_PUT
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
  GAP_REVERSAL:           { maxHoldMinutes: 120, holdDays: 0 },
  GAP_UP_REVERSAL:        { maxHoldMinutes: 120, holdDays: 0 },
  OPENING_RANGE_BREAKOUT: { maxHoldMinutes: 90,  holdDays: 0 },
  VWAP_RECLAIM:           { maxHoldMinutes: 90,  holdDays: 0 },
  POWER_HOUR:             { maxHoldMinutes: 60,  holdDays: 0 },
  CORRELATION_CASCADE:    { maxHoldMinutes: 180, holdDays: 0 },
  POST_MACRO:             { maxHoldMinutes: 180, holdDays: 0 },
  FAILED_BREAKDOWN:       { maxHoldMinutes: 120, holdDays: 0 },
  CAPITULATION_BOUNCE:    { maxHoldMinutes: 120, holdDays: 0 },
  BREAKDOWN_PUT:          { maxHoldMinutes: 120, holdDays: 0 },
  SECTOR_ROTATION_BOUNCE: { maxHoldMinutes: 120, holdDays: 0 },
  RELATIVE_WEAKNESS_PUT:  { maxHoldMinutes: 120, holdDays: 0 },
  CONSEC_BOUNCE:          { maxHoldMinutes: 0,   holdDays: 3 },
  VOL_DROP_PUT:           { maxHoldMinutes: 0,   holdDays: 1 },
  PRE_EARNINGS_PUT:       { maxHoldMinutes: 0,   holdDays: 14 },
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

// ── Strategy Implementations ─────────────────────────────────────────────────

/**
 * GAP_REVERSAL + GAP_UP_REVERSAL
 *
 * Check at 10:00 ET (offset ~30 bars from session open).
 * Gap down 2-3% with strong green candle -> CALL (GAP_REVERSAL)
 * Gap up 2-3% with strong red candle -> PUT (GAP_UP_REVERSAL)
 */
export function generateGapSignals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, dailyBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];
  const seen = new Set();

  const CHECK_OFFSET = 30; // ~30 bars from open = 10:00 ET

  for (const ticker of tickers) {
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

    const gap = (sessionOpen - prevClose) / prevClose;
    const absGap = Math.abs(gap);
    if (absGap < 0.02 || absGap > 0.03) continue;

    const gappedUp = gap > 0;
    const strategy = gappedUp ? 'GAP_UP_REVERSAL' : 'GAP_REVERSAL';
    const direction = gappedUp ? 'PUT' : 'CALL';

    const key = `${ticker}:${strategy}`;
    if (seen.has(key)) continue;

    // First candle check
    const firstCandle = tickerMinutes[allKeys[0]];
    if (!firstCandle) continue;
    const candleAnalysis = analyzeCandle(firstCandle);

    if (!gappedUp) {
      // Gap down: need green first candle with body > 50%
      if (firstCandle.c <= firstCandle.o) continue;
      if (candleAnalysis.bodyRatio < 0.50) continue;
      if (candleAnalysis.upperWickRatio > 0.30) continue;
    } else {
      // Gap up: need red first candle with body > 50%
      if (firstCandle.c >= firstCandle.o) continue;
      if (candleAnalysis.bodyRatio < 0.50) continue;
      if (candleAnalysis.lowerWickRatio > 0.30) continue;
    }

    // Build bars up to check time
    const checkKey = allKeys[CHECK_OFFSET];
    const bars = getBarsUpTo(minuteBars, ticker, date, checkKey);
    if (bars.length < 10) continue;

    const currentPrice = bars[bars.length - 1].c;
    const vwap = computeVWAP(bars);

    // Stabilization check
    const stabResult = detectFlushAndHold(bars, direction);
    const stabilized = stabResult.stabilized;

    // Confluence check
    const confluenceResult = checkConfluence(bars, direction, {
      vwap,
      currentPrice,
    }, { minFactors: 3 });
    if (!confluenceResult.pass) continue;

    // Trend structure
    const dailyTickerBars = dailyBars[ticker] ? Object.values(dailyBars[ticker]).sort((a, b) => (a.day || '').localeCompare(b.day || '')) : [];
    const structure = checkBounceStructure(currentPrice, dailyTickerBars, {
      todayLow: Math.min(...bars.map(b => b.l)),
      todayHigh: Math.max(...bars.map(b => b.h)),
      todayOpen: sessionOpen,
      vwap,
      intradayBars: bars,
    }, 'intraday');

    // Block on adverse trend + no stabilization
    if (!gappedUp && structure.trend === 'DOWNTREND' && structure.trendConfidence >= 0.7 && !stabilized) continue;
    if (gappedUp && structure.trend === 'UPTREND' && structure.trendConfidence >= 0.7 && !stabilized) continue;

    // Engulfing check
    let engulfing = false;
    if (bars.length >= 2) {
      const engulfResult = !gappedUp
        ? detectBullishEngulfing(bars.slice(-2))
        : detectBearishEngulfing(bars.slice(-2));
      engulfing = engulfResult.detected;
    }

    // Confidence scoring
    let confidence = 72;
    if (candleAnalysis.type.includes('MARUBOZU')) confidence += 6;
    else if (candleAnalysis.type.includes('STRONG')) confidence += 4;
    else confidence += 2;
    if (engulfing) confidence += 4;
    if (stabilized && stabResult.barsHeld >= 5) confidence += 4;
    else if (stabilized) confidence += 2;
    if (confluenceResult) {
      confidence += Math.max(0, confluenceResult.confirming * 2);
      confidence -= confluenceResult.opposing * 2;
    }
    if (vwap > 0) {
      if (!gappedUp && currentPrice > vwap) confidence += 2;
      if (gappedUp && currentPrice < vwap) confidence += 2;
    }
    if (!gappedUp && structure.trend === 'UPTREND') confidence += 3;
    else if (gappedUp && structure.trend === 'DOWNTREND') confidence += 3;
    else if (structure.trend === 'RANGE') confidence += 1;
    confidence = Math.min(95, Math.max(60, confidence));

    // Targets and stops
    const gapAmount = Math.abs(sessionOpen - prevClose);
    let stopPrice, targetPrice;
    if (!gappedUp) {
      const todayLow = Math.min(...bars.map(b => b.l));
      stopPrice = +(todayLow * 0.998).toFixed(2);
      targetPrice = +(sessionOpen + gapAmount * 0.40).toFixed(2);
    } else {
      const todayHigh = Math.max(...bars.map(b => b.h));
      stopPrice = +(todayHigh * 1.002).toFixed(2);
      targetPrice = +(sessionOpen - gapAmount * 0.40).toFixed(2);
    }

    seen.add(key);
    signals.push(buildSignal(strategy, date, checkKey, ticker, direction, confidence, currentPrice, stopPrice, targetPrice, profile, {
      gap_pct: +(gap * 100).toFixed(2),
      candle_type: candleAnalysis.type,
      engulfing,
      stabilized,
      trend: structure.trend,
      confluence: confluenceResult.confirming,
    }));
  }

  return signals;
}


/**
 * OPENING_RANGE_BREAKOUT
 *
 * Check at offsets 45, 75, 105 bars from open (~10:15, 10:45, 11:15 ET).
 * Compute opening range from first 30 bars. Breakout with volume + confluence.
 */
export function generateORBSignals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, dailyBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];
  const seen = new Set();

  const RANGE_BARS = 30;
  const CHECK_OFFSETS = [45, 75, 105]; // ~10:15, 10:45, 11:15 ET

  for (const ticker of tickers) {
    const profile = profiles[ticker];
    if (!profile) continue;

    const prevBar = findPrevDayBar(dailyBars, ticker, date);
    if (!prevBar) continue;

    const allKeys = getMinuteKeys(minuteBars, ticker, date);
    if (allKeys.length < RANGE_BARS + 15) continue;

    const tickerMinutes = minuteBars[ticker] || {};
    const sessionOpen = tickerMinutes[allKeys[0]]?.o;
    if (!sessionOpen) continue;

    const atr = profile.atr_20d || 0.025;

    // Compute opening range from first 30 bars
    let rangeHigh = -Infinity;
    let rangeLow = Infinity;
    for (let i = 0; i < Math.min(RANGE_BARS, allKeys.length); i++) {
      const bar = tickerMinutes[allKeys[i]];
      if (!bar) continue;
      if (bar.h > rangeHigh) rangeHigh = bar.h;
      if (bar.l < rangeLow) rangeLow = bar.l;
    }
    if (!isFinite(rangeHigh) || !isFinite(rangeLow) || rangeHigh <= rangeLow) continue;

    const rangeWidth = rangeHigh - rangeLow;
    const atrDollar = atr * sessionOpen;
    const rangeWidthATR = atrDollar > 0 ? rangeWidth / atrDollar : 999;
    if (rangeWidthATR < 0.3 || rangeWidthATR > 2.0) continue;

    for (const offset of CHECK_OFFSETS) {
      if (offset >= allKeys.length) continue;
      if (seen.has(ticker)) break;

      const checkKey = allKeys[offset];
      const bars = getBarsUpTo(minuteBars, ticker, date, checkKey);
      if (bars.length < 10) continue;

      const currentPrice = bars[bars.length - 1].c;

      // Today's range check (< 1.5 ATR)
      const todayHigh = Math.max(...bars.map(b => b.h));
      const todayLow = Math.min(...bars.map(b => b.l));
      if ((todayHigh - todayLow) > 1.5 * atrDollar) continue;

      // Breakout detection
      const breakoutBuffer = atrDollar * 0.05;
      const bullishBreak = currentPrice > rangeHigh + breakoutBuffer;
      const bearishBreak = currentPrice < rangeLow - breakoutBuffer;
      if (!bullishBreak && !bearishBreak) continue;

      const direction = bullishBreak ? 'CALL' : 'PUT';
      const vwap = computeVWAP(bars);

      // Candle quality
      const candleAnalysis = analyzeCandle(bars[bars.length - 1]);
      if (candleAnalysis.bodyRatio <= 0.40) continue;
      if (direction === 'CALL' && candleAnalysis.upperWickRatio > 0.35) continue;
      if (direction === 'PUT' && candleAnalysis.lowerWickRatio > 0.35) continue;

      // VWAP alignment
      if (direction === 'CALL' && currentPrice <= vwap) continue;
      if (direction === 'PUT' && currentPrice >= vwap) continue;

      // Confluence
      const confluenceResult = checkConfluence(bars, direction, {
        vwap,
        currentPrice,
      }, { minFactors: 3 });
      if (!confluenceResult.pass) continue;

      // SPY/QQQ alignment
      const spyChange = getETFChange(etfMinuteBars, 'SPY', date, checkKey);
      const qqqChange = getETFChange(etfMinuteBars, 'QQQ', date, checkKey);
      const marketAligned = (direction === 'CALL' && spyChange > 0) || (direction === 'PUT' && spyChange < 0);

      // Engulfing
      let engulfing = false;
      if (bars.length >= 2) {
        const engulfResult = direction === 'CALL'
          ? detectBullishEngulfing(bars.slice(-2))
          : detectBearishEngulfing(bars.slice(-2));
        engulfing = engulfResult.detected;
      }

      // Confidence scoring
      let confidence = 72;
      if (candleAnalysis.type.includes('MARUBOZU')) confidence += 6;
      else if (candleAnalysis.type.includes('STRONG')) confidence += 4;
      else confidence += 2;
      if (engulfing) confidence += 4;
      if (marketAligned) confidence += 3;

      const breakDistance = direction === 'CALL'
        ? currentPrice - rangeHigh
        : rangeLow - currentPrice;
      if (breakDistance > 0.1 * atrDollar) confidence += 3;
      if (rangeWidthATR >= 0.3 && rangeWidthATR <= 0.8) confidence += 3;
      if (confluenceResult) {
        confidence += Math.max(0, confluenceResult.confirming * 2);
        confidence -= confluenceResult.opposing * 2;
      }
      confidence = Math.min(95, Math.max(60, confidence));

      // Targets and stops
      let stopPrice, targetPrice;
      if (direction === 'CALL') {
        stopPrice = +rangeLow.toFixed(2);
        targetPrice = +(currentPrice + 0.5 * atrDollar).toFixed(2);
      } else {
        stopPrice = +rangeHigh.toFixed(2);
        targetPrice = +(currentPrice - 0.5 * atrDollar).toFixed(2);
      }

      seen.add(ticker);
      signals.push(buildSignal('OPENING_RANGE_BREAKOUT', date, checkKey, ticker, direction, confidence, currentPrice, stopPrice, targetPrice, profile, {
        range_high: +rangeHigh.toFixed(2),
        range_low: +rangeLow.toFixed(2),
        range_width_atr: +rangeWidthATR.toFixed(2),
        candle_type: candleAnalysis.type,
        engulfing,
        market_aligned: marketAligned,
        confluence: confluenceResult.confirming,
      }));
      break; // one signal per ticker
    }
  }

  return signals;
}


/**
 * VWAP_RECLAIM (CALL: reclaim from below) and VWAP_REJECT (PUT: reject from below)
 *
 * Check at offsets 60, 120, 180, 240 bars (~10:30, 11:30, 12:30, 13:30 ET).
 */
export function generateVWAPSignals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, dailyBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];
  const seen = new Set();

  const CHECK_OFFSETS = [60, 120, 180, 240];

  for (const ticker of tickers) {
    const profile = profiles[ticker];
    if (!profile) continue;

    const allKeys = getMinuteKeys(minuteBars, ticker, date);
    if (allKeys.length < 60) continue;

    const tickerMinutes = minuteBars[ticker] || {};
    const sessionOpen = tickerMinutes[allKeys[0]]?.o;
    if (!sessionOpen) continue;

    const atr = profile.atr_20d || 0.025;

    for (const offset of CHECK_OFFSETS) {
      if (offset >= allKeys.length) continue;
      if (seen.has(ticker)) break;

      const checkKey = allKeys[offset];
      const bars = getBarsUpTo(minuteBars, ticker, date, checkKey);
      if (bars.length < 10) continue;

      const currentPrice = bars[bars.length - 1].c;
      const vwap = computeVWAP(bars);
      if (!vwap || vwap <= 0) continue;

      const atrDollar = atr * currentPrice;
      const recentBars = bars.slice(-10);
      const spyChange = getETFChange(etfMinuteBars, 'SPY', date, checkKey);

      // --- VWAP RECLAIM (CALL) ---
      if (currentPrice > vwap) {
        const wasBelowRecently = recentBars.some(bar => bar.c < vwap);
        const currentBarAbove = recentBars[recentBars.length - 1]?.c > vwap;
        if (!wasBelowRecently || !currentBarAbove) continue;

        const vwapDistancePct = (currentPrice - vwap) / vwap;
        if (vwapDistancePct > 0.005 || vwapDistancePct <= 0) continue;

        const lastBar = recentBars[recentBars.length - 1];
        const candleInfo = analyzeCandle(lastBar);
        if (candleInfo.bodyRatio <= 0.40) continue;

        const confluence = checkConfluence(bars, 'CALL', { vwap, currentPrice }, { minFactors: 3 });
        if (!confluence.pass) continue;

        const engulfing = detectBullishEngulfing(recentBars.slice(-2));
        const stabilization = detectFlushAndHold(bars, 'CALL');

        // VWAP tests count
        let vwapTests = 0;
        for (const bar of recentBars) {
          if ((bar.l <= vwap && bar.h >= vwap) || (bar.c <= vwap * 1.002 && bar.c >= vwap * 0.998)) vwapTests++;
        }

        // Confidence scoring
        let confidence = 72;
        if (candleInfo.type === 'BULLISH_MARUBOZU') confidence += 6;
        else if (candleInfo.type === 'STRONG_BULLISH') confidence += 4;
        else confidence += 2;
        if (engulfing.detected) confidence += 4;
        if (stabilization.stabilized && stabilization.barsHeld >= 5) confidence += 5;
        else if (stabilization.stabilized) confidence += 3;
        if (spyChange > 0) confidence += 3;
        confidence += Math.min(6, vwapTests * 2);
        confidence += confluence.confirming * 2;
        confidence -= confluence.opposing * 2;
        confidence = Math.max(60, Math.min(95, confidence));

        const stopPrice = +(vwap * 0.995).toFixed(2);
        const targetPrice = +(currentPrice + 0.4 * atrDollar).toFixed(2);

        seen.add(ticker);
        signals.push(buildSignal('VWAP_RECLAIM', date, checkKey, ticker, 'CALL', confidence, currentPrice, stopPrice, targetPrice, profile, {
          signal_type: 'RECLAIM',
          vwap_price: +vwap.toFixed(2),
          vwap_distance_pct: +(vwapDistancePct * 100).toFixed(2),
          candle_type: candleInfo.type,
          engulfing: engulfing.detected,
          vwap_tests: vwapTests,
          confluence: confluence.confirming,
        }));
        break;
      }

      // --- VWAP REJECT (PUT) ---
      if (currentPrice < vwap) {
        const testedVwap = recentBars.some(bar => bar.h >= vwap * 0.998);
        const currentBelowVwap = recentBars[recentBars.length - 1]?.c < vwap;
        if (!testedVwap || !currentBelowVwap) continue;

        const vwapDistancePct = (currentPrice - vwap) / vwap;
        if (vwapDistancePct < -0.008 || vwapDistancePct >= 0) continue;

        const lastBar = recentBars[recentBars.length - 1];
        const candleInfo = analyzeCandle(lastBar);
        if (candleInfo.bodyRatio <= 0.40) continue;

        const confluence = checkConfluence(bars, 'PUT', { vwap, currentPrice }, { minFactors: 3 });
        if (!confluence.pass) continue;

        const engulfing = detectBearishEngulfing(recentBars.slice(-2));
        const stabilization = detectFlushAndHold(bars, 'PUT');

        let vwapTests = 0;
        for (const bar of recentBars) {
          if (bar.h >= vwap * 0.998 && bar.c < vwap) vwapTests++;
        }

        let confidence = 72;
        if (candleInfo.type === 'BEARISH_MARUBOZU') confidence += 6;
        else if (candleInfo.type === 'STRONG_BEARISH') confidence += 4;
        else confidence += 2;
        if (engulfing.detected) confidence += 4;
        if (stabilization.stabilized && stabilization.barsHeld >= 5) confidence += 5;
        else if (stabilization.stabilized) confidence += 3;
        if (spyChange < 0) confidence += 3;
        confidence += Math.min(6, vwapTests * 2);
        confidence += confluence.confirming * 2;
        confidence -= confluence.opposing * 2;
        confidence = Math.max(60, Math.min(95, confidence));

        const stopPrice = +(vwap * 1.005).toFixed(2);
        const targetPrice = +(currentPrice - 0.4 * atrDollar).toFixed(2);

        seen.add(ticker);
        signals.push(buildSignal('VWAP_RECLAIM', date, checkKey, ticker, 'PUT', confidence, currentPrice, stopPrice, targetPrice, profile, {
          signal_type: 'REJECT',
          vwap_price: +vwap.toFixed(2),
          vwap_distance_pct: +(vwapDistancePct * 100).toFixed(2),
          candle_type: candleInfo.type,
          engulfing: engulfing.detected,
          vwap_tests: vwapTests,
          confluence: confluence.confirming,
        }));
        break;
      }
    }
  }

  return signals;
}


/**
 * POWER_HOUR
 *
 * Check at offset ~315 bars from open (~14:45 ET).
 * Established intraday trend 0.5-2.5 ATR, VWAP aligned, no reversal bars.
 */
export function generatePowerHourSignals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, dailyBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];

  const CHECK_OFFSET = 315; // ~14:45 ET

  for (const ticker of tickers) {
    const profile = profiles[ticker];
    if (!profile) continue;

    const prevBar = findPrevDayBar(dailyBars, ticker, date);
    if (!prevBar) continue;

    const allKeys = getMinuteKeys(minuteBars, ticker, date);
    if (allKeys.length <= CHECK_OFFSET) continue;

    const tickerMinutes = minuteBars[ticker] || {};
    const sessionOpen = tickerMinutes[allKeys[0]]?.o;
    if (!sessionOpen) continue;

    const checkKey = allKeys[CHECK_OFFSET];
    const bars = getBarsUpTo(minuteBars, ticker, date, checkKey);
    if (bars.length < 15) continue;

    const currentPrice = bars[bars.length - 1].c;
    const atr = profile.atr_20d || 0.025;
    const atrDollar = atr * currentPrice;

    // Intraday trend
    const intradayMove = (currentPrice - sessionOpen) / sessionOpen;
    const moveInATRs = Math.abs(intradayMove) / atr;
    if (moveInATRs < 0.5 || moveInATRs > 2.5) continue;

    const direction = intradayMove > 0 ? 'CALL' : 'PUT';

    // VWAP alignment
    const vwap = computeVWAP(bars);
    if (!vwap || vwap <= 0) continue;
    if (direction === 'CALL' && currentPrice <= vwap) continue;
    if (direction === 'PUT' && currentPrice >= vwap) continue;

    // SPY alignment
    const spyChange = getETFChange(etfMinuteBars, 'SPY', date, checkKey);
    if (direction === 'CALL' && spyChange <= -0.002) continue;
    if (direction === 'PUT' && spyChange >= 0.002) continue;

    // No reversal bars in last 5
    const recentBars = bars.slice(-15);
    const lastFive = recentBars.slice(-5);
    const reversalThreshold = 0.2 * atrDollar;
    let hasReversal = false;
    for (const bar of lastFive) {
      const barMove = bar.c - bar.o;
      if (direction === 'CALL' && barMove < -reversalThreshold) { hasReversal = true; break; }
      if (direction === 'PUT' && barMove > reversalThreshold) { hasReversal = true; break; }
    }
    if (hasReversal) continue;

    // Candle quality
    const candleAnalysis = analyzeCandle(bars[bars.length - 1]);
    if (candleAnalysis.bodyRatio <= 0.4) continue;
    if (direction === 'CALL' && (candleAnalysis.type.startsWith('BEARISH') || candleAnalysis.type === 'SHOOTING_STAR')) continue;
    if (direction === 'PUT' && (candleAnalysis.type.startsWith('BULLISH') || candleAnalysis.type === 'HAMMER')) continue;

    // Confluence
    const confluenceResult = checkConfluence(bars, direction, {
      vwap,
      currentPrice,
    }, { minFactors: 3 });
    if (!confluenceResult.pass) continue;

    // Engulfing
    const engulfingResult = bars.length >= 2
      ? (direction === 'CALL' ? detectBullishEngulfing(bars) : detectBearishEngulfing(bars))
      : { detected: false };

    // Clean trend check
    let majorWhipsaws = 0;
    const whipsawThreshold = 0.5 * atrDollar;
    for (let i = 1; i < recentBars.length; i++) {
      const prevMove = recentBars[i - 1].c - recentBars[i - 1].o;
      const currMove = recentBars[i].c - recentBars[i].o;
      if (direction === 'CALL' && prevMove > whipsawThreshold && currMove < -whipsawThreshold) majorWhipsaws++;
      if (direction === 'PUT' && prevMove < -whipsawThreshold && currMove > whipsawThreshold) majorWhipsaws++;
    }
    const cleanTrend = majorWhipsaws === 0;

    // Confidence
    let confidence = 72;
    if (candleAnalysis.type.includes('MARUBOZU')) confidence += 6;
    else if (candleAnalysis.type.startsWith('STRONG')) confidence += 4;
    else confidence += 2;
    if (engulfingResult.detected) confidence += 4;
    if (moveInATRs >= 0.8 && moveInATRs <= 1.5) confidence += 4;
    const momentumPersistence = profile.momentum_persistence || 0.5;
    if (momentumPersistence >= 0.6) confidence += 4;
    else if (momentumPersistence >= 0.4) confidence += 2;
    if (direction === 'CALL' && spyChange > 0.003) confidence += 3;
    if (direction === 'PUT' && spyChange < -0.003) confidence += 3;
    if (cleanTrend) confidence += 2;
    if (confluenceResult) {
      confidence += confluenceResult.confirming * 2;
      confidence -= confluenceResult.opposing * 2;
    }
    confidence = Math.min(95, Math.max(60, confidence));

    // Targets and stops
    const vwapDistance = (currentPrice - vwap) / vwap;
    const stopPrice = direction === 'CALL'
      ? +(vwap * 0.998).toFixed(2)
      : +(vwap * 1.002).toFixed(2);
    const targetPrice = direction === 'CALL'
      ? +(currentPrice + 0.3 * atrDollar).toFixed(2)
      : +(currentPrice - 0.3 * atrDollar).toFixed(2);

    signals.push(buildSignal('POWER_HOUR', date, checkKey, ticker, direction, confidence, currentPrice, stopPrice, targetPrice, profile, {
      move_from_open_pct: +(intradayMove * 100).toFixed(2),
      move_in_atrs: +moveInATRs.toFixed(2),
      candle_type: candleAnalysis.type,
      engulfing: engulfingResult.detected,
      clean_trend: cleanTrend,
      confluence: confluenceResult.confirming,
    }));
  }

  // Cap at top 5
  signals.sort((a, b) => b.composite - a.composite);
  return signals.slice(0, 5);
}


/**
 * CORRELATION_CASCADE
 *
 * Check at offsets 60, 120, 180 (~10:30, 11:30, 12:30 ET).
 * SPY/QQQ >= 0.5% move, stock beta >= 0.5, catch-up ratio < 0.6.
 */
export function generateCascadeSignals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, dailyBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];
  const seen = new Set();

  const CHECK_OFFSETS = [60, 120, 180];

  for (const offset of CHECK_OFFSETS) {
    // Get ETF changes at this checkpoint
    const sampleTicker = tickers.find(t => {
      const keys = getMinuteKeys(minuteBars, t, date);
      return keys.length > offset;
    });
    if (!sampleTicker) continue;

    const sampleKeys = getMinuteKeys(minuteBars, sampleTicker, date);
    if (sampleKeys.length <= offset) continue;
    const checkKey = sampleKeys[offset];

    const spyChange = getETFChange(etfMinuteBars, 'SPY', date, checkKey);
    const qqqChange = getETFChange(etfMinuteBars, 'QQQ', date, checkKey);

    // Hard gate: SPY or QQQ must be moving >= 0.5%
    if (Math.abs(spyChange) < 0.005 && Math.abs(qqqChange) < 0.005) continue;

    const marketMove = Math.abs(spyChange) > Math.abs(qqqChange) ? spyChange : qqqChange;
    const marketDir = marketMove > 0 ? 'CALL' : 'PUT';
    const bothSameDir = (spyChange > 0 && qqqChange > 0) || (spyChange < 0 && qqqChange < 0);

    for (const ticker of tickers) {
      if (ticker === 'SPY' || ticker === 'QQQ') continue;
      if (seen.has(ticker)) continue;

      const profile = profiles[ticker];
      if (!profile) continue;

      const beta = profile.beta_spy || profile.beta_qqq || 1.0;
      if (beta < 0.5) continue;

      const allKeys = getMinuteKeys(minuteBars, ticker, date);
      if (allKeys.length <= offset) continue;

      const tickerMinutes = minuteBars[ticker] || {};
      const sessionOpen = tickerMinutes[allKeys[0]]?.o;
      if (!sessionOpen) continue;

      const tickerCheckKey = allKeys[offset];
      const bars = getBarsUpTo(minuteBars, ticker, date, tickerCheckKey);
      if (bars.length < 5) continue;

      const currentPrice = bars[bars.length - 1].c;
      const actualMove = (currentPrice - sessionOpen) / sessionOpen;
      const expectedMove = marketMove * beta;
      if (expectedMove === 0) continue;

      const catchupRatio = actualMove / expectedMove;
      if (catchupRatio > 0.6 || catchupRatio < -0.3) continue;

      const vwap = computeVWAP(bars);

      // VWAP alignment
      let vwapAligned = false;
      if (vwap > 0) {
        if (marketDir === 'CALL') vwapAligned = currentPrice >= vwap * 0.995;
        else vwapAligned = currentPrice <= vwap * 1.005;
      }

      // Candle check
      const candleResult = bars.length > 0 ? analyzeCandle(bars[bars.length - 1]) : null;

      // Confluence
      let confluenceResult = null;
      if (bars.length >= 10) {
        confluenceResult = checkConfluence(bars, marketDir, { vwap, currentPrice }, { minFactors: 3 });
        if (!confluenceResult.pass) continue;
      }

      // Confidence
      let confidence = 72;
      if (candleResult) {
        if (candleResult.type.includes('MARUBOZU')) confidence += 6;
        else if (candleResult.type.includes('STRONG')) confidence += 4;
        else confidence += 2;
      }
      if (Math.abs(marketMove) >= 0.01) confidence += 5;
      else if (Math.abs(marketMove) >= 0.007) confidence += 3;
      if (beta >= 1.5) confidence += 4;
      if (catchupRatio >= 0.0 && catchupRatio < 0.2) confidence += 5;
      else if (catchupRatio >= 0.2 && catchupRatio < 0.4) confidence += 3;
      if (vwapAligned) confidence += 2;
      if (bothSameDir) confidence += 3;
      if (confluenceResult) {
        confidence += (confluenceResult.confirming || 0) * 2;
        confidence -= (confluenceResult.opposing || 0) * 2;
      }
      confidence = Math.max(60, Math.min(95, confidence));

      // Targets
      const todayLow = Math.min(...bars.map(b => b.l));
      const todayHigh = Math.max(...bars.map(b => b.h));
      const expectedDelta = currentPrice * expectedMove;
      const stopPrice = marketDir === 'CALL'
        ? +(todayLow * 0.998).toFixed(2)
        : +(todayHigh * 1.002).toFixed(2);
      const targetPrice = +(currentPrice + expectedDelta * 0.5).toFixed(2);

      seen.add(ticker);
      signals.push(buildSignal('CORRELATION_CASCADE', date, tickerCheckKey, ticker, marketDir, confidence, currentPrice, stopPrice, targetPrice, profile, {
        beta: +beta.toFixed(2),
        expected_move_pct: +(expectedMove * 100).toFixed(2),
        actual_move_pct: +(actualMove * 100).toFixed(2),
        catchup_ratio: +catchupRatio.toFixed(3),
        spy_change_pct: +(spyChange * 100).toFixed(2),
        qqq_change_pct: +(qqqChange * 100).toFixed(2),
        confluence: confluenceResult ? confluenceResult.confirming : 0,
      }));
    }
  }

  // Cap at top 5
  signals.sort((a, b) => b.composite - a.composite);
  return signals.slice(0, 5);
}


/**
 * POST_MACRO
 *
 * Check at offset 45 (~10:15 ET). Requires macroEvent in context.
 * SPY+QQQ consensus >= 0.3%, beta >= 1.0, VWAP aligned.
 */
export function generatePostMacroSignals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, dailyBars } = dayData;
  const { profiles, tickers, intelligence } = context;
  const signals = [];

  // Check if this is a macro day (caller must populate context.macroEvents)
  const macroEvent = context.macroEvents?.[date] || null;
  if (!macroEvent) return signals;

  const CHECK_OFFSET = 45; // ~10:15 ET

  // Find a valid check key
  const refTicker = tickers.find(t => getMinuteKeys(minuteBars, t, date).length > CHECK_OFFSET);
  if (!refTicker) return signals;
  const refKeys = getMinuteKeys(minuteBars, refTicker, date);
  const refCheckKey = refKeys[CHECK_OFFSET];

  const spyChange = getETFChange(etfMinuteBars, 'SPY', date, refCheckKey);
  const qqqChange = getETFChange(etfMinuteBars, 'QQQ', date, refCheckKey);

  // Consensus direction
  let consensusDirection = null;
  if (spyChange >= 0.003 && qqqChange >= 0.003) consensusDirection = 'CALL';
  else if (spyChange <= -0.003 && qqqChange <= -0.003) consensusDirection = 'PUT';
  else return signals;

  const isBullish = consensusDirection === 'CALL';

  for (const ticker of tickers) {
    const profile = profiles[ticker];
    if (!profile) continue;

    const beta = Math.max(profile.beta_spy || 0, profile.beta_qqq || 0);
    if (beta < 1.0) continue;

    const momentumPersistence = profile.momentum_persistence;
    if (momentumPersistence == null || momentumPersistence < 0.4) continue;

    const allKeys = getMinuteKeys(minuteBars, ticker, date);
    if (allKeys.length <= CHECK_OFFSET) continue;

    const tickerMinutes = minuteBars[ticker] || {};
    const sessionOpen = tickerMinutes[allKeys[0]]?.o;
    if (!sessionOpen) continue;

    const checkKey = allKeys[CHECK_OFFSET];
    const bars = getBarsUpTo(minuteBars, ticker, date, checkKey);
    if (bars.length < 10) continue;

    const currentPrice = bars[bars.length - 1].c;
    const atr = profile.atr_20d || 0.025;
    const atrDollar = atr * currentPrice;

    // Move check
    const moveFromOpen = currentPrice - sessionOpen;
    const moveInATRs = Math.abs(moveFromOpen) / atrDollar;
    if (moveInATRs >= 2.0) continue;

    // VWAP alignment
    const vwap = computeVWAP(bars);
    if (!vwap || vwap <= 0) continue;
    if (isBullish && currentPrice <= vwap) continue;
    if (!isBullish && currentPrice >= vwap) continue;

    // Confluence
    let confluenceResult = null;
    if (bars.length >= 10) {
      confluenceResult = checkConfluence(bars, consensusDirection, { vwap, currentPrice }, { minFactors: 3 });
      if (!confluenceResult.pass) continue;
    }

    // Confidence
    let confidence = 72;
    const candleResult = analyzeCandle(bars[bars.length - 1]);
    if (candleResult.type.includes('MARUBOZU')) confidence += 6;
    else if (candleResult.type.includes('STRONG')) confidence += 4;
    else confidence += 2;

    if (Math.abs(spyChange) > 0.005 && Math.abs(qqqChange) > 0.005) confidence += 5;
    else confidence += 3;
    if (beta >= 1.5) confidence += 4;
    else if (beta >= 1.2) confidence += 2;
    if (momentumPersistence >= 0.7) confidence += 4;
    else if (momentumPersistence >= 0.5) confidence += 2;
    if (moveInATRs < 0.5) confidence += 3;
    if (confluenceResult) {
      confidence += (confluenceResult.confirming || 0) * 2;
      confidence -= (confluenceResult.opposing || 0) * 2;
    }
    confidence = Math.max(60, Math.min(95, confidence));

    const stopPrice = isBullish
      ? +(vwap * 0.997).toFixed(2)
      : +(vwap * 1.003).toFixed(2);
    const targetPrice = isBullish
      ? +(currentPrice + 0.7 * atrDollar).toFixed(2)
      : +(currentPrice - 0.7 * atrDollar).toFixed(2);

    signals.push(buildSignal('POST_MACRO', date, checkKey, ticker, consensusDirection, confidence, currentPrice, stopPrice, targetPrice, profile, {
      macro_event: macroEvent,
      beta: +beta.toFixed(2),
      momentum_persistence: +momentumPersistence.toFixed(2),
      spy_change_pct: +(spyChange * 100).toFixed(2),
      qqq_change_pct: +(qqqChange * 100).toFixed(2),
      confluence: confluenceResult ? confluenceResult.confirming : 0,
    }));
  }

  // Cap at top 3
  signals.sort((a, b) => b.composite - a.composite);
  return signals.slice(0, 3);
}


/**
 * FAILED_BREAKDOWN (bear trap -> CALL, bull trap -> PUT)
 *
 * Check at offsets 60, 120, 180 (~10:30, 11:30, 12:30 ET).
 * Today's low broke prev day low but price recovered (CALL).
 * Today's high broke prev day high but price rejected (PUT).
 */
export function generateTrapSignals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, dailyBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];
  const seen = new Set();

  const CHECK_OFFSETS = [60, 120, 180];

  for (const ticker of tickers) {
    const profile = profiles[ticker];
    if (!profile) continue;

    const prevBar = findPrevDayBar(dailyBars, ticker, date);
    if (!prevBar) continue;
    const prevDayLow = prevBar.l;
    const prevDayHigh = prevBar.h;

    const allKeys = getMinuteKeys(minuteBars, ticker, date);
    if (allKeys.length < 60) continue;

    const tickerMinutes = minuteBars[ticker] || {};
    const sessionOpen = tickerMinutes[allKeys[0]]?.o;
    if (!sessionOpen) continue;

    const atr = profile.atr_20d || 0.025;

    for (const offset of CHECK_OFFSETS) {
      if (offset >= allKeys.length) continue;
      if (seen.has(ticker)) break;

      const checkKey = allKeys[offset];
      const bars = getBarsUpTo(minuteBars, ticker, date, checkKey);
      if (bars.length < 10) continue;

      const currentPrice = bars[bars.length - 1].c;
      const atrDollar = atr * currentPrice;
      const vwap = computeVWAP(bars);
      const todayLow = Math.min(...bars.map(b => b.l));
      const todayHigh = Math.max(...bars.map(b => b.h));

      const spyChange = getETFChange(etfMinuteBars, 'SPY', date, checkKey);

      // --- Bear Trap (CALL) ---
      if (prevDayLow && prevDayLow > 0 && todayLow < prevDayLow && currentPrice > prevDayLow) {
        const recoveryPct = (currentPrice - prevDayLow) / prevDayLow;
        if (recoveryPct >= 0.002) {
          const recentBars = bars.slice(-30);
          const recentBreak = recentBars.some(bar => bar.l < prevDayLow);
          if (!recentBreak) continue;

          const candleInfo = analyzeCandle(bars[bars.length - 1]);
          if (candleInfo.type === 'BEARISH_MARUBOZU') continue;

          const confluence = checkConfluence(bars, 'CALL', { vwap, currentPrice }, { minFactors: 3 });
          if (!confluence.pass) continue;

          const engulfing = detectBullishEngulfing(bars);
          const stabilization = bars.length >= 5 ? detectFlushAndHold(bars, 'CALL') : { stabilized: false, barsHeld: 0 };

          let confidence = 72;
          if (candleInfo.type === 'BULLISH_MARUBOZU') confidence += 6;
          else if (candleInfo.type === 'STRONG_BULLISH') confidence += 4;
          else confidence += 2;
          if (engulfing.detected) confidence += 4;
          if (recoveryPct > 0.005) confidence += 4;
          if (stabilization.stabilized) confidence += 4;
          if (vwap > 0 && currentPrice > vwap) confidence += 3;
          if (spyChange >= 0) confidence += 2;
          if (atrDollar > 0 && (prevDayLow - todayLow) > 0.1 * atrDollar) confidence += 2;
          if (confluence) {
            confidence += confluence.confirming * 2;
            confidence -= confluence.opposing * 2;
          }
          confidence = Math.max(60, Math.min(95, confidence));

          const stopPrice = +(todayLow * 0.998).toFixed(2);
          const targetPrice = +(currentPrice + 0.5 * atrDollar).toFixed(2);

          seen.add(ticker);
          signals.push(buildSignal('FAILED_BREAKDOWN', date, checkKey, ticker, 'CALL', confidence, currentPrice, stopPrice, targetPrice, profile, {
            trap_type: 'BEAR_TRAP',
            level_broken: prevDayLow,
            recovery_pct: +(recoveryPct * 100).toFixed(2),
            candle_type: candleInfo.type,
            engulfing: engulfing.detected,
            stabilized: stabilization.stabilized,
            confluence: confluence.confirming,
          }));
          break;
        }
      }

      // --- Bull Trap (PUT) ---
      if (prevDayHigh && prevDayHigh > 0 && todayHigh > prevDayHigh && currentPrice < prevDayHigh) {
        const rejectionPct = (prevDayHigh - currentPrice) / prevDayHigh;
        if (rejectionPct >= 0.002) {
          const recentBars = bars.slice(-30);
          const recentBreak = recentBars.some(bar => bar.h > prevDayHigh);
          if (!recentBreak) continue;

          const candleInfo = analyzeCandle(bars[bars.length - 1]);
          if (candleInfo.type === 'BULLISH_MARUBOZU') continue;

          const confluence = checkConfluence(bars, 'PUT', { vwap, currentPrice }, { minFactors: 3 });
          if (!confluence.pass) continue;

          const engulfing = detectBearishEngulfing(bars);
          const stabilization = bars.length >= 5 ? detectFlushAndHold(bars, 'PUT') : { stabilized: false, barsHeld: 0 };

          let confidence = 72;
          if (candleInfo.type === 'BEARISH_MARUBOZU') confidence += 6;
          else if (candleInfo.type === 'STRONG_BEARISH') confidence += 4;
          else confidence += 2;
          if (engulfing.detected) confidence += 4;
          if (rejectionPct > 0.005) confidence += 4;
          if (stabilization.stabilized) confidence += 4;
          if (vwap > 0 && currentPrice < vwap) confidence += 3;
          if (spyChange <= 0) confidence += 2;
          if (atrDollar > 0 && (todayHigh - prevDayHigh) > 0.1 * atrDollar) confidence += 2;
          if (confluence) {
            confidence += confluence.confirming * 2;
            confidence -= confluence.opposing * 2;
          }
          confidence = Math.max(60, Math.min(95, confidence));

          const stopPrice = +(todayHigh * 1.002).toFixed(2);
          const targetPrice = +(currentPrice - 0.5 * atrDollar).toFixed(2);

          seen.add(ticker);
          signals.push(buildSignal('FAILED_BREAKDOWN', date, checkKey, ticker, 'PUT', confidence, currentPrice, stopPrice, targetPrice, profile, {
            trap_type: 'BULL_TRAP',
            level_broken: prevDayHigh,
            rejection_pct: +(rejectionPct * 100).toFixed(2),
            candle_type: candleInfo.type,
            engulfing: engulfing.detected,
            stabilized: stabilization.stabilized,
            confluence: confluence.confirming,
          }));
          break;
        }
      }
    }
  }

  // Cap at top 3
  signals.sort((a, b) => b.composite - a.composite);
  return signals.slice(0, 3);
}


/**
 * CAPITULATION_BOUNCE + SECTOR_ROTATION_BOUNCE
 *
 * CAPITULATION_BOUNCE: 3%+ intraday drop with volume surge + reversal candle.
 *   Check at offset 30 (~10:00 ET).
 *
 * SECTOR_ROTATION_BOUNCE: 2-3% gap down on green market day (SPY+QQQ both >0.3%).
 *   Check at offset 30 (~10:00 ET).
 */
export function generateBounceSignals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, dailyBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];

  const CHECK_OFFSET = 30; // ~10:00 ET

  for (const ticker of tickers) {
    const profile = profiles[ticker];
    if (!profile) continue;

    const prevBar = findPrevDayBar(dailyBars, ticker, date);
    if (!prevBar) continue;
    const prevClose = prevBar.c;

    const allKeys = getMinuteKeys(minuteBars, ticker, date);
    if (allKeys.length < CHECK_OFFSET + 5) continue;

    const tickerMinutes = minuteBars[ticker] || {};
    const sessionOpen = tickerMinutes[allKeys[0]]?.o;
    if (!sessionOpen) continue;

    const checkKey = allKeys[CHECK_OFFSET];
    const bars = getBarsUpTo(minuteBars, ticker, date, checkKey);
    if (bars.length < 5) continue;

    const currentPrice = bars[bars.length - 1].c;
    const vwap = computeVWAP(bars);

    const spyChange = getETFChange(etfMinuteBars, 'SPY', date, checkKey);
    const qqqChange = getETFChange(etfMinuteBars, 'QQQ', date, checkKey);

    // --- CAPITULATION_BOUNCE: 3%+ drop from open ---
    let emittedCapitulation = false;
    const intradayDrop = (currentPrice - sessionOpen) / sessionOpen;

    if (intradayDrop <= -0.03) {
      emittedCapitulation = tryCapitulationBounce(bars, currentPrice, sessionOpen, vwap, intradayDrop, checkKey, ticker, profile, date, dailyBars, signals);
    }

    // Skip sector rotation if we already emitted a capitulation signal for this ticker
    if (emittedCapitulation) continue;

    // --- SECTOR_ROTATION_BOUNCE: gap down 2-3% on green market day ---
    if (!prevClose || prevClose <= 0) continue;
    const gap = (sessionOpen - prevClose) / prevClose;
    if (gap < -0.03 || gap > -0.02) continue;

    // Market must be green
    if (spyChange <= 0.003 || qqqChange <= 0.003) continue;

    // First candle must be green + strong
    const firstCandle = tickerMinutes[allKeys[0]];
    if (!firstCandle || firstCandle.c <= firstCandle.o) continue;

    const sectorCandleAnalysis = analyzeCandle(firstCandle);
    let candlePass = sectorCandleAnalysis.bodyRatio >= 0.50;

    // Engulfing alternative
    let sectorEngulfing = false;
    if (bars.length >= 2) {
      const engulfResult = detectBullishEngulfing(bars.slice(-2));
      sectorEngulfing = engulfResult.detected;
      if (sectorEngulfing) candlePass = true;
    }
    if (!candlePass) continue;

    // Confluence
    let sectorConfluence = null;
    if (bars.length >= 10) {
      sectorConfluence = checkConfluence(bars, 'CALL', { vwap, currentPrice }, { minFactors: 3 });
      if (!sectorConfluence.pass) continue;
    }

    // Confidence
    let confidence = 72;
    if (sectorCandleAnalysis.type === 'BULLISH_MARUBOZU') confidence += 6;
    else if (sectorCandleAnalysis.type === 'STRONG_BULLISH') confidence += 4;
    else confidence += 2;
    if (sectorConfluence) {
      confidence += Math.max(0, sectorConfluence.confirming * 2);
      confidence -= sectorConfluence.opposing * 2;
    }
    if (sectorEngulfing) confidence += 4;
    if (vwap > 0 && currentPrice > vwap) confidence += 2;
    const marketStrength = spyChange + qqqChange;
    if (marketStrength >= 0.015) confidence += 3;
    else if (marketStrength >= 0.01) confidence += 1;
    confidence = Math.min(95, Math.max(60, confidence));

    const gapAmount = prevClose - sessionOpen;
    const targetPrice = +(sessionOpen + gapAmount * 0.40).toFixed(2);
    const todayLow = Math.min(...bars.map(b => b.l));
    const stopPrice = +(todayLow * 0.998).toFixed(2);

    signals.push(buildSignal('SECTOR_ROTATION_BOUNCE', date, checkKey, ticker, 'CALL', confidence, currentPrice, stopPrice, targetPrice, profile, {
      gap_pct: +(gap * 100).toFixed(2),
      spy_change_pct: +(spyChange * 100).toFixed(2),
      qqq_change_pct: +(qqqChange * 100).toFixed(2),
      candle_type: sectorCandleAnalysis.type,
      engulfing: sectorEngulfing,
      confluence: sectorConfluence ? sectorConfluence.confirming : 0,
    }));
  }

  return signals;
}

/**
 * Helper for capitulation bounce detection within generateBounceSignals.
 * Returns true if a signal was emitted.
 */
function tryCapitulationBounce(bars, currentPrice, sessionOpen, vwap, intradayDrop, checkKey, ticker, profile, date, dailyBars, signals) {
  // Need reversal candle
  const candleAnalysis = analyzeCandle(bars[bars.length - 1]);
  const isHammer = candleAnalysis.type === 'HAMMER' || candleAnalysis.type === 'INVERTED_HAMMER';
  const isStrongGreen = candleAnalysis.bodyRatio >= 0.50 && candleAnalysis.bullish;

  let engulfing = false;
  if (bars.length >= 2) {
    const engulfResult = detectBullishEngulfing(bars.slice(-2));
    engulfing = engulfResult.detected;
  }

  const hasReversalCandle = isHammer || engulfing || isStrongGreen;
  if (!hasReversalCandle) return false;

  // Stabilization required
  const stabResult = bars.length >= 3 ? detectFlushAndHold(bars, 'CALL') : { stabilized: false, barsHeld: 0 };
  if (!stabResult.stabilized) return false;

  // Confluence
  let confluenceResult = null;
  if (bars.length >= 10) {
    confluenceResult = checkConfluence(bars, 'CALL', { vwap, currentPrice }, { minFactors: 3 });
    if (!confluenceResult.pass) return false;
  }

  // Trend structure
  const dailyTickerBars = dailyBars[ticker] ? Object.values(dailyBars[ticker]).sort((a, b) => (a.day || '').localeCompare(b.day || '')) : [];
  const structure = checkBounceStructure(currentPrice, dailyTickerBars, {
    todayLow: Math.min(...bars.map(b => b.l)),
    todayHigh: Math.max(...bars.map(b => b.h)),
    todayOpen: sessionOpen,
    vwap,
    intradayBars: bars,
  }, 'intraday');

  if (structure.trend === 'DOWNTREND' && structure.trendConfidence >= 0.8) return false;

  // Confidence
  let confidence = 70;

  // Volume approximation
  const cumVol = cumulativeVolume(bars);
  const avgBarVol = cumVol / bars.length;
  const firstFewBars = bars.slice(0, Math.min(5, bars.length));
  const firstFewAvg = cumulativeVolume(firstFewBars) / firstFewBars.length;
  const volRatio = firstFewAvg > 0 ? avgBarVol / firstFewAvg : 1;

  if (volRatio >= 2.0) confidence += 5;
  else if (volRatio >= 1.5) confidence += 3;
  if (isHammer || engulfing) confidence += 4;
  if (stabResult.barsHeld >= 5) confidence += 4;
  else if (stabResult.barsHeld >= 3) confidence += 2;
  if (confluenceResult) confidence += Math.max(0, confluenceResult.confirming * 2);
  if (vwap > 0 && currentPrice > vwap) confidence += 2;
  if (structure.trend === 'UPTREND' || structure.trend === 'RANGE') confidence += 2;
  confidence = Math.min(95, Math.max(60, confidence));

  const todayLow = Math.min(...bars.map(b => b.l));
  const stopPrice = +(todayLow * 0.998).toFixed(2);
  const atrDollar = (profile.atr_20d || 0.025) * currentPrice;
  const targetPrice = +(currentPrice + 0.5 * atrDollar).toFixed(2);

  signals.push(buildSignal('CAPITULATION_BOUNCE', date, checkKey, ticker, 'CALL', confidence, currentPrice, stopPrice, targetPrice, profile, {
    intraday_drop_pct: +(intradayDrop * 100).toFixed(2),
    candle_type: candleAnalysis.type,
    engulfing,
    stabilized: stabResult.stabilized,
    bars_held: stabResult.barsHeld,
    confluence: confluenceResult ? confluenceResult.confirming : 0,
  }));

  return true;
}


/**
 * BREAKDOWN_PUT + RELATIVE_WEAKNESS_PUT
 *
 * BREAKDOWN_PUT: Red market (SPY+QQQ both <= -0.3%), stock below VWAP + near/below prev day low.
 * RELATIVE_WEAKNESS_PUT: Green/flat market, stock down >0.8% and underperforming SPY by 1.5%+.
 *
 * Check at offsets 60, 120 (~10:30, 11:30 ET).
 */
export function generateBreakdownSignals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, dailyBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];
  const seenBreakdown = new Set();
  const seenRelWeak = new Set();

  const CHECK_OFFSETS = [60, 120];

  for (const offset of CHECK_OFFSETS) {
    // Get reference check key
    const refTicker = tickers.find(t => getMinuteKeys(minuteBars, t, date).length > offset);
    if (!refTicker) continue;
    const refKeys = getMinuteKeys(minuteBars, refTicker, date);
    const refCheckKey = refKeys[offset];

    const spyChange = getETFChange(etfMinuteBars, 'SPY', date, refCheckKey);
    const qqqChange = getETFChange(etfMinuteBars, 'QQQ', date, refCheckKey);

    const isRedMarket = spyChange <= -0.003 && qqqChange <= -0.003;
    const isGreenFlatMarket = spyChange >= -0.001 || qqqChange >= -0.001;

    for (const ticker of tickers) {
      const profile = profiles[ticker];
      if (!profile) continue;

      const prevBar = findPrevDayBar(dailyBars, ticker, date);
      if (!prevBar) continue;
      const prevDayLow = prevBar.l;

      const allKeys = getMinuteKeys(minuteBars, ticker, date);
      if (allKeys.length <= offset) continue;

      const tickerMinutes = minuteBars[ticker] || {};
      const sessionOpen = tickerMinutes[allKeys[0]]?.o;
      if (!sessionOpen) continue;

      const checkKey = allKeys[offset];
      const bars = getBarsUpTo(minuteBars, ticker, date, checkKey);
      if (bars.length < 10) continue;

      const currentPrice = bars[bars.length - 1].c;
      const vwap = computeVWAP(bars);
      const intradayChange = (currentPrice - sessionOpen) / sessionOpen;
      const atr = profile.atr_20d || 0.025;

      // --- BREAKDOWN_PUT ---
      if (isRedMarket && !seenBreakdown.has(ticker)) {
        if (intradayChange <= -0.005 && vwap > 0 && currentPrice < vwap) {
          // Relative weakness check
          const relativeWeakness = spyChange - intradayChange;
          if (relativeWeakness >= 0.005) {
            // Near or below prev day low
            const belowPrevLow = prevDayLow > 0 && currentPrice <= prevDayLow;
            const nearPrevLow = prevDayLow > 0 && (currentPrice - prevDayLow) / prevDayLow <= 0.003;

            if (belowPrevLow || nearPrevLow) {
              // Candle quality
              const candleAnalysis = analyzeCandle(bars[bars.length - 1]);
              if (candleAnalysis.bodyRatio >= 0.50 && candleAnalysis.lowerWickRatio <= 0.30) {
                // Engulfing
                let engulfing = false;
                if (bars.length >= 2) {
                  const engulfResult = detectBearishEngulfing(bars.slice(-2));
                  engulfing = engulfResult.detected;
                }

                // Confluence
                const confluenceResult = checkConfluence(bars, 'PUT', { vwap, currentPrice }, { minFactors: 3 });
                if (confluenceResult.pass) {
                  // Trend structure
                  const dailyTickerBars = dailyBars[ticker] ? Object.values(dailyBars[ticker]).sort((a, b) => (a.day || '').localeCompare(b.day || '')) : [];
                  const structure = checkBounceStructure(currentPrice, dailyTickerBars, {
                    todayLow: Math.min(...bars.map(b => b.l)),
                    todayHigh: Math.max(...bars.map(b => b.h)),
                    todayOpen: sessionOpen,
                    vwap,
                    intradayBars: bars,
                  }, 'intraday');

                  if (!(structure.trend === 'UPTREND' && structure.trendConfidence >= 0.8)) {
                    const stabilization = bars.length >= 5 ? detectFlushAndHold(bars, 'PUT') : { stabilized: false };
                    const vwapDistance = (currentPrice - vwap) / vwap;

                    let confidence = 72;
                    if (belowPrevLow) confidence += 3;
                    if (candleAnalysis.type === 'BEARISH_MARUBOZU') confidence += 4;
                    else if (engulfing) confidence += 4;
                    else if (candleAnalysis.type === 'STRONG_BEARISH') confidence += 2;
                    if (stabilization.stabilized) confidence += 3;
                    confidence += Math.max(0, confluenceResult.confirming * 2);
                    confidence -= confluenceResult.opposing * 2;
                    if (structure.trend === 'DOWNTREND' && structure.trendConfidence >= 0.7) confidence += 3;
                    if (Math.abs(vwapDistance) > 0.005) confidence += 2;
                    if (relativeWeakness > 0.01) confidence += 2;
                    confidence = Math.min(95, Math.max(60, confidence));

                    const stopPrice = +(vwap * 1.003).toFixed(2);
                    const todayLow = Math.min(...bars.map(b => b.l));
                    const targetPrice = +(todayLow * 0.99).toFixed(2);

                    seenBreakdown.add(ticker);
                    signals.push(buildSignal('BREAKDOWN_PUT', date, checkKey, ticker, 'PUT', confidence, currentPrice, stopPrice, targetPrice, profile, {
                      vwap_distance_pct: +(vwapDistance * 100).toFixed(2),
                      below_prev_low: belowPrevLow,
                      candle_type: candleAnalysis.type,
                      engulfing,
                      spy_change_pct: +(spyChange * 100).toFixed(2),
                      confluence: confluenceResult.confirming,
                    }));
                  }
                }
              }
            }
          }
        }
      }

      // --- RELATIVE_WEAKNESS_PUT ---
      if (isGreenFlatMarket && !seenRelWeak.has(ticker)) {
        if (intradayChange <= -0.008 && vwap > 0 && currentPrice < vwap) {
          const relativeWeakness = spyChange - intradayChange;
          if (relativeWeakness >= 0.015) {
            // Candle check
            const lastBar = bars[bars.length - 1];
            let candleAnalysis = null;
            let candlePass = false;

            if (lastBar.c < lastBar.o) {
              candleAnalysis = analyzeCandle(lastBar);
              if (candleAnalysis.bodyRatio >= 0.50) candlePass = true;
            }

            let engulfing = false;
            if (bars.length >= 2) {
              const engulfResult = detectBearishEngulfing(bars.slice(-2));
              engulfing = engulfResult.detected;
              if (engulfing) candlePass = true;
            }

            if (candlePass) {
              // Confluence
              const confluenceResult = checkConfluence(bars, 'PUT', { vwap, currentPrice }, { minFactors: 3 });
              if (confluenceResult.pass) {
                // Trend structure
                const dailyTickerBars = dailyBars[ticker] ? Object.values(dailyBars[ticker]).sort((a, b) => (a.day || '').localeCompare(b.day || '')) : [];
                const structure = checkBounceStructure(currentPrice, dailyTickerBars, {
                  todayLow: Math.min(...bars.map(b => b.l)),
                  todayHigh: Math.max(...bars.map(b => b.h)),
                  todayOpen: sessionOpen,
                  vwap,
                  intradayBars: bars,
                }, 'intraday');

                const inDowntrend = structure.trend === 'DOWNTREND' && structure.trendConfidence >= 0.5;
                const breakingPrevLow = prevDayLow > 0 && currentPrice <= prevDayLow;

                if ((inDowntrend || breakingPrevLow) && !(structure.trend === 'UPTREND' && structure.trendConfidence >= 0.8)) {
                  const stabilization = bars.length >= 5 ? detectFlushAndHold(bars, 'PUT') : { stabilized: false, barsHeld: 0 };
                  const vwapDistance = (currentPrice - vwap) / vwap;

                  let confidence = 72;
                  if (candleAnalysis) {
                    if (candleAnalysis.type === 'BEARISH_MARUBOZU') confidence += 6;
                    else if (candleAnalysis.type === 'STRONG_BEARISH') confidence += 4;
                    else confidence += 2;
                  }
                  confidence += Math.max(0, confluenceResult.confirming * 2);
                  confidence -= confluenceResult.opposing * 2;
                  if (stabilization.stabilized && stabilization.barsHeld >= 5) confidence += 4;
                  else if (stabilization.stabilized) confidence += 2;
                  if (engulfing) confidence += 4;
                  if (vwapDistance < -0.01) confidence += 3;
                  if (inDowntrend) confidence += 3;
                  if (breakingPrevLow) confidence += 2;
                  if (relativeWeakness >= 0.025) confidence += 3;
                  else if (relativeWeakness >= 0.02) confidence += 2;
                  confidence = Math.min(95, Math.max(60, confidence));

                  const stopPrice = +(vwap * 1.003).toFixed(2);
                  const todayLow = Math.min(...bars.map(b => b.l));
                  const targetPrice = +(todayLow * 0.99).toFixed(2);

                  seenRelWeak.add(ticker);
                  signals.push(buildSignal('RELATIVE_WEAKNESS_PUT', date, checkKey, ticker, 'PUT', confidence, currentPrice, stopPrice, targetPrice, profile, {
                    relative_weakness_pct: +(relativeWeakness * 100).toFixed(2),
                    vwap_distance_pct: +(vwapDistance * 100).toFixed(2),
                    below_prev_low: breakingPrevLow,
                    candle_type: candleAnalysis ? candleAnalysis.type : null,
                    engulfing,
                    spy_change_pct: +(spyChange * 100).toFixed(2),
                    confluence: confluenceResult.confirming,
                  }));
                }
              }
            }
          }
        }
      }
    }
  }

  // Cap breakdown signals at 5 each
  const breakdownSignals = signals.filter(s => s.strategy === 'BREAKDOWN_PUT')
    .sort((a, b) => b.composite - a.composite).slice(0, 5);
  const relWeakSignals = signals.filter(s => s.strategy === 'RELATIVE_WEAKNESS_PUT')
    .sort((a, b) => b.composite - a.composite).slice(0, 5);

  return [...breakdownSignals, ...relWeakSignals];
}


/**
 * CONSEC_BOUNCE
 *
 * Uses daily bars only. 2+ consecutive days down 3%+ triggers a bounce play.
 * Multiday hold (3 days). Check once at offset 30 (~10:00 ET) for entry price.
 */
export function generateConsecSignals(date, dayData, context) {
  const { minuteBars, dailyBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];

  for (const ticker of tickers) {
    const profile = profiles[ticker];
    if (!profile) continue;

    const tickerDaily = dailyBars[ticker];
    if (!tickerDaily) continue;

    const dates = Object.keys(tickerDaily).filter(d => d < date).sort();
    if (dates.length < 3) continue;

    const n = dates.length;
    const c0 = tickerDaily[dates[n - 3]]?.c;
    const c1 = tickerDaily[dates[n - 2]]?.c;
    const c2 = tickerDaily[dates[n - 1]]?.c;

    if (!c0 || !c1 || !c2) continue;

    const drop1 = (c1 - c0) / c0;
    const drop2 = (c2 - c1) / c1;
    if (drop1 > -0.03 || drop2 > -0.03) continue;

    let consecutiveDays = 2;
    let totalDrop = (c2 - c0) / c0;

    if (dates.length >= 4) {
      const cPrev = tickerDaily[dates[n - 4]]?.c;
      if (cPrev) {
        const drop0 = (c0 - cPrev) / cPrev;
        if (drop0 <= -0.03) {
          consecutiveDays = 3;
          totalDrop = (c2 - cPrev) / cPrev;
        }
      }
    }

    // Get entry price from minute bars at 10:00
    const allKeys = getMinuteKeys(minuteBars, ticker, date);
    const CHECK_OFFSET = 30;
    let entryPrice = c2; // fallback to last daily close
    let checkKey = date + 'T10:00';

    if (allKeys.length > CHECK_OFFSET) {
      checkKey = allKeys[CHECK_OFFSET];
      const tickerMinutes = minuteBars[ticker] || {};
      entryPrice = tickerMinutes[checkKey]?.c || entryPrice;
    }

    // Trend structure
    const dailyBarsArr = dates.slice(-10).map(d => tickerDaily[d]).filter(Boolean);
    const structure = checkBounceStructure(entryPrice, dailyBarsArr, {}, 'multiday');

    // Confluence (relaxed, on daily bars)
    let confluenceResult = null;
    if (dailyBarsArr.length >= 15) {
      confluenceResult = checkConfluence(dailyBarsArr, 'CALL', { currentPrice: entryPrice }, { minFactors: 2 });
      if (confluenceResult.opposing > 2) continue;
    }

    // Candle quality on latest daily bar
    const candleResult = dailyBarsArr.length > 0 ? analyzeCandle(dailyBarsArr[dailyBarsArr.length - 1]) : null;

    // Confidence
    let confidence = consecutiveDays >= 3 ? 78 : 68;
    if (candleResult) {
      if (candleResult.type === 'HAMMER') confidence += 6;
      else if (candleResult.type === 'STRONG_BULLISH') confidence += 4;
      else if (candleResult.type === 'DOJI') confidence += 2;
    }
    if (confluenceResult) {
      confidence += (confluenceResult.confirming || 0) * 2;
      confidence -= (confluenceResult.opposing || 0) * 2;
    }
    if (structure.trend === 'UPTREND' || structure.trend === 'RANGE') confidence += 2;
    else if (structure.trend === 'DOWNTREND') confidence -= 3;
    confidence = Math.max(60, Math.min(95, confidence));

    // Stop: 3% below entry (wider for multiday)
    const stopPrice = +(entryPrice * 0.97).toFixed(2);
    // Target: 3% bounce (half of average drop)
    const targetPrice = +(entryPrice * 1.03).toFixed(2);

    signals.push(buildSignal('CONSEC_BOUNCE', date, checkKey, ticker, 'CALL', confidence, entryPrice, stopPrice, targetPrice, profile, {
      consecutive_days: consecutiveDays,
      total_drop_pct: +(totalDrop * 100).toFixed(2),
      trend: structure.trend,
      candle_type: candleResult ? candleResult.type : null,
      confluence: confluenceResult ? confluenceResult.confirming : 0,
    }));
  }

  return signals;
}

// ── VOL_DROP_PUT ──────────────────────────────────────────────────────────────

/**
 * VOL_DROP_PUT
 *
 * Detects 3%+ intraday drops on low volume (< 1.5x baseline).
 * Volume dropping while price drops = distribution, not capitulation
 * -> continuation PUT.
 */
export function generateVolDropSignals(date, dayData, context) {
  const { minuteBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];
  const seen = new Set();

  for (const ticker of tickers) {
    if (seen.has(ticker)) continue;
    const profile = profiles[ticker];
    if (!profile) continue;

    const tickerMinutes = minuteBars[ticker] || {};
    const allKeys = Object.keys(tickerMinutes).filter(k => k.startsWith(date)).sort();
    if (allKeys.length < 60) continue; // need enough bars

    const sessionOpen = tickerMinutes[allKeys[0]]?.o;
    if (!sessionOpen) continue;

    // Check at bar offset 120 (~12:00 ET) and 180 (~1:00 ET)
    for (const checkOffset of [120, 180]) {
      if (allKeys.length <= checkOffset) continue;
      const checkKey = allKeys[checkOffset];
      const checkBar = tickerMinutes[checkKey];
      if (!checkBar) continue;

      const currentPrice = checkBar.c;
      const intradayDrop = (currentPrice - sessionOpen) / sessionOpen;
      if (intradayDrop > -0.03) continue; // need 3%+ drop

      // Volume: compute average of last 30 bars
      const recentKeys = allKeys.slice(Math.max(0, checkOffset - 30), checkOffset + 1);
      const recentVols = recentKeys.map(k => tickerMinutes[k]?.v || 0).filter(v => v > 0);
      const avgVol = recentVols.length > 0 ? recentVols.reduce((a, b) => a + b, 0) / recentVols.length : 0;

      // Early volume baseline (first 30 bars)
      const earlyKeys = allKeys.slice(0, 30);
      const earlyVols = earlyKeys.map(k => tickerMinutes[k]?.v || 0).filter(v => v > 0);
      const earlyAvg = earlyVols.length > 0 ? earlyVols.reduce((a, b) => a + b, 0) / earlyVols.length : avgVol;

      const volumeRatio = earlyAvg > 0 ? avgVol / earlyAvg : 1;
      if (volumeRatio >= 1.5) continue; // high volume = capitulation, not distribution

      // Build bars array for confluence
      const barArray = allKeys.slice(0, checkOffset + 1).map(k => {
        const b = tickerMinutes[k];
        return { o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
      });

      // Confluence check (relaxed: minFactors 2)
      let confluenceResult = null;
      if (barArray.length >= 10) {
        confluenceResult = checkConfluence(barArray, 'PUT', {
          currentPrice,
        }, { minFactors: 2 });
        if (confluenceResult && confluenceResult.opposing > 1) continue;
      }

      // Candle quality
      const candleAnalysis = analyzeCandle(barArray[barArray.length - 1]);

      // Dynamic confidence
      let confidence = 62;
      if (candleAnalysis.type === 'BEARISH_MARUBOZU') confidence += 6;
      else if (candleAnalysis.type === 'STRONG_BEARISH') confidence += 4;
      else confidence += 2;
      if (intradayDrop < -0.04) confidence += 4;
      else if (intradayDrop < -0.035) confidence += 2;
      if (volumeRatio < 0.8) confidence += 3;
      if (confluenceResult) {
        confidence += Math.max(0, confluenceResult.confirming * 2);
        confidence -= confluenceResult.opposing * 2;
      }
      confidence = Math.max(55, Math.min(85, confidence));

      const atr = profile.atr_20d || 0.025;
      const stopPrice = +sessionOpen.toFixed(2); // stop if price recovers to open
      const t1Target = +(currentPrice * (1 - atr * 0.5)).toFixed(2);

      seen.add(ticker);
      signals.push(buildSignal('VOL_DROP_PUT', date, checkKey, ticker, 'PUT', confidence, currentPrice, stopPrice, t1Target, profile, {
        intraday_drop_pct: +(intradayDrop * 100).toFixed(2),
        volume_ratio: +volumeRatio.toFixed(2),
        candle_type: candleAnalysis.type,
        confluence: confluenceResult ? confluenceResult.confirming : 0,
      }));
      break; // one signal per ticker
    }
  }

  return signals;
}

// ── PRE_EARNINGS_PUT ──────────────────────────────────────────────────────────

/**
 * PRE_EARNINGS_PUT
 *
 * Uses conviction scores (simulated in backtest via earnings calendar,
 * price position vs 52-week high, and IV rank from context).
 * Targets stocks 15-35% below 52-week high with low IV rank
 * and 7-21 days to earnings.
 */
export function generatePreEarningsSignals(date, dayData, context) {
  const { dailyBars } = dayData;
  const { profiles, tickers, earningsCalendar, ivHistory } = context;
  const signals = [];

  for (const ticker of tickers) {
    const profile = profiles[ticker];
    if (!profile) continue;

    // Check earnings calendar
    const earningsDate = earningsCalendar?.[ticker];
    if (!earningsDate) continue;

    const ed = new Date(earningsDate);
    const today = new Date(date);
    const daysToEarnings = Math.round((ed - today) / 86400000);
    if (daysToEarnings < 7 || daysToEarnings > 21) continue;

    // IV rank check (need cheap options)
    const ivRank = ivHistory?.[ticker]?.iv_rank ?? 50;
    if (ivRank >= 35) continue;

    // Price position: need to be 15-35% below 52-week high
    const tickerDaily = dailyBars[ticker] || {};
    const dailyKeys = Object.keys(tickerDaily).filter(k => k <= date).sort();
    if (dailyKeys.length < 20) continue;

    // Approximate 52-week high from available data
    const allHighs = dailyKeys.map(k => tickerDaily[k]?.h || 0);
    const high52w = Math.max(...allHighs);
    const currentBar = tickerDaily[dailyKeys[dailyKeys.length - 1]];
    if (!currentBar) continue;
    const currentPrice = currentBar.c;

    const pctBelowHigh = ((currentPrice - high52w) / high52w) * 100; // negative
    const absPctBelow = Math.abs(pctBelowHigh);
    if (absPctBelow < 15 || absPctBelow > 35) continue;

    // ATR for sizing
    const atr = profile.atr_20d || 0.025;

    // Confidence: scaled by how far below high + low IV
    let confidence = 70;
    if (absPctBelow >= 25) confidence += 5;
    if (ivRank < 20) confidence += 5;
    if (daysToEarnings <= 14) confidence += 3;
    confidence = Math.max(60, Math.min(90, confidence));

    const stopPrice = +(currentPrice * 1.05).toFixed(2); // 5% above entry
    const t1Target = +(currentPrice * 0.90).toFixed(2); // 10% below

    signals.push(buildSignal('PRE_EARNINGS_PUT', date, `${date}T15:00`, ticker, 'PUT', confidence, currentPrice, stopPrice, t1Target, profile, {
      days_to_earnings: daysToEarnings,
      iv_rank: ivRank,
      pct_below_52w_high: +absPctBelow.toFixed(2),
      confluence: 0,
    }));
  }

  return signals;
}

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
 *   POWER_HOUR_MOMENTUM, MACRO_REACTION, EXTREME_REVERSAL, EOD_MEAN_REVERSION,
 *   HIGH_RVOL_BREAKOUT, PEAD_DRIFT, SECTOR_LAGGARD, SHORT_SQUEEZE_MOMENTUM,
 *   OPTIONS_FLOW, ANALYST_DRIFT, VIX_REVERSAL, ZERO_DTE_SCALP
 */

import { checkConfluence } from '../../../src/indicators/confluence.js';
import { analyzeCandle, detectBullishEngulfing, detectBearishEngulfing, scanCandlePatterns } from '../../../src/indicators/candle-patterns.js';
import { computeMACD } from '../../../src/indicators/technical.js';
import { checkBounceStructure, detectFlushAndHold } from '../../../src/strategies/support-check.js';
import { POSITION_SIZES } from '../execution-model.js';
import { applyCalibration } from '../grade-calibrator.js';

// ── Shared Helpers ───────────────────────────────────────────────────────────

/**
 * Determine if a date string (YYYY-MM-DD) falls in US Eastern Daylight Time.
 * EDT runs from the second Sunday in March to the first Sunday in November.
 */
function isEDT(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // Second Sunday in March
  const mar1Day = new Date(y, 2, 1).getDay(); // 0=Sun
  const secondSunMar = mar1Day === 0 ? 8 : (14 - mar1Day + 1);
  // First Sunday in November
  const nov1Day = new Date(y, 10, 1).getDay();
  const firstSunNov = nov1Day === 0 ? 1 : (7 - nov1Day + 1);
  const mmdd = m * 100 + d;
  return mmdd >= (300 + secondSunMar) && mmdd < (1100 + firstSunNov);
}

/**
 * Get RTH (Regular Trading Hours) UTC time boundaries for a given date.
 * EDT (UTC-4): 9:30 AM = 13:30 UTC, 4:00 PM = 20:00 UTC
 * EST (UTC-5): 9:30 AM = 14:30 UTC, 4:00 PM = 21:00 UTC
 */
function getRTHBounds(dateStr) {
  return isEDT(dateStr)
    ? { start: '13:30', end: '20:00' }
    : { start: '14:30', end: '21:00' };
}

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
  // Hold times tuned by directional study: exit before edge decays
  ORB_BREAKOUT:          { maxHoldMinutes: 60,  holdDays: 0 }, // MFE at 41 min, 93.7% directional
  GAP_FILL_REVERSION:    { maxHoldMinutes: 60,  holdDays: 0 }, // MFE at 40 min, 92.6% directional
  POWER_HOUR_MOMENTUM:   { maxHoldMinutes: 45,  holdDays: 0 }, // MFE at 24 min, 90.1% directional
  MOMENTUM_SCALP:        { maxHoldMinutes: 60,  holdDays: 0 }, // MFE at 47 min, 92.7% directional
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
 * Filters to Regular Trading Hours only (9:30 AM - 4:00 PM ET).
 * This ensures offset 0 = market open, offset 330 = 3:00 PM, etc.
 */
function getMinuteKeys(minuteBars, ticker, date) {
  const tickerMinutes = minuteBars[ticker] || {};
  const { start, end } = getRTHBounds(date);
  const rthStart = `${date}T${start}`;
  const rthEnd = `${date}T${end}`;
  return Object.keys(tickerMinutes)
    .filter(k => k >= rthStart && k <= rthEnd)
    .sort();
}

/**
 * Build an array of bar objects from minuteBars up to (and including) a given time key.
 * Filters to RTH only so VWAP and other aggregations exclude pre-market data.
 * Returns [{o, h, l, c, v, t}, ...] sorted chronologically.
 */
function getBarsUpTo(minuteBars, ticker, date, upToKey) {
  const tickerMinutes = minuteBars[ticker] || {};
  const { start } = getRTHBounds(date);
  const rthStart = `${date}T${start}`;
  const keys = Object.keys(tickerMinutes)
    .filter(k => k >= rthStart && k <= upToKey)
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
 * Aggregate 1-minute bars into 5-minute bars for multi-timeframe analysis.
 * Groups sequential bars in buckets of 5: OHLCV aggregated per standard rules.
 * @param {{o,h,l,c,v,t}[]} bars - chronological 1-min bars
 * @returns {{o,h,l,c,v,t}[]} aggregated 5-min bars
 */
function aggregate5Min(bars) {
  const result = [];
  for (let i = 0; i < bars.length; i += 5) {
    const bucket = bars.slice(i, i + 5);
    if (bucket.length === 0) break;
    result.push({
      o: bucket[0].o,
      h: Math.max(...bucket.map(b => b.h)),
      l: Math.min(...bucket.map(b => b.l)),
      c: bucket[bucket.length - 1].c,
      v: bucket.reduce((s, b) => s + (b.v || 0), 0),
      t: bucket[0].t,
    });
  }
  return result;
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
    exitOverrides: liveSignal.exitOverrides || null,
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
  if (bars.length < 5) return result;

  // Find the momentum extreme (exclude last 2 bars to leave room for pullback + trigger)
  let extremeIdx = -1;
  let extremeVal = direction === 'CALL' ? -Infinity : Infinity;

  for (let i = 0; i < bars.length - 2; i++) {
    if (direction === 'CALL' && bars[i].h > extremeVal) {
      extremeVal = bars[i].h;
      extremeIdx = i;
    }
    if (direction === 'PUT' && bars[i].l < extremeVal) {
      extremeVal = bars[i].l;
      extremeIdx = i;
    }
  }

  if (extremeIdx < 1 || extremeIdx >= bars.length - 2) return result;

  // Look for pullback bars after the extreme
  // Relaxed: count bars that are generally against trend OR flat (small moves)
  let pullbackStart = extremeIdx + 1;
  let pullbackCount = 0;
  let pullbackHigh = -Infinity;
  let pullbackLow = Infinity;

  for (let i = pullbackStart; i < bars.length - 1 && pullbackCount < 10; i++) {
    const bar = bars[i];
    const barRange = bar.h - bar.l;
    if (barRange <= 0) { pullbackCount++; continue; }

    // Count bars that move against trend OR are small (< 30% ATR)
    const barMove = bar.c - bar.o;
    const isAgainst = (direction === 'CALL' && barMove <= 0) || (direction === 'PUT' && barMove >= 0);
    const isSmall = Math.abs(barMove) < 0.3 * atr;
    if (!isAgainst && !isSmall && pullbackCount < 2) break; // need at least 2 counter/flat bars

    if (bar.h > pullbackHigh) pullbackHigh = bar.h;
    if (bar.l < pullbackLow) pullbackLow = bar.l;
    pullbackCount++;
  }

  if (pullbackCount < 2) return result;

  // Check trigger: any of the last 3 bars should break the pullback high/low
  for (let t = Math.max(0, bars.length - 3); t < bars.length; t++) {
    const triggerBar = bars[t];
    const triggerBreaks = direction === 'CALL'
      ? triggerBar.c > pullbackHigh
      : triggerBar.c < pullbackLow;
    if (triggerBreaks) {
      result.detected = true;
      result.pullbackLow = pullbackLow;
      result.pullbackHigh = pullbackHigh;
      result.pullbackBars = pullbackCount;
      result.triggerBar = triggerBar;
      return result;
    }
  }
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

/**
 * Enrich signal metadata with standardized market, volume, price, and candle context.
 * Call this just before buildSignal in each strategy, then spread into liveSignal.
 *
 * @param {Array} bars - Session bars up to signal time [{o,h,l,c,v,t}, ...]
 * @param {string} ticker - Ticker symbol
 * @param {string} date - Date string YYYY-MM-DD
 * @param {number} currentPrice - Current price at signal time
 * @param {number|null} vwap - Computed VWAP (null if unavailable)
 * @param {number|null} sessionOpen - Session open price (null if unavailable)
 * @param {number|null} atrDollar - ATR in dollar terms (null if unavailable)
 * @param {Object|null} etfMinuteBars - ETF minute bars for SPY change
 * @param {string} checkKey - Minute bar key at signal time (for ETF lookup)
 * @returns {Object} Enrichment fields to spread into metadata
 */
function enrichMetadata(bars, ticker, date, currentPrice, vwap, sessionOpen, atrDollar, etfMinuteBars, checkKey) {
  const result = {};

  // ── Market context ──────────────────────────────────────────────────────
  // spy_change_pct: SPY change from open at signal time
  result.spy_change_pct = etfMinuteBars
    ? +(getETFChange(etfMinuteBars, 'SPY', date, checkKey) * 100).toFixed(3)
    : 0;

  // intraday_vol: standard deviation of returns over last 20 bars
  if (bars.length >= 21) {
    const returns = [];
    const slice = bars.slice(-21);
    for (let i = 1; i < slice.length; i++) {
      if (slice[i - 1].c > 0) {
        returns.push((slice[i].c - slice[i - 1].c) / slice[i - 1].c);
      }
    }
    if (returns.length > 1) {
      const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
      const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
      result.intraday_vol = +Math.sqrt(variance).toFixed(6);
    } else {
      result.intraday_vol = 0;
    }
  } else {
    result.intraday_vol = 0;
  }

  // bars_from_open: how many minutes into the session
  result.bars_from_open = bars.length;

  // ── Volume context ──────────────────────────────────────────────────────
  // vol_ratio_20bar: current bar volume / average of last 20 bars
  if (bars.length >= 2) {
    const lookback = Math.min(20, bars.length - 1);
    const recentBars = bars.slice(-(lookback + 1), -1);
    const avgVol = recentBars.reduce((s, b) => s + (b.v || 0), 0) / recentBars.length;
    const currentVol = bars[bars.length - 1].v || 0;
    result.vol_ratio_20bar = avgVol > 0 ? +(currentVol / avgVol).toFixed(2) : 0;
  } else {
    result.vol_ratio_20bar = 0;
  }

  // cumulative_rvol: total session volume so far / expected at this pace
  // Compare to first-10-bar volume rate extrapolation (early session pace baseline)
  if (bars.length >= 1) {
    const cumVol = bars.reduce((s, b) => s + (b.v || 0), 0);
    const first10 = bars.slice(0, Math.min(10, bars.length));
    const first10Vol = first10.reduce((s, b) => s + (b.v || 0), 0);
    const first10AvgPerBar = first10.length > 0 ? first10Vol / first10.length : 0;
    const expectedCum = first10AvgPerBar * bars.length;
    result.cumulative_rvol = expectedCum > 0 ? +(cumVol / expectedCum).toFixed(2) : 0;
  } else {
    result.cumulative_rvol = 0;
  }

  // ── Price context ───────────────────────────────────────────────────────
  // dist_from_vwap_pct: signed distance from VWAP
  if (vwap && vwap > 0 && currentPrice > 0) {
    result.dist_from_vwap_pct = +(((currentPrice - vwap) / vwap) * 100).toFixed(3);
  } else {
    result.dist_from_vwap_pct = null;
  }

  // dist_from_session_high_pct & dist_from_session_low_pct
  if (bars.length >= 1 && currentPrice > 0) {
    const sessionHigh = Math.max(...bars.map(b => b.h));
    const sessionLow = Math.min(...bars.map(b => b.l));
    if (isFinite(sessionHigh) && sessionHigh > 0) {
      result.dist_from_session_high_pct = +(((currentPrice - sessionHigh) / sessionHigh) * 100).toFixed(3);
    } else {
      result.dist_from_session_high_pct = 0;
    }
    if (isFinite(sessionLow) && sessionLow > 0) {
      result.dist_from_session_low_pct = +(((currentPrice - sessionLow) / sessionLow) * 100).toFixed(3);
    } else {
      result.dist_from_session_low_pct = 0;
    }
  } else {
    result.dist_from_session_high_pct = 0;
    result.dist_from_session_low_pct = 0;
  }

  // move_from_open_pct: total % move from session open
  if (sessionOpen && sessionOpen > 0 && currentPrice > 0) {
    result.move_from_open_pct = +(((currentPrice - sessionOpen) / sessionOpen) * 100).toFixed(3);
  } else {
    result.move_from_open_pct = null;
  }

  // ── Candle context ──────────────────────────────────────────────────────
  // last_3_bar_direction: count of up bars in last 3
  if (bars.length >= 3) {
    const last3 = bars.slice(-3);
    result.last_3_bar_direction = last3.filter(b => b.c > b.o).length;
  } else {
    result.last_3_bar_direction = null;
  }

  // bar_range_vs_atr: current bar range / ATR
  if (bars.length >= 1 && atrDollar && atrDollar > 0) {
    const lastBar = bars[bars.length - 1];
    const barRange = lastBar.h - lastBar.l;
    result.bar_range_vs_atr = +(barRange / atrDollar).toFixed(3);
  } else {
    result.bar_range_vs_atr = null;
  }

  return result;
}

// ── Strategy Implementations ─────────────────────────────────────────────────

/**
 * ORB_BREAKOUT
 *
 * Edge: Institutional order flow at open. First 5 min reveals overnight order imbalance.
 * "Stocks in Play" filter: high RVOL (2x+) per Zarattini, Barbon & Aziz 2024 (Sharpe 2.81, 36% alpha).
 * Time: Bars 5-60 from open (9:35-10:30 AM). FIRST breakout only.
 * Range: First 5 bars. Min width 0.2%, max 1.5% of price.
 */
let _orbDiagLogged = false;
export function generateORBBreakoutSignals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, dailyBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];
  const seen = new Set();

  const RANGE_BARS = 5;

  // One-time diagnostic: log RTH bar counts
  if (!_orbDiagLogged) {
    _orbDiagLogged = true;
    const sampleTicker = tickers[0];
    const rthKeys = getMinuteKeys(minuteBars, sampleTicker, date);
    const allTickerKeys = Object.keys(minuteBars[sampleTicker] || {}).filter(k => k.startsWith(date)).sort();
    const bounds = getRTHBounds(date);
    console.log(`[DIAG] RTH filter: ${sampleTicker} ${date} | total=${allTickerKeys.length} rth=${rthKeys.length} | bounds=${bounds.start}-${bounds.end} | first_rth=${rthKeys[0]} last_rth=${rthKeys[rthKeys.length-1]} | first_all=${allTickerKeys[0]} last_all=${allTickerKeys[allTickerKeys.length-1]}`);
    // Log ETF bar counts too
    const spyRth = getMinuteKeys(etfMinuteBars || {}, 'SPY', date);
    console.log(`[DIAG] SPY ETF: rth=${spyRth.length} first=${spyRth[0]} last=${spyRth[spyRth.length-1]}`);
  }

  for (const ticker of tickers) {
    if (seen.has(ticker)) continue;
    const profile = profiles[ticker];
    if (!profile) continue;

    const allKeys = getMinuteKeys(minuteBars, ticker, date);
    if (allKeys.length < RANGE_BARS + 10) continue;

    // "Stocks in Play" filter: require 2x+ relative volume in opening range
    // per Zarattini et al. 2024 -- high RVOL is the key differentiator
    const tickerMinutesCheck = minuteBars[ticker] || {};
    let orTotalVol = 0;
    for (let j = 0; j < RANGE_BARS && j < allKeys.length; j++) {
      orTotalVol += tickerMinutesCheck[allKeys[j]]?.v || 0;
    }
    const avgDailyVol = profile.avg_volume_20d || profile.avg_volume || 0;
    // Approximate expected volume in first 5 min: ~8% of daily volume
    const expectedORVol = avgDailyVol * 0.08;
    if (expectedORVol > 0 && orTotalVol < expectedORVol * 2.0) continue;

    const tickerMinutes = minuteBars[ticker] || {};
    const sessionOpen = tickerMinutes[allKeys[0]]?.o;
    if (!sessionOpen) continue;

    // Compute opening range from first 5 bars
    const or = computeOpeningRange(minuteBars, ticker, date, RANGE_BARS);
    if (!or) continue;

    const rangeWidthPct = or.width / sessionOpen;
    if (rangeWidthPct < 0.002 || rangeWidthPct > 0.015) continue;

    // Scan bars 5-55 for FIRST breakout, then require 2-bar confirmation.
    // TA insight: winners show +0.08-0.18 ATR at 5min. Losers stall immediately.
    // By waiting 2 bars, we filter false breakouts that collapse back into range.
    const atr = profile.atr_20d || 0.025;
    const atrDollar = atr * sessionOpen;
    const maxOffset = Math.min(55, allKeys.length - 3); // leave room for confirmation bars
    for (let i = RANGE_BARS; i <= maxOffset; i++) {
      if (seen.has(ticker)) break;

      const breakoutKey = allKeys[i];
      const breakoutBar = tickerMinutes[breakoutKey];
      if (!breakoutBar) continue;

      const breakAbove = breakoutBar.c > or.high;
      const breakBelow = breakoutBar.c < or.low;
      if (!breakAbove && !breakBelow) continue;

      const direction = breakAbove ? 'CALL' : 'PUT';

      // Volume check: breakout bar volume vs range avg
      const volRatio = or.avgVolume > 0 ? (breakoutBar.v || 0) / or.avgVolume : 0;
      if (volRatio < 1.3) continue;

      // Candle quality on breakout bar
      const breakoutCandle = analyzeCandle(breakoutBar);
      if (breakoutCandle.bodyRatio < 0.50) continue;

      // ── 2-bar confirmation ──
      // Check that price HOLDS beyond the range for 2 bars after breakout.
      // This is the key TA filter: real breakouts don't stall.
      const confBar1 = tickerMinutes[allKeys[i + 1]];
      const confBar2 = tickerMinutes[allKeys[i + 2]];
      if (!confBar1 || !confBar2) continue;

      // Confirmation: both bars must close beyond the breakout level
      if (direction === 'CALL') {
        if (confBar1.c <= or.high || confBar2.c <= or.high) continue;
        // Price should be advancing: confBar2 close >= breakout close (no stall)
        if (confBar2.c < breakoutBar.c) continue;
      } else {
        if (confBar1.c >= or.low || confBar2.c >= or.low) continue;
        if (confBar2.c > breakoutBar.c) continue;
      }

      // ── Bar structure quality on confirmation bars ──
      // Winners show momentum bars: large bodies, small wicks
      const confCandle1 = analyzeCandle(confBar1);
      const confCandle2 = analyzeCandle(confBar2);
      // At least 1 of 2 confirmation bars should be a strong candle (body > 50%)
      const hasStrongConf = confCandle1.bodyRatio >= 0.50 || confCandle2.bodyRatio >= 0.50;

      // ── Confirmation volume ──
      // At least one confirmation bar should have decent volume (>= 0.8x breakout bar)
      const confVolOk = (confBar1.v >= breakoutBar.v * 0.8) || (confBar2.v >= breakoutBar.v * 0.8);

      // Entry at confirmation bar close (bar i+2), not the breakout bar
      const entryBar = confBar2;
      const entryKey = allKeys[i + 2];
      const entryPrice = entryBar.c;

      // VWAP alignment (using bars up to entry, not breakout)
      const bars = getBarsUpTo(minuteBars, ticker, date, entryKey);
      const vwap = computeVWAP(bars);
      if (direction === 'CALL' && entryPrice <= vwap) continue;
      if (direction === 'PUT' && entryPrice >= vwap) continue;

      // SPY alignment
      const spyChange = getETFChange(etfMinuteBars, 'SPY', date, entryKey);
      const spyAligned = (direction === 'CALL' && spyChange > 0) || (direction === 'PUT' && spyChange < 0);

      // Confluence
      const confluenceResult = checkConfluence(bars, direction, { vwap, currentPrice: entryPrice }, { minFactors: 3 });
      if (!confluenceResult.pass) continue;

      // Engulfing on breakout bar pair
      let engulfing = false;
      if (bars.length >= 2) {
        const engulfResult = direction === 'CALL'
          ? detectBullishEngulfing([tickerMinutes[allKeys[i - 1]] || breakoutBar, breakoutBar])
          : detectBearishEngulfing([tickerMinutes[allKeys[i - 1]] || breakoutBar, breakoutBar]);
        engulfing = engulfResult.detected;
      }

      // Confidence scoring -- now includes confirmation quality
      let confidence = 60;
      if (breakoutCandle.type.includes('MARUBOZU')) confidence += 6;
      else if (breakoutCandle.type.includes('STRONG')) confidence += 4;
      else confidence += 2;
      if (engulfing) confidence += 4;
      if (volRatio >= 1.5) confidence += 5;
      else confidence += 3;
      if (spyAligned) confidence += 3;
      confidence += 3; // VWAP aligned
      confidence += Math.max(0, confluenceResult.confirming * 2);
      confidence -= confluenceResult.opposing * 2;
      confidence += 5; // first breakout bonus
      // NEW: confirmation quality bonuses
      if (hasStrongConf) confidence += 3; // strong confirmation bars
      if (confVolOk) confidence += 2; // volume sustained through confirmation
      // Penalty if confirmation is weak
      if (!hasStrongConf && !confVolOk) confidence -= 5;
      confidence = Math.max(60, Math.min(95, confidence));

      // Stop: opposite edge of opening range. Target: 1.5x risk.
      const stopPrice = direction === 'CALL' ? +or.low.toFixed(2) : +or.high.toFixed(2);
      const risk = Math.abs(entryPrice - (direction === 'CALL' ? or.low : or.high));
      const targetPrice = direction === 'CALL'
        ? +(entryPrice + risk * 1.5).toFixed(2)
        : +(entryPrice - risk * 1.5).toFixed(2);

      seen.add(ticker);
      const _orbAtrDollar = atrDollar;
      const _orbEnrich = enrichMetadata(bars, ticker, date, entryPrice, vwap, sessionOpen, _orbAtrDollar, etfMinuteBars, entryKey);
      signals.push(buildSignal('ORB_BREAKOUT', date, entryKey, ticker, direction, confidence, entryPrice, stopPrice, targetPrice, profile, {
        range_high: +or.high.toFixed(2),
        range_low: +or.low.toFixed(2),
        range_width_pct: +(rangeWidthPct * 100).toFixed(2),
        breakout_vol_ratio: +volRatio.toFixed(2),
        breakout_candle: breakoutCandle.type,
        conf_bar1_body: +confCandle1.bodyRatio.toFixed(2),
        conf_bar2_body: +confCandle2.bodyRatio.toFixed(2),
        conf_vol_sustained: confVolOk,
        engulfing,
        spy_aligned: spyAligned,
        vwap_aligned: true,
        confluence: confluenceResult.confirming,
        exitOverrides: { momentumStall: true },
        ..._orbEnrich,
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

  // Diagnostic counters (first date only)
  const diag = { checks: 0, noVwap: 0, distFail: 0, noCross: 0, volFail: 0, candleFail: 0, passed: 0 };

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

      diag.checks++;
      const currentPrice = bars[bars.length - 1].c;
      const vwap = computeVWAP(bars);
      if (!vwap || vwap <= 0) { diag.noVwap++; continue; }

      const distPct = Math.abs(currentPrice - vwap) / vwap;
      if (distPct < 0.001 || distPct > 0.008) { diag.distFail++; continue; } // Widened: 0.1-0.8% from VWAP

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
      else { diag.noCross++; continue; }

      // Volume declining on pullback (soft bonus, not hard gate)
      const volDeclining = isVolumeDecreasing(bars, 5);

      // Reversal candle check (soft -- VWAP proximity IS the thesis)
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
      // Require at least one of: volume declining OR reversal candle
      if (!volDeclining && !hasReversal) { diag.candleFail++; continue; }
      diag.passed++;

      // Confluence (minFactors: 2 -- VWAP distance + vol decline + reversal candle already filter heavily)
      const confluenceResult = checkConfluence(bars, direction, { vwap, currentPrice }, { minFactors: 2 });

      // SPY alignment
      const spyChange = getETFChange(etfMinuteBars, 'SPY', date, checkKey);
      const spyAligned = (direction === 'CALL' && spyChange > 0) || (direction === 'PUT' && spyChange < 0);

      // Confidence
      let confidence = 60;
      if (candleAnalysis.type.includes('MARUBOZU')) confidence += 6;
      else if (candleAnalysis.type.includes('STRONG')) confidence += 4;
      else confidence += 2;
      if (isHammer || engulfing) confidence += 4;
      // Volume decline bonus
      const volBars = bars.slice(-10);
      const firstHalf = volBars.slice(0, 5);
      const secondHalf = volBars.slice(-5);
      const firstVol = firstHalf.reduce((s, b) => s + (b.v || 0), 0);
      const secondVol = secondHalf.reduce((s, b) => s + (b.v || 0), 0);
      const volDeclineRatio = firstVol > 0 ? secondVol / firstVol : 1;
      if (volDeclining && volDeclineRatio < 0.6) confidence += 5;
      else if (volDeclining) confidence += 3;
      else confidence += 1;
      if (spyAligned) confidence += 3;
      if (distPct >= 0.0015 && distPct <= 0.0025) confidence += 3;
      confidence += Math.max(0, confluenceResult.confirming * 2);
      confidence -= confluenceResult.opposing * 2;
      if (confluenceResult.pass) confidence += 3; // bonus for 2+ confluence
      confidence = Math.max(60, Math.min(95, confidence));

      // Stop: 0.3 ATR beyond VWAP (scales with stock price/volatility)
      const atr = profile.atr_20d || 0.025;
      const atrDollar = atr * currentPrice;
      const stopDistance = 0.3 * atrDollar;
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
      const _vbEnrich = enrichMetadata(bars, ticker, date, currentPrice, vwap, bars[0]?.o || null, atrDollar, etfMinuteBars, checkKey);
      signals.push(buildSignal('VWAP_BOUNCE', date, checkKey, ticker, direction, confidence, currentPrice, stopPrice, targetPrice, profile, {
        vwap_price: +vwap.toFixed(2),
        vwap_distance_pct: +(distPct * 100).toFixed(2),
        volume_declining: volDeclining,
        volume_decline_ratio: +volDeclineRatio.toFixed(2),
        candle_type: candleAnalysis.type,
        engulfing,
        is_hammer: isHammer,
        spy_aligned: spyAligned,
        confluence: confluenceResult.confirming,
        ..._vbEnrich,
      }));
      break;
    }
  }

  if (diag.checks > 0 && signals.length === 0) {
    console.log(`[DIAG] VWAP_BOUNCE ${date}: checks=${diag.checks} noVwap=${diag.noVwap} distFail=${diag.distFail} noCross=${diag.noCross} volFail=${diag.volFail} candleFail=${diag.candleFail} passed=${diag.passed}`);
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
  const diag = { checks: 0, noMomentum: 0, noPullback: 0, deepPB: 0, vwapFail: 0, passed: 0 };

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

      diag.checks++;
      const currentPrice = bars[bars.length - 1].c;

      // Momentum check: need >= 0.3 ATR move from open (relaxed from 0.5)
      const moveFromOpen = currentPrice - sessionOpen;
      const moveATRs = Math.abs(moveFromOpen) / atrDollar;
      if (moveATRs < 0.3) { diag.noMomentum++; continue; }

      const direction = moveFromOpen > 0 ? 'CALL' : 'PUT';

      // Detect first pullback
      const pullback = detectPullback(bars, direction, atrDollar);
      if (!pullback.detected) { diag.noPullback++; continue; }

      // Pullback depth check: must retrace < 50% of the initial move
      // Deeper retracement = trend exhaustion, not profit-taking pause
      const moveExtreme = direction === 'CALL'
        ? Math.max(...bars.map(b => b.h))
        : Math.min(...bars.map(b => b.l));
      const totalMove = Math.abs(moveExtreme - sessionOpen);
      const pullbackDepth = direction === 'CALL'
        ? moveExtreme - pullback.pullbackLow
        : pullback.pullbackHigh - moveExtreme;
      if (totalMove > 0 && pullbackDepth / totalMove > 0.62) { diag.deepPB++; continue; } // Relaxed from 0.50

      // VWAP alignment (soft -- momentum + pullback is the thesis)
      const vwap = computeVWAP(bars);
      const vwapAligned = (direction === 'CALL' && currentPrice > vwap) || (direction === 'PUT' && currentPrice < vwap);
      diag.passed++;

      // SPY alignment
      const spyChange = getETFChange(etfMinuteBars, 'SPY', date, checkKey);
      const spyAligned = (direction === 'CALL' && spyChange > 0) || (direction === 'PUT' && spyChange < 0);

      // Confluence (minFactors: 2 -- momentum + pullback + VWAP + SPY already filter heavily)
      const confluenceResult = checkConfluence(bars, direction, { vwap, currentPrice }, { minFactors: 2 });

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
      if (vwapAligned) confidence += 3; // VWAP bonus (soft)
      confidence += Math.max(0, confluenceResult.confirming * 2);
      confidence -= confluenceResult.opposing * 2;
      if (confluenceResult.pass) confidence += 4; // first pullback bonus
      else confidence += 2;
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
      const _fpEnrich = enrichMetadata(bars, ticker, date, currentPrice, vwap, sessionOpen, atrDollar, etfMinuteBars, checkKey);
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
        ..._fpEnrich,
      }));
      break;
    }
  }

  if (diag.checks > 0 && signals.length === 0) {
    console.log(`[DIAG] FIRST_PULLBACK ${date}: checks=${diag.checks} noMomentum=${diag.noMomentum} noPullback=${diag.noPullback} deepPB=${diag.deepPB} vwapFail=${diag.vwapFail} passed=${diag.passed}`);
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

    // Stop: 0.5 ATR for reversion, 0.75 ATR for continuation (wider due to gap volatility)
    const stopATR = logicType === 'CONTINUATION' ? 0.75 : 0.5;
    const stopPrice = direction === 'CALL'
      ? +(currentPrice - stopATR * atrDollar).toFixed(2)
      : +(currentPrice + stopATR * atrDollar).toFixed(2);

    // Target: gap fill (prev close) or 2:1 R:R
    const risk = stopATR * atrDollar;
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
    const _gfEnrich = enrichMetadata(bars, ticker, date, currentPrice, vwap, sessionOpen, atrDollar, etfMinuteBars, checkKey);
    signals.push(buildSignal('GAP_FILL_REVERSION', date, checkKey, ticker, direction, confidence, currentPrice, stopPrice, targetPrice, profile, {
      gap_pct: +(gapPct * 100).toFixed(2),
      logic_type: logicType,
      candle_type: candleAnalysis.type,
      engulfing,
      volume_ratio: +volRatio.toFixed(2),
      spy_aligned: spyAligned,
      vwap_aligned: vwap > 0,
      confluence: confluenceResult.confirming,
      exitOverrides: { momentumStall: true },
      ..._gfEnrich,
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
  const diag = { tickers: 0, noKeys: 0, noTrend: 0, noVwap: 0, reversal: 0, noSpy: 0, passed: 0 };

  const CHECK_OFFSET = 330;

  for (const ticker of tickers) {
    const profile = profiles[ticker];
    if (!profile) continue;

    const allKeys = getMinuteKeys(minuteBars, ticker, date);
    if (allKeys.length <= CHECK_OFFSET) { diag.noKeys++; continue; }
    diag.tickers++;

    const tickerMinutes = minuteBars[ticker] || {};
    const sessionOpen = tickerMinutes[allKeys[0]]?.o;
    if (!sessionOpen) continue;

    const checkKey = allKeys[CHECK_OFFSET];
    const bars = getBarsUpTo(minuteBars, ticker, date, checkKey);
    if (bars.length < 30) continue;

    const currentPrice = bars[bars.length - 1].c;
    const atr = profile.atr_20d || 0.025;
    const atrDollar = atr * currentPrice;

    // Intraday trend check: >= 0.2 ATR (relaxed from 0.3)
    const intradayMove = currentPrice - sessionOpen;
    const moveATRs = Math.abs(intradayMove) / atrDollar;
    if (moveATRs < 0.2) { diag.noTrend++; continue; }

    const direction = intradayMove > 0 ? 'CALL' : 'PUT';

    // VWAP confirming
    const vwap = computeVWAP(bars);
    if (!vwap || vwap <= 0) { diag.noVwap++; continue; }
    if (direction === 'CALL' && currentPrice <= vwap) { diag.noVwap++; continue; }
    if (direction === 'PUT' && currentPrice >= vwap) { diag.noVwap++; continue; }

    // ── Micro-trend structure (last 5 bars) ──
    // The edge at power hour is CONTINUATION. Last 5 bars must show directional structure.
    // CALL: higher lows (each bar's low >= prev bar's low). PUT: lower highs.
    const last5 = bars.slice(-5);
    let microTrendBars = 0;
    for (let t = 1; t < last5.length; t++) {
      if (direction === 'CALL' && last5[t].l >= last5[t - 1].l) microTrendBars++;
      if (direction === 'PUT' && last5[t].h <= last5[t - 1].h) microTrendBars++;
    }
    const hasMicroTrend = microTrendBars >= 3; // 3 of 4 pairs must confirm
    if (microTrendBars < 2) { diag.reversal++; continue; } // hard gate: at least 2

    // Reversal bar count in last 10 bars
    const last10 = bars.slice(-10);
    const reversalThreshold = 0.2 * atrDollar;
    let reversalCount = 0;
    for (const bar of last10) {
      const barMove = bar.c - bar.o;
      if (direction === 'CALL' && barMove < -reversalThreshold) reversalCount++;
      if (direction === 'PUT' && barMove > reversalThreshold) reversalCount++;
    }
    if (reversalCount >= 5) { diag.reversal++; continue; }

    // ── Bar-over-bar volume check (last 3 bars) ──
    // Power hour moves that work have volume stepping up. Coarse block comparison misses this.
    const last3 = bars.slice(-3);
    let volSteppingUp = 0;
    for (let t = 1; t < last3.length; t++) {
      if ((last3[t].v || 0) > (last3[t - 1].v || 0)) volSteppingUp++;
    }
    const hasVolStep = volSteppingUp >= 1; // at least 1 of 2 steps increasing

    // Consolidation/flag pattern: last 15 bars range
    const last15 = bars.slice(-15);
    const consolHigh = Math.max(...last15.map(b => b.h));
    const consolLow = Math.min(...last15.map(b => b.l));
    const consolRange = consolHigh - consolLow;
    const hasConsolidation = consolRange < 0.3 * atrDollar;

    // ── Breakout from consolidation ──
    // Current bar should be at or near session extreme (not mid-range)
    const sessionHigh = Math.max(...bars.map(b => b.h));
    const sessionLow = Math.min(...bars.map(b => b.l));
    const sessionRange = sessionHigh - sessionLow;
    const atExtreme = sessionRange > 0 && (
      (direction === 'CALL' && (currentPrice - sessionLow) / sessionRange >= 0.75) ||
      (direction === 'PUT' && (sessionHigh - currentPrice) / sessionRange >= 0.75)
    );

    // Volume block comparison (kept for context)
    const prior15 = bars.slice(-30, -15);
    const last15Vol = last15.reduce((s, b) => s + (b.v || 0), 0) / last15.length;
    const prior15Vol = prior15.length > 0 ? prior15.reduce((s, b) => s + (b.v || 0), 0) / prior15.length : last15Vol;
    const volTrend = prior15Vol > 0 ? last15Vol / prior15Vol : 1;

    // SPY alignment (soft bonus)
    const spyChange = getETFChange(etfMinuteBars, 'SPY', date, checkKey);
    const spyAligned = (direction === 'CALL' && spyChange > 0) || (direction === 'PUT' && spyChange < 0);
    diag.passed++;

    // Confluence
    const confluenceResult = checkConfluence(bars, direction, { vwap, currentPrice }, { minFactors: 2 });

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

    // Confidence -- now rewards micro-trend quality, bar-over-bar volume, and position at extreme
    let confidence = 60;
    if (candleAnalysis.type.includes('MARUBOZU')) confidence += 6;
    else if (candleAnalysis.type.includes('STRONG')) confidence += 4;
    else confidence += 2;
    if (engulfing) confidence += 4;
    if (volTrend >= 1.3) confidence += 3;
    else if (volTrend >= 1.0) confidence += 1;
    if (hasVolStep) confidence += 3; // NEW: bar-over-bar volume stepping up
    if (spyAligned) confidence += 3;
    confidence += 3; // VWAP aligned
    if (reversalCount === 0) confidence += 2;
    confidence += Math.max(0, confluenceResult.confirming * 2);
    confidence -= confluenceResult.opposing * 2;
    if (moveATRs >= 0.5) confidence += 4;
    else confidence += 2;
    if (hasConsolidation) confidence += 2;
    if (hasMicroTrend) confidence += 4; // NEW: strong micro-trend structure
    if (atExtreme) confidence += 3; // NEW: at session extreme = real breakout
    if (confluenceResult.pass) confidence += 2;
    confidence = Math.max(60, Math.min(95, confidence));

    // Stop: below consolidation low/high. Target: 2:1 R:R.
    const stopPrice = direction === 'CALL'
      ? +consolLow.toFixed(2)
      : +consolHigh.toFixed(2);
    const risk = Math.abs(currentPrice - (direction === 'CALL' ? consolLow : consolHigh));
    const targetPrice = direction === 'CALL'
      ? +(currentPrice + Math.max(risk, 0.1 * atrDollar) * 2).toFixed(2)
      : +(currentPrice - Math.max(risk, 0.1 * atrDollar) * 2).toFixed(2);

    const _phEnrich = enrichMetadata(bars, ticker, date, currentPrice, vwap, sessionOpen, atrDollar, etfMinuteBars, checkKey);
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
      ..._phEnrich,
    }));
  }

  if (diag.tickers > 0 && signals.length === 0) {
    console.log(`[DIAG] POWER_HOUR ${date}: tickers=${diag.tickers} noKeys=${diag.noKeys} noTrend=${diag.noTrend} noVwap=${diag.noVwap} reversal=${diag.reversal} noSpy=${diag.noSpy} passed=${diag.passed}`);
  }
  // Cap at top 5
  signals.sort((a, b) => b.composite - a.composite);
  return signals.slice(0, 5);
}

// SR_BOUNCE removed -- no academic citation, fixed $0.12 stop bug, simplistic direction logic.

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
      const _mrEnrich = enrichMetadata(bars, ticker, date, currentPrice, vwap, sessionOpen, atrDollar, etfMinuteBars, checkKey);
      const sig = buildSignal('MACRO_REACTION', date, checkKey, ticker, consensusDirection, confidence, currentPrice, stopPrice, targetPrice, profile, {
        macro_event: macroEvent,
        beta: +beta.toFixed(2),
        spy_change_pct: +(spyChange * 100).toFixed(2),
        qqq_change_pct: +(qqqChange * 100).toFixed(2),
        consensus_pct: +(consensusPct * 100).toFixed(2),
        candle_type: candleAnalysis.type,
        engulfing,
        confluence: confluenceResult.confirming,
        ..._mrEnrich,
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

// ── New Day Trade Strategies ────────────────────────────────────────────────

/**
 * EXTREME_REVERSAL
 *
 * Edge: Intraday overreaction mean reversion. Brogaard, Han & Kim 2024 (162.3% annualized).
 * Stocks that move > 2 ATR intraday by midday tend to revert.
 * Time: Check at offsets 120, 150, 180 (11:30 AM - 12:30 PM).
 */
export function generateExtremeReversalSignals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, dailyBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];
  const seen = new Set();

  const CHECK_OFFSETS = [120, 150, 180];

  for (const ticker of tickers) {
    if (seen.has(ticker)) continue;
    const profile = profiles[ticker];
    if (!profile) continue;

    const allKeys = getMinuteKeys(minuteBars, ticker, date);
    if (allKeys.length < 120) continue;

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
      if (bars.length < 30) continue;

      const currentPrice = bars[bars.length - 1].c;
      const moveFromOpen = currentPrice - sessionOpen;
      const moveATRs = Math.abs(moveFromOpen) / atrDollar;

      // Must have moved > 1.0 ATR from open (extreme move)
      if (moveATRs < 1.0) continue;

      // Reversal direction: if stock dropped 2+ ATR, buy CALL (mean reversion up)
      const direction = moveFromOpen < 0 ? 'CALL' : 'PUT';

      // Reversal candle confirmation
      const candleAnalysis = analyzeCandle(bars[bars.length - 1]);
      const barMove = bars[bars.length - 1].c - bars[bars.length - 1].o;
      const isReversalBar = (direction === 'CALL' && barMove > 0) || (direction === 'PUT' && barMove < 0);
      if (!isReversalBar) continue;

      // Volume should still be elevated (liquidity provision opportunity)
      const recentVol = bars.slice(-5).reduce((s, b) => s + (b.v || 0), 0) / 5;
      const earlyVol = bars.slice(0, 10).reduce((s, b) => s + (b.v || 0), 0) / 10;
      const volRatio = earlyVol > 0 ? recentVol / earlyVol : 1;

      // Engulfing
      let engulfing = false;
      if (bars.length >= 2) {
        const engulfResult = direction === 'CALL'
          ? detectBullishEngulfing(bars.slice(-2))
          : detectBearishEngulfing(bars.slice(-2));
        engulfing = engulfResult.detected;
      }

      // VWAP -- for reversal, price should be on the extended side of VWAP
      const vwap = computeVWAP(bars);

      // Confluence (use minFactors: 2 for extreme reversal -- thesis is the extreme move itself)
      const confluenceResult = checkConfluence(bars, direction, { vwap, currentPrice }, { minFactors: 2 });

      // Confidence
      let confidence = 60;
      if (candleAnalysis.type.includes('MARUBOZU')) confidence += 6;
      else if (candleAnalysis.type.includes('STRONG')) confidence += 4;
      else confidence += 2;
      if (engulfing) confidence += 4;
      if (volRatio >= 0.8) confidence += 3; // still has volume
      if (moveATRs >= 2.5) confidence += 5; // more extreme = stronger reversion
      else confidence += 3;
      if (confluenceResult.pass) confidence += confluenceResult.confirming * 2;
      confidence -= (confluenceResult.opposing || 0) * 2;
      confidence += 4; // extreme reversal bonus
      confidence = Math.max(60, Math.min(95, confidence));

      // Stop: 0.5 ATR beyond the extreme (let the move exhaust)
      const extremePrice = direction === 'CALL'
        ? Math.min(...bars.map(b => b.l))
        : Math.max(...bars.map(b => b.h));
      const stopPrice = direction === 'CALL'
        ? +(extremePrice - 0.5 * atrDollar).toFixed(2)
        : +(extremePrice + 0.5 * atrDollar).toFixed(2);

      // Target: 50% retracement of the extreme move
      const retracementTarget = sessionOpen + moveFromOpen * 0.5;
      const targetPrice = +retracementTarget.toFixed(2);

      seen.add(ticker);
      const _erEnrich = enrichMetadata(bars, ticker, date, currentPrice, vwap, sessionOpen, atrDollar, etfMinuteBars, checkKey);
      signals.push(buildSignal('EXTREME_REVERSAL', date, checkKey, ticker, direction, confidence, currentPrice, stopPrice, targetPrice, profile, {
        move_from_open_atrs: +moveATRs.toFixed(2),
        move_from_open_pct: +((moveFromOpen / sessionOpen) * 100).toFixed(2),
        candle_type: candleAnalysis.type,
        engulfing,
        volume_ratio: +volRatio.toFixed(2),
        confluence: confluenceResult.confirming || 0,
        ..._erEnrich,
      }));
      break;
    }
  }

  // Cap at top 5
  signals.sort((a, b) => b.composite - a.composite);
  return signals.slice(0, 5);
}

/**
 * EOD_MEAN_REVERSION
 *
 * Edge: End-of-day reversal. Baltussen, Da & Soebhag 2024 (0.24%/day in last 30 min).
 * Intraday losers bounce 3:30-4:00 PM due to retail attention + short covering.
 * Time: Single check at offset 360 (3:30 PM).
 */
export function generateEODMeanReversionSignals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, dailyBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];

  const CHECK_OFFSET = 360; // 3:30 PM

  // Collect all tickers with their intraday returns
  const candidates = [];

  for (const ticker of tickers) {
    const profile = profiles[ticker];
    if (!profile) continue;

    const allKeys = getMinuteKeys(minuteBars, ticker, date);
    if (allKeys.length <= CHECK_OFFSET) continue;

    const tickerMinutes = minuteBars[ticker] || {};
    const sessionOpen = tickerMinutes[allKeys[0]]?.o;
    if (!sessionOpen) continue;

    const checkKey = allKeys[CHECK_OFFSET];
    const currentPrice = tickerMinutes[checkKey]?.c;
    if (!currentPrice) continue;

    const intradayReturn = (currentPrice - sessionOpen) / sessionOpen;
    const atr = profile.atr_20d || 0.025;
    const atrDollar = atr * currentPrice;

    candidates.push({ ticker, profile, intradayReturn, currentPrice, sessionOpen, checkKey, atr, atrDollar, allKeys });
  }

  // Sort by intraday return -- biggest losers first (these are the reversal candidates)
  candidates.sort((a, b) => a.intradayReturn - b.intradayReturn);

  // Take bottom 20% (biggest losers) for CALL reversal
  const bottomN = Math.max(2, Math.floor(candidates.length * 0.20));
  const losers = candidates.slice(0, bottomN);

  // Also take top 20% (biggest winners) for PUT reversal
  const topN = Math.max(2, Math.floor(candidates.length * 0.20));
  const winners = candidates.slice(-topN);

  const reversalCandidates = [
    ...losers.map(c => ({ ...c, direction: 'CALL' })),
    ...winners.map(c => ({ ...c, direction: 'PUT' })),
  ];

  for (const cand of reversalCandidates) {
    const { ticker, profile, direction, currentPrice, checkKey, atr, atrDollar, allKeys, intradayReturn } = cand;

    // Must have moved meaningfully (> 0.5% intraday) to be a reversal candidate
    if (Math.abs(intradayReturn) < 0.005) continue;

    const bars = getBarsUpTo(minuteBars, ticker, date, checkKey);
    if (bars.length < 30) continue;

    const vwap = computeVWAP(bars);
    const candleAnalysis = analyzeCandle(bars[bars.length - 1]);

    // Engulfing
    let engulfing = false;
    if (bars.length >= 2) {
      const engulfResult = direction === 'CALL'
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
    // Bigger intraday move = stronger reversal signal
    if (Math.abs(intradayReturn) >= 0.03) confidence += 5;
    else if (Math.abs(intradayReturn) >= 0.02) confidence += 3;
    else confidence += 2;
    confidence += 4; // EOD reversal bonus (academic edge)
    confidence = Math.max(60, Math.min(95, confidence));

    // Stop: 0.3 ATR (tight -- only 25 min hold)
    const stopPrice = direction === 'CALL'
      ? +(currentPrice - 0.3 * atrDollar).toFixed(2)
      : +(currentPrice + 0.3 * atrDollar).toFixed(2);

    // Target: 0.5 ATR reversion (capturing the last-30-min bounce)
    const targetPrice = direction === 'CALL'
      ? +(currentPrice + 0.5 * atrDollar).toFixed(2)
      : +(currentPrice - 0.5 * atrDollar).toFixed(2);

    const _eodEnrich = enrichMetadata(bars, ticker, date, currentPrice, vwap, bars[0]?.o || null, atrDollar, etfMinuteBars, checkKey);
    signals.push(buildSignal('EOD_MEAN_REVERSION', date, checkKey, ticker, direction, confidence, currentPrice, stopPrice, targetPrice, profile, {
      intraday_return_pct: +(intradayReturn * 100).toFixed(2),
      candle_type: candleAnalysis.type,
      engulfing,
      confluence: 0,
      ..._eodEnrich,
    }));
  }

  // Cap at top 5
  signals.sort((a, b) => b.composite - a.composite);
  return signals.slice(0, 5);
}

/**
 * HIGH_RVOL_BREAKOUT
 *
 * Edge: High relative volume = attention premium + directional signal.
 * Gervais, Kaniel & Mingelgrin 2001 (JoF) + Zarattini et al. 2024 "Stocks in Play".
 * Time: Offsets 30-60 (10:00-10:30 AM). Requires 2x+ RVOL in first 30 min.
 */
export function generateHighRvolBreakoutSignals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, dailyBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];
  const seen = new Set();

  for (const ticker of tickers) {
    if (seen.has(ticker)) continue;
    const profile = profiles[ticker];
    if (!profile) continue;

    const allKeys = getMinuteKeys(minuteBars, ticker, date);
    if (allKeys.length < 60) continue;

    const tickerMinutes = minuteBars[ticker] || {};
    const sessionOpen = tickerMinutes[allKeys[0]]?.o;
    if (!sessionOpen) continue;

    // Check relative volume in first 30 bars
    let first30Vol = 0;
    for (let i = 0; i < 30 && i < allKeys.length; i++) {
      first30Vol += tickerMinutes[allKeys[i]]?.v || 0;
    }
    const avgDailyVol = profile.avg_volume_20d || profile.avg_volume || 0;
    // First 30 min is ~25% of daily volume normally
    const expectedFirst30Vol = avgDailyVol * 0.25;
    if (expectedFirst30Vol <= 0) continue;
    const rvol = first30Vol / expectedFirst30Vol;
    if (rvol < 1.5) continue; // Must be 1.5x+ relative volume

    const atr = profile.atr_20d || 0.025;
    const atrDollar = atr * sessionOpen;

    // Check for directional breakout at offset 30-60
    for (let offset = 30; offset <= Math.min(60, allKeys.length - 1); offset += 5) {
      if (seen.has(ticker)) break;

      const checkKey = allKeys[offset];
      const bars = getBarsUpTo(minuteBars, ticker, date, checkKey);
      if (bars.length < 20) continue;

      const currentPrice = bars[bars.length - 1].c;
      const moveFromOpen = currentPrice - sessionOpen;
      const moveATRs = Math.abs(moveFromOpen) / atrDollar;

      // Need meaningful directional move (>= 0.3 ATR)
      if (moveATRs < 0.3) continue;

      const direction = moveFromOpen > 0 ? 'CALL' : 'PUT';

      // VWAP alignment (soft bonus)
      const vwap = computeVWAP(bars);
      const vwapAligned = (direction === 'CALL' && currentPrice > vwap) || (direction === 'PUT' && currentPrice < vwap);

      // SPY alignment
      const spyChange = getETFChange(etfMinuteBars, 'SPY', date, checkKey);
      const spyAligned = (direction === 'CALL' && spyChange > 0) || (direction === 'PUT' && spyChange < 0);

      // Candle quality
      const candleAnalysis = analyzeCandle(bars[bars.length - 1]);

      // Engulfing
      let engulfing = false;
      if (bars.length >= 2) {
        const engulfResult = direction === 'CALL'
          ? detectBullishEngulfing(bars.slice(-2))
          : detectBearishEngulfing(bars.slice(-2));
        engulfing = engulfResult.detected;
      }

      // Confluence (soft)
      const confluenceResult = checkConfluence(bars, direction, { vwap, currentPrice }, { minFactors: 2 });

      // Confidence
      let confidence = 60;
      if (candleAnalysis.type.includes('MARUBOZU')) confidence += 6;
      else if (candleAnalysis.type.includes('STRONG')) confidence += 4;
      else confidence += 2;
      if (engulfing) confidence += 4;
      if (rvol >= 3.0) confidence += 5;
      else confidence += 3;
      if (spyAligned) confidence += 3;
      if (vwapAligned) confidence += 3; // VWAP soft bonus
      confidence += Math.max(0, confluenceResult.confirming * 2);
      confidence -= confluenceResult.opposing * 2;
      confidence += 4; // high RVOL bonus
      if (confluenceResult.pass) confidence += 3;
      confidence = Math.max(60, Math.min(95, confidence));

      // Stop: below first-30-min low/high
      const first30Bars = bars.slice(0, 30);
      const first30High = Math.max(...first30Bars.map(b => b.h));
      const first30Low = Math.min(...first30Bars.map(b => b.l));
      const stopPrice = direction === 'CALL'
        ? +first30Low.toFixed(2)
        : +first30High.toFixed(2);

      // Target: 1.5x risk
      const risk = Math.abs(currentPrice - stopPrice);
      const targetPrice = direction === 'CALL'
        ? +(currentPrice + risk * 1.5).toFixed(2)
        : +(currentPrice - risk * 1.5).toFixed(2);

      seen.add(ticker);
      const _hrEnrich = enrichMetadata(bars, ticker, date, currentPrice, vwap, sessionOpen, atrDollar, etfMinuteBars, checkKey);
      signals.push(buildSignal('HIGH_RVOL_BREAKOUT', date, checkKey, ticker, direction, confidence, currentPrice, stopPrice, targetPrice, profile, {
        rvol: +rvol.toFixed(2),
        move_from_open_atrs: +moveATRs.toFixed(2),
        candle_type: candleAnalysis.type,
        engulfing,
        spy_aligned: spyAligned,
        confluence: confluenceResult.confirming,
        ..._hrEnrich,
      }));
      break;
    }
  }

  // Cap at top 5
  signals.sort((a, b) => b.composite - a.composite);
  return signals.slice(0, 5);
}

// ── New Swing Trade Strategies ──────────────────────────────────────────────

/**
 * PEAD_DRIFT
 *
 * Edge: Post-earnings announcement drift. Battalio & Mendenhall 2007 (14%/yr after costs).
 * Enter direction of earnings surprise 15-30 min after open on earnings day.
 * Hold 1-3 days.
 */
export function generatePEADDriftSignals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, dailyBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];

  // Check for earnings events (earningsCalendar from strategy-data-loader)
  // earningsCalendar[date] is an ARRAY of tickers like ['AAPL', 'MSFT'], not an object keyed by ticker
  const earningsToday = context.earningsCalendar?.[date] || context.earningsEvents?.[date] || [];

  for (const ticker of tickers) {
    // earningsToday may be an array (earningsCalendar) or object (earningsEvents fallback)
    const hasEarnings = Array.isArray(earningsToday)
      ? earningsToday.includes(ticker)
      : !!earningsToday?.[ticker];
    if (!hasEarnings) continue; // Only trade on earnings days

    const profile = profiles[ticker];
    if (!profile) continue;

    const allKeys = getMinuteKeys(minuteBars, ticker, date);
    if (allKeys.length < 45) continue;

    const tickerMinutes = minuteBars[ticker] || {};
    const sessionOpen = tickerMinutes[allKeys[0]]?.o;
    if (!sessionOpen) continue;

    const prevBar = findPrevDayBar(dailyBars, ticker, date);
    if (!prevBar) continue;

    // Gap from prev close reveals earnings surprise direction
    const gapPct = (sessionOpen - prevBar.c) / prevBar.c;
    if (Math.abs(gapPct) < 0.02) continue; // Need meaningful gap (2%+)

    const direction = gapPct > 0 ? 'CALL' : 'PUT';

    // Check at offset 30 (30 min after open -- let noise settle)
    const checkOffset = Math.min(30, allKeys.length - 1);
    const checkKey = allKeys[checkOffset];
    const bars = getBarsUpTo(minuteBars, ticker, date, checkKey);
    if (bars.length < 15) continue;

    const currentPrice = bars[bars.length - 1].c;
    const atr = profile.atr_20d || 0.025;
    const atrDollar = atr * currentPrice;

    // Drift confirmation: price should be continuing in gap direction
    const driftFromOpen = (currentPrice - sessionOpen) / sessionOpen;
    const driftAligned = (direction === 'CALL' && driftFromOpen > 0) || (direction === 'PUT' && driftFromOpen < 0);
    if (!driftAligned) continue; // Gap reversal, not drift

    const vwap = computeVWAP(bars);
    const candleAnalysis = analyzeCandle(bars[bars.length - 1]);

    // Engulfing
    let engulfing = false;
    if (bars.length >= 2) {
      const engulfResult = direction === 'CALL'
        ? detectBullishEngulfing(bars.slice(-2))
        : detectBearishEngulfing(bars.slice(-2));
      engulfing = engulfResult.detected;
    }

    // Volume should be elevated (earnings day)
    let first30Vol = 0;
    for (let i = 0; i < 30 && i < allKeys.length; i++) {
      first30Vol += tickerMinutes[allKeys[i]]?.v || 0;
    }
    const avgDailyVol = profile.avg_volume_20d || profile.avg_volume || 0;
    const volRatio = avgDailyVol > 0 ? first30Vol / (avgDailyVol * 0.25) : 1;

    // Confidence
    let confidence = 60;
    if (candleAnalysis.type.includes('MARUBOZU')) confidence += 6;
    else if (candleAnalysis.type.includes('STRONG')) confidence += 4;
    else confidence += 2;
    if (engulfing) confidence += 4;
    if (volRatio >= 2.0) confidence += 5;
    else if (volRatio >= 1.5) confidence += 3;
    // Bigger gap = stronger surprise = more drift
    if (Math.abs(gapPct) >= 0.05) confidence += 5;
    else if (Math.abs(gapPct) >= 0.03) confidence += 3;
    else confidence += 2;
    confidence += 4; // PEAD academic bonus
    confidence = Math.max(60, Math.min(95, confidence));

    // Stop: 1.0 ATR (wider for multi-day hold)
    const stopPrice = direction === 'CALL'
      ? +(currentPrice - 1.0 * atrDollar).toFixed(2)
      : +(currentPrice + 1.0 * atrDollar).toFixed(2);

    // Target: 2.0 ATR (drift continues over days)
    const targetPrice = direction === 'CALL'
      ? +(currentPrice + 2.0 * atrDollar).toFixed(2)
      : +(currentPrice - 2.0 * atrDollar).toFixed(2);

    const _pdEnrich = enrichMetadata(bars, ticker, date, currentPrice, vwap, sessionOpen, atrDollar, etfMinuteBars, checkKey);
    signals.push(buildSignal('PEAD_DRIFT', date, checkKey, ticker, direction, confidence, currentPrice, stopPrice, targetPrice, profile, {
      gap_pct: +(gapPct * 100).toFixed(2),
      drift_from_open_pct: +(driftFromOpen * 100).toFixed(2),
      volume_ratio: +volRatio.toFixed(2),
      candle_type: candleAnalysis.type,
      engulfing,
      confluence: 0,
      ..._pdEnrich,
    }));
  }

  // Cap at top 3
  signals.sort((a, b) => b.composite - a.composite);
  return signals.slice(0, 3);
}

/**
 * SECTOR_LAGGARD
 *
 * Edge: Sector ETF → constituent price discovery lag. Ernst 2022; Gatev et al. 2006 RFS.
 * Stub: activates when sector mapping data is available in context.sectorMap.
 */
export function generateSectorLaggardSignals(date, dayData, context) {
  const { minuteBars, etfMinuteBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];

  // Requires sector ETF mapping data
  const sectorMap = context.sectorMap;
  if (!sectorMap || Object.keys(sectorMap).length === 0) return signals;

  const CHECK_OFFSET = 60; // 10:30 AM -- let sector move establish

  for (const [sectorETF, constituents] of Object.entries(sectorMap)) {
    const etfKeys = getMinuteKeys(etfMinuteBars, sectorETF, date);
    if (etfKeys.length <= CHECK_OFFSET) continue;

    const etfBars = getBarsUpTo(etfMinuteBars, sectorETF, date, etfKeys[CHECK_OFFSET]);
    if (etfBars.length < 30) continue;

    const etfOpen = etfBars[0].o;
    const etfCurrent = etfBars[etfBars.length - 1].c;
    const etfReturn = (etfCurrent - etfOpen) / etfOpen;

    // Need meaningful sector move (>= 0.5%)
    if (Math.abs(etfReturn) < 0.005) continue;

    const sectorDirection = etfReturn > 0 ? 'CALL' : 'PUT';

    for (const ticker of constituents) {
      if (!tickers.includes(ticker)) continue;
      const profile = profiles[ticker];
      if (!profile) continue;

      const allKeys = getMinuteKeys(minuteBars, ticker, date);
      if (allKeys.length <= CHECK_OFFSET) continue;

      const tickerMinutes = minuteBars[ticker] || {};
      const tickerOpen = tickerMinutes[allKeys[0]]?.o;
      if (!tickerOpen) continue;

      const checkKey = allKeys[CHECK_OFFSET];
      const tickerCurrent = tickerMinutes[checkKey]?.c;
      if (!tickerCurrent) continue;

      const tickerReturn = (tickerCurrent - tickerOpen) / tickerOpen;

      // Laggard: ticker hasn't moved with sector (lag > 50% of sector move)
      const lagRatio = Math.abs(etfReturn) > 0 ? tickerReturn / etfReturn : 0;
      if (lagRatio > 0.5) continue; // Already moved with sector, not a laggard

      const bars = getBarsUpTo(minuteBars, ticker, date, checkKey);
      const vwap = computeVWAP(bars);
      const atr = profile.atr_20d || 0.025;
      const atrDollar = atr * tickerCurrent;
      const candleAnalysis = analyzeCandle(bars[bars.length - 1]);

      // Confidence
      let confidence = 60;
      if (candleAnalysis.type.includes('STRONG')) confidence += 4;
      else confidence += 2;
      if (Math.abs(etfReturn) >= 0.01) confidence += 5;
      else confidence += 3;
      if (lagRatio < 0.2) confidence += 4; // very lagged
      else confidence += 2;
      confidence += 3; // sector lag bonus
      confidence = Math.max(60, Math.min(95, confidence));

      // Stop: 0.75 ATR
      const stopPrice = sectorDirection === 'CALL'
        ? +(tickerCurrent - 0.75 * atrDollar).toFixed(2)
        : +(tickerCurrent + 0.75 * atrDollar).toFixed(2);

      // Target: 1.5 ATR
      const targetPrice = sectorDirection === 'CALL'
        ? +(tickerCurrent + 1.5 * atrDollar).toFixed(2)
        : +(tickerCurrent - 1.5 * atrDollar).toFixed(2);

      const _slEnrich = enrichMetadata(bars, ticker, date, tickerCurrent, vwap, tickerOpen, atrDollar, etfMinuteBars, checkKey);
      signals.push(buildSignal('SECTOR_LAGGARD', date, checkKey, ticker, sectorDirection, confidence, tickerCurrent, stopPrice, targetPrice, profile, {
        sector_etf: sectorETF,
        sector_return_pct: +(etfReturn * 100).toFixed(2),
        ticker_return_pct: +(tickerReturn * 100).toFixed(2),
        lag_ratio: +lagRatio.toFixed(2),
        candle_type: candleAnalysis.type,
        confluence: 0,
        ..._slEnrich,
      }));
    }
  }

  signals.sort((a, b) => b.composite - a.composite);
  return signals.slice(0, 5);
}

/**
 * SHORT_SQUEEZE_MOMENTUM
 *
 * Edge: High short interest + catalyst = forced covering. Schultz 2024 JFQA.
 * Stub: activates when short interest data is available in context.shortInterest.
 */
export function generateShortSqueezeSignals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, dailyBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];

  // Requires short interest data
  const shortInterest = context.shortInterest;
  if (!shortInterest || Object.keys(shortInterest).length === 0) return signals;

  const CHECK_OFFSET = 30;

  for (const ticker of tickers) {
    const si = shortInterest[ticker];
    if (!si || si.short_pct < 0.15) continue; // Need 15%+ short interest

    const profile = profiles[ticker];
    if (!profile) continue;

    const allKeys = getMinuteKeys(minuteBars, ticker, date);
    if (allKeys.length <= CHECK_OFFSET) continue;

    const tickerMinutes = minuteBars[ticker] || {};
    const sessionOpen = tickerMinutes[allKeys[0]]?.o;
    if (!sessionOpen) continue;

    const checkKey = allKeys[CHECK_OFFSET];
    const bars = getBarsUpTo(minuteBars, ticker, date, checkKey);
    if (bars.length < 15) continue;

    const currentPrice = bars[bars.length - 1].c;
    const moveFromOpen = (currentPrice - sessionOpen) / sessionOpen;

    // Squeeze = strong upward move on high SI stock
    if (moveFromOpen < 0.02) continue; // Need 2%+ up move (squeeze initiation)

    const atr = profile.atr_20d || 0.025;
    const atrDollar = atr * currentPrice;
    const vwap = computeVWAP(bars);
    const candleAnalysis = analyzeCandle(bars[bars.length - 1]);

    // Volume must be very elevated
    let totalVol = bars.reduce((s, b) => s + (b.v || 0), 0);
    const avgDailyVol = profile.avg_volume_20d || profile.avg_volume || 0;
    const expectedVol = avgDailyVol * (CHECK_OFFSET / 390);
    const volRatio = expectedVol > 0 ? totalVol / expectedVol : 1;
    if (volRatio < 2.0) continue; // Need 2x+ volume

    // Confidence
    let confidence = 60;
    if (candleAnalysis.type.includes('MARUBOZU')) confidence += 6;
    else if (candleAnalysis.type.includes('STRONG')) confidence += 4;
    else confidence += 2;
    if (volRatio >= 3.0) confidence += 5;
    else confidence += 3;
    if (si.short_pct >= 0.25) confidence += 5; // very high SI
    else confidence += 3;
    confidence += 3; // squeeze bonus
    confidence = Math.max(60, Math.min(95, confidence));

    // Stop: 1.0 ATR (wide -- squeezes are volatile)
    const stopPrice = +(currentPrice - 1.0 * atrDollar).toFixed(2);

    // Target: 2.0 ATR
    const targetPrice = +(currentPrice + 2.0 * atrDollar).toFixed(2);

    const _ssEnrich = enrichMetadata(bars, ticker, date, currentPrice, vwap, sessionOpen, atrDollar, etfMinuteBars, checkKey);
    signals.push(buildSignal('SHORT_SQUEEZE_MOMENTUM', date, checkKey, ticker, 'CALL', confidence, currentPrice, stopPrice, targetPrice, profile, {
      short_pct: +(si.short_pct * 100).toFixed(1),
      move_from_open_pct: +(moveFromOpen * 100).toFixed(2),
      volume_ratio: +volRatio.toFixed(2),
      candle_type: candleAnalysis.type,
      confluence: 0,
      ..._ssEnrich,
    }));
  }

  signals.sort((a, b) => b.composite - a.composite);
  return signals.slice(0, 3);
}

/**
 * OPTIONS_FLOW
 *
 * Edge: Unusual options activity predicts returns. Pan & Poteshman 2006 RFS (+40bp/day, +1%/week).
 * Stub: activates when options flow data is available in context.optionsFlow.
 */
export function generateOptionsFlowSignals(date, dayData, context) {
  const { minuteBars, dailyBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];

  // Requires options flow data
  const optionsFlow = context.optionsFlow?.[date];
  if (!optionsFlow || Object.keys(optionsFlow).length === 0) return signals;

  const CHECK_OFFSET = 60; // 10:30 AM -- flow data needs time to aggregate

  for (const ticker of tickers) {
    const flow = optionsFlow[ticker];
    if (!flow) continue;

    // Need significant unusual activity: volume >= 3x avg OI
    if (!flow.unusual || flow.call_put_ratio == null) continue;

    const profile = profiles[ticker];
    if (!profile) continue;

    const allKeys = getMinuteKeys(minuteBars, ticker, date);
    if (allKeys.length <= CHECK_OFFSET) continue;

    const tickerMinutes = minuteBars[ticker] || {};
    const checkKey = allKeys[CHECK_OFFSET];
    const currentPrice = tickerMinutes[checkKey]?.c;
    if (!currentPrice) continue;

    const atr = profile.atr_20d || 0.025;
    const atrDollar = atr * currentPrice;

    // Direction from options flow: high call/put ratio = CALL, low = PUT
    const direction = flow.call_put_ratio > 1.5 ? 'CALL' : flow.call_put_ratio < 0.5 ? 'PUT' : null;
    if (!direction) continue;

    const candleAnalysis = analyzeCandle(tickerMinutes[checkKey]);

    // Confidence
    let confidence = 60;
    if (candleAnalysis.type.includes('STRONG')) confidence += 4;
    else confidence += 2;
    if (flow.volume_vs_oi >= 5) confidence += 5;
    else if (flow.volume_vs_oi >= 3) confidence += 3;
    confidence += 4; // options flow academic bonus
    confidence = Math.max(60, Math.min(95, confidence));

    // Stop: 0.75 ATR
    const stopPrice = direction === 'CALL'
      ? +(currentPrice - 0.75 * atrDollar).toFixed(2)
      : +(currentPrice + 0.75 * atrDollar).toFixed(2);

    // Target: 1.5 ATR (multi-day hold captures the 1-week drift)
    const targetPrice = direction === 'CALL'
      ? +(currentPrice + 1.5 * atrDollar).toFixed(2)
      : +(currentPrice - 1.5 * atrDollar).toFixed(2);

    const _ofBars = getBarsUpTo(minuteBars, ticker, date, checkKey);
    const _ofVwap = _ofBars.length > 0 ? computeVWAP(_ofBars) : null;
    const _ofEnrich = enrichMetadata(_ofBars, ticker, date, currentPrice, _ofVwap, _ofBars[0]?.o || null, atrDollar, dayData.etfMinuteBars, checkKey);
    signals.push(buildSignal('OPTIONS_FLOW', date, checkKey, ticker, direction, confidence, currentPrice, stopPrice, targetPrice, profile, {
      call_put_ratio: +flow.call_put_ratio.toFixed(2),
      volume_vs_oi: +(flow.volume_vs_oi || 0).toFixed(1),
      candle_type: candleAnalysis.type,
      confluence: 0,
      ..._ofEnrich,
    }));
  }

  signals.sort((a, b) => b.composite - a.composite);
  return signals.slice(0, 5);
}

/**
 * ANALYST_DRIFT
 *
 * Edge: Post-downgrade drift -9.1% over 6 months, post-upgrade drift +2.4%.
 * Womack 1996 JoF. Sells are 4x more informative than buys.
 * Activates when analyst rating changes are available in context.analystChanges.
 */
export function generateAnalystDriftSignals(date, dayData, context) {
  const { minuteBars, dailyBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];

  // Derive analyst signals from context.intelligence (the available data source)
  // context.intelligence[ticker] has: analyst_consensus, analyst_price_target, upside_to_target_pct
  const analystChanges = {};
  if (context.intelligence) {
    for (const ticker of tickers) {
      const intel = context.intelligence[ticker];
      if (!intel || !intel.analyst_consensus) continue;
      const upside = intel.upside_to_target_pct || 0;
      // Upgrade signal: buy/strong_buy consensus with meaningful upside (> 5%)
      const consensus = (intel.analyst_consensus || '').toUpperCase();
      if ((consensus === 'BUY' || consensus === 'STRONG_BUY') && upside > 5) {
        analystChanges[ticker] = { direction: 'UPGRADE', firm: 'consensus', firm_tier: 'major', upside_pct: upside };
      // Downgrade signal: sell consensus, or hold with negative upside (< -5%)
      } else if (consensus === 'SELL' || consensus === 'STRONG_SELL' || (consensus === 'HOLD' && upside < -5)) {
        analystChanges[ticker] = { direction: 'DOWNGRADE', firm: 'consensus', firm_tier: 'major', upside_pct: upside };
      }
    }
  }

  for (const ticker of tickers) {
    const change = analystChanges[ticker];
    if (!change) continue;

    // Only act on clear upgrades/downgrades
    if (!change.direction) continue; // 'UPGRADE' or 'DOWNGRADE'

    const profile = profiles[ticker];
    if (!profile) continue;

    const allKeys = getMinuteKeys(minuteBars, ticker, date);
    if (allKeys.length < 30) continue;

    const tickerMinutes = minuteBars[ticker] || {};
    const checkOffset = Math.min(30, allKeys.length - 1);
    const checkKey = allKeys[checkOffset];
    const bars = getBarsUpTo(minuteBars, ticker, date, checkKey);
    if (bars.length < 10) continue;

    const currentPrice = bars[bars.length - 1].c;
    const atr = profile.atr_20d || 0.025;
    const atrDollar = atr * currentPrice;

    // Direction: CALL for upgrade, PUT for downgrade
    // Downgrades are 4x more informative (Womack 1996)
    const direction = change.direction === 'UPGRADE' ? 'CALL' : 'PUT';

    const candleAnalysis = analyzeCandle(bars[bars.length - 1]);

    // Confidence -- downgrades get higher base confidence
    let confidence = 60;
    if (candleAnalysis.type.includes('STRONG')) confidence += 4;
    else confidence += 2;
    if (change.direction === 'DOWNGRADE') confidence += 5; // 4x more informative
    else confidence += 3;
    if (change.firm_tier === 'major') confidence += 3; // Goldman, Morgan Stanley, etc.
    confidence += 3; // analyst drift bonus
    confidence = Math.max(60, Math.min(95, confidence));

    // Stop: 1.5 ATR (wider for multi-week hold)
    const stopPrice = direction === 'CALL'
      ? +(currentPrice - 1.5 * atrDollar).toFixed(2)
      : +(currentPrice + 1.5 * atrDollar).toFixed(2);

    // Target: 3.0 ATR for downgrades (bigger drift), 2.0 ATR for upgrades
    const targetATR = change.direction === 'DOWNGRADE' ? 3.0 : 2.0;
    const targetPrice = direction === 'CALL'
      ? +(currentPrice + targetATR * atrDollar).toFixed(2)
      : +(currentPrice - targetATR * atrDollar).toFixed(2);

    const _adVwap = bars.length > 0 ? computeVWAP(bars) : null;
    const _adEnrich = enrichMetadata(bars, ticker, date, currentPrice, _adVwap, bars[0]?.o || null, atrDollar, dayData.etfMinuteBars, checkKey);
    signals.push(buildSignal('ANALYST_DRIFT', date, checkKey, ticker, direction, confidence, currentPrice, stopPrice, targetPrice, profile, {
      analyst_direction: change.direction,
      firm: change.firm || 'unknown',
      candle_type: candleAnalysis.type,
      confluence: 0,
      ..._adEnrich,
    }));
  }

  signals.sort((a, b) => b.composite - a.composite);
  return signals.slice(0, 3);
}

/**
 * VIX_REVERSAL
 *
 * Edge: Extreme VIX → positive short-term returns. Giot 2005 JPM.
 * When VIX spikes > 90th percentile, buy calls on high-beta stocks.
 * Hold 5-20 days.
 */
export function generateVIXReversalSignals(date, dayData, context) {
  const { minuteBars, dailyBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];

  // VIX data from dayData.vixByTime: { 'YYYY-MM-DDTHH:MM': priceValue }
  // Values are plain numbers (VIXY/UVXY proxy prices), not bar objects
  const vixByTime = dayData.vixByTime || {};
  const vixKeys = Object.keys(vixByTime).filter(k => k.startsWith(date)).sort();

  const CHECK_OFFSET = 30;

  // Get VIX level at or before the check offset time
  // We'll resolve this per-ticker below using the first ticker's minute keys as time reference
  // For the gate check, use the latest VIX reading for the day
  let vixLevel = 0;
  if (vixKeys.length > 0) {
    const lastVal = vixByTime[vixKeys[vixKeys.length - 1]];
    // vixByTime values are plain numbers (price), not objects
    vixLevel = typeof lastVal === 'number' ? lastVal : (lastVal?.c || lastVal?.close || 0);
  }
  if (vixLevel <= 0) return signals;

  // Only fire when VIX is extreme (> 28 absolute)
  // No vixData percentile available in context, rely on absolute level
  if (vixLevel < 28) return signals;

  for (const ticker of tickers) {
    const profile = profiles[ticker];
    if (!profile) continue;

    // High beta stocks amplify the VIX reversion (Savor & Wilson 2014)
    const beta = Math.max(profile.beta_spy || 0, profile.beta_qqq || 0);
    if (beta < 1.2) continue;

    const allKeys = getMinuteKeys(minuteBars, ticker, date);
    if (allKeys.length <= CHECK_OFFSET) continue;

    const tickerMinutes = minuteBars[ticker] || {};
    const checkKey = allKeys[CHECK_OFFSET];
    const bars = getBarsUpTo(minuteBars, ticker, date, checkKey);
    if (bars.length < 15) continue;

    // Resolve VIX at or before check offset time for this ticker
    // checkKey format: 'YYYY-MM-DDTHH:MM', vixKeys use same format
    let vixAtCheck = vixLevel; // fallback to day-level reading
    if (vixKeys.length > 0) {
      for (let vi = vixKeys.length - 1; vi >= 0; vi--) {
        if (vixKeys[vi] <= checkKey) {
          const val = vixByTime[vixKeys[vi]];
          vixAtCheck = typeof val === 'number' ? val : (val?.c || val?.close || vixLevel);
          break;
        }
      }
    }

    const currentPrice = bars[bars.length - 1].c;
    const atr = profile.atr_20d || 0.025;
    const atrDollar = atr * currentPrice;
    const vwap = computeVWAP(bars);
    const candleAnalysis = analyzeCandle(bars[bars.length - 1]);

    // VIX extreme = buy calls (fear will revert, stocks will bounce)
    const direction = 'CALL';

    // Confidence
    let confidence = 60;
    if (candleAnalysis.type.includes('STRONG')) confidence += 4;
    else confidence += 2;
    if (vixAtCheck >= 35) confidence += 5; // very extreme
    else confidence += 3;
    if (beta >= 1.5) confidence += 4;
    else confidence += 2;
    confidence += 4; // VIX reversal academic bonus
    confidence = Math.max(60, Math.min(95, confidence));

    // Stop: 1.5 ATR (wider for multi-week hold in high-vol environment)
    const stopPrice = +(currentPrice - 1.5 * atrDollar).toFixed(2);

    // Target: 2.5 ATR (VIX reversion drives multi-day rally)
    const targetPrice = +(currentPrice + 2.5 * atrDollar).toFixed(2);

    // Half position size (high-vol environment)
    const _vxEnrich = enrichMetadata(bars, ticker, date, currentPrice, vwap, bars[0]?.o || null, atrDollar, dayData.etfMinuteBars, checkKey);
    const sig = buildSignal('VIX_REVERSAL', date, checkKey, ticker, direction, confidence, currentPrice, stopPrice, targetPrice, profile, {
      vix_level: +vixAtCheck.toFixed(1),
      beta: +beta.toFixed(2),
      candle_type: candleAnalysis.type,
      confluence: 0,
      ..._vxEnrich,
    });
    sig.sizePct = (sig.sizePct || 0.10) * 0.5; // HALF size in extreme vol
    signals.push(sig);
  }

  signals.sort((a, b) => b.composite - a.composite);
  return signals.slice(0, 5);
}

// ── Scalp Strategy ──────────────────────────────────────────────────────────

/**
 * ZERO_DTE_SCALP
 *
 * Edge: Gamma leverage on index ETFs + intraday momentum/VWAP patterns.
 * SPY and IWM only. 0DTE ATM options. 5-15 min hold.
 * Entry patterns: VWAP bounce, momentum burst, 30-min level break.
 * Max 3 scalps/day/ticker.
 */
export function generateZeroDTEScalpSignals(date, dayData, context) {
  const { minuteBars, etfMinuteBars } = dayData;
  const { profiles } = context;
  const signals = [];
  const scalpCounts = { SPY: 0, IWM: 0 };
  const MAX_SCALPS_PER_TICKER = 3;

  const SCALP_TICKERS = ['SPY', 'IWM'];
  // Check every 15 bars from offset 15 to 360 (9:45 AM to 3:30 PM)
  const CHECK_OFFSETS = [];
  for (let i = 15; i <= 360; i += 15) CHECK_OFFSETS.push(i);

  for (const ticker of SCALP_TICKERS) {
    const source = etfMinuteBars || minuteBars;
    const allKeys = getMinuteKeys(source, ticker, date);
    if (allKeys.length < 60) continue;

    const tickerMinutes = source[ticker] || {};
    const sessionOpen = tickerMinutes[allKeys[0]]?.o;
    if (!sessionOpen) continue;

    // Use SPY profile or construct minimal one
    const profile = profiles[ticker] || { atr_20d: ticker === 'SPY' ? 0.012 : 0.015 };
    const atr = profile.atr_20d || (ticker === 'SPY' ? 0.012 : 0.015);
    const atrDollar = atr * sessionOpen;

    for (const offset of CHECK_OFFSETS) {
      if (offset >= allKeys.length) continue;
      if (scalpCounts[ticker] >= MAX_SCALPS_PER_TICKER) break;

      const checkKey = allKeys[offset];
      const bars = getBarsUpTo(source, ticker, date, checkKey);
      if (bars.length < 15) continue;

      const currentPrice = bars[bars.length - 1].c;
      const vwap = computeVWAP(bars);
      let fired = false;
      let direction = null;
      let pattern = null;

      // Pattern 1: VWAP Bounce -- price touches VWAP and reverses
      if (!fired) {
        const distPct = Math.abs(currentPrice - vwap) / vwap;
        if (distPct <= 0.001 && bars.length >= 3) {
          const prev2 = bars[bars.length - 3].c;
          const prev1 = bars[bars.length - 2].c;
          // Approaching from below and reversing up
          if (prev2 < vwap && prev1 <= vwap && currentPrice > vwap) {
            direction = 'CALL';
            pattern = 'VWAP_TOUCH';
            fired = true;
          }
          // Approaching from above and reversing down
          if (prev2 > vwap && prev1 >= vwap && currentPrice < vwap) {
            direction = 'PUT';
            pattern = 'VWAP_TOUCH';
            fired = true;
          }
        }
      }

      // Pattern 2: Momentum Burst -- 3+ consecutive bars same direction with expanding volume
      if (!fired && bars.length >= 4) {
        const last3 = bars.slice(-3);
        const allUp = last3.every(b => b.c > b.o);
        const allDown = last3.every(b => b.c < b.o);
        const volExpanding = last3[2].v > last3[1].v && last3[1].v > last3[0].v;

        if ((allUp || allDown) && volExpanding) {
          direction = allUp ? 'CALL' : 'PUT';
          pattern = 'MOMENTUM_BURST';
          fired = true;
        }
      }

      // Pattern 3: 30-min Level Break -- break of rolling 30-bar high/low
      if (!fired && bars.length >= 31) {
        const prior30 = bars.slice(-31, -1);
        const rolling30High = Math.max(...prior30.map(b => b.h));
        const rolling30Low = Math.min(...prior30.map(b => b.l));
        const lastBar = bars[bars.length - 1];

        if (lastBar.c > rolling30High && (lastBar.v || 0) > 0) {
          direction = 'CALL';
          pattern = 'LEVEL_BREAK';
          fired = true;
        } else if (lastBar.c < rolling30Low && (lastBar.v || 0) > 0) {
          direction = 'PUT';
          pattern = 'LEVEL_BREAK';
          fired = true;
        }
      }

      if (!fired || !direction) continue;

      // Confidence
      let confidence = 60;
      const candleAnalysis = analyzeCandle(bars[bars.length - 1]);
      if (candleAnalysis.type.includes('MARUBOZU')) confidence += 6;
      else if (candleAnalysis.type.includes('STRONG')) confidence += 4;
      else confidence += 2;
      if (pattern === 'MOMENTUM_BURST') confidence += 4;
      if (pattern === 'VWAP_TOUCH') confidence += 3;
      if (pattern === 'LEVEL_BREAK') confidence += 5;
      confidence += 3; // scalp gamma bonus
      confidence = Math.max(60, Math.min(95, confidence));

      // Tight scalp stops and targets
      const stopPct = 0.0015; // 0.15% stop
      const targetPct = 0.003; // 0.3% target
      const stopPrice = direction === 'CALL'
        ? +(currentPrice * (1 - stopPct)).toFixed(2)
        : +(currentPrice * (1 + stopPct)).toFixed(2);
      const targetPrice = direction === 'CALL'
        ? +(currentPrice * (1 + targetPct)).toFixed(2)
        : +(currentPrice * (1 - targetPct)).toFixed(2);

      scalpCounts[ticker]++;

      const _zdEnrich = enrichMetadata(bars, ticker, date, currentPrice, vwap, sessionOpen, atrDollar, etfMinuteBars, checkKey);
      const sig = buildSignal('ZERO_DTE_SCALP', date, checkKey, ticker, direction, confidence, currentPrice, stopPrice, targetPrice, profile, {
        pattern,
        vwap_price: +vwap.toFixed(2),
        candle_type: candleAnalysis.type,
        confluence: 0,
        ..._zdEnrich,
      });
      sig.sizePct = 0.05; // Fixed 5% position size for scalps
      signals.push(sig);
    }
  }

  return signals;
}

// ── MOMENTUM_SCALP ─────────────────────────────────────────────────────────────

/**
 * MOMENTUM_SCALP
 *
 * Pure TA scalp strategy. Identifies high-opportunity setups from price action
 * and rides them for 1-5 minutes. Three patterns, each with a clear structural reason:
 *
 * 1. LEVEL_REJECTION: Price touches a key level (VWAP, session H/L, OR H/L, prev day H/L)
 *    and prints a rejection wick. Scalp the bounce. WHY: Institutional liquidity pools at
 *    key levels cause predictable reactions.
 *
 * 2. MOMENTUM_BURST: Consolidation (5+ bars in tight range) breaks with a large-body
 *    candle + volume spike. Ride the initial thrust. WHY: Compression resolves into
 *    expansion -- stored energy releases directionally.
 *
 * 3. TREND_CONTINUATION: 5+ bars trending (higher lows / lower highs), 1-2 bar pullback
 *    on declining volume, then a continuation candle. WHY: Orderly pullbacks in a trend
 *    are profit-taking, not reversals. First pullback has highest follow-through.
 *
 * Rules:
 *   - Check every 5 bars from offset 15 to 370 (9:45 AM - 3:40 PM)
 *   - Max hold: 5 minutes
 *   - Stop: tight, pattern-specific (rejection wick, consolidation edge, pullback low)
 *   - Target: 0.2-0.3% or 1.5:1 R:R
 *   - Max 3 signals per ticker per day, max 10 total (top by confidence)
 */
/**
 * ETF Trend Continuation — 0DTE scalp on SPY, QQQ, IWM
 *
 * Focused exclusively on major ETFs for maximum liquidity, tight spreads,
 * and 0DTE gamma. Trades TREND_CONTINUATION pattern: established trend →
 * orderly pullback on declining volume → continuation candle.
 *
 * Why ETFs: institutional flow drives persistent trends, massive OI for
 * fills, 0DTE options available daily, gamma asymmetry maximized.
 */
export function generateMomentumScalpSignals(date, dayData, context) {
  const { minuteBars, etfMinuteBars } = dayData;
  const { profiles } = context;
  const signals = [];

  // ETFs only — max liquidity, 0DTE available daily
  const ETF_TICKERS = ['SPY', 'QQQ', 'IWM'];
  const ETF_DEFAULTS = {
    SPY: { atr: 0.012, ticker: 'SPY' },
    QQQ: { atr: 0.015, ticker: 'QQQ' },
    IWM: { atr: 0.013, ticker: 'IWM' },
  };
  const MAX_PER_TICKER = 3;
  const MAX_TOTAL = 9;

  // Start at offset 36 — need 35+ bars for 1-min MACD (12+26+9-2=35)
  const CHECK_OFFSETS = [];
  for (let i = 36; i <= 370; i += 3) CHECK_OFFSETS.push(i);

  for (const ticker of ETF_TICKERS) {
    const tickerMinutes = minuteBars[ticker] || (etfMinuteBars && etfMinuteBars[ticker]) || {};
    const barSource = minuteBars[ticker] ? minuteBars : (etfMinuteBars || {});

    const allKeys = getMinuteKeys(barSource, ticker, date);
    if (allKeys.length < 36) continue;

    const profile = profiles[ticker] || ETF_DEFAULTS[ticker];
    const atr = profile.atr_20d || profile.atr_5d || ETF_DEFAULTS[ticker].atr;
    const sessionOpen = tickerMinutes[allKeys[0]]?.o;
    if (!sessionOpen) continue;
    const atrDollar = atr * sessionOpen;

    let tickerCount = 0;

    for (const offset of CHECK_OFFSETS) {
      if (offset >= allKeys.length) continue;
      if (tickerCount >= MAX_PER_TICKER) break;

      const checkKey = allKeys[offset];
      const bars = getBarsUpTo(barSource, ticker, date, checkKey);
      if (bars.length < 36) continue;

      const currentBar = bars[bars.length - 1];
      const currentPrice = currentBar.c;
      const vwap = computeVWAP(bars);

      // ── GATE 1: Volume spike (hard gate) ──────────────────────────────────
      const recent10 = bars.slice(-11, -1);
      const avgVol10 = recent10.reduce((s, b) => s + (b.v || 0), 0) / recent10.length;
      const volRatio = avgVol10 > 0 ? (currentBar.v || 0) / avgVol10 : 1;
      if (volRatio < 1.3) continue;  // no volume = no conviction

      // ── Exhaustion gate ────────────────────────────────────────────────────
      const vwapDistPct = vwap > 0 ? Math.abs(currentPrice - vwap) / vwap * 100 : 0;
      if (vwapDistPct > 2.0) continue;

      // ── GATE 2: 1-Min MACD direction (hard gate) ──────────────────────────
      const closes1m = bars.map(b => b.c);
      const macd1m = computeMACD(closes1m);
      if (macd1m.histogram === null) continue;

      // Determine MACD direction
      let macdDirection = null;
      if (macd1m.histogram > 0) macdDirection = 'CALL';
      else if (macd1m.histogram < 0) macdDirection = 'PUT';
      else continue;  // histogram exactly 0 = no momentum

      // ── GATE 3: 1-Min candle pattern confirming direction (hard gate) ─────
      const patternScan = scanCandlePatterns(bars.slice(-5));
      let candleDirection = null;
      let candlePatternName = null;
      let candleQuality = 0;

      if (macdDirection === 'CALL' && patternScan.strongestBullish && patternScan.strongestBullish.quality >= 40) {
        candleDirection = 'CALL';
        candlePatternName = patternScan.strongestBullish.name;
        candleQuality = patternScan.strongestBullish.quality;
      } else if (macdDirection === 'PUT' && patternScan.strongestBearish && patternScan.strongestBearish.quality >= 40) {
        candleDirection = 'PUT';
        candlePatternName = patternScan.strongestBearish.name;
        candleQuality = patternScan.strongestBearish.quality;
      }
      if (!candleDirection) continue;  // MACD and candles must agree

      const direction = candleDirection;

      // ── GATE 4: 5-Min trend alignment (hard gate) ─────────────────────────
      const bars5m = aggregate5Min(bars);
      let fiveMinAligned = false;
      if (bars5m.length >= 10) {
        // Enough data for 5-min MACD (3/7/3 = needs 10 candles)
        const closes5m = bars5m.map(b => b.c);
        const macd5m = computeMACD(closes5m, 3, 7, 3);
        if (macd5m.histogram !== null) {
          fiveMinAligned = (direction === 'CALL' && macd5m.histogram >= 0)
                        || (direction === 'PUT' && macd5m.histogram <= 0);
        }
      } else if (bars5m.length >= 3) {
        // Fallback: check last 3 five-min bars price structure
        const last3 = bars5m.slice(-3);
        const greenCount = last3.filter(b => b.c > b.o).length;
        const redCount = last3.filter(b => b.c < b.o).length;
        fiveMinAligned = (direction === 'CALL' && greenCount >= 2)
                      || (direction === 'PUT' && redCount >= 2);
      }
      if (!fiveMinAligned) continue;

      // ── GATE 5: Cross-ETF alignment (hard gate) ───────────────────────────
      const otherETFs = ETF_TICKERS.filter(e => e !== ticker);
      let etfAlignCount = 0;
      for (const other of otherETFs) {
        const change = getETFChange(etfMinuteBars, other, date, checkKey)
                    || getETFChange(barSource, other, date, checkKey);
        if ((direction === 'CALL' && change > 0) || (direction === 'PUT' && change < 0)) etfAlignCount++;
      }
      if (etfAlignCount < 1) continue;  // at least 1 other ETF must confirm

      // ── VWAP alignment (soft — confidence bonus) ──────────────────────────
      const vwapAligned = vwap > 0 && (
        (direction === 'CALL' && currentPrice >= vwap) ||
        (direction === 'PUT' && currentPrice <= vwap)
      );

      // ── Stop & target ─────────────────────────────────────────────────────
      const recentSwingLow = Math.min(...bars.slice(-5).map(b => b.l));
      const recentSwingHigh = Math.max(...bars.slice(-5).map(b => b.h));
      let stopPrice, targetPrice;
      if (direction === 'CALL') {
        stopPrice = +(recentSwingLow - atrDollar * 0.02).toFixed(2);
        const risk = currentPrice - stopPrice;
        targetPrice = +(currentPrice + risk * 1.5).toFixed(2);
      } else {
        stopPrice = +(recentSwingHigh + atrDollar * 0.02).toFixed(2);
        const risk = stopPrice - currentPrice;
        targetPrice = +(currentPrice - risk * 1.5).toFixed(2);
      }

      // ── Confidence scoring ────────────────────────────────────────────────
      let confidence = 65;

      // MACD strength
      if (macd1m.crossover === 'BULLISH' || macd1m.crossover === 'BEARISH') confidence += 6;
      else if (macd1m.histogramTrend === 'EXPANDING_BULLISH' || macd1m.histogramTrend === 'EXPANDING_BEARISH') confidence += 3;
      else confidence += 1;

      // Candle pattern strength
      if (candlePatternName.includes('MARUBOZU') || candlePatternName.includes('ENGULFING')) confidence += 5;
      else if (candlePatternName.includes('STRONG') || candlePatternName.includes('STAR')) confidence += 3;
      else confidence += 2;

      // Volume
      if (volRatio >= 2.0) confidence += 4;
      else confidence += 2;  // already gated at 1.3

      // VWAP
      if (vwapAligned) confidence += 3;

      // Cross-ETF
      if (etfAlignCount >= 2) confidence += 5;
      else confidence += 3;

      // PUT directional bias — user has better success with PUTs
      if (direction === 'PUT') confidence += 3;

      confidence = Math.max(60, Math.min(95, confidence));

      tickerCount++;

      const _msEnrich = enrichMetadata(bars, ticker, date, currentPrice, vwap, sessionOpen, atrDollar, etfMinuteBars, checkKey);
      signals.push(buildSignal('MOMENTUM_SCALP', date, checkKey, ticker, direction, confidence, currentPrice, stopPrice, targetPrice, profile, {
        pattern: 'MACD_CANDLE_CONFIRMED',
        candle_pattern: candlePatternName,
        candle_quality: candleQuality,
        macd_1m_histogram: +macd1m.histogram.toFixed(4),
        macd_1m_crossover: macd1m.crossover,
        macd_1m_trend: macd1m.histogramTrend,
        five_min_aligned: fiveMinAligned,
        vol_ratio: +volRatio.toFixed(2),
        vwap_aligned: vwapAligned,
        cross_etf_aligned: true,
        etf_align_count: etfAlignCount,
        confluence: etfAlignCount + (vwapAligned ? 1 : 0),
        exitOverrides: {
          targetPct: 100,         // no fixed cap — let gamma run on big moves
          trailActivatePct: 20,   // trail only after meaningful gain (10-20% is typical capture)
          trailGiveBack: 0.65,    // keep 65% of peak when trail does fire
          lossCutPct: -15,        // cut at -15% (premium is the risk)
          momentumStall: true,    // PRIMARY profit exit: 2 bars against = reversal starting
        },
        ..._msEnrich,
      }));
    }
  }

  signals.sort((a, b) => b.composite - a.composite);
  return signals.slice(0, MAX_TOTAL);
}

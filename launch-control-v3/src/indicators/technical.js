/**
 * Technical Indicators — EMA, SMA, MACD, RSI, ATR Bands
 *
 * All functions accept bar arrays [{o, h, l, c, v, t}] and return
 * computed values. Designed for 1-min intraday bars (last 20-50).
 */

// ── Simple Moving Average ────────────────────────────────────────────────────

/**
 * @param {number[]} values - array of numbers
 * @param {number} period
 * @returns {number|null} SMA or null if insufficient data
 */
export function sma(values, period) {
  if (!values || values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

/**
 * SMA series — returns array of SMA values (one per input value where enough history exists)
 * @param {number[]} values
 * @param {number} period
 * @returns {number[]}
 */
export function smaSeries(values, period) {
  const result = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else {
      const slice = values.slice(i - period + 1, i + 1);
      result.push(slice.reduce((s, v) => s + v, 0) / period);
    }
  }
  return result;
}

// ── Exponential Moving Average ───────────────────────────────────────────────

/**
 * EMA series from an array of values.
 * @param {number[]} values
 * @param {number} period
 * @returns {number[]} array same length as values (nulls where insufficient data)
 */
export function emaSeries(values, period) {
  if (!values || values.length === 0) return [];
  const k = 2 / (period + 1);
  const result = new Array(values.length).fill(null);

  // Seed with SMA of first `period` values
  if (values.length < period) return result;
  let ema = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  result[period - 1] = ema;

  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

/**
 * Current EMA value (latest).
 * @param {number[]} values
 * @param {number} period
 * @returns {number|null}
 */
export function ema(values, period) {
  const series = emaSeries(values, period);
  return series[series.length - 1];
}

// ── MACD (12, 26, 9) ────────────────────────────────────────────────────────

/**
 * Compute MACD line, signal line, and histogram.
 * @param {number[]} closes - array of close prices
 * @param {number} fastPeriod - default 12
 * @param {number} slowPeriod - default 26
 * @param {number} signalPeriod - default 9
 * @returns {{ macd: number|null, signal: number|null, histogram: number|null, series: object[] }}
 */
export function computeMACD(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const result = { macd: null, signal: null, histogram: null, series: [], crossover: null };

  if (!closes || closes.length < slowPeriod + signalPeriod) return result;

  const fastEMA = emaSeries(closes, fastPeriod);
  const slowEMA = emaSeries(closes, slowPeriod);

  // MACD line = fast EMA - slow EMA
  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    if (fastEMA[i] !== null && slowEMA[i] !== null) {
      macdLine.push(fastEMA[i] - slowEMA[i]);
    } else {
      macdLine.push(null);
    }
  }

  // Signal line = EMA of MACD line
  const validMacd = macdLine.filter(v => v !== null);
  const signalLine = emaSeries(validMacd, signalPeriod);

  // Align signal line back to full array
  const signalFull = new Array(closes.length).fill(null);
  let validIdx = 0;
  for (let i = 0; i < closes.length; i++) {
    if (macdLine[i] !== null) {
      signalFull[i] = signalLine[validIdx] || null;
      validIdx++;
    }
  }

  // Histogram = MACD - Signal
  const histogram = [];
  for (let i = 0; i < closes.length; i++) {
    if (macdLine[i] !== null && signalFull[i] !== null) {
      histogram.push(macdLine[i] - signalFull[i]);
    } else {
      histogram.push(null);
    }
  }

  // Build series for last 5 entries
  const series = [];
  for (let i = Math.max(0, closes.length - 5); i < closes.length; i++) {
    series.push({
      macd: macdLine[i],
      signal: signalFull[i],
      histogram: histogram[i],
    });
  }

  const lastMACD = macdLine[macdLine.length - 1];
  const lastSignal = signalFull[signalFull.length - 1];
  const lastHist = histogram[histogram.length - 1];
  const prevHist = histogram.length >= 2 ? histogram[histogram.length - 2] : null;

  // Crossover detection
  let crossover = null;
  if (lastHist !== null && prevHist !== null) {
    if (lastHist > 0 && prevHist <= 0) crossover = 'BULLISH';
    else if (lastHist < 0 && prevHist >= 0) crossover = 'BEARISH';
  }

  // Histogram trend (momentum shifting)
  let histogramTrend = null;
  if (lastHist !== null && prevHist !== null) {
    if (lastHist > prevHist) histogramTrend = 'EXPANDING_BULLISH';
    else if (lastHist < prevHist) histogramTrend = 'EXPANDING_BEARISH';
  }

  return {
    macd: lastMACD,
    signal: lastSignal,
    histogram: lastHist,
    crossover,
    histogramTrend,
    series,
  };
}

// ── RSI (Relative Strength Index) ────────────────────────────────────────────

/**
 * Compute RSI using Wilder's smoothing method.
 * @param {number[]} closes - array of close prices
 * @param {number} period - default 14
 * @returns {{ rsi: number|null, overbought: boolean, oversold: boolean, zone: string }}
 */
export function computeRSI(closes, period = 14) {
  const result = { rsi: null, overbought: false, oversold: false, zone: 'NEUTRAL' };

  if (!closes || closes.length < period + 1) return result;

  // Calculate price changes
  const changes = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }

  // First average gain/loss (SMA of first `period` changes)
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] >= 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder's smoothing for remaining changes
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] >= 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) {
    result.rsi = 100;
  } else {
    const rs = avgGain / avgLoss;
    result.rsi = 100 - (100 / (1 + rs));
  }

  result.rsi = parseFloat(result.rsi.toFixed(2));
  result.overbought = result.rsi >= 70;
  result.oversold = result.rsi <= 30;
  result.zone = result.rsi >= 70 ? 'OVERBOUGHT'
              : result.rsi >= 60 ? 'BULLISH'
              : result.rsi <= 30 ? 'OVERSOLD'
              : result.rsi <= 40 ? 'BEARISH'
              : 'NEUTRAL';

  return result;
}

// ── EMA Context (price vs key EMAs) ──────────────────────────────────────────

/**
 * Analyze price position relative to key EMAs (9, 21, 50).
 * Returns EMA values, crossover state, and stack alignment.
 *
 * @param {number[]} closes - close prices (need >= 50 for full analysis)
 * @returns {object} EMA context
 */
export function analyzeEMAContext(closes) {
  const result = {
    ema9: null, ema21: null, ema50: null,
    priceAboveEma9: null, priceAboveEma21: null, priceAboveEma50: null,
    ema9AboveEma21: null, ema21AboveEma50: null,
    bullishStack: false,   // price > ema9 > ema21 > ema50
    bearishStack: false,   // price < ema9 < ema21 < ema50
    ema9Crossover: null,   // 'BULLISH' | 'BEARISH' | null (9 crossing 21)
    trendStrength: 'NONE', // STRONG_BULL | BULL | NEUTRAL | BEAR | STRONG_BEAR | NONE
  };

  if (!closes || closes.length < 10) return result;

  const price = closes[closes.length - 1];

  // Compute EMAs (use what data we have)
  result.ema9 = ema(closes, Math.min(9, closes.length));
  result.ema21 = closes.length >= 21 ? ema(closes, 21) : null;
  result.ema50 = closes.length >= 50 ? ema(closes, 50) : null;

  if (result.ema9 !== null) {
    result.priceAboveEma9 = price > result.ema9;
  }
  if (result.ema21 !== null) {
    result.priceAboveEma21 = price > result.ema21;
  }
  if (result.ema50 !== null) {
    result.priceAboveEma50 = price > result.ema50;
  }

  // EMA stack
  if (result.ema9 !== null && result.ema21 !== null) {
    result.ema9AboveEma21 = result.ema9 > result.ema21;
  }
  if (result.ema21 !== null && result.ema50 !== null) {
    result.ema21AboveEma50 = result.ema21 > result.ema50;
  }

  // Full stack alignment
  if (result.priceAboveEma9 && result.ema9AboveEma21 &&
      (result.ema21AboveEma50 === null || result.ema21AboveEma50)) {
    result.bullishStack = true;
  }
  if (result.priceAboveEma9 === false && result.ema9AboveEma21 === false &&
      (result.ema21AboveEma50 === null || result.ema21AboveEma50 === false)) {
    result.bearishStack = true;
  }

  // EMA 9/21 crossover (check last 2 values)
  if (closes.length >= 22) {
    const prevCloses = closes.slice(0, -1);
    const prevEma9 = ema(prevCloses, 9);
    const prevEma21 = ema(prevCloses, 21);

    if (prevEma9 !== null && prevEma21 !== null &&
        result.ema9 !== null && result.ema21 !== null) {
      if (prevEma9 <= prevEma21 && result.ema9 > result.ema21) {
        result.ema9Crossover = 'BULLISH';
      } else if (prevEma9 >= prevEma21 && result.ema9 < result.ema21) {
        result.ema9Crossover = 'BEARISH';
      }
    }
  }

  // Trend strength summary
  let bullPoints = 0;
  let bearPoints = 0;
  if (result.priceAboveEma9 === true) bullPoints++; else if (result.priceAboveEma9 === false) bearPoints++;
  if (result.priceAboveEma21 === true) bullPoints++; else if (result.priceAboveEma21 === false) bearPoints++;
  if (result.ema9AboveEma21 === true) bullPoints++; else if (result.ema9AboveEma21 === false) bearPoints++;
  if (result.priceAboveEma50 === true) bullPoints++; else if (result.priceAboveEma50 === false) bearPoints++;

  if (bullPoints >= 4) result.trendStrength = 'STRONG_BULL';
  else if (bullPoints >= 3) result.trendStrength = 'BULL';
  else if (bearPoints >= 4) result.trendStrength = 'STRONG_BEAR';
  else if (bearPoints >= 3) result.trendStrength = 'BEAR';
  else result.trendStrength = 'NEUTRAL';

  return result;
}

// ── Convenience: Full Technical Snapshot ──────────────────────────────────────

/**
 * Compute all indicators from a bar array. This is the main entry point
 * for strategies that need multi-factor confluence.
 *
 * @param {Array<{o,h,l,c,v}>} bars - intraday bars (min 15, ideal 30-50)
 * @returns {object} full technical snapshot
 */
export function computeTechnicals(bars) {
  if (!bars || bars.length < 10) {
    return { valid: false, reason: 'insufficient_bars' };
  }

  const closes = bars.map(b => b.c);
  const highs = bars.map(b => b.h);
  const lows = bars.map(b => b.l);
  const volumes = bars.map(b => b.v || 0);

  const emaCtx = analyzeEMAContext(closes);
  const rsi = computeRSI(closes, Math.min(14, closes.length - 1));
  const macd = computeMACD(closes);

  // Volume trend: last 5 vs prior 5
  let volumeTrend = null;
  if (volumes.length >= 10) {
    const recent5 = volumes.slice(-5).reduce((s, v) => s + v, 0) / 5;
    const prior5 = volumes.slice(-10, -5).reduce((s, v) => s + v, 0) / 5;
    volumeTrend = prior5 > 0 ? recent5 / prior5 : 1;
  }

  // Price momentum: last 3 bars vs prior 3 bars
  let priceMomentum = null;
  if (closes.length >= 6) {
    const recent3 = (closes[closes.length - 1] - closes[closes.length - 3]) / closes[closes.length - 3];
    const prior3 = (closes[closes.length - 3] - closes[closes.length - 6]) / closes[closes.length - 6];
    priceMomentum = { recent: recent3, prior: prior3, accelerating: Math.abs(recent3) > Math.abs(prior3) };
  }

  return {
    valid: true,
    ema: emaCtx,
    rsi,
    macd,
    volumeTrend: volumeTrend !== null ? parseFloat(volumeTrend.toFixed(2)) : null,
    priceMomentum,
    barCount: bars.length,
  };
}

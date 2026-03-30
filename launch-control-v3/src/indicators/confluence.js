/**
 * Confluence Checker — Multi-Factor Signal Validation
 *
 * Every strategy must pass through this to confirm a signal.
 * Requires minimum 3 of 6 factors confirming the direction.
 *
 * Factors:
 *   1. EMA alignment (price vs 9/21 EMA, stack direction)
 *   2. MACD confirmation (histogram direction or crossover)
 *   3. RSI zone (not overbought for CALL, not oversold for PUT)
 *   4. Candle pattern (engulfing, hammer, strong bar in direction)
 *   5. Volume confirmation (expanding on move, or surge)
 *   6. VWAP alignment (above for CALL, below for PUT)
 *
 * Returns a confluence score and pass/fail for each factor.
 */

import { computeTechnicals } from './technical.js';
import { scanCandlePatterns } from './candle-patterns.js';

/**
 * Check confluence for a proposed signal direction.
 *
 * @param {Array<{o,h,l,c,v}>} bars - intraday bars (min 15, ideal 30+)
 * @param {string} direction - 'CALL' or 'PUT'
 * @param {object} context - { vwap, volumeRatio, currentPrice }
 * @param {object} options - { minFactors: 3 } minimum confirming factors to pass
 * @returns {object} confluence result
 */
export function checkConfluence(bars, direction, context = {}, options = {}) {
  const minFactors = options.minFactors ?? 3;
  const { vwap, volumeRatio, currentPrice } = context;

  const result = {
    pass: false,
    score: 0,
    confirming: 0,
    opposing: 0,
    neutral: 0,
    factors: {},
    summary: '',
    details: [],
  };

  if (!bars || bars.length < 10) {
    result.summary = 'insufficient bars for confluence check';
    return result;
  }

  const isBull = direction === 'CALL';

  // ── Factor 1: EMA Alignment ──────────────────────────────────────────────
  const tech = computeTechnicals(bars);
  if (tech.valid) {
    const ema = tech.ema;
    let emaScore = 0;

    if (isBull) {
      if (ema.bullishStack) emaScore = 2;
      else if (ema.priceAboveEma9 && ema.ema9AboveEma21) emaScore = 2;
      else if (ema.priceAboveEma9) emaScore = 1;
      else if (ema.bearishStack) emaScore = -2;
      else if (ema.priceAboveEma9 === false) emaScore = -1;
    } else {
      if (ema.bearishStack) emaScore = 2;
      else if (ema.priceAboveEma9 === false && ema.ema9AboveEma21 === false) emaScore = 2;
      else if (ema.priceAboveEma9 === false) emaScore = 1;
      else if (ema.bullishStack) emaScore = -2;
      else if (ema.priceAboveEma9) emaScore = -1;
    }

    const emaConfirm = emaScore > 0 ? 'CONFIRMING' : emaScore < 0 ? 'OPPOSING' : 'NEUTRAL';
    result.factors.ema = { confirm: emaConfirm, score: emaScore, detail: ema.trendStrength };

    if (ema.ema9Crossover) {
      const crossConfirms = (isBull && ema.ema9Crossover === 'BULLISH') ||
                           (!isBull && ema.ema9Crossover === 'BEARISH');
      if (crossConfirms) {
        result.factors.ema.score++;
        result.factors.ema.detail += ` + ${ema.ema9Crossover} crossover`;
      }
    }

    // ── Factor 2: MACD ────────────────────────────────────────────────────
    const macd = tech.macd;
    let macdScore = 0;

    if (macd.histogram !== null) {
      if (isBull) {
        if (macd.crossover === 'BULLISH') macdScore = 2;
        else if (macd.histogramTrend === 'EXPANDING_BULLISH') macdScore = 1;
        else if (macd.histogram > 0) macdScore = 1;
        else if (macd.crossover === 'BEARISH') macdScore = -2;
        else if (macd.histogram < 0) macdScore = -1;
      } else {
        if (macd.crossover === 'BEARISH') macdScore = 2;
        else if (macd.histogramTrend === 'EXPANDING_BEARISH') macdScore = 1;
        else if (macd.histogram < 0) macdScore = 1;
        else if (macd.crossover === 'BULLISH') macdScore = -2;
        else if (macd.histogram > 0) macdScore = -1;
      }
    }

    const macdConfirm = macdScore > 0 ? 'CONFIRMING' : macdScore < 0 ? 'OPPOSING' : 'NEUTRAL';
    result.factors.macd = {
      confirm: macdConfirm,
      score: macdScore,
      detail: macd.crossover || macd.histogramTrend || 'no signal',
    };

    // ── Factor 3: RSI ─────────────────────────────────────────────────────
    const rsi = tech.rsi;
    let rsiScore = 0;

    if (rsi.rsi !== null) {
      if (isBull) {
        // For CALL: oversold is great (reversal), overbought is bad (exhausted)
        if (rsi.oversold) rsiScore = 2;           // RSI < 30 = strong buy signal
        else if (rsi.rsi < 45) rsiScore = 1;      // room to run
        else if (rsi.overbought) rsiScore = -2;   // exhausted, don't buy
        else if (rsi.rsi > 65) rsiScore = -1;     // getting stretched
      } else {
        if (rsi.overbought) rsiScore = 2;
        else if (rsi.rsi > 55) rsiScore = 1;
        else if (rsi.oversold) rsiScore = -2;
        else if (rsi.rsi < 35) rsiScore = -1;
      }
    }

    const rsiConfirm = rsiScore > 0 ? 'CONFIRMING' : rsiScore < 0 ? 'OPPOSING' : 'NEUTRAL';
    result.factors.rsi = {
      confirm: rsiConfirm,
      score: rsiScore,
      detail: rsi.rsi !== null ? `RSI=${rsi.rsi} ${rsi.zone}` : 'N/A',
    };
  }

  // ── Factor 4: Candle Pattern ──────────────────────────────────────────
  const candleResult = scanCandlePatterns(bars);
  let candleScore = 0;

  if (isBull) {
    if (candleResult.strongestBullish && candleResult.strongestBullish.quality >= 50) candleScore = 2;
    else if (candleResult.strongestBullish) candleScore = 1;
    if (candleResult.strongestBearish && candleResult.strongestBearish.quality >= 50) candleScore -= 1;
  } else {
    if (candleResult.strongestBearish && candleResult.strongestBearish.quality >= 50) candleScore = 2;
    else if (candleResult.strongestBearish) candleScore = 1;
    if (candleResult.strongestBullish && candleResult.strongestBullish.quality >= 50) candleScore -= 1;
  }

  const candleConfirm = candleScore > 0 ? 'CONFIRMING' : candleScore < 0 ? 'OPPOSING' : 'NEUTRAL';
  const candleDetail = isBull
    ? (candleResult.strongestBullish?.name || 'none')
    : (candleResult.strongestBearish?.name || 'none');
  result.factors.candle = { confirm: candleConfirm, score: candleScore, detail: candleDetail };

  // ── Factor 5: Volume ──────────────────────────────────────────────────
  let volScore = 0;
  const volTrend = tech.valid ? tech.volumeTrend : null;

  if (volumeRatio !== null && volumeRatio !== undefined) {
    if (volumeRatio >= 1.5) volScore = 2;
    else if (volumeRatio >= 1.2) volScore = 1;
    else if (volumeRatio < 0.5) volScore = -1; // dead volume, no conviction
  } else if (volTrend !== null) {
    if (volTrend >= 1.3) volScore = 1;
    else if (volTrend < 0.5) volScore = -1;
  }

  const volConfirm = volScore > 0 ? 'CONFIRMING' : volScore < 0 ? 'OPPOSING' : 'NEUTRAL';
  result.factors.volume = {
    confirm: volConfirm,
    score: volScore,
    detail: volumeRatio != null ? `${volumeRatio.toFixed(1)}x baseline` : (volTrend != null ? `trend ${volTrend.toFixed(1)}x` : 'N/A'),
  };

  // ── Factor 6: VWAP ────────────────────────────────────────────────────
  let vwapScore = 0;
  const price = currentPrice || (bars.length > 0 ? bars[bars.length - 1].c : null);

  if (vwap && price) {
    const vwapDist = (price - vwap) / vwap;
    if (isBull) {
      if (vwapDist > 0.003) vwapScore = 2;     // above VWAP = institutional support
      else if (vwapDist > -0.002) vwapScore = 1; // near VWAP
      else if (vwapDist < -0.005) vwapScore = -1; // well below
    } else {
      if (vwapDist < -0.003) vwapScore = 2;
      else if (vwapDist < 0.002) vwapScore = 1;
      else if (vwapDist > 0.005) vwapScore = -1;
    }
  }

  const vwapConfirm = vwapScore > 0 ? 'CONFIRMING' : vwapScore < 0 ? 'OPPOSING' : 'NEUTRAL';
  result.factors.vwap = {
    confirm: vwapConfirm,
    score: vwapScore,
    detail: vwap && price ? `${((price - vwap) / vwap * 100).toFixed(2)}% from VWAP` : 'N/A',
  };

  // ── Aggregate ─────────────────────────────────────────────────────────
  let totalScore = 0;
  let confirming = 0;
  let opposing = 0;
  let neutral = 0;
  const details = [];

  for (const [name, factor] of Object.entries(result.factors)) {
    totalScore += factor.score;
    if (factor.confirm === 'CONFIRMING') confirming++;
    else if (factor.confirm === 'OPPOSING') opposing++;
    else neutral++;
    details.push(`${name}:${factor.confirm}(${factor.score > 0 ? '+' : ''}${factor.score})`);
  }

  result.score = totalScore;
  result.confirming = confirming;
  result.opposing = opposing;
  result.neutral = neutral;
  result.pass = confirming >= minFactors && opposing <= 1;
  result.summary = `${confirming}/${Object.keys(result.factors).length} confirming, ${opposing} opposing`;
  result.details = details;

  // Attach raw indicator data for strategy-specific use
  result.technicals = tech.valid ? tech : null;
  result.candlePatterns = candleResult;

  return result;
}

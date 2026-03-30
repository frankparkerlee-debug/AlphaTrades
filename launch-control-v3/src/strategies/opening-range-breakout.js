import { checkBounceStructure } from './support-check.js';
import { detectFlushAndHold } from './support-check.js';
import { checkConfluence } from '../indicators/confluence.js';
import { analyzeCandle, detectBullishEngulfing, detectBearishEngulfing } from '../indicators/candle-patterns.js';

/**
 * Opening Range Breakout Strategy
 *
 * The first 15-30 minutes establish institutional supply/demand zones.
 * A breakout of that range with volume predicts the day's direction.
 *
 * INCOME playbook -- single-leg options (CALL or PUT), no spreads.
 *
 * Entry criteria:
 *   1. Opening range computed from first 30 min (or per-ticker override)
 *   2. Range quality: 0.3-2.0 ATR wide (too narrow = no setup, too wide = already moved)
 *   3. Breakout: price must clear the range with a small ATR buffer
 *   4. Volume confirming: >= 1.2x window baseline
 *   5. Time gate: after opening range is complete, before 14:00 ET
 *   6. VWAP alignment: CALL above VWAP, PUT below VWAP
 *   7. Today's full range must not exceed 1.5 ATR (move already happened)
 *
 * Targets: 0.5 ATR (T1) and 1.0 ATR (T2) from entry
 * Stop: opposite edge of the opening range (re-entry = failed breakout)
 *
 * @param {Object} snapshots        - { ticker: { open, price, volume, windowKey } }
 * @param {Object} prevCloses       - { ticker: number }
 * @param {number} spyChange        - SPY intraday change as decimal (e.g. -0.008 = -0.8%)
 * @param {number} qqqChange        - QQQ intraday change as decimal
 * @param {Object} volumeBaselines  - { "TICKER:windowKey": number }
 * @param {Object} levelData        - { prevDayLows, prevDayHighs, todayLows, todayHighs, dailyBars, vwaps, intradayBars }
 * @param {Object} profiles         - { ticker: { atr_20d, opening_chop_minutes, ... } }
 * @returns {Array} array of signal objects
 */
export function scanOpeningRangeBreakout(snapshots, prevCloses, spyChange, qqqChange, volumeBaselines, levelData = {}, profiles = {}) {
  const signals = [];

  // ── Current ET time ────────────────────────────────────────────────────────
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etHour = nowET.getHours();
  const etMinute = nowET.getMinutes();
  const etMinutesFromMidnight = etHour * 60 + etMinute;

  const { prevDayLows = {}, prevDayHighs = {}, todayLows = {}, todayHighs = {}, dailyBars = {}, vwaps = {}, intradayBars = {} } = levelData;

  for (const ticker of Object.keys(snapshots)) {
    const snap = snapshots[ticker];
    const prevClose = prevCloses[ticker];
    const profile = profiles[ticker] || {};

    if (!snap || !prevClose || !snap.price || !snap.open) continue;

    const currentPrice = snap.price;
    const todayOpen = snap.open;
    const bars = intradayBars[ticker] || [];

    // ── Profile-driven parameters ──────────────────────────────────────────
    const chopMinutes = profile.opening_chop_minutes || 30;
    const atrPct = profile.atr_20d || 0.025;
    const atrDollar = atrPct * currentPrice;

    // ── Time gate ──────────────────────────────────────────────────────────
    // Opening range ends at 9:30 + chopMinutes  (570 + chopMinutes from midnight)
    const rangeEndMinute = 570 + chopMinutes; // 570 = 9:30 ET in minutes from midnight
    if (etMinutesFromMidnight < rangeEndMinute) continue; // range not yet complete
    if (etMinutesFromMidnight >= 840) continue; // 14:00 ET cutoff -- ORB loses edge in afternoon

    // ── Compute opening range from intraday bars ───────────────────────────
    // Bars within the first chopMinutes (9:30-10:00 ET for default 30 min)
    // Bar timestamps are expected to have a `t` field (epoch ms or parseable date)
    const rangeBars = [];
    for (const bar of bars) {
      if (!bar.t) continue;
      const barDate = new Date(bar.t);
      const barET = new Date(barDate.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const barMinFromMidnight = barET.getHours() * 60 + barET.getMinutes();
      if (barMinFromMidnight >= 570 && barMinFromMidnight < rangeEndMinute) {
        rangeBars.push(bar);
      }
    }

    if (rangeBars.length < 10) continue; // not enough data to define the range

    let rangeHigh = -Infinity;
    let rangeLow = Infinity;
    for (const bar of rangeBars) {
      if (bar.h > rangeHigh) rangeHigh = bar.h;
      if (bar.l < rangeLow) rangeLow = bar.l;
    }

    if (!isFinite(rangeHigh) || !isFinite(rangeLow) || rangeHigh <= rangeLow) continue;

    const rangeWidth = rangeHigh - rangeLow;
    const rangeWidthATR = rangeWidth / atrDollar;

    // ── Range quality gate ─────────────────────────────────────────────────
    if (rangeWidthATR < 0.3 || rangeWidthATR > 2.0) continue;

    // ── Today's full range check ───────────────────────────────────────────
    // If today's range already exceeds 1.5 ATR, the move has happened
    const todayHigh = todayHighs[ticker] || rangeHigh;
    const todayLow = todayLows[ticker] || rangeLow;
    const todayRange = todayHigh - todayLow;
    if (todayRange > 1.5 * atrDollar) continue;

    // ── Breakout detection ─────────────────────────────────────────────────
    const breakoutBuffer = atrDollar * 0.05;
    const bullishBreak = currentPrice > rangeHigh + breakoutBuffer;
    const bearishBreak = currentPrice < rangeLow - breakoutBuffer;

    if (!bullishBreak && !bearishBreak) continue;

    const direction = bullishBreak ? 'CALL' : 'PUT';

    // ── Candle quality gate ──────────────────────────────────────────────
    const latestBar = bars.length > 0 ? bars[bars.length - 1] : null;
    const candleAnalysis = latestBar ? analyzeCandle(latestBar) : null;

    if (candleAnalysis) {
      // Breakout candles should have strong body (> 40% of range)
      if (candleAnalysis.bodyRatio <= 0.40) continue;

      // Skip if upper wick > 35% for CALL (weak close) or lower wick > 35% for PUT
      if (direction === 'CALL' && candleAnalysis.upperWickRatio > 0.35) continue;
      if (direction === 'PUT' && candleAnalysis.lowerWickRatio > 0.35) continue;
    }

    // ── Confluence check ─────────────────────────────────────────────────
    let confluenceResult = null;
    if (bars.length >= 10) {
      confluenceResult = checkConfluence(bars, direction, {
        vwap: vwaps[ticker],
        volumeRatio: null,
        currentPrice,
      }, { minFactors: 3 });

      if (!confluenceResult.pass) {
        console.log(`[ORB SKIP] ${ticker} — confluence fail: ${confluenceResult.summary}`);
        continue;
      }
    }

    // ── Engulfing bonus ──────────────────────────────────────────────────
    let engulfing = false;
    if (bars.length >= 2) {
      const lastTwo = bars.slice(-2);
      const engulfResult = direction === 'CALL'
        ? detectBullishEngulfing(lastTwo)
        : detectBearishEngulfing(lastTwo);
      engulfing = engulfResult.detected;
    }

    // ── VWAP alignment ─────────────────────────────────────────────────────
    const vwap = vwaps[ticker];
    let vwapConfirms = false;
    if (vwap && vwap > 0) {
      if (direction === 'CALL' && currentPrice > vwap) vwapConfirms = true;
      if (direction === 'PUT' && currentPrice < vwap) vwapConfirms = true;
    }

    // ── Volume confirmation ────────────────────────────────────────────────
    const windowKey = snap.windowKey;
    if (!windowKey) continue;
    const baseline = volumeBaselines[`${ticker}:${windowKey}`];
    let volumeRatio = null;
    if (baseline && baseline > 0) {
      volumeRatio = snap.volume / baseline;
      if (volumeRatio < 1.2) continue;
    }

    // ── Trend structure (for flag enrichment) ──────────────────────────────
    const structure = checkBounceStructure(currentPrice, dailyBars[ticker], {
      todayLow: todayLows[ticker],
      todayHigh: todayHighs[ticker],
      todayOpen,
      vwap,
      intradayBars: bars,
    }, 'intraday');

    // ── Flush+hold check aligned with breakout direction ───────────────────
    const stabilization = bars.length >= 5
      ? detectFlushAndHold(bars, direction)
      : { stabilized: false, barsHeld: 0 };

    // ── Build trend flags ──────────────────────────────────────────────────
    const trend_flags = [...(structure.flags || [])];
    if (!stabilization.stabilized && bars.length >= 5) trend_flags.push('no_stabilization');
    if (direction === 'CALL' && structure.trend === 'DOWNTREND' && structure.trendConfidence >= 0.7) {
      trend_flags.push('counter_trend_breakout');
    }
    if (direction === 'PUT' && structure.trend === 'UPTREND' && structure.trendConfidence >= 0.7) {
      trend_flags.push('counter_trend_breakout');
    }

    // ── Dynamic confidence scoring (base 72) ──────────────────────────────
    let confidence = 72;

    // Candle quality
    if (candleAnalysis) {
      if (candleAnalysis.type.includes('MARUBOZU')) confidence += 6;
      else if (candleAnalysis.type.includes('STRONG')) confidence += 4;
      else confidence += 2;
    }

    // Engulfing pattern
    if (engulfing) confidence += 4;

    // Volume surge
    if (volumeRatio && volumeRatio >= 1.5) {
      confidence += 5;
    } else if (volumeRatio && volumeRatio >= 1.2) {
      confidence += 3;
    }

    // Clean break: distance from range edge > 0.1 ATR
    const breakDistance = direction === 'CALL'
      ? currentPrice - rangeHigh
      : rangeLow - currentPrice;
    if (breakDistance > 0.1 * atrDollar) {
      confidence += 3;
    }

    // VWAP confirms
    if (vwapConfirms) {
      confidence += 3;
    }

    // Market alignment (SPY moving same direction as breakout)
    const marketAligned = (direction === 'CALL' && spyChange > 0) || (direction === 'PUT' && spyChange < 0);
    if (marketAligned) {
      confidence += 3;
    }

    // Tight range = coiled energy (0.3-0.8 ATR)
    if (rangeWidthATR >= 0.3 && rangeWidthATR <= 0.8) {
      confidence += 3;
    }

    // Trend aligned (structure trend matches breakout direction)
    const trendAligned =
      (direction === 'CALL' && structure.trend === 'UPTREND') ||
      (direction === 'PUT' && structure.trend === 'DOWNTREND');
    if (trendAligned) {
      confidence += 2;
    }

    // Confluence score
    if (confluenceResult) {
      confidence += Math.max(0, confluenceResult.confirming * 2);
      confidence -= confluenceResult.opposing * 2;
    }

    // Clamp
    confidence = Math.max(60, Math.min(95, confidence));

    // ── Targets and stops ──────────────────────────────────────────────────
    let stopPrice, t1Target, t2Target;

    if (direction === 'CALL') {
      stopPrice = +rangeLow.toFixed(2);
      t1Target = +(currentPrice + 0.5 * atrDollar).toFixed(2);
      t2Target = +(currentPrice + 1.0 * atrDollar).toFixed(2);
    } else {
      stopPrice = +rangeHigh.toFixed(2);
      t1Target = +(currentPrice - 0.5 * atrDollar).toFixed(2);
      t2Target = +(currentPrice - 1.0 * atrDollar).toFixed(2);
    }

    // ── Gap percent (open-to-current) ──────────────────────────────────────
    const gapPct = (currentPrice - todayOpen) / todayOpen;

    // ── Build note ─────────────────────────────────────────────────────────
    const dirLabel = direction === 'CALL' ? 'bullish' : 'bearish';
    const candleTypeLabel = candleAnalysis ? candleAnalysis.type : 'N/A';
    const confluenceNote = confluenceResult
      ? `confluence=${confluenceResult.confirming}/${Object.keys(confluenceResult.factors).length}`
      : 'no bars';
    const note = `ORB ${dirLabel} breakout: range ${rangeLow.toFixed(2)}-${rangeHigh.toFixed(2)} (${rangeWidthATR.toFixed(2)} ATR) | ${candleTypeLabel} body=${candleAnalysis ? Math.round(candleAnalysis.bodyRatio * 100) : 0}% | vol ${volumeRatio ? volumeRatio.toFixed(1) : 'N/A'}x | ${confluenceNote}${engulfing ? ' | ENGULFING' : ''}${vwapConfirms ? ' | VWAP confirms' : ''}${marketAligned ? ' | market aligned' : ''}`;

    signals.push({
      ticker,
      direction,
      strategy: 'OPENING_RANGE_BREAKOUT',
      entry_price: currentPrice,
      stop_price: stopPrice,
      t1_target: t1Target,
      t2_target: t2Target,
      confidence,
      exit_by: null,
      hold: 'STRUCTURAL',
      gap_pct: +(gapPct * 100).toFixed(2),
      volume_ratio: volumeRatio ? +volumeRatio.toFixed(2) : null,
      spy_change_pct: +(spyChange * 100).toFixed(2),
      qqq_change_pct: +(qqqChange * 100).toFixed(2),
      range_high: +rangeHigh.toFixed(2),
      range_low: +rangeLow.toFixed(2),
      range_width_atr: +rangeWidthATR.toFixed(2),
      trend: structure.trend,
      trend_flags,
      candle_type: candleAnalysis ? candleAnalysis.type : null,
      candle_body_pct: candleAnalysis ? Math.round(candleAnalysis.bodyRatio * 100) : null,
      engulfing,
      confluence: confluenceResult ? {
        confirming: confluenceResult.confirming,
        opposing: confluenceResult.opposing,
        factors: Object.fromEntries(
          Object.entries(confluenceResult.factors).map(([k, v]) => [k, v.confirm])
        ),
      } : null,
      note,
    });

    console.log(`[ORB] ${ticker} ${dirLabel} breakout ${currentPrice.toFixed(2)} outside ${rangeLow.toFixed(2)}-${rangeHigh.toFixed(2)} (${rangeWidthATR.toFixed(1)} ATR) | ${candleTypeLabel} | ${confluenceNote} | vol=${volumeRatio ? volumeRatio.toFixed(1) : 'N/A'}x conf=${confidence} -> ${direction}`);
  }

  // Cap at top 5 by confidence
  signals.sort((a, b) => b.confidence - a.confidence || b.volume_ratio - a.volume_ratio);
  return signals.slice(0, 5);
}

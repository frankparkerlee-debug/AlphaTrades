import { checkBounceStructure } from './support-check.js';
import { detectFlushAndHold } from './support-check.js';
import { checkConfluence } from '../indicators/confluence.js';
import { analyzeCandle, detectBearishEngulfing } from '../indicators/candle-patterns.js';

/**
 * Breakdown PUT Strategy — MULTI-FACTOR CONFLUENCE
 *
 * Red market day is the TRIGGER, not the trade. The trade requires:
 *   1. Market bearish: SPY <= -0.3% AND QQQ <= -0.3%
 *   2. Stock breaking down: price below VWAP AND at/below prior day low
 *   3. Candle confirmation: recent bar must show bearish conviction — strong red,
 *      bearish engulfing, or bearish marubozu (not weak/indecisive)
 *   4. Volume surge: >= 1.2x baseline (selling with conviction)
 *   5. EMA/MACD/RSI confluence: at least 3 of 6 technical factors confirming PUT
 *   6. Structure: not in confirmed strong uptrend
 *
 * Horizon: STRUCTURAL — exit when thesis breaks (price reclaims VWAP)
 *
 * @param {Object} snapshots      - { ticker: { open, price, volume, windowKey } }
 * @param {Object} prevCloses     - { ticker: number }
 * @param {number} spyChange      - SPY intraday change as decimal (e.g. -0.008 = -0.8%)
 * @param {number} qqqChange      - QQQ intraday change as decimal
 * @param {Object} volumeBaselines - { "TICKER:windowKey": number }
 * @param {Object} levelData      - { prevDayLows, prevDayHighs, todayLows, todayHighs, dailyBars, vwaps, intradayBars }
 * @returns {Array} array of signal objects
 */
export function scanBreakdownPut(snapshots, prevCloses, spyChange, qqqChange, volumeBaselines, levelData = {}) {
  const signals = [];

  // Hard gate: both SPY and QQQ must be red 0.3%+
  if (spyChange > -0.003 || qqqChange > -0.003) return signals;

  const { prevDayLows = {}, prevDayHighs = {}, todayLows = {}, todayHighs = {}, dailyBars = {}, vwaps = {}, intradayBars = {} } = levelData;

  for (const ticker of Object.keys(snapshots)) {
    const snap = snapshots[ticker];
    const prevClose = prevCloses[ticker];

    if (!snap || !prevClose || !snap.price || !snap.open) continue;

    const currentPrice = snap.price;
    const todayOpen = snap.open;
    const prevDayLow = prevDayLows[ticker];
    const vwap = vwaps[ticker];

    // Must be trading below today's open (confirming intraday weakness)
    const intradayChange = (currentPrice - todayOpen) / todayOpen;
    if (intradayChange > -0.005) continue; // at least -0.5% from open

    // Must be weaker than the market — if stock is down the same as SPY,
    // that's just beta, not a breakdown. Require 0.5%+ underperformance.
    const relativeWeakness = spyChange - intradayChange;
    if (relativeWeakness < 0.005) continue;

    // Must be below VWAP (institutional selling pressure)
    if (!vwap || vwap <= 0) continue;
    if (currentPrice >= vwap) continue;
    const vwapDistance = (currentPrice - vwap) / vwap;

    // Must be at or below prior day low (support break)
    if (!prevDayLow || prevDayLow <= 0) continue;
    const belowPrevLow = currentPrice <= prevDayLow;
    const nearPrevLow = (currentPrice - prevDayLow) / prevDayLow <= 0.003; // within 0.3%

    if (!belowPrevLow && !nearPrevLow) continue;

    // Volume confirmation: need at least 1.2x baseline (selling with conviction)
    const windowKey = snap.windowKey;
    if (!windowKey) continue;
    const baseline = volumeBaselines[`${ticker}:${windowKey}`];
    let volumeRatio = null;
    if (baseline && baseline > 0) {
      volumeRatio = snap.volume / baseline;
      if (volumeRatio < 1.2) continue;
    }

    // ── Candle Quality: recent bar must show bearish conviction ────────
    const bars = intradayBars[ticker] || [];
    let candleAnalysis = null;
    let engulfing = false;

    if (bars.length >= 1) {
      const recentBar = bars[bars.length - 1];
      candleAnalysis = analyzeCandle(recentBar);

      // Reject weak/indecisive candles — need body > 50% of range (strong conviction selling)
      if (candleAnalysis.bodyRatio < 0.50) {
        console.log(`[BREAKDOWN SKIP] ${ticker} — weak candle (body=${(candleAnalysis.bodyRatio * 100).toFixed(0)}%)`);
        continue;
      }

      // Reject candles with large lower wicks (buyers defending the level)
      if (candleAnalysis.lowerWickRatio > 0.30) {
        console.log(`[BREAKDOWN SKIP] ${ticker} — buying pressure (lowerWick=${(candleAnalysis.lowerWickRatio * 100).toFixed(0)}%)`);
        continue;
      }
    }

    // ── Bearish Engulfing Pattern ─────────────────────────────────────
    if (bars.length >= 2) {
      const engulfResult = detectBearishEngulfing(bars.slice(-2));
      engulfing = engulfResult.detected;
    }

    // ── Multi-Factor Confluence ───────────────────────────────────────
    // Require at least 3 of 6 factors confirming the PUT direction
    let confluenceResult = null;
    if (bars.length >= 10) {
      confluenceResult = checkConfluence(bars, 'PUT', {
        vwap,
        volumeRatio,
        currentPrice,
      }, { minFactors: 3 });

      if (!confluenceResult.pass) {
        console.log(`[BREAKDOWN SKIP] ${ticker} — confluence fail: ${confluenceResult.summary} [${confluenceResult.details.join(', ')}]`);
        continue;
      }
    }

    // ── Trend Structure ───────────────────────────────────────────────
    const structure = checkBounceStructure(currentPrice, dailyBars[ticker], {
      todayLow: todayLows[ticker], todayHigh: todayHighs[ticker], todayOpen,
      vwap,
      intradayBars: bars,
    }, 'intraday');

    // Skip if strong uptrend — this is a pullback in a bull trend, not a breakdown
    if (structure.trend === 'UPTREND' && structure.trendConfidence >= 0.8) continue;

    // ── Stabilization Check ───────────────────────────────────────────
    // Flush+hold for PUT direction: sellers holding price below resistance
    const stabilization = bars.length >= 5 ? detectFlushAndHold(bars, 'PUT') : { stabilized: false, barsHeld: 0 };

    // Build flags
    const trend_flags = [...(structure.flags || [])];
    if (!stabilization.stabilized && bars.length >= 5) trend_flags.push('no_stabilization');
    if (structure.trend === 'UPTREND') trend_flags.push('uptrend_pullback');

    // ── Targets ───────────────────────────────────────────────────────
    const todayLow = todayLows[ticker] || currentPrice * 0.97;
    const swingLow = structure.nearestSupport;
    const t1Level = swingLow && swingLow < currentPrice ? swingLow : todayLow;
    const t2Level = t1Level * 0.99; // 1% beyond T1

    // ── Dynamic Confidence ────────────────────────────────────────────
    let confidence = 72; // base — must earn it through confluence

    // Below prev day low (clean break vs. just near)
    if (belowPrevLow) confidence += 3;

    // Volume conviction
    if (volumeRatio && volumeRatio >= 2.0) confidence += 5;
    else if (volumeRatio && volumeRatio >= 1.5) confidence += 3;
    else if (volumeRatio && volumeRatio >= 1.2) confidence += 1;

    // Bearish candle pattern
    if (candleAnalysis) {
      if (candleAnalysis.type === 'BEARISH_MARUBOZU') confidence += 4;
      else if (engulfing) confidence += 4;
      else if (candleAnalysis.type === 'STRONG_BEARISH') confidence += 2;
    }

    // Stabilization (sellers holding)
    if (stabilization.stabilized) confidence += 3;

    // Confluence confirming factors
    if (confluenceResult) {
      confidence += Math.max(0, confluenceResult.confirming * 2);
      confidence -= confluenceResult.opposing * 2;
    }

    // Downtrend confirmed
    if (structure.trend === 'DOWNTREND' && structure.trendConfidence >= 0.7) confidence += 3;

    // VWAP distance > 0.5% below
    if (Math.abs(vwapDistance) > 0.005) confidence += 2;

    // Relative weakness > 1%
    if (relativeWeakness > 0.01) confidence += 2;

    confidence = Math.min(95, Math.max(60, confidence));

    // ── Structural Stop ───────────────────────────────────────────────
    // Stop = above VWAP (if price reclaims VWAP, thesis is broken)
    const stopPrice = +(vwap * 1.003).toFixed(2); // VWAP + 0.3% buffer

    const confluenceNote = confluenceResult
      ? `confluence=${confluenceResult.confirming}/${Object.keys(confluenceResult.factors).length}`
      : 'no bars';

    signals.push({
      ticker,
      direction: 'PUT',
      strategy: 'BREAKDOWN_PUT',
      entry_price: currentPrice,
      stop_price: stopPrice,
      t1_target: +t1Level.toFixed(2),
      t2_target: +t2Level.toFixed(2),
      confidence,
      exit_by: null,  // structural exit, not time-based
      hold: 'STRUCTURAL',
      candle_type: candleAnalysis ? candleAnalysis.type : null,
      engulfing,
      gap_pct: +(intradayChange * 100).toFixed(2),
      volume_ratio: volumeRatio ? +volumeRatio.toFixed(2) : null,
      spy_change_pct: +(spyChange * 100).toFixed(2),
      qqq_change_pct: +(qqqChange * 100).toFixed(2),
      vwap_distance_pct: +(vwapDistance * 100).toFixed(2),
      below_prev_low: belowPrevLow,
      trend: structure.trend,
      trend_flags,
      support_at: structure.nearestSupport,
      resistance_at: structure.nearestResistance,
      stabilized: stabilization.stabilized,
      bars_held: stabilization.barsHeld,
      confluence: confluenceResult ? {
        confirming: confluenceResult.confirming,
        opposing: confluenceResult.opposing,
        factors: Object.fromEntries(
          Object.entries(confluenceResult.factors).map(([k, v]) => [k, v.confirm])
        ),
      } : null,
      note: `below VWAP ${(vwapDistance * 100).toFixed(1)}%${belowPrevLow ? ' + broke prev day low' : ' near prev day low'} | ${candleAnalysis ? candleAnalysis.type : 'N/A'} | ${confluenceNote}${engulfing ? ' | ENGULFING' : ''}${stabilization.stabilized ? ` | stabilized ${stabilization.barsHeld}bars` : ''} | SPY${(spyChange * 100).toFixed(1)}% QQQ${(qqqChange * 100).toFixed(1)}%`,
    });

    console.log(`[BREAKDOWN] ${ticker} ${(intradayChange * 100).toFixed(1)}% below VWAP ${(vwapDistance * 100).toFixed(1)}% | ${candleAnalysis ? candleAnalysis.type : 'N/A'} | ${confluenceNote} | vol=${volumeRatio ? volumeRatio.toFixed(1) : 'N/A'}x | conf=${confidence}`);
  }

  // Cap at top 5 strongest signals — broad selloffs shouldn't flood the dashboard
  signals.sort((a, b) => b.confidence - a.confidence || (a.gap_pct || 0) - (b.gap_pct || 0));
  return signals.slice(0, 5);
}

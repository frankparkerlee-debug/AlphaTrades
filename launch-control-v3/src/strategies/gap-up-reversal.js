import { checkBounceStructure } from './support-check.js';
import { detectFlushAndHold } from './support-check.js';
import { checkConfluence } from '../indicators/confluence.js';
import { analyzeCandle, detectBearishEngulfing } from '../indicators/candle-patterns.js';

/**
 * Gap Up Reversal Strategy -- MULTI-FACTOR CONFLUENCE (PUT)
 *
 * Gap up 2-3% is the TRIGGER, not the trade. The trade requires:
 *   1. Gap trigger: 2-3% gap up
 *   2. Candle confirmation: first candle must be STRONG red (body > 50% of
 *      range, no large lower wick > 30%) -- real selling, not a doji
 *   3. Volume surge: first candle volume on the sell side (sellers stepping in)
 *   4. EMA/MACD/RSI confluence: at least 3 of 6 technical factors confirming PUT
 *   5. Stabilization: sellers holding highs down (flush+hold for PUT direction)
 *   6. Structure: not in confirmed uptrend with no stabilization (bull trap / catching knives)
 *
 * Based on data analysis finding: 2-3% gap ups with a red first
 * 5-minute candle close below the open 90% of the time (100% in
 * the 2.0-2.5% bucket). Average drop when winning: 2.07%.
 *
 * Horizon: INTRADAY -- structural exit (new high = thesis broken)
 */
export function scanGapUpReversal(snapshots, prevCloses, firstCandles, levelData = {}) {
  const signals = [];
  const { todayLows = {}, todayHighs = {}, dailyBars = {}, vwaps = {}, intradayBars = {} } = levelData;

  for (const ticker of Object.keys(snapshots)) {
    const snap = snapshots[ticker];
    const prevClose = prevCloses[ticker];
    const candle = firstCandles[ticker];

    if (!snap || !prevClose || !candle) continue;

    const todayOpen = snap.open;
    if (!todayOpen || !prevClose) continue;

    // -- Trigger: gap up 2-3% ---------------------------------------------
    const gap = (todayOpen - prevClose) / prevClose;
    if (gap < 0.02 || gap > 0.03) continue;

    // -- Candle Quality: must be a STRONG red candle -----------------------
    const isRed = candle.close < candle.open;
    if (!isRed) continue;

    const candleAnalysis = analyzeCandle(candle);

    // Reject weak candles -- need body > 50% of range (strong conviction selling)
    if (candleAnalysis.bodyRatio < 0.50) {
      console.log(`[GAP_UP SKIP] ${ticker} gap +${(gap * 100).toFixed(1)}% -- weak candle (body=${(candleAnalysis.bodyRatio * 100).toFixed(0)}%)`);
      continue;
    }

    // Reject candles with large lower wicks (buyers absorbing the sell-off)
    if (candleAnalysis.lowerWickRatio > 0.30) {
      console.log(`[GAP_UP SKIP] ${ticker} gap +${(gap * 100).toFixed(1)}% -- buying pressure (lowerWick=${(candleAnalysis.lowerWickRatio * 100).toFixed(0)}%)`);
      continue;
    }

    const currentPrice = snap.price || candle.close;
    const gapAmount = todayOpen - prevClose;
    const vwap = vwaps[ticker] || 0;

    // -- Volume Confirmation -----------------------------------------------
    // First candle should show real selling volume, not just a wick dip
    // We check this via the intraday bars if available
    const bars = intradayBars[ticker] || [];

    // -- Stabilization Check -----------------------------------------------
    // After the gap, sellers must hold highs down (not bouncing back up)
    let stabilized = false;
    let barsHeld = 0;
    if (bars.length >= 5) {
      const stabResult = detectFlushAndHold(bars, 'PUT');
      stabilized = stabResult.stabilized;
      barsHeld = stabResult.barsHeld;
    }

    // -- Multi-Factor Confluence -------------------------------------------
    // Require at least 3 of 6 factors confirming the PUT direction
    let confluenceResult = null;
    if (bars.length >= 10) {
      confluenceResult = checkConfluence(bars, 'PUT', {
        vwap,
        volumeRatio: null, // volume handled separately
        currentPrice,
      }, { minFactors: 3 });

      if (!confluenceResult.pass) {
        console.log(`[GAP_UP SKIP] ${ticker} gap +${(gap * 100).toFixed(1)}% -- confluence fail: ${confluenceResult.summary} [${confluenceResult.details.join(', ')}]`);
        continue;
      }
    }

    // -- Trend Structure ---------------------------------------------------
    const structure = checkBounceStructure(currentPrice, dailyBars[ticker], {
      todayLow: todayLows[ticker], todayHigh: todayHighs[ticker], todayOpen,
      vwap,
      intradayBars: bars,
    }, 'intraday');

    // Block on confirmed uptrend with no stabilization -- bull trap / catching falling knives
    if (structure.trend === 'UPTREND' && structure.trendConfidence >= 0.7 && !stabilized) {
      console.log(`[GAP_UP SKIP] ${ticker} gap +${(gap * 100).toFixed(1)}% -- uptrend + no stabilization`);
      continue;
    }

    // -- Bearish Engulfing Bonus -------------------------------------------
    // If the first candle engulfs the prior bar, even stronger sell signal
    let engulfing = false;
    if (bars.length >= 2) {
      const engulfResult = detectBearishEngulfing(bars.slice(-2));
      engulfing = engulfResult.detected;
    }

    // -- Dynamic Confidence ------------------------------------------------
    let confidence = 72; // base -- must earn it through confluence

    // Candle quality
    if (candleAnalysis.type === 'BEARISH_MARUBOZU') confidence += 6;
    else if (candleAnalysis.type === 'STRONG_BEARISH') confidence += 4;
    else confidence += 2; // minimum for passing the body ratio check

    // Engulfing pattern
    if (engulfing) confidence += 4;

    // Stabilization
    if (stabilized && barsHeld >= 5) confidence += 4;
    else if (stabilized) confidence += 2;

    // Confluence score
    if (confluenceResult) {
      confidence += Math.max(0, confluenceResult.confirming * 2);
      confidence -= confluenceResult.opposing * 2;
    }

    // VWAP confirmation -- price below VWAP is bearish
    if (vwap > 0 && currentPrice < vwap) confidence += 2;

    // Trend alignment
    if (structure.trend === 'DOWNTREND') confidence += 3;
    else if (structure.trend === 'RANGE') confidence += 1;
    else if (structure.trend === 'UPTREND') confidence -= 3;

    confidence = Math.min(95, Math.max(60, confidence));

    // -- Structural Stop ---------------------------------------------------
    // Stop = today's high (if price makes new high, the reversal thesis is dead)
    const todayHigh = todayHighs[ticker] || candle.high || todayOpen;
    const stopPrice = +(todayHigh * 1.002).toFixed(2);

    const confluenceNote = confluenceResult
      ? `confluence=${confluenceResult.confirming}/${Object.keys(confluenceResult.factors).length}`
      : 'no bars';

    signals.push({
      ticker,
      direction: 'PUT',
      strategy: 'GAP_UP_REVERSAL',
      entry_price: currentPrice,
      stop_price: stopPrice,
      gap_pct: +(gap * 100).toFixed(2),
      t1_target: +(todayOpen - gapAmount * 0.40).toFixed(2),
      t2_target: +prevClose.toFixed(2),
      confidence,
      exit_by: null,  // structural exit, not time-based
      hold: 'STRUCTURAL',
      candle_type: candleAnalysis.type,
      candle_body_pct: Math.round(candleAnalysis.bodyRatio * 100),
      engulfing,
      trend: structure.trend,
      trend_flags: structure.flags,
      support_at: structure.nearestSupport,
      resistance_at: structure.nearestResistance,
      resistance_room: structure.resistanceRoom,
      vwap_bearish: vwap > 0 && currentPrice < vwap,
      stabilized,
      bars_held: barsHeld,
      confluence: confluenceResult ? {
        confirming: confluenceResult.confirming,
        opposing: confluenceResult.opposing,
        factors: Object.fromEntries(
          Object.entries(confluenceResult.factors).map(([k, v]) => [k, v.confirm])
        ),
      } : null,
      note: `gap +${(gap * 100).toFixed(1)}% | ${candleAnalysis.type} body=${Math.round(candleAnalysis.bodyRatio * 100)}% | ${confluenceNote}${engulfing ? ' | ENGULFING' : ''}${stabilized ? ` | stabilized ${barsHeld}bars` : ''}`,
    });

    console.log(`[GAP_UP] ${ticker} gap +${(gap * 100).toFixed(1)}% | ${candleAnalysis.type} | ${confluenceNote} | conf=${confidence}`);
  }

  return signals;
}

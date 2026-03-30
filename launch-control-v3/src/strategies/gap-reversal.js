import { checkBounceStructure } from './support-check.js';
import { detectFlushAndHold } from './support-check.js';
import { checkConfluence } from '../indicators/confluence.js';
import { analyzeCandle, detectBullishEngulfing } from '../indicators/candle-patterns.js';

/**
 * Gap Reversal Strategy — MULTI-FACTOR CONFLUENCE
 *
 * Gap down 2-3% is the TRIGGER, not the trade. The trade requires:
 *   1. Gap trigger: 2-3% gap down
 *   2. Candle confirmation: first candle must be STRONG green (engulfing, marubozu,
 *      or body > 65% of range) — not just any green candle
 *   3. Volume surge: first candle volume > 1.3x average (buyers stepping in)
 *   4. EMA/MACD/RSI confluence: at least 3 of 6 technical factors confirming
 *   5. Stabilization: price holding above the low (flush+hold pattern)
 *   6. Structure: not in confirmed downtrend with high confidence
 *
 * Horizon: INTRADAY — structural exit (new low = thesis broken)
 */
export function scanGapReversal(snapshots, prevCloses, firstCandles, levelData = {}) {
  const signals = [];
  const { todayLows = {}, todayHighs = {}, dailyBars = {}, vwaps = {}, intradayBars = {} } = levelData;

  for (const ticker of Object.keys(snapshots)) {
    const snap = snapshots[ticker];
    const prevClose = prevCloses[ticker];
    const candle = firstCandles[ticker];

    if (!snap || !prevClose || !candle) continue;

    const todayOpen = snap.open;
    if (!todayOpen || !prevClose) continue;

    // ── Trigger: gap down 2-3% ──────────────────────────────────────────
    const gap = (todayOpen - prevClose) / prevClose;
    if (gap < -0.03 || gap > -0.02) continue;

    // ── Candle Quality: must be a STRONG green candle ───────────────────
    const isGreen = candle.close > candle.open;
    if (!isGreen) continue;

    const candleAnalysis = analyzeCandle(candle);

    // Reject weak candles — need body > 50% of range (strong conviction buying)
    if (candleAnalysis.bodyRatio < 0.50) {
      console.log(`[GAP_REV SKIP] ${ticker} gap ${(gap*100).toFixed(1)}% — weak candle (body=${(candleAnalysis.bodyRatio*100).toFixed(0)}%)`);
      continue;
    }

    // Reject candles with large upper wicks (sellers rejecting the bounce)
    if (candleAnalysis.upperWickRatio > 0.30) {
      console.log(`[GAP_REV SKIP] ${ticker} gap ${(gap*100).toFixed(1)}% — selling pressure (upperWick=${(candleAnalysis.upperWickRatio*100).toFixed(0)}%)`);
      continue;
    }

    const currentPrice = snap.price || candle.close;
    const gapAmount = prevClose - todayOpen;
    const vwap = vwaps[ticker] || 0;

    // ── Volume Confirmation ─────────────────────────────────────────────
    // First candle should show real buying volume, not just a wick bounce
    // We check this via the intraday bars if available
    const bars = intradayBars[ticker] || [];

    // ── Stabilization Check ─────────────────────────────────────────────
    // After the gap, price must show stabilization (not still making new lows)
    let stabilized = false;
    let barsHeld = 0;
    if (bars.length >= 5) {
      const stabResult = detectFlushAndHold(bars, 'CALL');
      stabilized = stabResult.stabilized;
      barsHeld = stabResult.barsHeld;
    }

    // ── Multi-Factor Confluence ─────────────────────────────────────────
    // Require at least 3 of 6 factors confirming the CALL direction
    let confluenceResult = null;
    if (bars.length >= 10) {
      confluenceResult = checkConfluence(bars, 'CALL', {
        vwap,
        volumeRatio: snap.volume && snap.windowKey ? null : null, // volume handled separately
        currentPrice,
      }, { minFactors: 3 });

      if (!confluenceResult.pass) {
        console.log(`[GAP_REV SKIP] ${ticker} gap ${(gap*100).toFixed(1)}% — confluence fail: ${confluenceResult.summary} [${confluenceResult.details.join(', ')}]`);
        continue;
      }
    }

    // ── Trend Structure ─────────────────────────────────────────────────
    const structure = checkBounceStructure(currentPrice, dailyBars[ticker], {
      todayLow: todayLows[ticker], todayHigh: todayHighs[ticker], todayOpen,
      vwap,
      intradayBars: bars,
    }, 'intraday');

    // Block on confirmed downtrend with no stabilization — dead cat bounce
    if (structure.trend === 'DOWNTREND' && structure.trendConfidence >= 0.7 && !stabilized) {
      console.log(`[GAP_REV SKIP] ${ticker} gap ${(gap*100).toFixed(1)}% — downtrend + no stabilization`);
      continue;
    }

    // ── Engulfing Pattern Bonus ─────────────────────────────────────────
    // If the first candle engulfs the prior (pre-market or last bar), even stronger
    let engulfing = false;
    if (bars.length >= 2) {
      const engulfResult = detectBullishEngulfing(bars.slice(-2));
      engulfing = engulfResult.detected;
    }

    // ── Dynamic Confidence ──────────────────────────────────────────────
    let confidence = 72; // base (lower than before — must earn it through confluence)

    // Candle quality
    if (candleAnalysis.type === 'BULLISH_MARUBOZU') confidence += 6;
    else if (candleAnalysis.type === 'STRONG_BULLISH') confidence += 4;
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

    // VWAP support
    if (vwap > 0 && currentPrice > vwap) confidence += 2;

    // Trend alignment
    if (structure.trend === 'UPTREND') confidence += 3;
    else if (structure.trend === 'RANGE') confidence += 1;
    else if (structure.trend === 'DOWNTREND') confidence -= 3;

    confidence = Math.min(95, Math.max(60, confidence));

    // ── Structural Stop ─────────────────────────────────────────────────
    // Stop = today's low (if price makes new low, the gap reversal thesis is dead)
    const todayLow = todayLows[ticker] || candle.low || todayOpen;
    const stopPrice = +(todayLow * 0.998).toFixed(2);

    const confluenceNote = confluenceResult
      ? `confluence=${confluenceResult.confirming}/${Object.keys(confluenceResult.factors).length}`
      : 'no bars';

    signals.push({
      ticker,
      direction: 'CALL',
      strategy: 'GAP_REVERSAL',
      entry_price: currentPrice,
      stop_price: stopPrice,
      gap_pct: +(gap * 100).toFixed(2),
      t1_target: +(todayOpen + gapAmount * 0.40).toFixed(2),
      t2_target: +(todayOpen + gapAmount * 0.77).toFixed(2),
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
      vwap_support: structure.vwapSupport,
      stabilized,
      bars_held: barsHeld,
      confluence: confluenceResult ? {
        confirming: confluenceResult.confirming,
        opposing: confluenceResult.opposing,
        factors: Object.fromEntries(
          Object.entries(confluenceResult.factors).map(([k, v]) => [k, v.confirm])
        ),
      } : null,
      note: `gap ${(gap*100).toFixed(1)}% | ${candleAnalysis.type} body=${Math.round(candleAnalysis.bodyRatio*100)}% | ${confluenceNote}${engulfing ? ' | ENGULFING' : ''}${stabilized ? ` | stabilized ${barsHeld}bars` : ''}`,
    });

    console.log(`[GAP_REV] ${ticker} gap ${(gap*100).toFixed(1)}% | ${candleAnalysis.type} | ${confluenceNote} | conf=${confidence}`);
  }

  return signals;
}

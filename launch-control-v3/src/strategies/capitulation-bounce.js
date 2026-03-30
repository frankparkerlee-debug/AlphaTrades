import { checkBounceStructure } from './support-check.js';
import { detectFlushAndHold } from './support-check.js';
import { checkConfluence } from '../indicators/confluence.js';
import { analyzeCandle, detectBullishEngulfing } from '../indicators/candle-patterns.js';

/**
 * Capitulation Bounce Strategy — MULTI-FACTOR CONFLUENCE
 *
 * A 3%+ intraday drop on heavy volume is the TRIGGER, not the trade.
 * The trade requires:
 *   1. Drop trigger: 3%+ intraday drop from open
 *   2. Volume surge: current volume > 1.5x baseline (panic selling)
 *   3. Candle confirmation: reversal candle (hammer, engulfing, or strong
 *      green bar with body > 50%) — visible buyer entry, not just "it dropped"
 *   4. Stabilization: detectFlushAndHold must confirm price is holding
 *   5. Multi-factor confluence: at least 3 of 6 technical factors confirming
 *   6. Structure: not in confirmed downtrend with high confidence and no stabilization
 *
 * Horizon: STRUCTURAL — hold until thesis breaks (new low)
 */
export function scanCapitulationBounce(snapshots, prevCloses, volumeBaselines, levelData = {}) {
  const signals = [];
  const { todayLows = {}, todayHighs = {}, dailyBars = {}, vwaps = {}, intradayBars = {} } = levelData;

  for (const ticker of Object.keys(snapshots)) {
    const snap = snapshots[ticker];
    if (!snap || !snap.open || !snap.price || !snap.volume) continue;

    const todayOpen = snap.open;
    const currentPrice = snap.price;
    const intradayDrop = (currentPrice - todayOpen) / todayOpen;

    // ── Trigger: 3%+ intraday drop ─────────────────────────────────────
    if (intradayDrop > -0.03) continue;

    const bounceFromOpen = (currentPrice - todayOpen) / todayOpen;
    if (bounceFromOpen > 0.015) continue;

    const windowKey = snap.windowKey;
    if (!windowKey) continue;

    // ── Volume Confirmation: 1.5x baseline ──────────────────────────────
    const baseline = volumeBaselines[`${ticker}:${windowKey}`];
    if (!baseline || baseline <= 0) continue;

    const volumeRatio = snap.volume / baseline;
    if (volumeRatio < 1.5) continue;

    const bars = intradayBars[ticker] || [];
    const vwap = vwaps[ticker] || 0;

    // ── Candle Quality: must show reversal ──────────────────────────────
    // A capitulation bounce needs visible buyer entry — hammer, bullish
    // engulfing, or strong green bar (body > 50%). Not just "it dropped a lot."
    let candleAnalysis = null;
    let engulfing = false;

    if (bars.length >= 1) {
      const recentBar = bars[bars.length - 1];
      candleAnalysis = analyzeCandle(recentBar);
    }

    if (bars.length >= 2) {
      const engulfResult = detectBullishEngulfing(bars.slice(-2));
      engulfing = engulfResult.detected;
    }

    // Need at least one reversal signal from the candles
    const isHammer = candleAnalysis && (candleAnalysis.type === 'HAMMER' || candleAnalysis.type === 'INVERTED_HAMMER');
    const isStrongGreen = candleAnalysis && candleAnalysis.bodyRatio >= 0.50 && candleAnalysis.direction === 'BULLISH';
    const hasReversalCandle = isHammer || engulfing || isStrongGreen;

    if (!hasReversalCandle) {
      console.log(`[CAPIT SKIP] ${ticker} drop ${(intradayDrop*100).toFixed(1)}% — no reversal candle (type=${candleAnalysis ? candleAnalysis.type : 'none'}, body=${candleAnalysis ? Math.round(candleAnalysis.bodyRatio*100) : 0}%)`);
      continue;
    }

    // ── Stabilization REQUIRED ──────────────────────────────────────────
    // If not stabilized, the stock may still be falling — skip
    let stabilized = false;
    let barsHeld = 0;

    if (bars.length >= 3) {
      const stabResult = detectFlushAndHold(bars, 'CALL');
      stabilized = stabResult.stabilized;
      barsHeld = stabResult.barsHeld;
    }

    if (!stabilized) {
      console.log(`[CAPIT SKIP] ${ticker} drop ${(intradayDrop*100).toFixed(1)}% — not stabilized (bars=${bars.length})`);
      continue;
    }

    // ── Multi-Factor Confluence ─────────────────────────────────────────
    // Require at least 3 of 6 factors confirming the CALL direction
    let confluenceResult = null;
    if (bars.length >= 10) {
      confluenceResult = checkConfluence(bars, 'CALL', {
        vwap,
        volumeRatio,
        currentPrice,
      }, { minFactors: 3 });

      if (!confluenceResult.pass) {
        console.log(`[CAPIT SKIP] ${ticker} drop ${(intradayDrop*100).toFixed(1)}% — confluence fail: ${confluenceResult.summary} [${confluenceResult.details.join(', ')}]`);
        continue;
      }
    }

    // ── Trend Structure ─────────────────────────────────────────────────
    const structure = checkBounceStructure(currentPrice, dailyBars[ticker], {
      todayLow: todayLows[ticker], todayHigh: todayHighs[ticker], todayOpen,
      vwap,
      intradayBars: bars,
    }, 'intraday');

    // Block on confirmed downtrend with high confidence AND no stabilization
    // (dead cat bounce) — threshold is stricter than gap-reversal at 0.8
    if (structure.trend === 'DOWNTREND' && structure.trendConfidence >= 0.8 && !stabilized) {
      console.log(`[CAPIT SKIP] ${ticker} drop ${(intradayDrop*100).toFixed(1)}% — downtrend (conf=${structure.trendConfidence}) + no stabilization`);
      continue;
    }

    // ── Dynamic Confidence ──────────────────────────────────────────────
    let confidence = 70; // base — must earn the rest through confluence

    // Volume ratio
    if (volumeRatio >= 2.0) confidence += 5;
    else if (volumeRatio >= 1.5) confidence += 3;

    // Hammer or engulfing pattern
    if (isHammer || engulfing) confidence += 4;

    // Stabilization depth
    if (stabilized && barsHeld >= 5) confidence += 4;
    else if (stabilized && barsHeld >= 3) confidence += 2;

    // Confluence score
    if (confluenceResult) {
      confidence += Math.max(0, confluenceResult.confirming * 2);
    }

    // VWAP approach — price near or above VWAP is supportive
    if (vwap > 0 && currentPrice > vwap) confidence += 2;

    // Trend alignment
    if (structure.trend === 'UPTREND' || structure.trend === 'RANGE') confidence += 2;

    confidence = Math.min(95, Math.max(60, confidence));

    // ── Structural Stop ─────────────────────────────────────────────────
    // Stop = today's low * 0.998 — if price breaks below, capitulation thesis is dead
    const todayLow = todayLows[ticker] || todayOpen;
    const stopPrice = +(todayLow * 0.998).toFixed(2);

    if (structure.flags.length > 0) {
      console.log(`[CAPIT] ${ticker} dropped ${(intradayDrop*100).toFixed(1)}% — flagged: ${structure.flags.join(', ')} (trend=${structure.trend})`);
    }

    const confluenceNote = confluenceResult
      ? `confluence=${confluenceResult.confirming}/${Object.keys(confluenceResult.factors).length}`
      : 'no bars';

    const candleType = candleAnalysis ? candleAnalysis.type : 'UNKNOWN';

    signals.push({
      ticker,
      direction: 'CALL',
      strategy: 'CAPITULATION_BOUNCE',
      entry_price: currentPrice,
      stop_price: stopPrice,
      gap_pct: +(intradayDrop * 100).toFixed(2),
      volume_ratio: +volumeRatio.toFixed(2),
      confidence,
      exit_by: null,
      hold: 'STRUCTURAL',
      candle_type: candleType,
      candle_body_pct: candleAnalysis ? Math.round(candleAnalysis.bodyRatio * 100) : 0,
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
      note: `drop ${(intradayDrop*100).toFixed(1)}% vol=${volumeRatio.toFixed(1)}x | ${candleType} body=${candleAnalysis ? Math.round(candleAnalysis.bodyRatio*100) : 0}% | ${confluenceNote}${engulfing ? ' | ENGULFING' : ''} | stabilized ${barsHeld}bars`,
    });

    console.log(`[CAPIT] ${ticker} drop ${(intradayDrop*100).toFixed(1)}% vol=${volumeRatio.toFixed(1)}x | ${candleType} | ${confluenceNote} | conf=${confidence}`);
  }

  return signals;
}

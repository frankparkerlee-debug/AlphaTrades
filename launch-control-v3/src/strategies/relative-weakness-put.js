import { checkBounceStructure } from './support-check.js';
import { detectFlushAndHold } from './support-check.js';
import { checkConfluence } from '../indicators/confluence.js';
import { analyzeCandle, detectBearishEngulfing } from '../indicators/candle-patterns.js';

/**
 * Relative Weakness PUT Strategy — MULTI-FACTOR CONFLUENCE
 *
 * Fires on GREEN market days when individual stocks show weakness.
 * This fills the gap where Breakdown PUT requires both SPY and QQQ red.
 *
 * The thesis: when the broad market is up but a stock can't hold its
 * own, something is wrong — relative weakness is bearish.
 *
 * Multi-factor validation:
 *   1. Market filter: SPY >= -0.1% OR QQQ >= -0.1% (green/flat day)
 *   2. Stock weakness: down >0.8% intraday, underperforming SPY by 1.5%+
 *   3. Below VWAP (institutional selling pressure)
 *   4. Candle confirmation: strong red candle (body > 50%) or bearish pattern
 *   5. Confluence: at least 3 of 6 technical factors confirming PUT direction
 *   6. Trend: confirmed downtrend OR breaking prior day low
 *   7. Dynamic confidence: starts at 72, earned through candle + confluence + structure
 *
 * Horizon: INTRADAY — structural exit (reclaim VWAP = thesis broken)
 */
export function scanRelativeWeaknessPut(
  snapshots, prevCloses, spyChange, qqqChange,
  volumeBaselines, levelData = {}
) {
  const signals = [];

  // Only fire when market is NOT broadly red — that's breakdown-put territory
  if (spyChange < -0.001 && qqqChange < -0.001) return signals;

  const {
    prevDayLows = {}, prevDayHighs = {},
    todayLows = {}, todayHighs = {},
    dailyBars = {}, vwaps = {}, intradayBars = {}
  } = levelData;

  for (const ticker of Object.keys(snapshots)) {
    const snap = snapshots[ticker];
    const prevClose = prevCloses[ticker];

    if (!snap || !prevClose || !snap.price || !snap.open) continue;

    const currentPrice = snap.price;
    const todayOpen = snap.open;
    const vwap = vwaps[ticker];
    const prevDayLow = prevDayLows[ticker];

    // -- Trigger: stock must be red intraday (at least -0.8%) -----------------
    const intradayChange = (currentPrice - todayOpen) / todayOpen;
    if (intradayChange > -0.008) continue;

    // Relative weakness: stock must underperform SPY by at least 1.5%
    const relativeWeakness = spyChange - intradayChange;
    if (relativeWeakness < 0.015) continue;

    // Must be below VWAP
    if (!vwap || vwap <= 0 || currentPrice >= vwap) continue;
    const vwapDistance = (currentPrice - vwap) / vwap;

    const bars = intradayBars[ticker] || [];

    // -- Candle Quality: must be a STRONG red candle or bearish pattern --------
    let candleAnalysis = null;
    let candlePass = false;

    if (bars.length >= 1) {
      const lastBar = bars[bars.length - 1];
      const isRed = lastBar.c < lastBar.o;

      if (isRed) {
        candleAnalysis = analyzeCandle(lastBar);
        // Need body > 50% of range (strong conviction selling)
        if (candleAnalysis.bodyRatio >= 0.50) {
          candlePass = true;
        }
      }
    }

    // Check for bearish engulfing as alternative candle confirmation
    let engulfing = false;
    if (bars.length >= 2) {
      const engulfResult = detectBearishEngulfing(bars.slice(-2));
      engulfing = engulfResult.detected;
      if (engulfing) candlePass = true;
    }

    // If we have bars but candle fails quality check, skip
    if (bars.length >= 1 && !candlePass) {
      const bodyPct = candleAnalysis ? (candleAnalysis.bodyRatio * 100).toFixed(0) : '?';
      console.log(`[REL_WEAKNESS SKIP] ${ticker} -- weak candle (body=${bodyPct}%, no engulfing)`);
      continue;
    }

    // -- Multi-Factor Confluence ----------------------------------------------
    let confluenceResult = null;
    if (bars.length >= 10) {
      confluenceResult = checkConfluence(bars, 'PUT', {
        vwap,
        volumeRatio: null,
        currentPrice,
      }, { minFactors: 3 });

      if (!confluenceResult.pass) {
        console.log(`[REL_WEAKNESS SKIP] ${ticker} -- confluence fail: ${confluenceResult.summary} [${confluenceResult.details.join(', ')}]`);
        continue;
      }
    }

    // -- Trend Structure Analysis ---------------------------------------------
    const structure = checkBounceStructure(currentPrice, dailyBars[ticker], {
      todayLow: todayLows[ticker], todayHigh: todayHighs[ticker], todayOpen,
      vwap,
      intradayBars: bars,
    }, 'intraday');

    // Need either: confirmed downtrend OR breaking below prior day low
    const inDowntrend = structure.trend === 'DOWNTREND' && structure.trendConfidence >= 0.5;
    const breakingPrevLow = prevDayLow && prevDayLow > 0 && currentPrice <= prevDayLow;

    if (!inDowntrend && !breakingPrevLow) continue;

    // Skip if strong uptrend with high confidence — this is a normal pullback
    if (structure.trend === 'UPTREND' && structure.trendConfidence >= 0.8) continue;

    // -- Stabilization check for PUT direction --------------------------------
    const stabilization = bars.length >= 5
      ? detectFlushAndHold(bars, 'PUT')
      : { stabilized: false, barsHeld: 0 };

    // -- Volume check (optional boost, not required) --------------------------
    const windowKey = snap.windowKey;
    let volumeRatio = null;
    if (windowKey) {
      const baseline = volumeBaselines[`${ticker}:${windowKey}`];
      if (baseline && baseline > 0) {
        volumeRatio = snap.volume / baseline;
      }
    }

    // -- Dynamic Confidence ---------------------------------------------------
    let confidence = 72; // base — must earn it through confluence

    // Candle quality
    if (candleAnalysis) {
      if (candleAnalysis.type === 'BEARISH_MARUBOZU') confidence += 6;
      else if (candleAnalysis.type === 'STRONG_BEARISH') confidence += 4;
      else confidence += 2; // minimum for passing the body ratio check
    }

    // Confluence score
    if (confluenceResult) {
      confidence += Math.max(0, confluenceResult.confirming * 2);
      confidence -= confluenceResult.opposing * 2;
    }

    // Stabilization (sellers holding)
    if (stabilization.stabilized && stabilization.barsHeld >= 5) confidence += 4;
    else if (stabilization.stabilized) confidence += 2;

    // Engulfing pattern
    if (engulfing) confidence += 4;

    // VWAP — well below is stronger
    if (vwap > 0 && vwapDistance < -0.01) confidence += 3;
    else if (vwap > 0 && currentPrice < vwap) confidence += 1;

    // Trend alignment
    if (inDowntrend) confidence += 3;
    if (breakingPrevLow) confidence += 2;

    // Relative weakness strength
    if (relativeWeakness >= 0.025) confidence += 3; // 2.5%+ relative weakness
    else if (relativeWeakness >= 0.02) confidence += 2;

    // Volume surge
    if (volumeRatio && volumeRatio >= 1.5) confidence += 2;

    confidence = Math.min(95, Math.max(60, confidence));

    // -- Targets --------------------------------------------------------------
    const swingLow = structure.nearestSupport;
    const todayLow = todayLows[ticker] || currentPrice * 0.98;
    const t1Level = swingLow && swingLow < currentPrice ? swingLow : todayLow;
    const t2Level = t1Level * 0.99;

    // -- Structural Stop: above VWAP + buffer ---------------------------------
    const stopPrice = +(vwap * 1.003).toFixed(2);

    // Build flags
    const trend_flags = [...(structure.flags || [])];
    if (structure.trend === 'UPTREND') trend_flags.push('uptrend_pullback');

    const confluenceNote = confluenceResult
      ? `confluence=${confluenceResult.confirming}/${Object.keys(confluenceResult.factors).length}`
      : 'no bars';

    const candleTypeNote = candleAnalysis ? candleAnalysis.type : 'no_candle';
    const candleBodyPct = candleAnalysis ? Math.round(candleAnalysis.bodyRatio * 100) : null;

    signals.push({
      ticker,
      direction: 'PUT',
      strategy: 'RELATIVE_WEAKNESS_PUT',
      entry_price: currentPrice,
      stop_price: stopPrice,
      t1_target: +t1Level.toFixed(2),
      t2_target: +t2Level.toFixed(2),
      confidence,
      exit_by: null,       // structural exit, not time-based
      hold: 'STRUCTURAL',
      gap_pct: +(intradayChange * 100).toFixed(2),
      volume_ratio: volumeRatio ? +volumeRatio.toFixed(2) : null,
      spy_change_pct: +(spyChange * 100).toFixed(2),
      qqq_change_pct: +(qqqChange * 100).toFixed(2),
      vwap_distance_pct: +(vwapDistance * 100).toFixed(2),
      relative_weakness_pct: +(relativeWeakness * 100).toFixed(2),
      below_prev_low: breakingPrevLow,
      candle_type: candleTypeNote,
      candle_body_pct: candleBodyPct,
      engulfing,
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
      note: `relative weakness ${(relativeWeakness * 100).toFixed(1)}% vs SPY on green day | ${candleTypeNote}${candleBodyPct != null ? ` body=${candleBodyPct}%` : ''} | below VWAP ${(vwapDistance * 100).toFixed(1)}% | ${confluenceNote}${engulfing ? ' | ENGULFING' : ''}${breakingPrevLow ? ' | broke prev day low' : ''}${stabilization.stabilized ? ` | stabilized ${stabilization.barsHeld}bars` : ''}`,
    });

    console.log(`[REL_WEAKNESS] ${ticker} ${(intradayChange * 100).toFixed(1)}% while SPY ${(spyChange * 100).toFixed(1)}% | ${candleTypeNote} | ${confluenceNote} | conf=${confidence}`);
  }

  // Cap at top 5 — if 30 stocks are weak on a green day, only the weakest matter
  signals.sort((a, b) => b.confidence - a.confidence || (a.gap_pct || 0) - (b.gap_pct || 0));
  return signals.slice(0, 5);
}

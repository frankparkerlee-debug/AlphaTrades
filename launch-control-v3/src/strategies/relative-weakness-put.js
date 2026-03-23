import { checkBounceStructure } from './support-check.js';
import { detectFlushAndHold } from './support-check.js';

/**
 * Relative Weakness PUT Strategy
 *
 * Fires on GREEN market days when individual stocks show weakness.
 * This fills the gap where Breakdown PUT requires both SPY and QQQ red.
 *
 * The thesis: when the broad market is up but a stock can't hold its
 * own, something is wrong — relative weakness is bearish.
 *
 * Entry criteria:
 *   1. Market is NOT red: SPY >= -0.1% OR QQQ >= -0.1% (green/flat day)
 *   2. Stock is weak: down >0.8% intraday while market is up
 *   3. Below VWAP (institutional selling pressure)
 *   4. Trend: confirmed downtrend OR breaking prior day low
 *   5. Relative weakness: stock underperforming SPY by at least 1%
 *
 * This does NOT require stabilization — if the stock is still falling
 * on a green day, that's the signal. Overwhelming news breakdowns
 * (like SMCI) pass through without any stabilization gate.
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

    // Stock must be red intraday (at least -0.8%)
    const intradayChange = (currentPrice - todayOpen) / todayOpen;
    if (intradayChange > -0.008) continue;

    // Relative weakness: stock must underperform SPY by at least 1%
    const relativeWeakness = spyChange - intradayChange;
    if (relativeWeakness < 0.01) continue;

    // Must be below VWAP
    if (!vwap || vwap <= 0 || currentPrice >= vwap) continue;
    const vwapDistance = (currentPrice - vwap) / vwap;

    // Trend structure analysis
    const structure = checkBounceStructure(currentPrice, dailyBars[ticker], {
      todayLow: todayLows[ticker], todayHigh: todayHighs[ticker], todayOpen,
      vwap,
      intradayBars: intradayBars[ticker] || [],
    }, 'intraday');

    // Need either: confirmed downtrend OR breaking below prior day low
    const inDowntrend = structure.trend === 'DOWNTREND' && structure.trendConfidence >= 0.5;
    const breakingPrevLow = prevDayLow && prevDayLow > 0 && currentPrice <= prevDayLow;

    if (!inDowntrend && !breakingPrevLow) continue;

    // Skip if strong uptrend with high confidence — this is a normal pullback
    if (structure.trend === 'UPTREND' && structure.trendConfidence >= 0.8) continue;

    // Volume check (optional boost, not required)
    const windowKey = snap.windowKey;
    let volumeRatio = null;
    if (windowKey) {
      const baseline = volumeBaselines[`${ticker}:${windowKey}`];
      if (baseline && baseline > 0) {
        volumeRatio = snap.volume / baseline;
      }
    }

    // Stabilization check for PUT direction
    const bars = intradayBars[ticker] || [];
    const stabilization = bars.length >= 5
      ? detectFlushAndHold(bars, 'PUT')
      : { stabilized: false, barsHeld: 0 };

    // Build flags
    const trend_flags = [...(structure.flags || [])];
    if (structure.trend === 'UPTREND') trend_flags.push('uptrend_pullback');

    // Targets
    const swingLow = structure.nearestSupport;
    const todayLow = todayLows[ticker] || currentPrice * 0.98;
    const t1Level = swingLow && swingLow < currentPrice ? swingLow : todayLow;
    const t2Level = t1Level * 0.99;

    // Confidence scoring
    let confidence = 80;
    if (inDowntrend) confidence += 5;
    if (breakingPrevLow) confidence += 3;
    if (relativeWeakness >= 0.02) confidence += 3; // 2%+ relative weakness
    if (volumeRatio && volumeRatio >= 1.5) confidence += 3;
    if (stabilization.stabilized) confidence += 2; // sellers holding
    if (vwapDistance < -0.01) confidence += 2; // well below VWAP
    confidence = Math.min(95, confidence);

    // Stop: above VWAP + buffer
    const stopPrice = +(vwap * 1.003).toFixed(2);

    signals.push({
      ticker,
      direction: 'PUT',
      strategy: 'RELATIVE_WEAKNESS_PUT',
      entry_price: currentPrice,
      stop_price: stopPrice,
      t1_target: +t1Level.toFixed(2),
      t2_target: +t2Level.toFixed(2),
      confidence,
      exit_by: '13:00',
      hold: 'SAME_DAY',
      gap_pct: +(intradayChange * 100).toFixed(2),
      volume_ratio: volumeRatio ? +volumeRatio.toFixed(2) : null,
      spy_change_pct: +(spyChange * 100).toFixed(2),
      qqq_change_pct: +(qqqChange * 100).toFixed(2),
      vwap_distance_pct: +(vwapDistance * 100).toFixed(2),
      relative_weakness_pct: +(relativeWeakness * 100).toFixed(2),
      below_prev_low: breakingPrevLow,
      trend: structure.trend,
      trend_flags,
      support_at: structure.nearestSupport,
      resistance_at: structure.nearestResistance,
      stabilized: stabilization.stabilized,
      bars_held: stabilization.barsHeld,
      note: `relative weakness ${(relativeWeakness * 100).toFixed(1)}% vs SPY on green day | below VWAP ${(vwapDistance * 100).toFixed(1)}%${breakingPrevLow ? ' + broke prev day low' : ''}`,
    });

    console.log(`[REL_WEAKNESS] ${ticker} ${(intradayChange * 100).toFixed(1)}% while SPY ${(spyChange * 100).toFixed(1)}% — relWeak=${(relativeWeakness * 100).toFixed(1)}% below VWAP ${(vwapDistance * 100).toFixed(1)}% → PUT`);
  }

  return signals;
}

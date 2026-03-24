import { checkBounceStructure } from './support-check.js';
import { detectFlushAndHold } from './support-check.js';

/**
 * Breakdown PUT Strategy
 *
 * Mirror of Sector Rotation Bounce: on red market days (SPY AND QQQ both
 * down 0.3%+), stocks breaking below key support continue down.
 *
 * Entry criteria:
 *   1. Market bearish: SPY <= -0.3% AND QQQ <= -0.3%
 *   2. Stock breaking down: price below VWAP AND below prior day low
 *   3. Volume confirming: >= 1.2x window baseline (selling with conviction)
 *   4. Trend structure: not in confirmed uptrend (avoids buying-the-dip pullbacks)
 *
 * Targets: next support level (swing low or today's low)
 * Exit: 13:00 (same-day) or next open (overnight if late entry)
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

    // Trend structure: flag if stock is in confirmed uptrend (fighting the trend)
    const structure = checkBounceStructure(currentPrice, dailyBars[ticker], {
      todayLow: todayLows[ticker], todayHigh: todayHighs[ticker], todayOpen,
      vwap,
      intradayBars: intradayBars[ticker] || [],
    }, 'intraday');

    // Skip if strong uptrend — this is a pullback in a bull trend, not a breakdown
    if (structure.trend === 'UPTREND' && structure.trendConfidence >= 0.8) continue;

    // Flush+hold for PUT direction: sellers holding price below resistance
    const bars = intradayBars[ticker] || [];
    const stabilization = bars.length >= 5 ? detectFlushAndHold(bars, 'PUT') : { stabilized: false, barsHeld: 0 };

    // Build flags
    const trend_flags = [...(structure.flags || [])];
    if (!stabilization.stabilized && bars.length >= 5) trend_flags.push('no_stabilization');
    if (structure.trend === 'UPTREND') trend_flags.push('uptrend_pullback');

    // Targets: next support below (swing low or today's low)
    const todayLow = todayLows[ticker] || currentPrice * 0.97;
    const swingLow = structure.nearestSupport;
    const t1Level = swingLow && swingLow < currentPrice ? swingLow : todayLow;
    const t2Level = t1Level * 0.99; // 1% beyond T1

    // Confidence: base 82, boost for confirmed downtrend + stabilization
    let confidence = 82;
    if (structure.trend === 'DOWNTREND' && structure.trendConfidence >= 0.7) confidence += 5;
    if (stabilization.stabilized) confidence += 3;
    if (volumeRatio && volumeRatio >= 2.0) confidence += 3;
    if (belowPrevLow) confidence += 2; // clean break, not just near
    confidence = Math.min(95, confidence);

    // Stop: above VWAP (if price reclaims VWAP, thesis is broken)
    const stopPrice = +(vwap * 1.003).toFixed(2); // VWAP + 0.3% buffer

    signals.push({
      ticker,
      direction: 'PUT',
      strategy: 'BREAKDOWN_PUT',
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
      below_prev_low: belowPrevLow,
      trend: structure.trend,
      trend_flags,
      support_at: structure.nearestSupport,
      resistance_at: structure.nearestResistance,
      stabilized: stabilization.stabilized,
      bars_held: stabilization.barsHeld,
      note: `below VWAP ${(vwapDistance * 100).toFixed(1)}%${belowPrevLow ? ' + broke prev day low' : ' near prev day low'} on red market SPY${(spyChange * 100).toFixed(1)}% QQQ${(qqqChange * 100).toFixed(1)}%`,
    });

    console.log(`[BREAKDOWN] ${ticker} ${(intradayChange * 100).toFixed(1)}% below VWAP ${(vwapDistance * 100).toFixed(1)}% vol=${volumeRatio?.toFixed(1)}x trend=${structure.trend} → PUT`);
  }

  // Cap at top 5 strongest signals — broad selloffs shouldn't flood the dashboard
  signals.sort((a, b) => b.confidence - a.confidence || (a.gap_pct || 0) - (b.gap_pct || 0));
  return signals.slice(0, 5);
}

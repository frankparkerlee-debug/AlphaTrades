import { checkBounceStructure } from './support-check.js';

/**
 * Gap Reversal Strategy
 *
 * 2-3% gap downs with a green first 5-min candle recover to close green
 * 83.9% of the time. Trend structure flags attached — never blocked.
 *
 * Horizon: INTRADAY (exit by 13:00)
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

    const gap = (todayOpen - prevClose) / prevClose;
    if (gap < -0.03 || gap > -0.02) continue;

    const isGreen = candle.close > candle.open;
    if (!isGreen) continue;

    const currentPrice = snap.price || candle.close;
    const gapAmount = prevClose - todayOpen;

    // Trend structure analysis — flags, never blocks
    const structure = checkBounceStructure(currentPrice, dailyBars[ticker], {
      todayLow: todayLows[ticker], todayHigh: todayHighs[ticker], todayOpen,
      vwap: vwaps[ticker] || 0,
      intradayBars: intradayBars[ticker] || [],
    }, 'intraday');

    if (structure.flags.length > 0) {
      console.log(`[GAP_REV] ${ticker} gapped ${(gap*100).toFixed(1)}% — flagged: ${structure.flags.join(', ')} (trend=${structure.trend})`);
    }

    signals.push({
      ticker,
      direction: 'CALL',
      strategy: 'GAP_REVERSAL',
      entry_price: candle.close,
      stop_price: +((candle.low || candle.open) - candle.close * 0.005).toFixed(2),
      gap_pct: +(gap * 100).toFixed(2),
      t1_target: +(todayOpen + gapAmount * 0.40).toFixed(2),
      t2_target: +(todayOpen + gapAmount * 0.77).toFixed(2),
      confidence: 83.9,
      exit_by: '13:00',
      trend: structure.trend,
      trend_flags: structure.flags,
      support_at: structure.nearestSupport,
      resistance_at: structure.nearestResistance,
      resistance_room: structure.resistanceRoom,
      vwap_support: structure.vwapSupport,
      stabilized: structure.stabilization.stabilized,
      bars_held: structure.stabilization.barsHeld,
    });
  }

  return signals;
}

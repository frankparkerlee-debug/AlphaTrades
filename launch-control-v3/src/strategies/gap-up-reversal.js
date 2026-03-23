import { checkBounceStructure } from './support-check.js';
import { detectFlushAndHold } from './support-check.js';

/**
 * Gap Up Reversal Strategy (PUT)
 *
 * Based on data analysis finding: 2-3% gap ups with a red first
 * 5-minute candle close below the open 90% of the time (100% in
 * the 2.0-2.5% bucket). Average drop when winning: 2.07%.
 *
 * Horizon: INTRADAY (exit by 13:00)
 */
export function scanGapUpReversal(snapshots, prevCloses, firstCandles, levelData = {}) {
  const signals = [];
  const { vwaps = {}, intradayBars = {} } = levelData;

  for (const ticker of Object.keys(snapshots)) {
    const snap = snapshots[ticker];
    const prevClose = prevCloses[ticker];
    const candle = firstCandles[ticker];

    if (!snap || !prevClose || !candle) continue;

    const todayOpen = snap.open;
    if (!todayOpen || !prevClose) continue;

    const gap = (todayOpen - prevClose) / prevClose;

    // Up 2-3% at open
    if (gap < 0.02 || gap > 0.03) continue;

    // Red first candle: close < open
    const isRed = candle.close < candle.open;
    if (!isRed) continue;

    const gapAmount = todayOpen - prevClose;
    const currentPrice = candle.close;

    // VWAP context for PUT: price below VWAP is bearish confirmation
    const vwap = vwaps[ticker] || 0;
    const vwapBearish = vwap > 0 && currentPrice < vwap;

    // Flush+hold for PUT direction (sellers holding highs down)
    const bars = intradayBars[ticker] || [];
    const stabilization = bars.length >= 5 ? detectFlushAndHold(bars, 'PUT') : { stabilized: false, barsHeld: 0 };

    const trend_flags = [];
    if (!stabilization.stabilized && bars.length >= 5) trend_flags.push('no_stabilization');
    if (vwap > 0 && currentPrice > vwap) trend_flags.push('above_vwap'); // buying pressure warning

    signals.push({
      ticker,
      direction: 'PUT',
      strategy: 'GAP_UP_REVERSAL',
      entry_price: candle.close,
      stop_price: +((candle.high || candle.open) + candle.close * 0.005).toFixed(2),
      gap_pct: +(gap * 100).toFixed(2),
      t1_target: +(todayOpen - gapAmount * 0.40).toFixed(2),
      t2_target: +prevClose.toFixed(2),
      confidence: 90.0,
      exit_by: '13:00',
      trend_flags,
      vwap_bearish: vwapBearish,
      stabilized: stabilization.stabilized,
      bars_held: stabilization.barsHeld,
    });

    console.log(`[GAP_UP] ${ticker} gapped +${(gap * 100).toFixed(1)}% red first candle → PUT${trend_flags.length > 0 ? ` flags: ${trend_flags.join(', ')}` : ''}`);
  }

  return signals;
}

/**
 * Gap Up Reversal Strategy (PUT)
 *
 * Based on data analysis finding: 2-3% gap ups with a red first
 * 5-minute candle close below the open 90% of the time (100% in
 * the 2.0-2.5% bucket). Average drop when winning: 2.07%.
 *
 * @param {Object} snapshots   - { ticker: { open, price, ... } }
 * @param {Object} prevCloses  - { ticker: number }
 * @param {Object} firstCandles - { ticker: { open, close } }
 * @returns {Array} array of signal objects
 */
export function scanGapUpReversal(snapshots, prevCloses, firstCandles) {
  const signals = [];

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
    });

    console.log(`[GAP_UP] ${ticker} gapped +${(gap * 100).toFixed(1)}% red first candle → PUT`);
  }

  return signals;
}

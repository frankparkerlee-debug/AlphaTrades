/**
 * Gap Reversal Strategy
 *
 * Based on data analysis finding: 2-3% gap downs with a green first
 * 5-minute candle recover to close green 83.9% of the time, with
 * an average 77% gap fill. Targets derived from observed fill rates.
 *
 * @param {Object} snapshots  - { ticker: { open, ... } } today's session data
 * @param {Object} prevCloses - { ticker: number } previous day's closing price
 * @param {Object} firstCandles - { ticker: { open, close } } first 5-min candle
 * @returns {Array} array of signal objects
 */
export function scanGapReversal(snapshots, prevCloses, firstCandles) {
  const signals = [];

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

    const gapAmount = prevClose - todayOpen;

    signals.push({
      ticker,
      direction: 'CALL',
      strategy: 'GAP_REVERSAL',
      entry_price: candle.close,
      stop_price: candle.open,
      gap_pct: +(gap * 100).toFixed(2),
      t1_target: +(todayOpen + gapAmount * 0.40).toFixed(2),
      t2_target: +(todayOpen + gapAmount * 0.77).toFixed(2),
      confidence: 83.9,
      exit_by: '13:00',
    });
  }

  return signals;
}

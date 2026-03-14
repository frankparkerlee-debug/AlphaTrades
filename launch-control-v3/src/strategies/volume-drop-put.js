/**
 * Volume Drop Put Strategy
 *
 * Based on data analysis finding: 3%+ intraday drops on normal volume
 * (<1.5x baseline) continue down 57% of the time with average -0.38%
 * next day. Low volume selling = distribution, not capitulation.
 *
 * @param {Object} snapshots - { ticker: { open, price, volume, windowKey } }
 * @param {Object} prevCloses - { ticker: number }
 * @param {Object} volumeBaselines - { "TICKER:windowKey": number }
 * @returns {Array} array of signal objects
 */
export function scanVolumeDropPut(snapshots, prevCloses, volumeBaselines) {
  const signals = [];

  for (const ticker of Object.keys(snapshots)) {
    const snap = snapshots[ticker];
    if (!snap || !snap.open || !snap.price || !snap.volume) continue;

    const todayOpen = snap.open;
    const currentPrice = snap.price;
    const intradayDrop = (currentPrice - todayOpen) / todayOpen;

    if (intradayDrop > -0.03) continue;

    const windowKey = snap.windowKey;
    if (!windowKey) continue;

    const baseline = volumeBaselines[`${ticker}:${windowKey}`];
    if (!baseline || baseline <= 0) continue;

    const volumeRatio = snap.volume / baseline;
    if (volumeRatio >= 1.5) continue;

    signals.push({
      ticker,
      direction: 'PUT',
      strategy: 'VOL_DROP_PUT',
      entry_price: currentPrice,
      intraday_drop_pct: +(intradayDrop * 100).toFixed(2),
      volume_ratio: +volumeRatio.toFixed(2),
      confidence: 57.0,
      hold: 'OVERNIGHT',
      exit_at: 'NEXT_OPEN',
      note: 'LOW_VOLUME_DISTRIBUTION',
    });
  }

  return signals;
}

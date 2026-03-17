/**
 * Capitulation Bounce Strategy
 *
 * Based on data analysis finding: 3%+ intraday drops on high volume
 * (>1.5x baseline) are capitulation events — only 28.1% continue down
 * the next day, with average +0.78% bounce. Hold overnight, exit at
 * next open.
 *
 * @param {Object} snapshots - { ticker: { open, price, volume, windowKey } }
 * @param {Object} prevCloses - { ticker: number }
 * @param {Object} volumeBaselines - { "TICKER:windowKey": number }
 * @returns {Array} array of signal objects
 */
export function scanCapitulationBounce(snapshots, prevCloses, volumeBaselines) {
  const signals = [];

  for (const ticker of Object.keys(snapshots)) {
    const snap = snapshots[ticker];
    if (!snap || !snap.open || !snap.price || !snap.volume) continue;

    const todayOpen = snap.open;
    const currentPrice = snap.price;
    const intradayDrop = (currentPrice - todayOpen) / todayOpen;

    if (intradayDrop > -0.03) continue;

    // Guard: if price has already bounced >1.5% above open, the move happened — skip
    const bounceFromOpen = (currentPrice - todayOpen) / todayOpen;
    if (bounceFromOpen > 0.015) continue;

    const windowKey = snap.windowKey;
    if (!windowKey) continue;

    const baseline = volumeBaselines[`${ticker}:${windowKey}`];
    if (!baseline || baseline <= 0) continue;

    const volumeRatio = snap.volume / baseline;
    if (volumeRatio < 1.5) continue;

    signals.push({
      ticker,
      direction: 'CALL',
      strategy: 'CAPITULATION_BOUNCE',
      entry_price: currentPrice,
      gap_pct: +(intradayDrop * 100).toFixed(2),
      volume_ratio: +volumeRatio.toFixed(2),
      confidence: 72.0,
      hold: 'OVERNIGHT',
      exit_at: 'NEXT_OPEN',
    });
  }

  return signals;
}

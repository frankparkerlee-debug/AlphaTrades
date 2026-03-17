/**
 * Sector Rotation Bounce Strategy
 *
 * Based on data analysis finding: on green market days (SPY >+0.3% AND QQQ >+0.3%),
 * tickers gapping down 2-3% at open bounce 90% of the time with an
 * average +2.22% intraday recovery. Requiring both SPY and QQQ green confirms
 * broad market + tech participation — the green market IS the confirmation.
 *
 * @param {Object} snapshots    - { ticker: { open, price, volume } }
 * @param {Object} prevCloses   - { ticker: number }
 * @param {number} spyChange    - SPY intraday change as decimal (e.g. 0.008 = +0.8%)
 * @param {Object} firstCandles - { ticker: { open, close } } (unused — market is confirmation)
 * @param {number} qqqChange    - QQQ intraday change as decimal
 * @returns {Array} array of signal objects
 */
export function scanSectorRotationBounce(snapshots, prevCloses, spyChange, firstCandles, qqqChange = 0) {
  const signals = [];

  // Require BOTH SPY and QQQ up 0.3%+ for broad market confirmation
  if (spyChange <= 0.003 || qqqChange <= 0.003) return signals;

  for (const ticker of Object.keys(snapshots)) {
    const snap = snapshots[ticker];
    const prevClose = prevCloses[ticker];

    if (!snap || !prevClose) continue;

    const todayOpen = snap.open;
    if (!todayOpen || !prevClose) continue;

    const gap = (todayOpen - prevClose) / prevClose;

    // Down 2-3% at open
    if (gap < -0.03 || gap > -0.02) continue;

    const currentPrice = snap.price || todayOpen;

    signals.push({
      ticker,
      direction: 'CALL',
      strategy: 'SECTOR_ROTATION_BOUNCE',
      entry_price: currentPrice,
      gap_pct: +(gap * 100).toFixed(2),
      spy_change_pct: +(spyChange * 100).toFixed(2),
      t1_target: +(prevClose * 0.985).toFixed(2),
      t2_target: +(prevClose).toFixed(2),
      confidence: 90.0,
      exit_by: '14:00',
      hold: 'SAME_DAY',
      qqq_change_pct: +(qqqChange * 100).toFixed(2),
      note: `down ${Math.abs(gap * 100).toFixed(1)}% on green market day SPY+${(spyChange * 100).toFixed(1)}% QQQ+${(qqqChange * 100).toFixed(1)}%`,
    });

    console.log(`[SECTOR] ${ticker} down ${(gap * 100).toFixed(1)}% on green market day SPY+${(spyChange * 100).toFixed(1)}% QQQ+${(qqqChange * 100).toFixed(1)}% → CALL`);
  }

  return signals;
}

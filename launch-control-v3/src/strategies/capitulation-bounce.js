import { checkBounceStructure } from './support-check.js';

/**
 * Capitulation Bounce Strategy
 *
 * 3%+ intraday drops on >1.5x volume are capitulation events — only 28.1%
 * continue down the next day. Trend structure flags attached — a 3% drop
 * into a higher low is flagged clean, into a lower low is flagged 'downtrend'.
 *
 * Horizon: OVERNIGHT (exit at next open)
 */
export function scanCapitulationBounce(snapshots, prevCloses, volumeBaselines, levelData = {}) {
  const signals = [];
  const { todayLows = {}, todayHighs = {}, dailyBars = {}, vwaps = {}, intradayBars = {} } = levelData;

  for (const ticker of Object.keys(snapshots)) {
    const snap = snapshots[ticker];
    if (!snap || !snap.open || !snap.price || !snap.volume) continue;

    const todayOpen = snap.open;
    const currentPrice = snap.price;
    const intradayDrop = (currentPrice - todayOpen) / todayOpen;

    if (intradayDrop > -0.03) continue;

    const bounceFromOpen = (currentPrice - todayOpen) / todayOpen;
    if (bounceFromOpen > 0.015) continue;

    const windowKey = snap.windowKey;
    if (!windowKey) continue;

    const baseline = volumeBaselines[`${ticker}:${windowKey}`];
    if (!baseline || baseline <= 0) continue;

    const volumeRatio = snap.volume / baseline;
    if (volumeRatio < 1.5) continue;

    // Trend structure analysis — flags, never blocks
    const structure = checkBounceStructure(currentPrice, dailyBars[ticker], {
      todayLow: todayLows[ticker], todayHigh: todayHighs[ticker], todayOpen,
      vwap: vwaps[ticker] || 0,
      intradayBars: intradayBars[ticker] || [],
    }, 'overnight');

    if (structure.flags.length > 0) {
      console.log(`[CAPIT] ${ticker} dropped ${(intradayDrop*100).toFixed(1)}% — flagged: ${structure.flags.join(', ')} (trend=${structure.trend})`);
    }

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

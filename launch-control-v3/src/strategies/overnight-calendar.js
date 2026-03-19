/**
 * Overnight Calendar Spread Strategy
 *
 * Sells 1DTE ATM call, buys 7DTE ATM call on SPY/QQQ/IWM when conditions
 * indicate low overnight gap risk: VIX < 15, no macro event, not Friday,
 * daily range < 1%, and time is 2:45-2:55pm ET.
 *
 * Based on data analysis: overnight gaps >= 1.5% occur ~1.6% of the time,
 * and zero large gaps followed low-vol days in a 6-month sample.
 *
 * @param {Object} snapshots  - { ticker: { open, price, volume } } Alpaca snapshot data
 * @param {Object} spySnap    - SPY snapshot from Alpaca (dailyBar, latestTrade, etc.)
 * @param {number} vixLevel   - current VIX level
 * @param {string|null} macroEventToday - macro event name or null
 * @returns {Array} array of signal objects
 */
export function scanOvernightCalendar(snapshots, spySnap, vixLevel, macroEventToday) {
  const signals = [];

  // ── Time gate: only fire between 2:45pm and 2:55pm ET ──────────────────
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etMins = et.getHours() * 60 + et.getMinutes();
  if (etMins < 14 * 60 + 45 || etMins > 14 * 60 + 55) return signals;

  // ── VIX gate: must be below 15 ────────────────────────────────────────
  if (vixLevel >= 15) return signals;

  // ── Macro gate: no high-impact macro event today ──────────────────────
  if (macroEventToday) return signals;

  // ── Day gate: not Friday (weekend gap risk) ───────────────────────────
  if (et.getDay() === 5) return signals;

  // ── SPY daily range gate: (dayHigh - dayLow) / dayOpen < 1% ──────────
  if (!spySnap || !spySnap.dailyBar) return signals;
  const dayHigh = spySnap.dailyBar.h;
  const dayLow = spySnap.dailyBar.l;
  const dayOpen = spySnap.dailyBar.o;
  if (!dayHigh || !dayLow || !dayOpen || dayOpen <= 0) return signals;

  const rangePct = (dayHigh - dayLow) / dayOpen;
  if (rangePct >= 0.01) return signals;

  // ── All conditions met — generate signals for SPY, QQQ, IWM ──────────
  const tickers = ['SPY', 'QQQ', 'IWM'];
  const now = new Date();

  for (const ticker of tickers) {
    const snap = snapshots[ticker];
    if (!snap || !snap.price) continue;

    signals.push({
      ticker,
      direction: 'CALENDAR',
      strategy: 'OVERNIGHT_CALENDAR',
      entry_price: snap.price,
      confidence: 82,
      hold: 'OVERNIGHT',
      front_leg: 'SELL 1DTE ATM CALL',
      back_leg: 'BUY 7DTE ATM CALL',
      entry_time: now.toISOString(),
      exit_time: 'NEXT_DAY_0930',
      exit_at: 'NEXT_OPEN',
      range_pct: +(rangePct * 100).toFixed(2),
      vix_level: +vixLevel.toFixed(1),
      note: `range=${(rangePct * 100).toFixed(2)}% VIX=${vixLevel.toFixed(1)}`,
    });
  }

  return signals;
}

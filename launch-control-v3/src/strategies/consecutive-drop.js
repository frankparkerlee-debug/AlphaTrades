/**
 * Consecutive Drop Bounce Strategy
 *
 * Based on data analysis finding: 2 consecutive days down 3%+ →
 * 64.3% bounce (avg +0.82%). 3 consecutive days down 3%+ →
 * 100% bounced (3/3, avg +2.74%). Hold multiday, exit within 3 days.
 *
 * @param {string[]} tickers - list of tickers to scan
 * @param {Object} dailyBars - { ticker: [{ day, o, h, l, c, v }, ...] } sorted by day asc
 * @returns {Array} array of signal objects
 */
export function scanConsecutiveDrop(tickers, dailyBars) {
  const signals = [];

  // Current week number for dedup
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((now - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7);

  for (const ticker of tickers) {
    const bars = dailyBars[ticker];
    if (!bars || bars.length < 3) continue;

    const n = bars.length;
    const c0 = bars[n - 3].c; // 3 days ago close
    const c1 = bars[n - 2].c; // 2 days ago close
    const c2 = bars[n - 1].c; // yesterday close

    if (!c0 || !c1 || !c2) continue;

    const drop1 = (c1 - c0) / c0; // day 1 return
    const drop2 = (c2 - c1) / c1; // day 2 return

    // Need at least 2 consecutive 3%+ drops
    if (drop1 > -0.03 || drop2 > -0.03) continue;

    // Check for 3-day: need bar n-4
    let consecutiveDays = 2;
    let totalDrop = (c2 - c0) / c0;

    if (bars.length >= 4) {
      const c_prev = bars[n - 4].c;
      if (c_prev) {
        const drop0 = (c0 - c_prev) / c_prev;
        if (drop0 <= -0.03) {
          consecutiveDays = 3;
          totalDrop = (c2 - c_prev) / c_prev;
        }
      }
    }

    signals.push({
      ticker,
      direction: 'CALL',
      strategy: 'CONSEC_BOUNCE',
      consecutive_days: consecutiveDays,
      total_drop_pct: +(totalDrop * 100).toFixed(2),
      confidence: consecutiveDays >= 3 ? 85.0 : 64.0,
      hold: 'MULTIDAY',
      exit_within_days: 3,
      dedup_key: `${ticker}-W${weekNum}`,
    });
  }

  return signals;
}

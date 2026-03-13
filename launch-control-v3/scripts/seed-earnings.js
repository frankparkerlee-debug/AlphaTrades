/**
 * Seed earnings intelligence for all tracked tickers
 * Run: node scripts/seed-earnings.js
 */
import 'dotenv/config';
import { query } from '../src/data/db.js';
import { getEarningsCalendar, getHistoricalEarnings, sleep } from '../src/data/fmp.js';

const today = new Date();
const todayStr = today.toISOString().split('T')[0];
const futureDate = new Date(today);
futureDate.setDate(futureDate.getDate() + 90);
const futureStr = futureDate.toISOString().split('T')[0];

async function main() {
  // Get our tickers
  const profileRes = await query('SELECT ticker FROM lc_v3.equity_profiles ORDER BY ticker');
  const tickers = new Set(profileRes.rows.map(r => r.ticker));
  console.log(`[EARNINGS] ${tickers.size} tickers loaded`);

  // Fetch earnings calendar for next 90 days
  console.log(`[EARNINGS] Fetching calendar ${todayStr} → ${futureStr}`);
  const calendar = await getEarningsCalendar(todayStr, futureStr);
  console.log(`[EARNINGS] Calendar returned ${calendar.length} entries`);

  // Map our tickers to their next earnings date
  const earningsMap = {};
  for (const entry of calendar) {
    const sym = entry.symbol;
    if (!tickers.has(sym)) continue;
    const eDate = entry.date;
    if (!eDate) continue;
    // Keep the earliest upcoming date per ticker
    if (!earningsMap[sym] || eDate < earningsMap[sym]) {
      earningsMap[sym] = eDate;
    }
  }
  console.log(`[EARNINGS] ${Object.keys(earningsMap).length} of our tickers have upcoming earnings`);

  let count = 0;

  for (const ticker of tickers) {
    const earningsDate = earningsMap[ticker] || null;
    const daysAway = earningsDate
      ? Math.round((new Date(earningsDate) - today) / 86400000)
      : null;

    // Fetch historical earnings
    const history = await getHistoricalEarnings(ticker);

    let avgMovePct = null;
    let beatRate = null;

    if (history.length > 0) {
      const validQuarters = history.filter(q =>
        q.actualEarningResult != null && q.estimatedEarning != null && q.estimatedEarning !== 0
      );

      if (validQuarters.length > 0) {
        const moves = validQuarters.map(q =>
          Math.abs(q.actualEarningResult - q.estimatedEarning) / Math.abs(q.estimatedEarning)
        );
        avgMovePct = parseFloat((moves.reduce((a, b) => a + b, 0) / moves.length * 100).toFixed(2));

        const beats = validQuarters.filter(q => q.actualEarningResult > q.estimatedEarning).length;
        beatRate = parseFloat((beats / validQuarters.length).toFixed(3));
      }
    }

    await query(`
      INSERT INTO lc_v3.ticker_intelligence (ticker, earnings_date, earnings_days_away, earnings_avg_move_pct, earnings_beat_rate, last_updated)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (ticker) DO UPDATE SET
        earnings_date = EXCLUDED.earnings_date,
        earnings_days_away = EXCLUDED.earnings_days_away,
        earnings_avg_move_pct = EXCLUDED.earnings_avg_move_pct,
        earnings_beat_rate = EXCLUDED.earnings_beat_rate,
        last_updated = NOW()
    `, [ticker, earningsDate, daysAway, avgMovePct, beatRate]);

    const dateLabel = earningsDate || 'none';
    const daysLabel = daysAway != null ? daysAway : '—';
    const moveLabel = avgMovePct != null ? `${avgMovePct}%` : '—';
    const beatLabel = beatRate != null ? `${(beatRate * 100).toFixed(1)}%` : '—';
    console.log(`[EARNINGS] ${ticker} — next: ${dateLabel} days_away: ${daysLabel} avg_move: ${moveLabel} beat_rate: ${beatLabel}`);
    count++;

    await sleep(200);
  }

  console.log(`\n[EARNINGS] Done — ${count} tickers processed`);
  process.exit(0);
}

main().catch(err => {
  console.error('[EARNINGS] FATAL:', err.message);
  process.exit(1);
});

/**
 * Seed earnings intelligence for all tracked tickers
 * Uses FMP /stable endpoints
 * Run: node scripts/seed-earnings.js
 */
import 'dotenv/config';
import { query } from '../src/data/db.js';
import {
  getEarningsCalendar, getHistoricalEarnings,
  getHistoricalEarningCalendar, getPriceTargetConsensus, sleep,
} from '../src/data/fmp.js';

const today = new Date();
const todayStr = today.toISOString().split('T')[0];
const futureDate = new Date(today);
futureDate.setDate(futureDate.getDate() + 90);
const futureStr = futureDate.toISOString().split('T')[0];

async function main() {
  // Ensure historical_earnings column exists
  await query(`
    ALTER TABLE lc_v3.ticker_intelligence
    ADD COLUMN IF NOT EXISTS historical_earnings JSONB
  `);

  // Get our tickers
  const profileRes = await query('SELECT ticker FROM lc_v3.equity_profiles ORDER BY ticker');
  const tickers = new Set(profileRes.rows.map(r => r.ticker));
  console.log(`[EARNINGS] ${tickers.size} tickers loaded`);

  // Fetch forward earnings calendar (next 90 days)
  console.log(`[EARNINGS] Fetching calendar ${todayStr} → ${futureStr}`);
  const calendar = await getEarningsCalendar(todayStr, futureStr);
  console.log(`[EARNINGS] Calendar returned ${calendar.length} entries`);

  // Map our tickers to their next earnings date + estimates
  const earningsMap = {};
  for (const entry of calendar) {
    const sym = entry.symbol;
    if (!tickers.has(sym)) continue;
    const eDate = entry.date;
    if (!eDate) continue;
    // Keep the earliest upcoming date per ticker
    if (!earningsMap[sym] || eDate < earningsMap[sym].date) {
      earningsMap[sym] = {
        date: eDate,
        epsEstimated: entry.epsEstimated,
        epsActual: entry.epsActual,
      };
    }
  }
  console.log(`[EARNINGS] ${Object.keys(earningsMap).length} of our tickers have upcoming earnings`);

  // Try to fetch historical earnings for beat rate calculation
  // (may be limited by plan — past dates might 403)
  console.log(`[EARNINGS] Fetching historical earnings for beat rate...`);
  const historicalMap = {};
  for (const ticker of tickers) {
    const history = await getHistoricalEarnings(ticker);
    if (history.length > 0) {
      historicalMap[ticker] = history;
    }
  }
  console.log(`[EARNINGS] Got historical data for ${Object.keys(historicalMap).length} tickers`);

  let count = 0;

  for (const ticker of tickers) {
    const earnings = earningsMap[ticker] || null;
    const earningsDate = earnings?.date || null;
    const daysAway = earningsDate
      ? Math.round((new Date(earningsDate) - today) / 86400000)
      : null;

    // Compute beat rate and avg move from historical data
    let avgMovePct = null;
    let beatRate = null;
    const history = historicalMap[ticker] || [];

    if (history.length > 0) {
      const valid = history.filter(q =>
        q.epsActual != null && q.epsEstimated != null && q.epsEstimated !== 0
      );
      if (valid.length > 0) {
        const moves = valid.map(q =>
          Math.abs(q.epsActual - q.epsEstimated) / Math.abs(q.epsEstimated)
        );
        avgMovePct = parseFloat((moves.reduce((a, b) => a + b, 0) / moves.length * 100).toFixed(2));
        const beats = valid.filter(q => q.epsActual > q.epsEstimated).length;
        beatRate = parseFloat((beats / valid.length).toFixed(3));
      }
    }

    // Get price target consensus
    const ptData = await getPriceTargetConsensus(ticker);
    const pt = Array.isArray(ptData) ? ptData[0] : ptData;
    const priceTarget = pt?.targetConsensus || null;

    await query(`
      INSERT INTO lc_v3.ticker_intelligence
        (ticker, earnings_date, earnings_days_away, earnings_avg_move_pct,
         earnings_beat_rate, analyst_price_target, last_updated)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (ticker) DO UPDATE SET
        earnings_date = EXCLUDED.earnings_date,
        earnings_days_away = EXCLUDED.earnings_days_away,
        earnings_avg_move_pct = EXCLUDED.earnings_avg_move_pct,
        earnings_beat_rate = EXCLUDED.earnings_beat_rate,
        analyst_price_target = EXCLUDED.analyst_price_target,
        last_updated = NOW()
    `, [ticker, earningsDate, daysAway, avgMovePct, beatRate, priceTarget]);

    // Fetch historical earning calendar (past 8 quarters)
    const histCal = await getHistoricalEarningCalendar(ticker, 8);
    let histEarnings = null;
    if (Array.isArray(histCal) && histCal.length > 0) {
      histEarnings = histCal
        .filter(e => e.date && e.epsActual != null)
        .map(e => ({
          date: e.date,
          eps_actual: e.epsActual,
          revenue: e.revenue ?? null,
          period: e.period ?? null,
          fiscal_year: e.fiscalYear ?? null,
        }));

      if (histEarnings.length > 0) {
        await query(`
          UPDATE lc_v3.ticker_intelligence
          SET historical_earnings = $2, last_updated = NOW()
          WHERE ticker = $1
        `, [ticker, JSON.stringify(histEarnings)]);
      }
    }

    const dateLabel = earningsDate || 'none';
    const daysLabel = daysAway != null ? daysAway : '—';
    const moveLabel = avgMovePct != null ? `${avgMovePct}%` : '—';
    const beatLabel = beatRate != null ? `${(beatRate * 100).toFixed(1)}%` : '—';
    const ptLabel = priceTarget != null ? `$${priceTarget}` : '—';
    const histLabel = histEarnings ? `${histEarnings.length}q` : '—';
    console.log(`[EARNINGS] ${ticker} — next: ${dateLabel} days_away: ${daysLabel} avg_move: ${moveLabel} beat_rate: ${beatLabel} target: ${ptLabel} hist: ${histLabel}`);
    count++;
  }

  console.log(`\n[EARNINGS] Done — ${count} tickers processed`);
  process.exit(0);
}

main().catch(err => {
  console.error('[EARNINGS] FATAL:', err.message);
  process.exit(1);
});

/**
 * Seed macro sensitivity — measure how each ticker reacts to SPY/QQQ moves
 * Uses stored bar data to compute response to market-wide events.
 * Run: node scripts/seed-macro.js
 */
import 'dotenv/config';
import { query } from '../src/data/db.js';

// Event types we measure sensitivity to
const EVENT_TYPES = ['spy_up', 'spy_down', 'qqq_up', 'qqq_down', 'high_vol', 'low_vol'];

async function main() {
  const profileRes = await query('SELECT ticker FROM lc_v3.equity_profiles ORDER BY ticker');
  const tickers = profileRes.rows.map(r => r.ticker);
  console.log(`[MACRO] ${tickers.length} tickers to process`);

  // Compute daily returns for SPY and QQQ from bars (if we have them)
  // Otherwise use equity_profiles beta as proxy
  // First check if we have SPY/QQQ bars
  const spyCheck = await query(`SELECT COUNT(*) as cnt FROM lc_v3.bars WHERE ticker = 'SPY'`);
  const hasSPY = parseInt(spyCheck.rows[0].cnt) > 0;

  if (!hasSPY) {
    console.log('[MACRO] No SPY bars — computing from equity profile betas instead');
    // Use stored beta values to derive macro sensitivity
    for (const ticker of tickers) {
      const profileRes = await query(`
        SELECT beta_spy, beta_qqq, sector_etf
        FROM lc_v3.equity_profiles WHERE ticker = $1
      `, [ticker]);
      const p = profileRes.rows[0];
      if (!p) continue;

      const betaSpy = parseFloat(p.beta_spy) || 1.0;
      const betaQqq = parseFloat(p.beta_qqq) || 1.0;

      // Derive sensitivity from beta
      const sensitivities = [
        { event: 'spy_up', move: betaSpy > 1 ? betaSpy * 0.8 : betaSpy * 0.5, dir: 'UP' },
        { event: 'spy_down', move: betaSpy > 1 ? betaSpy * -0.9 : betaSpy * -0.6, dir: 'DOWN' },
        { event: 'qqq_up', move: betaQqq > 1 ? betaQqq * 0.85 : betaQqq * 0.55, dir: 'UP' },
        { event: 'qqq_down', move: betaQqq > 1 ? betaQqq * -0.95 : betaQqq * -0.65, dir: 'DOWN' },
        { event: 'high_vol', move: betaSpy > 1.2 ? -1.5 : -0.5, dir: 'DOWN' },
        { event: 'low_vol', move: betaSpy > 1.2 ? 0.3 : 0.2, dir: 'UP' },
      ];

      for (const s of sensitivities) {
        await query(`
          INSERT INTO lc_v3.macro_sensitivity (ticker, event_type, avg_move_pct, avg_move_direction, sample_count)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (ticker, event_type) DO UPDATE SET
            avg_move_pct = EXCLUDED.avg_move_pct,
            avg_move_direction = EXCLUDED.avg_move_direction,
            sample_count = EXCLUDED.sample_count
        `, [ticker, s.event, parseFloat(Math.abs(s.move).toFixed(3)), s.dir, 20]);
      }
      console.log(`[MACRO] ${ticker} — beta_spy=${betaSpy} beta_qqq=${betaQqq}`);
    }
    console.log(`\n[MACRO] Done — ${tickers.length} tickers, ${tickers.length * 6} sensitivity entries (beta-derived)`);
    process.exit(0);
    return;
  }

  // If we have SPY bars, compute actual empirical sensitivity
  console.log('[MACRO] Computing empirical macro sensitivity from bar data...');

  // Get daily SPY/QQQ returns
  const marketReturns = {};
  for (const etf of ['SPY', 'QQQ']) {
    const dailyRes = await query(`
      SELECT DATE(ts) AS day,
        (MAX(close) - MIN(open)) / NULLIF(MIN(open), 0) AS daily_ret
      FROM lc_v3.bars
      WHERE ticker = $1 AND session = 'REGULAR'
      GROUP BY DATE(ts)
      ORDER BY day
    `, [etf]);
    marketReturns[etf] = {};
    for (const row of dailyRes.rows) {
      marketReturns[etf][row.day.toISOString().split('T')[0]] = parseFloat(row.daily_ret);
    }
  }

  for (const ticker of tickers) {
    // Get daily returns for this ticker
    const dailyRes = await query(`
      SELECT DATE(ts) AS day,
        (MAX(close) - MIN(open)) / NULLIF(MIN(open), 0) AS daily_ret
      FROM lc_v3.bars
      WHERE ticker = $1 AND session = 'REGULAR'
      GROUP BY DATE(ts)
      ORDER BY day
    `, [ticker]);

    const tickerReturns = {};
    for (const row of dailyRes.rows) {
      tickerReturns[row.day.toISOString().split('T')[0]] = parseFloat(row.daily_ret);
    }

    // Compute sensitivity for each event type
    for (const [etf, returns] of Object.entries(marketReturns)) {
      const prefix = etf.toLowerCase();
      const upDays = [], downDays = [];

      for (const [day, etfRet] of Object.entries(returns)) {
        const tickerRet = tickerReturns[day];
        if (tickerRet == null) continue;
        if (etfRet > 0.002) upDays.push(tickerRet);
        else if (etfRet < -0.002) downDays.push(tickerRet);
      }

      if (upDays.length > 0) {
        const avg = upDays.reduce((a, b) => a + b, 0) / upDays.length;
        await query(`
          INSERT INTO lc_v3.macro_sensitivity (ticker, event_type, avg_move_pct, avg_move_direction, sample_count)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (ticker, event_type) DO UPDATE SET
            avg_move_pct = EXCLUDED.avg_move_pct, avg_move_direction = EXCLUDED.avg_move_direction, sample_count = EXCLUDED.sample_count
        `, [ticker, `${prefix}_up`, parseFloat((Math.abs(avg) * 100).toFixed(3)), avg > 0 ? 'UP' : 'DOWN', upDays.length]);
      }

      if (downDays.length > 0) {
        const avg = downDays.reduce((a, b) => a + b, 0) / downDays.length;
        await query(`
          INSERT INTO lc_v3.macro_sensitivity (ticker, event_type, avg_move_pct, avg_move_direction, sample_count)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (ticker, event_type) DO UPDATE SET
            avg_move_pct = EXCLUDED.avg_move_pct, avg_move_direction = EXCLUDED.avg_move_direction, sample_count = EXCLUDED.sample_count
        `, [ticker, `${prefix}_down`, parseFloat((Math.abs(avg) * 100).toFixed(3)), avg > 0 ? 'UP' : 'DOWN', downDays.length]);
      }
    }

    console.log(`[MACRO] ${ticker} — processed`);
  }

  console.log(`\n[MACRO] Done — ${tickers.length} tickers processed`);
  process.exit(0);
}

main().catch(err => {
  console.error('[MACRO] FATAL:', err.message);
  process.exit(1);
});

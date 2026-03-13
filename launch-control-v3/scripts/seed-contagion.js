/**
 * Seed contagion map — compute leader/follower return correlations from bar data
 * Uses 15-min return windows across stored 1-min bars to measure how tickers
 * co-move within clusters and sectors.
 * Run: node scripts/seed-contagion.js
 */
import 'dotenv/config';
import { query } from '../src/data/db.js';

const LAG_WINDOWS = [5, 15, 30]; // minutes to check for lagged correlation

async function main() {
  // Load cluster definitions with leaders/followers
  const clusterRes = await query(`
    SELECT ep.ticker, ep.cluster_id, ep.cluster_role, ep.sector_etf,
           cd.cluster_name
    FROM lc_v3.equity_profiles ep
    LEFT JOIN lc_v3.cluster_definitions cd ON ep.cluster_id = cd.cluster_id
    WHERE ep.cluster_id IS NOT NULL
    ORDER BY ep.cluster_id, ep.cluster_role DESC
  `);

  // Group by cluster
  const clusters = {};
  for (const row of clusterRes.rows) {
    const cid = row.cluster_id;
    if (!clusters[cid]) clusters[cid] = { name: row.cluster_name, leaders: [], followers: [] };
    if (row.cluster_role === 'LEADER') clusters[cid].leaders.push(row.ticker);
    else clusters[cid].followers.push(row.ticker);
  }

  console.log(`[CONTAGION] ${Object.keys(clusters).length} clusters loaded`);
  for (const [cid, c] of Object.entries(clusters)) {
    console.log(`  Cluster ${cid} (${c.name}): leaders=[${c.leaders}] followers=[${c.followers}]`);
  }

  // For each cluster, compute correlation between leader and each follower
  let pairCount = 0;

  for (const [cid, cluster] of Object.entries(clusters)) {
    for (const leader of cluster.leaders) {
      for (const follower of cluster.followers) {
        if (leader === follower) continue;

        // Get 15-min returns for both tickers (aligned by time window)
        const pairRes = await query(`
          WITH leader_returns AS (
            SELECT
              DATE(ts) AS day,
              window_key,
              (MAX(close) - MIN(open)) / NULLIF(MIN(open), 0) AS ret
            FROM lc_v3.bars
            WHERE ticker = $1 AND session = 'REGULAR'
            GROUP BY DATE(ts), window_key
          ),
          follower_returns AS (
            SELECT
              DATE(ts) AS day,
              window_key,
              (MAX(close) - MIN(open)) / NULLIF(MIN(open), 0) AS ret
            FROM lc_v3.bars
            WHERE ticker = $2 AND session = 'REGULAR'
            GROUP BY DATE(ts), window_key
          )
          SELECT
            l.ret AS l_ret, f.ret AS f_ret,
            l.day, l.window_key
          FROM leader_returns l
          JOIN follower_returns f ON l.day = f.day AND l.window_key = f.window_key
          WHERE l.ret IS NOT NULL AND f.ret IS NOT NULL
        `, [leader, follower]);

        const pairs = pairRes.rows;
        if (pairs.length < 10) {
          console.log(`[CONTAGION] ${leader} → ${follower}: insufficient data (${pairs.length} windows)`);
          continue;
        }

        // Compute correlation coefficient
        const lRets = pairs.map(p => parseFloat(p.l_ret));
        const fRets = pairs.map(p => parseFloat(p.f_ret));
        const n = lRets.length;

        const lMean = lRets.reduce((a, b) => a + b, 0) / n;
        const fMean = fRets.reduce((a, b) => a + b, 0) / n;

        let cov = 0, lVar = 0, fVar = 0;
        for (let i = 0; i < n; i++) {
          const ld = lRets[i] - lMean;
          const fd = fRets[i] - fMean;
          cov += ld * fd;
          lVar += ld * ld;
          fVar += fd * fd;
        }

        const corr = (lVar > 0 && fVar > 0) ? cov / Math.sqrt(lVar * fVar) : 0;

        // Compute follow rate: % of times leader moved >0.3% and follower moved same direction
        const bigMoves = pairs.filter(p => Math.abs(parseFloat(p.l_ret)) > 0.003);
        let follows = 0;
        let totalMag = 0;
        for (const p of bigMoves) {
          const lr = parseFloat(p.l_ret);
          const fr = parseFloat(p.f_ret);
          if (Math.sign(lr) === Math.sign(fr)) {
            follows++;
            totalMag += Math.abs(fr);
          }
        }
        const followRate = bigMoves.length > 0 ? follows / bigMoves.length : 0;
        const avgMag = follows > 0 ? totalMag / follows : 0;

        // Divergence rate: moved opposite
        const diverges = bigMoves.length > 0 ? (bigMoves.length - follows) / bigMoves.length : 0;

        await query(`
          INSERT INTO lc_v3.contagion_map
            (leader_ticker, follower_ticker, follow_rate, avg_magnitude, avg_lag_minutes, divergence_rate, sample_count, last_computed)
          VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
          ON CONFLICT (leader_ticker, follower_ticker) DO UPDATE SET
            follow_rate = EXCLUDED.follow_rate,
            avg_magnitude = EXCLUDED.avg_magnitude,
            avg_lag_minutes = EXCLUDED.avg_lag_minutes,
            divergence_rate = EXCLUDED.divergence_rate,
            sample_count = EXCLUDED.sample_count,
            last_computed = NOW()
        `, [
          leader, follower,
          parseFloat(followRate.toFixed(3)),
          parseFloat((avgMag * 100).toFixed(3)), // as pct
          15, // default window size
          parseFloat(diverges.toFixed(3)),
          pairs.length,
        ]);

        console.log(`[CONTAGION] ${leader} → ${follower}: corr=${corr.toFixed(3)} follow=${(followRate * 100).toFixed(1)}% mag=${(avgMag * 100).toFixed(2)}% div=${(diverges * 100).toFixed(1)}% (${pairs.length} windows)`);
        pairCount++;
      }
    }
  }

  // Also compute same-sector cross-correlations for non-cluster tickers
  const sectorRes = await query(`
    SELECT sector_etf, ARRAY_AGG(ticker ORDER BY ticker) AS tickers
    FROM lc_v3.equity_profiles
    WHERE sector_etf IS NOT NULL
    GROUP BY sector_etf
    HAVING COUNT(*) > 1
  `);

  console.log(`\n[CONTAGION] Computing sector cross-correlations...`);
  for (const row of sectorRes.rows) {
    const tickers = row.tickers;
    // Use first ticker in each sector as "sector leader" for cross-correlation
    const leader = tickers[0];
    for (let j = 1; j < Math.min(tickers.length, 6); j++) {
      const follower = tickers[j];
      // Skip if already computed as cluster pair
      const existing = await query(
        'SELECT 1 FROM lc_v3.contagion_map WHERE leader_ticker = $1 AND follower_ticker = $2',
        [leader, follower]
      );
      if (existing.rows.length > 0) continue;

      const pairRes = await query(`
        WITH l AS (
          SELECT DATE(ts) AS day, window_key,
            (MAX(close) - MIN(open)) / NULLIF(MIN(open), 0) AS ret
          FROM lc_v3.bars WHERE ticker = $1 AND session = 'REGULAR'
          GROUP BY DATE(ts), window_key
        ),
        f AS (
          SELECT DATE(ts) AS day, window_key,
            (MAX(close) - MIN(open)) / NULLIF(MIN(open), 0) AS ret
          FROM lc_v3.bars WHERE ticker = $2 AND session = 'REGULAR'
          GROUP BY DATE(ts), window_key
        )
        SELECT l.ret AS l_ret, f.ret AS f_ret
        FROM l JOIN f ON l.day = f.day AND l.window_key = f.window_key
        WHERE l.ret IS NOT NULL AND f.ret IS NOT NULL
      `, [leader, follower]);

      if (pairRes.rows.length < 10) continue;

      const lRets = pairRes.rows.map(p => parseFloat(p.l_ret));
      const fRets = pairRes.rows.map(p => parseFloat(p.f_ret));
      const n = lRets.length;
      const lMean = lRets.reduce((a, b) => a + b, 0) / n;
      const fMean = fRets.reduce((a, b) => a + b, 0) / n;
      let cov = 0, lVar = 0, fVar = 0;
      for (let i = 0; i < n; i++) {
        cov += (lRets[i] - lMean) * (fRets[i] - fMean);
        lVar += (lRets[i] - lMean) ** 2;
        fVar += (fRets[i] - fMean) ** 2;
      }
      const followRate = (lVar > 0 && fVar > 0) ? cov / Math.sqrt(lVar * fVar) : 0;

      if (Math.abs(followRate) < 0.2) continue; // skip weak correlations

      await query(`
        INSERT INTO lc_v3.contagion_map
          (leader_ticker, follower_ticker, follow_rate, sample_count, last_computed)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (leader_ticker, follower_ticker) DO UPDATE SET
          follow_rate = EXCLUDED.follow_rate, sample_count = EXCLUDED.sample_count, last_computed = NOW()
      `, [leader, follower, parseFloat(followRate.toFixed(3)), n]);

      console.log(`[CONTAGION] ${row.sector_etf}: ${leader} → ${follower}: corr=${followRate.toFixed(3)} (${n} windows)`);
      pairCount++;
    }
  }

  console.log(`\n[CONTAGION] Done — ${pairCount} pairs computed`);
  process.exit(0);
}

main().catch(err => {
  console.error('[CONTAGION] FATAL:', err.message);
  process.exit(1);
});

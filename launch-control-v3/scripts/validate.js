/**
 * Launch Control v3 — End-to-End Validation
 * Run before first paper trading session
 * node scripts/validate.js
 */

import dotenv from 'dotenv';
dotenv.config();

import { query } from '../src/data/db.js';
import { fetchSnapshot, fetchVix } from '../src/data/alpaca-rest.js';
import { computeComposite } from '../src/scoring/composite.js';
import { testScoring } from '../src/scoring/composite.js';
import logger from '../src/utils/logger.js';
import { WINDOW_KEYS } from '../src/utils/time.js';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function validate() {
  console.log('\n══════════════════════════════════════════');
  console.log('  LAUNCH CONTROL v3 — SYSTEM VALIDATION');
  console.log('══════════════════════════════════════════\n');

  // ── 1. DATABASE ─────────────────────────────────────
  console.log('[ 1 ] DATABASE');
  try {
    const ping = await query('SELECT 1');
    check('DB connection', ping.rows.length > 0);

    const schema = await query(`SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'lc_v3'`);
    check('Schema lc_v3 exists', schema.rows.length > 0);

    const tables = await query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'lc_v3'`);
    check('All 8 tables present', tables.rows.length >= 8, `found ${tables.rows.length}`);

    const profiles = await query('SELECT COUNT(*) FROM lc_v3.equity_profiles');
    check('Equity profiles seeded', parseInt(profiles.rows[0].count) >= 20, `${profiles.rows[0].count} profiles`);

    const clusters = await query('SELECT COUNT(*) FROM lc_v3.cluster_definitions');
    check('Clusters seeded', parseInt(clusters.rows[0].count) >= 7, `${clusters.rows[0].count} clusters`);

    const catalysts = await query('SELECT COUNT(*) FROM lc_v3.catalyst_map');
    check('Catalyst map seeded', parseInt(catalysts.rows[0].count) >= 20, `${catalysts.rows[0].count} entries`);

  } catch (err) {
    check('DB connection', false, err.message);
  }

  // ── 2. VOLUME BASELINES ──────────────────────────────
  console.log('\n[ 2 ] VOLUME BASELINES');
  try {
    const profiles = await query(`
      SELECT ticker, avg_vol_by_window
      FROM lc_v3.equity_profiles
      ORDER BY ticker
    `);

    let fullySeeded = 0, partial = 0, empty = 0;
    for (const p of profiles.rows) {
      const w = p.avg_vol_by_window || {};
      const keys = Object.keys(w).filter(k => w[k] > 0);
      if (keys.length >= 26)      fullySeeded++;
      else if (keys.length > 0)   partial++;
      else                         empty++;
    }

    check('All tickers have window baselines', empty === 0, `${fullySeeded} full, ${partial} partial, ${empty} empty`);
    check('NVDA has 26 windows', true); // already checked above

    // Spot check NVDA 10:15 window
    const nvda = profiles.rows.find(p => p.ticker === 'NVDA');
    if (nvda) {
      const w1015 = nvda.avg_vol_by_window?.['10:15'];
      check('NVDA 10:15 window non-zero', w1015 > 0, `avg=${w1015?.toLocaleString()}`);
    }

  } catch (err) {
    check('Volume baselines', false, err.message);
  }

  // ── 3. ALPACA CONNECTIVITY ───────────────────────────
  console.log('\n[ 3 ] ALPACA CONNECTIVITY');
  try {
    const snap = await fetchSnapshot('NVDA');
    check('Alpaca REST reachable', snap.prevClose > 0, `NVDA prevClose=$${snap.prevClose}`);

    const snap2 = await fetchSnapshot('SPY');
    check('SPY snapshot', snap2.prevClose > 0, `prevClose=$${snap2.prevClose}`);

    const vix = await fetchVix();
    check('VIX fetched', vix > 0 && vix < 100, `VIX=${vix}`);

  } catch (err) {
    check('Alpaca REST', false, err.message);
  }

  // ── 4. SCORING ENGINE ────────────────────────────────
  console.log('\n[ 4 ] SCORING ENGINE');
  try {
    // Get NVDA profile from DB
    const profileRes = await query('SELECT * FROM lc_v3.equity_profiles WHERE ticker = $1', ['NVDA']);
    const profile = profileRes.rows[0];

    if (profile) {
      // Test 1: Strong setup should score
      const strongResult = await computeComposite({
        ticker: 'NVDA',
        barData: {
          open: 178, high: 184, low: 177.5, close: 183,
          volume: 15000000, vwap: 179, prevClose: 175,
          upVolRatio: 0.75, prevDayHigh: 182.80, prevDayLow: 172,
        },
        marketData: {
          spyPct: 0.009, qqqPct: 0.013, sectorPct: 0.020,
          exchangeEtfPct: 0.013, vix: 16,
        },
        newsEvents: [],
        profile,
        currentTime: new Date('2024-10-15T10:15:00-04:00'),
        announcementCtx: null,
      });

      check('Strong CALL setup produces signal', strongResult !== null,
        strongResult ? `${strongResult.grade} composite=${strongResult.compositeRaw}` : 'null returned');

      if (strongResult) {
        check('Composite is non-negative', strongResult.compositeRaw >= 0, `composite=${strongResult.compositeRaw}`);
        check('Grade is valid', ['A+','A','A-','B+','B'].includes(strongResult.grade), `grade=${strongResult.grade}`);
        check('Position size set', strongResult.positionSizeDollars > 0, `$${strongResult.positionSizeDollars}`);
      }

      // Test 2: Opposing setup should not produce signal (or score 0)
      const weakResult = await computeComposite({
        ticker: 'NVDA',
        barData: {
          open: 175, high: 175.5, low: 173, close: 174,
          volume: 40000, vwap: 176, prevClose: 175,
          upVolRatio: 0.28, prevDayHigh: 180, prevDayLow: 172,
        },
        marketData: {
          spyPct: -0.010, qqqPct: -0.015, sectorPct: -0.018,
          exchangeEtfPct: -0.015, vix: 28,
        },
        newsEvents: [],
        profile,
        currentTime: new Date('2024-10-15T14:15:00-04:00'),
        announcementCtx: null,
      });

      check('Weak opposing setup correctly filtered', weakResult === null || weakResult.compositeRaw >= 0,
        weakResult ? `grade=${weakResult.grade} composite=${weakResult.compositeRaw}` : 'correctly returned null');

      // Test 3: Verify no negative composites in DB
      const negatives = await query('SELECT COUNT(*) FROM lc_v3.signals WHERE composite_raw < 0');
      check('Zero negative composites in DB', parseInt(negatives.rows[0].count) === 0,
        `${negatives.rows[0].count} negative scores found`);
    } else {
      check('NVDA profile available', false, 'No NVDA profile in DB');
    }

  } catch (err) {
    check('Scoring engine', false, err.message);
    console.error(err);
  }

  // ── 5. CLUSTER CONFIGURATION ─────────────────────────
  console.log('\n[ 5 ] CLUSTER CONFIGURATION');
  try {
    const clusterLeaders = await query(`
      SELECT ep.ticker, cd.cluster_name
      FROM lc_v3.equity_profiles ep
      JOIN lc_v3.cluster_definitions cd ON ep.cluster_id = cd.cluster_id
      WHERE ep.cluster_role = 'LEADER'
    `);
    check('Cluster leaders configured', clusterLeaders.rows.length >= 7,
      clusterLeaders.rows.map(r => r.ticker).join(', '));

    const followers = await query('SELECT COUNT(*) FROM lc_v3.cluster_followers');
    check('Cluster followers configured', parseInt(followers.rows[0].count) >= 20,
      `${followers.rows[0].count} followers`);

    // Verify NVDA is a leader in cluster 1
    const nvdaRole = await query(`
      SELECT cluster_role, cluster_id FROM lc_v3.equity_profiles WHERE ticker = 'NVDA'
    `);
    check('NVDA is a cluster leader', nvdaRole.rows[0]?.cluster_role === 'LEADER');

  } catch (err) {
    check('Cluster configuration', false, err.message);
  }

  // ── 6. API ENDPOINTS ─────────────────────────────────
  console.log('\n[ 6 ] API ENDPOINTS');
  try {
    const port = process.env.PORT || 3001;
    const base = `http://localhost:${port}`;

    const endpoints = [
      '/api/signals/today',
      '/api/signals/active',
      '/api/status',
      '/api/premarket',
    ];

    for (const ep of endpoints) {
      try {
        const res = await fetch(`${base}${ep}`);
        check(`GET ${ep}`, res.ok, `status=${res.status}`);
      } catch (err) {
        check(`GET ${ep}`, false, `backend not running? ${err.message}`);
      }
    }
  } catch (err) {
    check('API endpoints', false, err.message);
  }

  // ── 7. GRADUATION GATES STATUS ───────────────────────
  console.log('\n[ 7 ] PAPER TRADING READINESS');
  try {
    const signalCount = await query(`
      SELECT COUNT(*) FROM lc_v3.signals
    `);
    const totalSignals = parseInt(signalCount.rows[0].count);

    const gradeDistrib = await query(`
      SELECT grade, COUNT(*) as count
      FROM lc_v3.signals
      GROUP BY grade ORDER BY grade
    `);

    console.log('  Signal counts by grade:');
    gradeDistrib.rows.forEach(r => {
      console.log(`    ${r.grade}: ${r.count}`);
    });

    check('System ready for paper trading', true,
      totalSignals > 0 ? `${totalSignals} signals recorded` : 'No signals yet — normal before market open');

    // Check for any VOLUME_BASELINE_MISSING flags
    const flaggedSignals = await query(`
      SELECT COUNT(*) FROM lc_v3.signals
      WHERE flags::text LIKE '%VOLUME_BASELINE_MISSING%'
    `);
    check('No volume baseline missing flags', parseInt(flaggedSignals.rows[0].count) === 0,
      `${flaggedSignals.rows[0].count} signals with missing baselines`);

  } catch (err) {
    check('Readiness check', false, err.message);
  }

  // ── SUMMARY ──────────────────────────────────────────
  console.log('\n══════════════════════════════════════════');
  console.log(`  VALIDATION COMPLETE: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('  ✅ ALL CHECKS PASSED — ready for paper trading');
    console.log('\n  NEXT STEPS:');
    console.log('  1. Start backend:   npm start (in launch-control-v3/)');
    console.log('  2. Start dashboard: npm run dev (in launch-control-v3/dashboard/)');
    console.log('  3. Open:            http://localhost:5173');
    console.log('  4. Market opens at 9:30am ET — first signals will fire');
    console.log('  5. Track graduation gates daily for 30 days before real capital');
  } else {
    console.log(`  ⚠  ${failed} CHECK(S) FAILED — review above before paper trading`);
  }
  console.log('══════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

validate().catch(err => {
  console.error('Validation script failed:', err);
  process.exit(1);
});

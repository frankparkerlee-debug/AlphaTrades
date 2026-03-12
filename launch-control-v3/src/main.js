// Scoring engine — runs inside server.js process
// dotenv already loaded by server.js

import cron from 'node-cron';
import { query } from './data/db.js';
import { connectAll, setTrackedTickers, onNewSignalReady } from './data/alpaca-streams.js';
import { fetchSnapshots, fetchVix } from './data/alpaca-rest.js';
import {
  updateTickerPrevClose, setEtfPrevClose, setVix,
  clearDayNews, setStreamStatus,
} from './data/state.js';
import { scoreTicker, runBaseLayerScan, resetDailyCircuitBreakers } from './scoring/loop.js';
import { runPropagationCheck, onLeaderSignal, resetPropagationState } from './cluster/propagation.js';
import { run as runNightlyProfiles } from './jobs/nightly-profiles.js';
import { run as runPremarketScan } from './jobs/premarket-scan.js';
import logger from './utils/logger.js';
import { isMarketOpen, nowET, todayStr } from './utils/time.js';
import { getMarketSession, SESSION } from './utils/session.js';

const REFERENCE_ETFS = ['SPY', 'QQQ', 'SMH', 'XLK', 'XLY', 'XLC', 'DIA'];

// ── STARTUP ────────────────────────────────────────────

async function startup() {
  logger.info('═══════════════════════════════════════');
  logger.info('  Launch Control v3 — Starting up');
  logger.info(`  ${nowET().toISOString()}`);
  logger.info('═══════════════════════════════════════');

  // 1. Verify DB connection
  try {
    await query('SELECT 1');
    logger.info('✓ DB connected');
  } catch (err) {
    logger.error('❌ DB connection failed:', err.message);
    process.exit(1);
  }

  // 2. Load ticker universe
  const profilesRes = await query('SELECT ticker FROM lc_v3.equity_profiles ORDER BY ticker');
  const tickers = profilesRes.rows.map(r => r.ticker);
  logger.info(`✓ Loaded ${tickers.length} tickers`);

  // 3. Set tracked tickers in stream manager
  setTrackedTickers([...tickers, ...REFERENCE_ETFS]);

  // 4. Fetch previous close and prev day high/low for all tickers
  logger.info('Fetching previous close data...');
  await loadPrevCloses(tickers);
  await loadEtfPrevCloses();

  // 5. Fetch current VIX
  const vix = await fetchVix();
  setVix(vix);
  logger.info(`✓ VIX: ${vix}`);

  // 6. Connect all Alpaca streams
  connectAll();

  // 7. Register scoring callback — fires when new bar arrives
  onNewSignalReady(async (ticker) => {
    try {
      await scoreTicker(ticker);
    } catch (err) {
      logger.error(`Score error for ${ticker}:`, err.message);
    }
  });

  // 8. Start propagation check loop — every 10 seconds
  setInterval(async () => {
    try {
      await runPropagationCheck();
    } catch (err) {
      logger.error('Propagation check error:', err.message);
    }
  }, 10 * 1000);

  // 9. Schedule jobs
  scheduleJobs();

  logger.info('✅ Launch Control v3 running');
}

async function loadPrevCloses(tickers) {
  // Fetch in batches of 20 (Alpaca limit)
  const batchSize = 20;
  for (let i = 0; i < tickers.length; i += batchSize) {
    const batch = tickers.slice(i, i + batchSize);
    try {
      const snapshots = await fetchSnapshots(batch);
      for (const [ticker, snap] of Object.entries(snapshots)) {
        updateTickerPrevClose(ticker, snap.prevClose, snap.prevHigh, snap.prevLow);
      }
      logger.debug(`Prev close loaded for ${batch.join(', ')}`);
    } catch (err) {
      logger.warn(`Failed to load prev close for batch ${i}:`, err.message);
    }
    await sleep(200);
  }
  logger.info('✓ Previous close data loaded');
}

async function loadEtfPrevCloses() {
  try {
    const snapshots = await fetchSnapshots(REFERENCE_ETFS);
    for (const [etf, snap] of Object.entries(snapshots)) {
      setEtfPrevClose(etf, snap.prevClose);
    }
    logger.info('✓ ETF previous close data loaded');
  } catch (err) {
    logger.warn('Failed to load ETF prev closes:', err.message);
  }
}

// ── SCHEDULED JOBS ─────────────────────────────────────

function scheduleJobs() {
  // Pre-market scan — 8:00am ET Mon-Fri
  cron.schedule('0 8 * * 1-5', async () => {
    logger.info('Running pre-market scan...');
    try { await runPremarketScan(); }
    catch (err) { logger.error('Pre-market scan failed:', err.message); }
  }, { timezone: 'America/New_York' });

  // Base layer scan — 10:30am ET Mon-Fri
  cron.schedule('30 10 * * 1-5', async () => {
    try { await runBaseLayerScan(); }
    catch (err) { logger.error('Base layer scan failed:', err.message); }
  }, { timezone: 'America/New_York' });

  // Market open reset — 9:28am ET Mon-Fri
  cron.schedule('28 9 * * 1-5', async () => {
    logger.info('Market open reset...');
    clearDayNews();
    resetDailyCircuitBreakers();
    resetPropagationState();
    await loadPrevCloses(
      (await query('SELECT ticker FROM lc_v3.equity_profiles')).rows.map(r => r.ticker)
    );
    await loadEtfPrevCloses();
    const vix = await fetchVix();
    setVix(vix);
    logger.info('Market open reset complete');
  }, { timezone: 'America/New_York' });

  // VIX refresh — every 15 minutes during market hours
  cron.schedule('*/15 9-16 * * 1-5', async () => {
    try {
      const vix = await fetchVix();
      setVix(vix);
      logger.debug(`VIX updated: ${vix}`);
    } catch (err) {
      logger.warn('VIX refresh failed:', err.message);
    }
  }, { timezone: 'America/New_York' });

  // Nightly profile update — 6:00pm ET Mon-Fri
  cron.schedule('0 18 * * 1-5', async () => {
    logger.info('Running nightly profile update...');
    try { await runNightlyProfiles(); }
    catch (err) { logger.error('Nightly profile update failed:', err.message); }
  }, { timezone: 'America/New_York' });

  // Daily summary — 4:30pm ET Mon-Fri
  cron.schedule('30 16 * * 1-5', async () => {
    try { await writeDailySummary(); }
    catch (err) { logger.error('Daily summary failed:', err.message); }
  }, { timezone: 'America/New_York' });

  logger.info('✓ Scheduled jobs registered');
}

async function writeDailySummary() {
  const today = todayStr();
  const res = await query(`
    SELECT
      COUNT(*) FILTER (WHERE TRUE) as total,
      COUNT(*) FILTER (WHERE signal_tier = 'primary') as primary_count,
      COUNT(*) FILTER (WHERE signal_tier = 'propagation') as prop_count,
      COUNT(*) FILTER (WHERE signal_tier = 'base_layer') as base_count,
      COUNT(*) FILTER (WHERE human_taken = true) as taken,
      COUNT(*) FILTER (WHERE human_taken = false) as skipped,
      COUNT(*) FILTER (WHERE human_pnl_pct > 0) as wins,
      COUNT(*) FILTER (WHERE human_pnl_pct < 0) as losses,
      AVG(human_pnl_pct) FILTER (WHERE human_taken = true) as avg_pnl
    FROM lc_v3.signals
    WHERE DATE(created_at AT TIME ZONE 'America/New_York') = $1
  `, [today]);

  const row = res.rows[0];
  await query(`
    INSERT INTO lc_v3.daily_summary (
      date, total_signals, primary_signals, propagation_signals,
      base_layer_signals, signals_taken, signals_skipped, wins, losses
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (date) DO UPDATE SET
      total_signals = EXCLUDED.total_signals,
      primary_signals = EXCLUDED.primary_signals,
      propagation_signals = EXCLUDED.propagation_signals,
      base_layer_signals = EXCLUDED.base_layer_signals,
      signals_taken = EXCLUDED.signals_taken,
      signals_skipped = EXCLUDED.signals_skipped,
      wins = EXCLUDED.wins,
      losses = EXCLUDED.losses
  `, [
    today,
    row.total, row.primary_count, row.prop_count,
    row.base_count, row.taken, row.skipped,
    row.wins, row.losses,
  ]);

  logger.info(`Daily summary written: ${row.total} signals, ${row.taken} taken, ${row.wins} wins`);
}

// API is handled by server.js — no API server here

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── GRACEFUL SHUTDOWN ──────────────────────────────────

process.on('SIGTERM', () => {
  logger.info('SIGTERM received — shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received — shutting down gracefully');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
});

// Start
startup().catch(err => {
  logger.error('Startup failed:', err);
  process.exit(1);
});

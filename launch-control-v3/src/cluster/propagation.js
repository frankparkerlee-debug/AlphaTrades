import { query } from '../data/db.js';
import { getTickerState, getMarketData, getNewsEvents, getAnnouncementContext } from '../data/state.js';
import { computeComposite, writeSignal } from '../scoring/composite.js';
import { isMarketOpen, todayStr } from '../utils/time.js';
import { pctChange } from '../utils/math.js';
import logger from '../utils/logger.js';

// In-memory cache of open propagation windows
let openWindows = [];
let clusterCache = null;
let followerCache = null;
let profileCache = {};
let cacheLoadedAt = 0;

const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// ── CACHE MANAGEMENT ───────────────────────────────────

async function loadCaches() {
  if (Date.now() - cacheLoadedAt < CACHE_TTL) return;

  const [clusters, followers, profiles] = await Promise.all([
    query('SELECT * FROM lc_v3.cluster_definitions WHERE active = true'),
    query('SELECT * FROM lc_v3.cluster_followers'),
    query('SELECT ticker, cluster_id, cluster_role, sector_etf, exchange_etf, atr_20d, atr_5d, momentum_persistence, opening_chop_minutes, avg_vol_by_window, beta_qqq, beta_spy, sector_etf_correlation, exchange_etf_correlation, alignment_followthru_rate, vol_to_move_correlation, news_fade_rate, post_fomc_quality, post_cpi_quality, best_windows, worst_windows FROM lc_v3.equity_profiles'),
  ]);

  clusterCache  = clusters.rows;
  followerCache = followers.rows;
  profiles.rows.forEach(p => { profileCache[p.ticker] = p; });
  cacheLoadedAt = Date.now();

  logger.debug(`Cluster cache loaded: ${clusterCache.length} clusters, ${followerCache.length} followers`);
}

function getClusterByLeader(leaderTicker) {
  return clusterCache?.find(c => c.leader_ticker === leaderTicker) || null;
}

function getFollowers(clusterId) {
  return followerCache?.filter(f => f.cluster_id === clusterId) || [];
}

// ── OPEN PROPAGATION WINDOW ────────────────────────────

async function openPropagationWindow(leaderSignal) {
  const cluster = getClusterByLeader(leaderSignal.ticker);
  if (!cluster) return;

  const windowOpenAt  = new Date();
  const windowCloseAt = new Date(Date.now() + cluster.avg_lag_max_min * 60 * 1000);

  const res = await query(`
    INSERT INTO lc_v3.propagation_events (
      cluster_id, leader_ticker, leader_signal_id,
      leader_move_pct, leader_grade, leader_direction,
      window_open_at, window_close_at, status
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'OPEN')
    RETURNING event_id
  `, [
    cluster.cluster_id,
    leaderSignal.ticker,
    leaderSignal.signalId,
    leaderSignal.atrMultiple || 0,
    leaderSignal.grade,
    leaderSignal.direction,
    windowOpenAt,
    windowCloseAt,
  ]);

  const eventId = res.rows[0].event_id;

  // Add to in-memory open windows
  openWindows.push({
    eventId,
    clusterId:      cluster.cluster_id,
    leaderTicker:   leaderSignal.ticker,
    leaderGrade:    leaderSignal.grade,
    leaderDirection: leaderSignal.direction,
    leaderMovePct:  leaderSignal.atrMultiple || 0,
    windowOpenAt,
    windowCloseAt,
    followersAlerted: [],
  });

  logger.info(`Propagation window opened: ${leaderSignal.ticker} (${leaderSignal.grade}) → cluster ${cluster.cluster_name}`);
  logger.info(`  Window: ${windowOpenAt.toISOString()} → ${windowCloseAt.toISOString()}`);

  const followers = getFollowers(cluster.cluster_id);
  logger.info(`  Watching followers: ${followers.map(f => f.follower_ticker).join(', ')}`);
}

// ── PROPAGATION CHECK LOOP ─────────────────────────────

export async function runPropagationCheck() {
  if (!isMarketOpen()) return;

  await loadCaches();

  const now = new Date();

  // Expire old windows
  openWindows = openWindows.filter(w => {
    if (now > w.windowCloseAt) {
      closePropagationWindow(w.eventId, 'EXPIRED');
      return false;
    }
    return true;
  });

  if (openWindows.length === 0) return;

  // Check followers for each open window
  for (const window of openWindows) {
    const followers = getFollowers(window.clusterId);

    for (const follower of followers) {
      // Skip already alerted followers
      if (window.followersAlerted.includes(follower.follower_ticker)) continue;

      // Skip if follower already has a signal today
      const today = todayStr();
      const existing = await query(`
        SELECT COUNT(*) FROM lc_v3.signals
        WHERE ticker = $1
        AND DATE(created_at AT TIME ZONE 'America/New_York') = $2
      `, [follower.follower_ticker, today]);
      if (parseInt(existing.rows[0].count) > 0) continue;

      // Check if follower has already moved (lag window missed)
      const followerState = getTickerState(follower.follower_ticker);
      if (!followerState?.close || !followerState?.prevClose) continue;

      const followerMovePct = Math.abs(
        pctChange(followerState.close, followerState.prevClose)
      );
      const leaderMovePct = Math.abs(window.leaderMovePct);
      const expectedFollowerMove = followerMovePct * follower.avg_correlation;

      if (followerMovePct >= expectedFollowerMove * 0.8) {
        // Follower already moved proportionally — too late
        logger.debug(`${follower.follower_ticker}: already moved ${(followerMovePct*100).toFixed(2)}% — lag window missed`);
        continue;
      }

      // Score the follower in the same direction as the leader
      const profile = profileCache[follower.follower_ticker];
      if (!profile) continue;

      const marketData = getMarketData(profile.sector_etf, profile.exchange_etf);
      const newsEvents = getNewsEvents(follower.follower_ticker);
      const announcementCtx = getAnnouncementContext();

      const barData = {
        open:        followerState.open,
        high:        followerState.sessionHigh,
        low:         followerState.sessionLow,
        close:       followerState.close,
        volume:      followerState.volume,
        vwap:        followerState.vwap,
        prevClose:   followerState.prevClose,
        upVolRatio:  followerState.upVolRatio,
        prevDayHigh: followerState.prevDayHigh,
        prevDayLow:  followerState.prevDayLow,
      };

      const signal = await computeComposite({
        ticker:          follower.follower_ticker,
        barData,
        marketData,
        newsEvents,
        profile,
        currentTime:     new Date(),
        announcementCtx,
        isBaseLayer:     false,
      });

      if (!signal) continue;
      if (signal.grade === 'C' || signal.grade === 'B-') continue;

      // Override direction to match leader
      if (signal.direction !== window.leaderDirection) {
        logger.debug(`${follower.follower_ticker}: direction mismatch — follower ${signal.direction} vs leader ${window.leaderDirection}`);
        continue;
      }

      // Tag as propagation signal
      signal.signalTier       = 'propagation';
      signal.positionSizePct  = 0.075; // B+ sizing regardless of grade
      signal.positionSizeDollars = Math.round(
        parseFloat(process.env.ACCOUNT_SIZE || '7500') * 0.075
      );

      const lagMinutes = Math.round((now - window.windowOpenAt) / 60000);

      const signalId = await writeSignal(signal, {
        clusterId:         window.clusterId,
        context:           'PROPAGATION',
        leaderTicker:      window.leaderTicker,
        leaderMovePct:     window.leaderMovePct,
        propagationLagMin: lagMinutes,
      });

      if (signalId) {
        window.followersAlerted.push(follower.follower_ticker);

        // Update propagation event in DB
        await query(`
          UPDATE lc_v3.propagation_events
          SET followers_alerted = followers_alerted || $1::jsonb
          WHERE event_id = $2
        `, [JSON.stringify([follower.follower_ticker]), window.eventId]);

        logger.info(`PROPAGATION: ${follower.follower_ticker} ${signal.direction} ${signal.grade} (lag: ${lagMinutes}min from ${window.leaderTicker})`);
      }
    }
  }
}

/**
 * Called when a new primary leader signal is written.
 * Opens propagation window if the ticker is a cluster leader.
 */
export async function onLeaderSignal(signal) {
  await loadCaches();

  const profile = profileCache[signal.ticker];
  if (!profile || profile.cluster_role !== 'LEADER') return;
  if (!['A+', 'A', 'A-'].includes(signal.grade)) return; // only top grades trigger propagation

  await openPropagationWindow(signal);
}

async function closePropagationWindow(eventId, status) {
  try {
    await query(`
      UPDATE lc_v3.propagation_events
      SET status = $1
      WHERE event_id = $2
    `, [status, eventId]);
    logger.debug(`Propagation window ${eventId} closed: ${status}`);
  } catch (err) {
    logger.error(`Failed to close propagation window ${eventId}:`, err.message);
  }
}

/**
 * Get status of all open propagation windows (for dashboard)
 */
export function getOpenWindows() {
  return openWindows.map(w => ({
    eventId:          w.eventId,
    leaderTicker:     w.leaderTicker,
    leaderGrade:      w.leaderGrade,
    leaderDirection:  w.leaderDirection,
    followersAlerted: w.followersAlerted,
    windowClosesAt:   w.windowCloseAt,
    minutesRemaining: Math.max(0, Math.round((w.windowCloseAt - Date.now()) / 60000)),
  }));
}

/**
 * Reset in-memory windows (call at market open each day)
 */
export function resetPropagationState() {
  openWindows = [];
  cacheLoadedAt = 0;
  logger.info('Propagation state reset');
}

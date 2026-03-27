/**
 * Strategy A2: Cluster Lag Capture
 *
 * When a leader ticker makes a significant move, enter the follower
 * before it catches up. The contagion_map quantifies:
 *   - follow_rate: probability follower moves with leader
 *   - avg_lag_minutes: how long the delay is
 *   - avg_magnitude: expected follower move size
 *   - divergence_rate: probability follower goes opposite
 *
 * Uses debit vertical spreads for defined risk.
 * Hold: avg_lag_minutes (5-30 min).
 */

import { analyzeMomentum } from '../../../src/scoring/momentum.js';
import { classifyRegime } from '../../../src/scoring/intelligence.js';
import { getSpreadWidth, POSITION_SIZES } from '../execution-model.js';

const STRATEGY = 'A2_CLUSTER_LAG';
const MIN_FOLLOW_RATE  = 0.55;  // minimum 55% follow-through
const MIN_SAMPLE_COUNT = 20;
const MIN_LEADER_ATR   = 0.8;   // leader must move at least 0.8 ATR
const MAX_DIVERGENCE    = 0.35;  // max 35% divergence rate

/**
 * Generate A2 signals for a single trading day.
 */
export function generateA2Signals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, dailyBars } = dayData;
  const { profiles, contagionMap, tickers } = context;
  const signals = [];
  const seen = new Set(); // dedup per follower+direction per day
  const leaderFires = []; // track when leaders fire

  // First pass: identify leader signals
  const leaderTickers = Object.keys(contagionMap);

  for (const leader of leaderTickers) {
    const profile = profiles[leader];
    if (!profile) continue;

    const leaderMinutes = minuteBars[leader] || {};
    const sessionOpen = findSessionOpen(leaderMinutes, date);
    if (!sessionOpen) continue;

    const atr = profile.atr_5d || profile.atr_20d || 0.025;
    const atrDollar = atr * sessionOpen;

    // Scan leader bars for significant moves
    const minuteKeys = Object.keys(leaderMinutes)
      .filter(k => k >= `${date}T14:30` && k <= `${date}T19:30`)
      .sort();

    let recentBars = [];
    for (const minuteKey of minuteKeys) {
      const bar = leaderMinutes[minuteKey];
      recentBars.push(bar);
      if (recentBars.length > 20) recentBars = recentBars.slice(-20);
      if (recentBars.length < 3) continue;

      const moveFromOpen = (bar.c - sessionOpen) / sessionOpen;
      const moveInATRs = Math.abs(moveFromOpen) / atr;

      // Leader needs significant move (>= MIN_LEADER_ATR)
      if (moveInATRs < MIN_LEADER_ATR) continue;

      const direction = moveFromOpen > 0 ? 'CALL' : 'PUT';

      // Check leader freshness — want FRESH or DEVELOPING (not stale moves)
      const momentum = analyzeMomentum(
        recentBars, sessionOpen, sessionOpen, atr, direction
      );
      if (momentum.freshness === 'LATE' || momentum.freshness === 'EXHAUSTED') continue;

      leaderFires.push({
        leader,
        direction,
        time: minuteKey,
        moveInATRs,
        movePct: moveFromOpen * 100,
        price: bar.c,
      });
    }
  }

  // Second pass: for each leader fire, check followers
  for (const fire of leaderFires) {
    const followers = contagionMap[fire.leader] || [];

    for (const rel of followers) {
      if (rel.follow_rate < MIN_FOLLOW_RATE) continue;
      if (rel.sample_count < MIN_SAMPLE_COUNT) continue;
      if (rel.divergence_rate > MAX_DIVERGENCE) continue;

      const follower = rel.follower;
      const key = `${follower}:${fire.direction}`;
      if (seen.has(key)) continue;

      const followerProfile = profiles[follower];
      if (!followerProfile) continue;
      if (!tickers.includes(follower)) continue;

      const followerMinutes = minuteBars[follower] || {};
      const followerOpen = findSessionOpen(followerMinutes, date);
      if (!followerOpen) continue;

      // Check that follower hasn't already moved significantly
      const followerBar = followerMinutes[fire.time];
      if (!followerBar) continue;

      const followerAtr = followerProfile.atr_5d || followerProfile.atr_20d || 0.025;
      const followerMove = Math.abs((followerBar.c - followerOpen) / followerOpen) / followerAtr;

      // If follower already moved > 60% of leader's proportional move, we missed it
      if (followerMove > fire.moveInATRs * 0.6) continue;

      // Regime check
      const spyBars = getETFBarsUpto(etfMinuteBars?.SPY, fire.time);
      const qqqBars = getETFBarsUpto(etfMinuteBars?.QQQ, fire.time);
      const spyPct = spyBars.length >= 2
        ? (spyBars[spyBars.length-1].c - spyBars[0].c) / spyBars[0].c : 0;
      const qqqPct = qqqBars.length >= 2
        ? (qqqBars[qqqBars.length-1].c - qqqBars[0].c) / qqqBars[0].c : 0;

      const regime = classifyRegime({ spyPct, qqqPct }, 18, spyBars.slice(-3));
      if (regime.sizeMult === 0) continue;
      if (fire.direction === 'CALL' && !regime.callsAllowed) continue;
      if (fire.direction === 'PUT' && !regime.putsAllowed) continue;

      // Build signal
      const spreadWidth = getSpreadWidth(followerBar.c);
      const holdMinutes = Math.round(rel.avg_lag_minutes);
      const expectedMag = rel.avg_magnitude;

      // Grade based on follow_rate and leader signal quality
      const grade = followRateToGrade(rel.follow_rate, fire.moveInATRs);
      const sizePct = (POSITION_SIZES[grade] || 0.075) * regime.sizeMult;

      seen.add(key);
      signals.push({
        strategy: STRATEGY,
        date,
        time: fire.time,
        ticker: follower,
        direction: fire.direction,
        grade,
        entryPrice: followerBar.c,
        atr: followerAtr,
        spreadType: 'DEBIT_VERTICAL',
        spreadWidth,
        entryDebit: spreadWidth * 0.45,
        stopCondition:   { type: 'ATR', value: 0.5 },
        targetCondition: { type: 'ATR', value: (followerAtr > 0 && followerBar.c > 0) ? Math.max(0.3, Math.min(2.0, expectedMag / followerAtr / followerBar.c)) : 0.8 },
        maxHoldMinutes: Math.max(15, holdMinutes * 2), // allow 2x the avg lag
        holdDays: 0,
        sizePct,
        oiEstimate: Math.round((followerProfile.options_liquidity_score || 0.5) * 500),
        // Metadata
        freshness: 'PROPAGATION',
        regime: regime.regime,
        signalType: 'CLUSTER_LAG',
        composite: Math.round(rel.follow_rate * 100),
        scores: {
          followRate: Math.round(rel.follow_rate * 100),
          leaderStrength: Math.round(fire.moveInATRs * 10),
          sampleConfidence: Math.min(10, Math.round(rel.sample_count / 10)),
          regime: Math.round(regime.sizeMult * 5),
          divergenceRisk: Math.round((1 - rel.divergence_rate) * 10),
        },
        metadata: {
          leader: fire.leader,
          leaderMovePct: fire.movePct,
          leaderMoveATRs: fire.moveInATRs,
          followRate: rel.follow_rate,
          avgLagMinutes: rel.avg_lag_minutes,
          avgMagnitude: rel.avg_magnitude,
          divergenceRate: rel.divergence_rate,
          sampleCount: rel.sample_count,
        },
      });
    }
  }

  return signals;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function findSessionOpen(tickerMinutes, date) {
  const keys = Object.keys(tickerMinutes).filter(k => k.startsWith(date)).sort();
  return keys.length > 0 ? tickerMinutes[keys[0]]?.o : null;
}

function getETFBarsUpto(etfMinutes, uptoKey) {
  if (!etfMinutes) return [];
  const date = uptoKey.slice(0, 10);
  return Object.entries(etfMinutes)
    .filter(([k]) => k.startsWith(date) && k <= uptoKey)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v);
}

function followRateToGrade(followRate, leaderATRs) {
  const score = followRate * 50 + Math.min(leaderATRs, 2) * 15;
  if (score >= 55) return 'A+';
  if (score >= 45) return 'A';
  if (score >= 38) return 'A-';
  if (score >= 30) return 'B+';
  return 'B';
}

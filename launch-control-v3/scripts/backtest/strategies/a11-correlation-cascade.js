/**
 * Strategy A11: Correlation Cascade
 *
 * Uses a 1-minute resolution correlation engine to trade bidirectional
 * stock-ETF relationships.
 *
 * Two modes:
 *
 * MODE 1 — Stock Leads (Cascade)
 *   A high-influence stock makes a sharp 3-bar burst. The correlation
 *   engine's per-lag hit rates tell us exactly which stocks follow,
 *   at which minute lag, and how reliably. We enter the followers
 *   during the optimal lag window (typically 2-5 minutes).
 *
 * MODE 2 — ETF Leads (Amplification)
 *   SPY/QQQ make a sharp move. Per-lag burst analysis tells us which
 *   stocks amplify and by how much. We enter high-amplification
 *   stocks during their optimal response lag.
 *
 * All correlations computed from trailing 5-day 1-minute bars (~1,950
 * data points per pair). Lead/lag detected at 1-minute precision.
 * Intraday correlation confirms the relationship is active TODAY.
 *
 * Hold: Based on computed optimal lag (typically 5-15 min for the
 * cascade, then 15-30 min for the full follow-through).
 */

import { analyzeMomentum } from '../../../src/scoring/momentum.js';
import { classifyRegime } from '../../../src/scoring/intelligence.js';
import { computeDayCorrelations, computeIntradayCorrelation } from '../correlation-engine.js';
import { getSpreadWidth, POSITION_SIZES } from '../execution-model.js';

const STRATEGY = 'A11_CORRELATION_CASCADE';

// Mode 1: Stock leads — cascade to followers
const MIN_LEADER_BURST_ATR  = 0.5;   // leader must burst >= 0.5 ATR in 3 bars
const MIN_CASCADE_HIT_RATE  = 0.55;  // follower must follow >= 55% at best lag
const MAX_FOLLOWER_CATCHUP  = 0.4;   // follower hasn't moved more than 40% of expected

// Mode 2: ETF leads — amplification plays
const MIN_SPY_BURST_PCT     = 0.0015; // SPY must burst >= 0.15% in 3 bars
const MIN_AMPLIFICATION     = 1.3;    // stock must amplify by >= 1.3x
const MIN_ETF_HIT_RATE      = 0.55;   // must follow SPY >= 55% at best lag

// Shared
const MIN_INTRADAY_CORR     = 0.2;    // today's live correlation must be >= 0.2
const BURST_DETECT_BARS     = 3;      // detect moves over 3 consecutive 1-min bars

/**
 * Generate A11 signals for a single trading day.
 */
export function generateA11Signals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, tradingDays } = dayData;
  const { profiles, tickers } = context;
  const signals = [];
  const seen = new Set();

  // Compute trailing 5-day correlations (cached per date)
  const correlations = computeDayCorrelations(
    date, minuteBars, etfMinuteBars, tradingDays, profiles
  );

  if (Object.keys(correlations).length === 0) return signals;

  // Scan window: 10:00 - 14:30 ET
  const scanStart = `${date}T14:30`;
  const scanEnd   = `${date}T19:00`;

  // ── MODE 1: Stock Leads — Cascade Detection ──────────────────

  // Find influencer tickers: those with high impact hit rates on SPY
  const influencers = tickers.filter(t => {
    const corr = correlations[t];
    if (!corr) return false;
    return corr.tickerImpactOnSpy.sampleCount >= 10 &&
           corr.tickerImpactOnSpy.hitRate >= 0.50;
  });

  for (const leader of influencers) {
    const leaderBars = minuteBars[leader] || {};
    const leaderProfile = profiles[leader];
    if (!leaderProfile) continue;

    const leaderAtr = leaderProfile.atr_5d || leaderProfile.atr_20d || 0.025;
    const leaderOpen = findSessionOpen(leaderBars, date);
    if (!leaderOpen) continue;

    const leaderKeys = Object.keys(leaderBars)
      .filter(k => k >= scanStart && k <= scanEnd).sort();

    // Detect 3-bar bursts in the leader
    for (let i = BURST_DETECT_BARS; i < leaderKeys.length; i++) {
      const burstEnd = leaderBars[leaderKeys[i]];
      const burstStart = leaderBars[leaderKeys[i - BURST_DETECT_BARS]];
      if (!burstEnd?.c || !burstStart?.c || burstStart.c === 0) continue;

      const burstPct = (burstEnd.c - burstStart.c) / burstStart.c;
      const burstATRs = Math.abs(burstPct) / leaderAtr;

      if (burstATRs < MIN_LEADER_BURST_ATR) continue;

      const burstDir = burstPct > 0 ? 'CALL' : 'PUT';
      const burstTime = leaderKeys[i];

      // For each potential follower, check if correlation engine predicts cascade
      for (const follower of tickers) {
        if (follower === leader) continue;
        const key = `${follower}:${burstDir}:cascade`;
        if (seen.has(key)) continue;

        const followerCorr = correlations[follower];
        if (!followerCorr) continue;

        // Check per-lag impact: does SPY impact this follower at a specific lag?
        const impact = followerCorr.spyImpactOnTicker;
        if (impact.bestLagHitRate < MIN_CASCADE_HIT_RATE) continue;
        if (impact.sampleCount < 10) continue;

        // Correlation must be decent
        if (Math.abs(followerCorr.spyCorrelation) < 0.25) continue;

        // Intraday confirmation: is the relationship active TODAY?
        const intradayCorr = computeIntradayCorrelation(
          minuteBars[follower] || {}, etfMinuteBars.SPY || {}, burstTime, date
        );
        if (intradayCorr.samples >= 10 && Math.abs(intradayCorr.correlation) < MIN_INTRADAY_CORR) continue;

        // Check follower hasn't already moved
        const followerBars = minuteBars[follower] || {};
        const followerBar = followerBars[burstTime];
        if (!followerBar) continue;

        const followerOpen = findSessionOpen(followerBars, date);
        if (!followerOpen) continue;

        const followerAtr = profiles[follower]?.atr_5d || profiles[follower]?.atr_20d || 0.025;
        const followerMove = (followerBar.c - followerOpen) / followerOpen;
        const expectedMove = burstPct * impact.avgAmplification;

        if (expectedMove !== 0) {
          const catchup = Math.abs(followerMove) / Math.abs(expectedMove);
          if (catchup > MAX_FOLLOWER_CATCHUP) continue;
        }

        // Don't enter if moving opposite
        if (burstDir === 'CALL' && followerMove < -followerAtr * 0.3) continue;
        if (burstDir === 'PUT' && followerMove > followerAtr * 0.3) continue;

        // Momentum check
        const recentKeys = Object.keys(followerBars)
          .filter(k => k.startsWith(date) && k <= burstTime).sort().slice(-10);
        const recentBars = recentKeys.map(k => followerBars[k]).filter(Boolean);
        if (recentBars.length < 3) continue;

        const momentum = analyzeMomentum(
          recentBars, followerOpen, followerOpen, followerAtr, burstDir
        );
        if (momentum.freshness === 'EXHAUSTED') continue;

        // Regime
        const regime = getRegime(etfMinuteBars, burstTime);
        if (regime.sizeMult === 0) continue;
        if (burstDir === 'CALL' && !regime.callsAllowed) continue;
        if (burstDir === 'PUT' && !regime.putsAllowed) continue;

        // Use the best lag from per-lag analysis for hold time
        const optimalLag = impact.bestLagMinutes || 3;

        // Pick the best per-lag stats for scoring
        const bestPerLag = impact.perLag?.[optimalLag] || {};

        const spreadWidth = getSpreadWidth(followerBar.c);
        const grade = cascadeToGrade(impact, followerCorr, burstATRs, intradayCorr);
        const sizePct = (POSITION_SIZES[grade] || 0.075) * (regime.sizeMult || 1);

        seen.add(key);
        signals.push({
          strategy: STRATEGY,
          date,
          time: burstTime,
          ticker: follower,
          direction: burstDir,
          grade,
          entryPrice: followerBar.c,
          atr: followerAtr,
          spreadType: 'DEBIT_VERTICAL',
          spreadWidth,
          entryDebit: spreadWidth * 0.45,
          stopCondition:   { type: 'ATR', value: 0.35 },
          targetCondition: { type: 'ATR', value: 0.5 },
          maxHoldMinutes: Math.max(10, Math.min(45, optimalLag * 4)),
          holdDays: 0,
          sizePct,
          oiEstimate: Math.round((profiles[follower]?.options_liquidity_score || 0.5) * 500),
          freshness: momentum.freshness,
          regime: regime.regime,
          signalType: 'CASCADE_FROM_LEADER',
          composite: Math.round(
            impact.bestLagHitRate * 40 + burstATRs * 10 +
            Math.abs(followerCorr.spyCorrelation) * 20
          ),
          scores: {
            bestLagHitRate: Math.round((bestPerLag.hitRate || impact.bestLagHitRate) * 100),
            leaderBurstATRs: Math.round(burstATRs * 10),
            trailingCorr: Math.round(Math.abs(followerCorr.spyCorrelation) * 20),
            intradayCorr: Math.round(Math.abs(intradayCorr.correlation) * 15),
            amplification: Math.round(impact.avgAmplification * 10),
          },
          metadata: {
            mode: 'STOCK_LEADS_CASCADE',
            leader,
            leaderBurstATRs: parseFloat(burstATRs.toFixed(2)),
            leaderBurstPct: parseFloat((burstPct * 100).toFixed(3)),
            optimalLagMinutes: optimalLag,
            bestLagHitRate: impact.bestLagHitRate,
            avgAmplification: impact.avgAmplification,
            trailingCorrelation: followerCorr.spyCorrelation,
            intradayCorrelation: intradayCorr.correlation,
            leadLag: followerCorr.spyLeadLag,
            perLagStats: impact.perLag,
            conditional: followerCorr.conditional,
          },
        });
      }
    }
  }

  // ── MODE 2: ETF Leads — Amplification Plays ──────────────────

  const spyBars = etfMinuteBars?.SPY || {};
  const spyOpen = findSessionOpen(spyBars, date);
  if (!spyOpen) return signals;

  const spyKeys = Object.keys(spyBars)
    .filter(k => k >= scanStart && k <= scanEnd).sort();

  // Detect 3-bar bursts in SPY
  for (let i = BURST_DETECT_BARS; i < spyKeys.length; i++) {
    const burstEnd = spyBars[spyKeys[i]];
    const burstStart = spyBars[spyKeys[i - BURST_DETECT_BARS]];
    if (!burstEnd?.c || !burstStart?.c || burstStart.c === 0) continue;

    const spyBurst = (burstEnd.c - burstStart.c) / burstStart.c;
    if (Math.abs(spyBurst) < MIN_SPY_BURST_PCT) continue;

    const etfDir = spyBurst > 0 ? 'CALL' : 'PUT';
    const burstTime = spyKeys[i];

    for (const ticker of tickers) {
      const key = `${ticker}:${etfDir}:amplify`;
      if (seen.has(key)) continue;

      const corr = correlations[ticker];
      if (!corr) continue;

      const impact = corr.spyImpactOnTicker;
      if (impact.bestLagHitRate < MIN_ETF_HIT_RATE) continue;
      if (impact.avgAmplification < MIN_AMPLIFICATION) continue;
      if (impact.sampleCount < 10) continue;

      // Intraday confirmation
      const intradayCorr = computeIntradayCorrelation(
        minuteBars[ticker] || {}, spyBars, burstTime, date
      );
      if (intradayCorr.samples >= 10 && Math.abs(intradayCorr.correlation) < MIN_INTRADAY_CORR) continue;

      // Check stock position
      const tickerBars = minuteBars[ticker] || {};
      const tickerBar = tickerBars[burstTime];
      if (!tickerBar) continue;

      const tickerOpen = findSessionOpen(tickerBars, date);
      if (!tickerOpen) continue;

      const atr = profiles[ticker]?.atr_5d || profiles[ticker]?.atr_20d || 0.025;
      const tickerMove = (tickerBar.c - tickerOpen) / tickerOpen;
      const expectedMove = spyBurst * impact.avgAmplification;

      if (expectedMove !== 0) {
        const catchup = Math.abs(tickerMove) / Math.abs(expectedMove);
        if (catchup > MAX_FOLLOWER_CATCHUP) continue;
      }

      if (etfDir === 'CALL' && tickerMove < -atr * 0.3) continue;
      if (etfDir === 'PUT' && tickerMove > atr * 0.3) continue;

      // Momentum
      const recentKeys = Object.keys(tickerBars)
        .filter(k => k.startsWith(date) && k <= burstTime).sort().slice(-10);
      const recentBars = recentKeys.map(k => tickerBars[k]).filter(Boolean);
      if (recentBars.length < 3) continue;

      const momentum = analyzeMomentum(
        recentBars, tickerOpen, tickerOpen, atr, etfDir
      );
      if (momentum.freshness === 'EXHAUSTED') continue;

      const regime = getRegime(etfMinuteBars, burstTime);
      if (regime.sizeMult === 0) continue;
      if (etfDir === 'CALL' && !regime.callsAllowed) continue;
      if (etfDir === 'PUT' && !regime.putsAllowed) continue;

      // Use conditional correlation for the current time of day
      const hour = parseInt(burstTime.slice(11, 13));
      const conditionalCorr = hour < 17
        ? (corr.conditional.amCorrelation ?? corr.spyCorrelation)
        : (corr.conditional.pmCorrelation ?? corr.spyCorrelation);
      if (Math.abs(conditionalCorr) < 0.25) continue;

      // Use high-vol correlation if this is a high-vol bar
      const highVolCorr = corr.conditional.highVolCorrelation;

      const optimalLag = impact.bestLagMinutes || 3;
      const bestPerLag = impact.perLag?.[optimalLag] || {};
      const spreadWidth = getSpreadWidth(tickerBar.c);
      const grade = amplifyToGrade(impact, corr, spyBurst, intradayCorr);
      const sizePct = (POSITION_SIZES[grade] || 0.075) * (regime.sizeMult || 1);

      seen.add(key);
      signals.push({
        strategy: STRATEGY,
        date,
        time: burstTime,
        ticker,
        direction: etfDir,
        grade,
        entryPrice: tickerBar.c,
        atr,
        spreadType: 'DEBIT_VERTICAL',
        spreadWidth,
        entryDebit: spreadWidth * 0.45,
        stopCondition:   { type: 'ATR', value: 0.4 },
        targetCondition: { type: 'ATR', value: 0.6 },
        maxHoldMinutes: Math.max(10, Math.min(30, optimalLag * 3)),
        holdDays: 0,
        sizePct,
        oiEstimate: Math.round((profiles[ticker]?.options_liquidity_score || 0.5) * 500),
        freshness: momentum.freshness,
        regime: regime.regime,
        signalType: 'ETF_AMPLIFICATION',
        composite: Math.round(
          impact.bestLagHitRate * 30 + impact.avgAmplification * 15 +
          Math.abs(conditionalCorr) * 20
        ),
        scores: {
          bestLagHitRate: Math.round((bestPerLag.hitRate || impact.bestLagHitRate) * 100),
          amplification: Math.round(impact.avgAmplification * 10),
          conditionalCorr: Math.round(Math.abs(conditionalCorr) * 20),
          intradayCorr: Math.round(Math.abs(intradayCorr.correlation) * 15),
          spyBurst: Math.round(Math.abs(spyBurst) * 5000),
        },
        metadata: {
          mode: 'ETF_LEADS_AMPLIFICATION',
          spyBurstPct: parseFloat((spyBurst * 100).toFixed(3)),
          optimalLagMinutes: optimalLag,
          bestLagHitRate: impact.bestLagHitRate,
          avgAmplification: impact.avgAmplification,
          trailingCorrelation: corr.spyCorrelation,
          conditionalCorrelation: conditionalCorr,
          highVolCorrelation: highVolCorr,
          intradayCorrelation: intradayCorr.correlation,
          timeOfDay: hour < 17 ? 'AM' : 'PM',
          leadLag: corr.spyLeadLag,
          perLagStats: impact.perLag,
        },
      });
    }
  }

  return signals;
}

// -- Helpers ------------------------------------------------------------------

function findSessionOpen(minutes, date) {
  const keys = Object.keys(minutes).filter(k => k.startsWith(date)).sort();
  return keys.length > 0 ? minutes[keys[0]]?.o : null;
}

function getRegime(etfMinuteBars, minuteKey) {
  const spyBars = getETFBarsUpto(etfMinuteBars?.SPY, minuteKey);
  const qqqBars = getETFBarsUpto(etfMinuteBars?.QQQ, minuteKey);
  const spyPct = spyBars.length >= 2
    ? (spyBars[spyBars.length-1].c - spyBars[0].c) / spyBars[0].c : 0;
  const qqqPct = qqqBars.length >= 2
    ? (qqqBars[qqqBars.length-1].c - qqqBars[0].c) / qqqBars[0].c : 0;
  return classifyRegime({ spyPct, qqqPct }, 18, spyBars.slice(-3));
}

function getETFBarsUpto(etfMinutes, uptoKey) {
  if (!etfMinutes) return [];
  const date = uptoKey.slice(0, 10);
  return Object.entries(etfMinutes)
    .filter(([k]) => k.startsWith(date) && k <= uptoKey)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v);
}

function cascadeToGrade(impact, corr, burstATRs, intradayCorr) {
  let score = 0;
  score += Math.min(12, impact.bestLagHitRate * 20);
  score += Math.min(10, burstATRs * 8);
  score += Math.min(8, Math.abs(corr.spyCorrelation) * 12);
  score += Math.min(5, Math.abs(intradayCorr.correlation) * 8);
  score += Math.min(5, impact.avgAmplification * 3);
  score += impact.sampleCount >= 20 ? 3 : 1;

  if (score >= 38) return 'A+';
  if (score >= 30) return 'A';
  if (score >= 23) return 'A-';
  if (score >= 16) return 'B+';
  return 'B';
}

function amplifyToGrade(impact, corr, spyBurst, intradayCorr) {
  let score = 0;
  score += Math.min(10, impact.bestLagHitRate * 18);
  score += Math.min(10, impact.avgAmplification * 7);
  score += Math.min(8, Math.abs(corr.spyCorrelation) * 12);
  score += Math.min(5, Math.abs(intradayCorr.correlation) * 8);
  score += Math.min(8, Math.abs(spyBurst) * 3000);
  score += impact.sampleCount >= 20 ? 3 : 1;

  if (score >= 38) return 'A+';
  if (score >= 30) return 'A';
  if (score >= 23) return 'A-';
  if (score >= 16) return 'B+';
  return 'B';
}

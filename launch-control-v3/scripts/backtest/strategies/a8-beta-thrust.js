/**
 * Strategy A8: High-Beta Market Thrust
 *
 * When SPY/QQQ make a decisive intraday move (>0.3% in a direction),
 * high-beta stocks amplify the market move. Beta is structural —
 * if SPY moves 0.5%, a beta-1.5 stock "should" move 0.75%.
 *
 * Key edge: High-beta stocks often lag the index by 5-20 minutes as
 * correlated order flow propagates. The lag is the entry window.
 * Profile.beta_spy and beta_qqq quantify the amplification factor.
 *
 * Different from A2 (Cluster Lag): A2 uses contagion_map (specific
 * leader/follower pairs). A8 uses beta exposure to the broad market.
 * A2 may have no data if contagion_map is empty; A8 always works
 * because beta is always computed.
 *
 * Direction: Same as market move (directional momentum).
 * Structure: Debit vertical spread.
 * Hold: 30-60 min (beta catch-up is fast).
 */

import { analyzeMomentum } from '../../../src/scoring/momentum.js';
import { classifyRegime } from '../../../src/scoring/intelligence.js';
import { getSpreadWidth, POSITION_SIZES } from '../execution-model.js';

const STRATEGY = 'A8_BETA_THRUST';
const MIN_MARKET_MOVE_PCT = 0.003;  // SPY or QQQ must move >=0.3%
const MIN_BETA             = 1.3;    // stock must be high-beta
const MAX_STOCK_CATCHUP    = 0.6;    // if stock already moved >60% of expected, missed it
const MIN_CORRELATION      = 0.4;    // must have decent correlation to market

/**
 * Generate A8 signals for a single trading day.
 */
export function generateA8Signals(date, dayData, context) {
  const { minuteBars, etfMinuteBars } = dayData;
  const { profiles, tickers } = context;
  const signals = [];
  const seen = new Set();

  // Scan window: 10:00 - 14:30 ET (skip opening chop, stop before close)
  const scanStart = `${date}T14:30`; // ~9:30 ET
  const scanEnd   = `${date}T19:00`; // ~14:00 ET

  // Get SPY/QQQ bars for market move detection
  const spyMinutes = etfMinuteBars?.SPY || {};
  const qqqMinutes = etfMinuteBars?.QQQ || {};
  const spyKeys = Object.keys(spyMinutes)
    .filter(k => k >= scanStart && k <= scanEnd).sort();

  if (spyKeys.length < 10) return signals; // not enough market data

  const spyOpen = findSessionOpen(spyMinutes, date);
  const qqqOpen = findSessionOpen(qqqMinutes, date);
  if (!spyOpen || !qqqOpen) return signals;

  // Detect market thrust events: 30-min rolling move > threshold
  const thrustEvents = [];
  for (let i = 30; i < spyKeys.length; i++) {
    const currentKey = spyKeys[i];
    const lookbackKey = spyKeys[Math.max(0, i - 30)];

    const spyNow = spyMinutes[currentKey]?.c;
    const spy30ago = spyMinutes[lookbackKey]?.c;
    const qqqNow = qqqMinutes[currentKey]?.c;
    const qqq30ago = qqqMinutes[lookbackKey]?.c;

    if (!spyNow || !spy30ago) continue;

    const spyMove = (spyNow - spy30ago) / spy30ago;
    const qqqMove = qqqNow && qqq30ago ? (qqqNow - qqq30ago) / qqq30ago : spyMove;

    // Both must agree on direction and at least one must exceed threshold
    if (Math.sign(spyMove) !== Math.sign(qqqMove)) continue;
    if (Math.abs(spyMove) < MIN_MARKET_MOVE_PCT && Math.abs(qqqMove) < MIN_MARKET_MOVE_PCT) continue;

    const direction = spyMove > 0 ? 'CALL' : 'PUT';
    const marketMovePct = (Math.abs(spyMove) + Math.abs(qqqMove)) / 2;

    // Dedup: only fire once per 15-min window per direction
    const windowKey = currentKey.slice(0, 15); // YYYY-MM-DDTHH:M (15-min bucket)
    const thrustKey = `${windowKey}:${direction}`;
    if (thrustEvents.some(t => t.thrustKey === thrustKey)) continue;

    thrustEvents.push({
      time: currentKey,
      direction,
      marketMovePct,
      spyMove,
      qqqMove,
      thrustKey,
    });
  }

  // For each thrust event, find high-beta stocks that haven't caught up
  for (const thrust of thrustEvents) {
    for (const ticker of tickers) {
      const profile = profiles[ticker];
      if (!profile) continue;

      // Must be high-beta
      const beta = thrust.direction === 'CALL'
        ? Math.max(profile.beta_spy || 1, profile.beta_qqq || 1)
        : Math.max(profile.beta_spy || 1, profile.beta_qqq || 1);

      if (beta < MIN_BETA) continue;

      // Must have decent correlation
      const corr = Math.max(
        profile.sector_etf_correlation || 0,
        profile.exchange_etf_correlation || 0
      );
      if (corr < MIN_CORRELATION) continue;

      const key = `${ticker}:${thrust.direction}`;
      if (seen.has(key)) continue;

      const tickerMinutes = minuteBars[ticker] || {};
      const tickerBar = tickerMinutes[thrust.time];
      if (!tickerBar) continue;

      const tickerOpen = findSessionOpen(tickerMinutes, date);
      if (!tickerOpen) continue;

      const atr = profile.atr_5d || profile.atr_20d || 0.025;

      // How much has this stock moved vs how much beta predicts?
      const stockMove = (tickerBar.c - tickerOpen) / tickerOpen;
      const expectedMove = thrust.marketMovePct * beta;
      const catchupRatio = expectedMove !== 0 ? Math.abs(stockMove) / expectedMove : 1;

      // Stock should be lagging (hasn't caught up to beta-implied move)
      if (catchupRatio > MAX_STOCK_CATCHUP) continue;

      // Direction check: stock shouldn't be moving OPPOSITE to market
      if (thrust.direction === 'CALL' && stockMove < -atr * 0.3) continue;
      if (thrust.direction === 'PUT' && stockMove > atr * 0.3) continue;

      // Momentum check on recent bars
      const recentKeys = Object.keys(tickerMinutes)
        .filter(k => k.startsWith(date) && k <= thrust.time)
        .sort().slice(-10);
      const recentBars = recentKeys.map(k => tickerMinutes[k]).filter(Boolean);
      if (recentBars.length < 3) continue;

      const momentum = analyzeMomentum(
        recentBars, tickerOpen, tickerOpen, atr, thrust.direction
      );
      // Don't enter if already exhausted
      if (momentum.freshness === 'EXHAUSTED') continue;

      // Regime (already confirmed by thrust detection, but validate)
      const regime = classifyRegime(
        { spyPct: thrust.spyMove, qqqPct: thrust.qqqMove },
        18,
        []
      );
      if (regime.sizeMult === 0) continue;
      if (thrust.direction === 'CALL' && !regime.callsAllowed) continue;
      if (thrust.direction === 'PUT' && !regime.putsAllowed) continue;

      // Build signal
      const spreadWidth = getSpreadWidth(tickerBar.c);
      const grade = betaToGrade(beta, catchupRatio, corr, momentum);
      const sizePct = (POSITION_SIZES[grade] || 0.075) * (regime.sizeMult || 1);

      seen.add(key);
      signals.push({
        strategy: STRATEGY,
        date,
        time: thrust.time,
        ticker,
        direction: thrust.direction,
        grade,
        entryPrice: tickerBar.c,
        atr,
        spreadType: 'DEBIT_VERTICAL',
        spreadWidth,
        entryDebit: spreadWidth * 0.45,
        stopCondition:   { type: 'ATR', value: 0.4 },  // tight; beta catch-up should happen fast
        targetCondition: { type: 'ATR', value: 0.6 },  // target the beta-implied remaining move
        maxHoldMinutes: 60,  // beta catch-up is fast
        holdDays: 0,
        sizePct,
        oiEstimate: Math.round((profile.options_liquidity_score || 0.5) * 500),
        freshness: momentum.freshness,
        regime: regime.regime,
        signalType: 'BETA_THRUST',
        composite: Math.round(beta * 15 + (1 - catchupRatio) * 30 + corr * 10),
        scores: {
          beta: Math.round(beta * 10),
          lagOpportunity: Math.round((1 - catchupRatio) * 20),
          correlation: Math.round(corr * 10),
          marketThrust: Math.round(thrust.marketMovePct * 2000),
          regime: Math.round((regime.sizeMult || 1) * 5),
        },
        metadata: {
          beta,
          betaSpy: profile.beta_spy,
          betaQqq: profile.beta_qqq,
          correlation: corr,
          marketMovePct: parseFloat((thrust.marketMovePct * 100).toFixed(2)),
          stockMovePct: parseFloat((stockMove * 100).toFixed(2)),
          expectedMovePct: parseFloat((expectedMove * 100).toFixed(2)),
          catchupRatio: parseFloat(catchupRatio.toFixed(3)),
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

function betaToGrade(beta, catchupRatio, corr, momentum) {
  let score = 0;

  // Higher beta = more amplification
  score += Math.min(15, (beta - 1) * 20);

  // More lag = more opportunity
  score += Math.min(15, (1 - catchupRatio) * 20);

  // Higher correlation = more reliable
  score += Math.min(10, corr * 12);

  // Momentum freshness
  if (momentum.freshness === 'FRESH') score += 8;
  else if (momentum.freshness === 'DEVELOPING') score += 5;
  else if (momentum.freshness === 'EXTENDED') score += 2;

  if (score >= 38) return 'A+';
  if (score >= 30) return 'A';
  if (score >= 23) return 'A-';
  if (score >= 16) return 'B+';
  return 'B';
}

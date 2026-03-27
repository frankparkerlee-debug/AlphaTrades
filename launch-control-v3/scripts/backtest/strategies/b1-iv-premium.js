/**
 * Strategy B1: IV Rank Premium Harvest
 *
 * Sells premium when IV is high and no catalyst is imminent.
 * Implied vol overstates realized vol ~83% of the time — sell it.
 *
 * Structure: Iron condor (neutral) or directional credit spread (trending regime).
 * Hold: 3-7 trading days.
 * Target: Close at 50% of max profit.
 * Stop: Close at 2x credit received.
 *
 * Key data: iv_rank_30d, iv_percentile, earnings_days_away, sec_filings.
 */

import { classifyRegime } from '../../../src/scoring/intelligence.js';
import { getSpreadWidth, POSITION_SIZES } from '../execution-model.js';

const STRATEGY = 'B1_IV_PREMIUM';
const MIN_IV_RANK       = 70;       // IV must be in top 30%
const MIN_EARNINGS_DAYS = 10;       // no entries within 10 days of earnings
const HOLD_DAYS         = 5;        // target hold period
const CREDIT_RATIO      = 0.32;     // collect ~32% of spread width as credit
const WING_DISTANCE_ATR = 1.5;      // short strikes 1.5 ATR from current price

/**
 * Generate B1 signals for a single trading day.
 * B1 operates on daily bars — one signal decision per ticker per day.
 */
export function generateB1Signals(date, dayData, context) {
  const { minuteBars, etfMinuteBars, dailyBars } = dayData;
  const { profiles, intelligence, secFilings, ivHistory, tickers } = context;
  const signals = [];
  const seen = new Set();

  // Only enter on market open (use 10:00 ET bar for price)
  const entryMinuteKey = `${date}T14:30`; // ~9:30 ET

  for (const ticker of tickers) {
    if (seen.has(ticker)) continue;

    const profile = profiles[ticker];
    if (!profile) continue;

    const intel = intelligence[ticker];
    if (!intel) continue;

    // ── IV Rank filter ────────────────────────────────────────
    // Check IV history for this date, fall back to static intelligence
    const ivEntry = findIVForDate(ivHistory[ticker], date);
    const ivRank = ivEntry?.iv_rank || intel.iv_rank_30d || 50;

    if (ivRank < MIN_IV_RANK) continue;

    // ── Earnings filter ───────────────────────────────────────
    if (intel.earnings_days_away < MIN_EARNINGS_DAYS) continue;

    // ── Red flag filter ───────────────────────────────────────
    const filings = secFilings[ticker] || [];
    const recentRedFlag = filings.some(f =>
      f.is_red_flag && daysDiff(f.filed_at, date) <= 7
    );
    if (recentRedFlag) continue;

    // ── Liquidity filter ──────────────────────────────────────
    if ((profile.options_liquidity_score || 0) < 0.3) continue;

    // Get entry price from minute bars or daily bars
    const tickerMinutes = minuteBars[ticker] || {};
    const entryBar = findNearestBar(tickerMinutes, entryMinuteKey, date);
    if (!entryBar) continue;

    const entryPrice = entryBar.c;
    const atr = profile.atr_5d || profile.atr_20d || 0.025;

    // ── Regime classification ─────────────────────────────────
    const spyBars = getETFBarsUpto(etfMinuteBars?.SPY, entryMinuteKey);
    const qqqBars = getETFBarsUpto(etfMinuteBars?.QQQ, entryMinuteKey);
    const spyPct = spyBars.length >= 2
      ? (spyBars[spyBars.length-1].c - spyBars[0].c) / spyBars[0].c : 0;
    const qqqPct = qqqBars.length >= 2
      ? (qqqBars[qqqBars.length-1].c - qqqBars[0].c) / qqqBars[0].c : 0;

    const regime = classifyRegime({ spyPct, qqqPct }, 18, spyBars.slice(-3));
    if (regime.regime === 'MARKET_BREAKDOWN') continue;

    // ── Structure decision ────────────────────────────────────
    // Iron condor for neutral/choppy regimes
    // Directional credit spread for trending regimes
    let spreadType, direction;

    if (regime.regime === 'RISK_ON') {
      // Trending up → sell put credit spread (bullish)
      spreadType = 'CREDIT_VERTICAL';
      direction = 'PUT'; // selling puts = bullish
    } else if (regime.regime === 'RISK_OFF' || regime.regime === 'RISK_OFF_MILD') {
      // Trending down → sell call credit spread (bearish)
      spreadType = 'CREDIT_VERTICAL';
      direction = 'CALL'; // selling calls = bearish
    } else {
      // Neutral/diverging → iron condor (non-directional)
      spreadType = 'IRON_CONDOR';
      direction = 'NEUTRAL';
    }

    const spreadWidth = getSpreadWidth(entryPrice);
    const grade = ivRankToGrade(ivRank, profile.options_liquidity_score || 0.5);
    const sizePct = (POSITION_SIZES[grade] || 0.075) * (regime.sizeMult || 1);

    seen.add(ticker);
    signals.push({
      strategy: STRATEGY,
      date,
      time: entryMinuteKey + ':00',
      ticker,
      direction,
      grade,
      entryPrice,
      atr,
      spreadType,
      spreadWidth,
      entryCredit: spreadWidth * CREDIT_RATIO,
      stopCondition:   { type: 'CREDIT_MULT', value: 2 },  // stop at 2x credit loss
      targetCondition: { type: 'CREDIT_PCT', value: 0.50 }, // close at 50% of credit
      maxHoldMinutes: 0,
      holdDays: HOLD_DAYS,
      sizePct,
      wingDistance: WING_DISTANCE_ATR,
      oiEstimate: Math.round((profile.options_liquidity_score || 0.5) * 500),
      // Metadata
      freshness: 'N/A',
      regime: regime.regime,
      signalType: spreadType === 'IRON_CONDOR' ? 'IV_CONDOR' : 'IV_CREDIT',
      composite: Math.round(ivRank),
      scores: {
        ivRank: Math.round(ivRank),
        earningsSafety: Math.min(10, Math.round(intel.earnings_days_away / 3)),
        liquidity: Math.round((profile.options_liquidity_score || 0.5) * 10),
        regime: Math.round((regime.sizeMult || 1) * 5),
        noRedFlags: recentRedFlag ? 0 : 10,
      },
      metadata: {
        ivRank,
        ivPercentile: intel.iv_percentile,
        putCallSkew: ivEntry?.put_call_skew || intel.put_call_skew,
        earningsDaysAway: intel.earnings_days_away,
        structure: spreadType,
      },
    });
  }

  return signals;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function findIVForDate(ivEntries, date) {
  if (!ivEntries || ivEntries.length === 0) return null;
  // Find closest entry on or before this date
  const before = ivEntries.filter(e => e.date <= date);
  return before.length > 0 ? before[before.length - 1] : ivEntries[0];
}

function findNearestBar(tickerMinutes, targetKey, date) {
  // Find the closest bar at or after targetKey on this date
  const keys = Object.keys(tickerMinutes)
    .filter(k => k.startsWith(date) && k >= targetKey)
    .sort();
  if (keys.length > 0) return tickerMinutes[keys[0]];

  // Fallback: any bar on this date
  const allKeys = Object.keys(tickerMinutes).filter(k => k.startsWith(date)).sort();
  return allKeys.length > 0 ? tickerMinutes[allKeys[0]] : null;
}

function getETFBarsUpto(etfMinutes, uptoKey) {
  if (!etfMinutes) return [];
  const date = uptoKey.slice(0, 10);
  return Object.entries(etfMinutes)
    .filter(([k]) => k.startsWith(date) && k <= uptoKey)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v);
}

function daysDiff(d1, d2) {
  return Math.abs(Math.round((new Date(d2) - new Date(d1)) / (1000 * 60 * 60 * 24)));
}

function ivRankToGrade(ivRank, liquidityScore) {
  let score = 0;
  score += Math.min(20, (ivRank - 70) * 0.7);   // 70 -> 0, 100 -> 21
  score += liquidityScore * 15;                    // 0 -> 0, 1.0 -> 15

  if (score >= 28) return 'A+';
  if (score >= 22) return 'A';
  if (score >= 16) return 'A-';
  if (score >= 10) return 'B+';
  return 'B';
}

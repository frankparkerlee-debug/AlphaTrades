import { checkConfluence } from '../indicators/confluence.js';
import { analyzeCandle } from '../indicators/candle-patterns.js';

/**
 * Post-Macro Directional Strategy
 *
 * After major macro events (FOMC, CPI, NFP), the market establishes a
 * directional bias within 30 minutes. The initial reaction fades, then
 * the real institutional move begins. Trade the highest-beta names in
 * the consensus direction.
 *
 * ALPHA playbook -- cash account, single-leg options only (no spreads).
 *
 * Entry criteria:
 *   1. macroEvent must be truthy (caller detects macro days)
 *   2. Time window: 10:00-10:30 ET (30-60 min after open, post dust-settling)
 *   3. SPY AND QQQ both moving same direction >= 0.3% (directional consensus)
 *   4. Ticker has momentum_persistence >= 0.4, beta >= 1.0, moveInATRs < 2.0
 *   5. VWAP aligned with consensus direction
 *
 * Targets: 0.7 ATR (T1) and 1.2 ATR (T2) -- macro moves are large
 * Stop: VWAP with small buffer (if VWAP breaks against thesis, reaction is reversing)
 *
 * @param {Object} snapshots        - { ticker: { open, price, volume, windowKey, atr } }
 * @param {Object} prevCloses       - { ticker: number }
 * @param {number} spyChange        - SPY intraday change as decimal (e.g. 0.008 = +0.8%)
 * @param {number} qqqChange        - QQQ intraday change as decimal
 * @param {Object} volumeBaselines  - { "TICKER:windowKey": number }
 * @param {Object} levelData        - { vwaps, dailyBars, intradayBars, ... }
 * @param {Object} profiles         - { ticker: { momentum_persistence, beta_spy, beta_qqq, atr, ... } }
 * @param {string|null} macroEvent  - e.g. 'FOMC', 'CPI', 'NFP', or null
 * @returns {Array} array of signal objects (max 3)
 */
export function scanPostMacro(snapshots, prevCloses, spyChange, qqqChange, volumeBaselines, levelData = {}, profiles = {}, macroEvent = null) {
  const signals = [];

  // ── Hard gate: must be a macro day ──────────────────────────────────
  if (!macroEvent) return signals;

  // ── Time gate: 10:00-10:30 ET (600-630 minutes) ────────────────────
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etMins = et.getHours() * 60 + et.getMinutes();
  if (etMins < 600 || etMins > 630) return signals;

  // ── Directional consensus: SPY and QQQ must agree >= 0.3% ──────────
  let consensusDirection = null;
  if (spyChange >= 0.003 && qqqChange >= 0.003) {
    consensusDirection = 'CALL';
  } else if (spyChange <= -0.003 && qqqChange <= -0.003) {
    consensusDirection = 'PUT';
  } else {
    return signals; // no consensus
  }

  const isBullish = consensusDirection === 'CALL';
  const { vwaps = {}, dailyBars = {}, intradayBars = {} } = levelData;

  for (const ticker of Object.keys(snapshots)) {
    const snap = snapshots[ticker];
    const prevClose = prevCloses[ticker];
    const profile = profiles[ticker];

    if (!snap || !prevClose || !snap.price || !snap.open) continue;
    if (!profile) continue;

    const currentPrice = snap.price;
    const todayOpen = snap.open;
    const vwap = vwaps[ticker];

    // ── Profile gates ─────────────────────────────────────────────────
    const momentumPersistence = profile.momentum_persistence;
    if (momentumPersistence == null || momentumPersistence < 0.4) continue;

    const betaSpy = profile.beta_spy || 0;
    const betaQqq = profile.beta_qqq || 0;
    const beta = Math.max(betaSpy, betaQqq);
    if (beta < 1.0) continue;

    // ── ATR check: stock shouldn't be exhausted ───────────────────────
    const atr = profile.atr || snap.atr;
    if (!atr || atr <= 0) continue;

    const moveFromOpen = currentPrice - todayOpen;
    const moveInATRs = Math.abs(moveFromOpen) / atr;
    if (moveInATRs >= 2.0) continue;

    // ── VWAP alignment ────────────────────────────────────────────────
    if (!vwap || vwap <= 0) continue;
    if (isBullish && currentPrice <= vwap) continue;   // bullish: price must be above VWAP
    if (!isBullish && currentPrice >= vwap) continue;   // bearish: price must be below VWAP

    // ── Volume check ──────────────────────────────────────────────────
    const windowKey = snap.windowKey;
    let volumeRatio = null;
    if (windowKey) {
      const baseline = volumeBaselines[`${ticker}:${windowKey}`];
      if (baseline && baseline > 0) {
        volumeRatio = snap.volume / baseline;
      }
    }

    // ── Candle quality gate ──────────────────────────────────────────
    const intBars = intradayBars[ticker] || [];
    const candleResult = intBars.length > 0 ? analyzeCandle(intBars[intBars.length - 1]) : null;
    if (candleResult && candleResult.body_pct <= 0.4) {
      const candleBullish = candleResult.direction === 'BULL';
      if ((consensusDirection === 'CALL' && !candleBullish) || (consensusDirection === 'PUT' && candleBullish)) continue;
    }

    // ── Confluence check ────────────────────────────────────────────
    let confluenceResult = null;
    if (intBars.length >= 10) {
      confluenceResult = checkConfluence(intBars, consensusDirection, { vwap, volumeRatio, currentPrice }, { minFactors: 3 });
      if (!confluenceResult.passed) continue;
    }

    // ── Trend structure (lightweight -- use daily bars if available) ──
    const bars = dailyBars[ticker] || [];
    let trend = 'NEUTRAL';
    const trend_flags = [];

    if (bars.length >= 5) {
      const recentCloses = bars.slice(-5).map(b => b.close).filter(Boolean);
      if (recentCloses.length >= 3) {
        const rising = recentCloses.every((c, i) => i === 0 || c >= recentCloses[i - 1]);
        const falling = recentCloses.every((c, i) => i === 0 || c <= recentCloses[i - 1]);
        if (rising) trend = 'UPTREND';
        else if (falling) trend = 'DOWNTREND';
      }
    }

    if (isBullish && trend === 'DOWNTREND') trend_flags.push('counter_trend');
    if (!isBullish && trend === 'UPTREND') trend_flags.push('counter_trend');
    if (moveInATRs < 0.3) trend_flags.push('early_move');

    // ── Confidence scoring (base 72) ──────────────────────────────────
    let confidence = 72;

    // Candle quality
    if (candleResult) {
      if (candleResult.pattern === 'MARUBOZU') confidence += 6;
      else if (candleResult.strength === 'STRONG') confidence += 4;
      else confidence += 2;
    }

    // Market consensus strength
    const absSpyPct = Math.abs(spyChange);
    const absQqqPct = Math.abs(qqqChange);
    if (absSpyPct > 0.005 && absQqqPct > 0.005) {
      confidence += 5;
    } else if (absSpyPct > 0.003 && absQqqPct > 0.003) {
      confidence += 3;
    }

    // Beta boost
    if (beta >= 1.5) {
      confidence += 4;
    } else if (beta >= 1.2) {
      confidence += 2;
    }

    // Momentum persistence boost
    if (momentumPersistence >= 0.7) {
      confidence += 4;
    } else if (momentumPersistence >= 0.5) {
      confidence += 2;
    }

    // Stock hasn't moved much yet -- room to run
    if (moveInATRs < 0.5) {
      confidence += 3;
    }

    // VWAP aligned (already passed the gate, but reward strong alignment)
    const vwapDistPct = (currentPrice - vwap) / vwap;
    if ((isBullish && vwapDistPct > 0) || (!isBullish && vwapDistPct < 0)) {
      confidence += 2;
    }

    // Volume above average
    if (volumeRatio && volumeRatio >= 1.0) {
      confidence += 2;
    }

    // Confluence factor scoring
    if (confluenceResult) {
      confidence += (confluenceResult.confirming || 0) * 2;
      confidence -= (confluenceResult.opposing || 0) * 2;
    }

    // Clamp
    confidence = Math.max(60, Math.min(95, confidence));

    // ── Stop price: VWAP with buffer ──────────────────────────────────
    const stopPrice = isBullish
      ? +(vwap * 0.997).toFixed(2)
      : +(vwap * 1.003).toFixed(2);

    // ── Targets: 0.7 ATR (T1) and 1.2 ATR (T2) ──────────────────────
    const t1Target = isBullish
      ? +(currentPrice + 0.7 * atr).toFixed(2)
      : +(currentPrice - 0.7 * atr).toFixed(2);

    const t2Target = isBullish
      ? +(currentPrice + 1.2 * atr).toFixed(2)
      : +(currentPrice - 1.2 * atr).toFixed(2);

    // ── Move from open as percentage ──────────────────────────────────
    const moveFromOpenPct = ((currentPrice - todayOpen) / todayOpen) * 100;

    signals.push({
      ticker,
      direction: consensusDirection,
      strategy: 'POST_MACRO',
      entry_price: currentPrice,
      stop_price: stopPrice,
      t1_target: t1Target,
      t2_target: t2Target,
      confidence,
      exit_by: null,
      hold: 'STRUCTURAL',
      macro_event: macroEvent,
      consensus_direction: consensusDirection,
      spy_change_pct: +(spyChange * 100).toFixed(2),
      qqq_change_pct: +(qqqChange * 100).toFixed(2),
      beta: +beta.toFixed(2),
      momentum_persistence: +momentumPersistence.toFixed(2),
      move_from_open_pct: +moveFromOpenPct.toFixed(2),
      trend,
      trend_flags,
      candle_type: candleResult ? candleResult.pattern : null,
      confluence: confluenceResult ? { confirming: confluenceResult.confirming, opposing: confluenceResult.opposing, factors: confluenceResult.factors } : null,
      note: `${macroEvent} macro day -- ${consensusDirection} consensus SPY${(spyChange * 100).toFixed(1)}% QQQ${(qqqChange * 100).toFixed(1)}% | beta=${beta.toFixed(2)} persistence=${momentumPersistence.toFixed(2)} move=${moveFromOpenPct.toFixed(1)}% in ${moveInATRs.toFixed(1)} ATRs${candleResult ? ' candle=' + candleResult.pattern : ''}${confluenceResult ? ' confluence=' + confluenceResult.confirming + '/' + (confluenceResult.confirming + confluenceResult.opposing) : ''}`,
    });

    console.log(`[POST_MACRO] ${ticker} ${consensusDirection} on ${macroEvent} day | SPY${(spyChange * 100).toFixed(1)}% QQQ${(qqqChange * 100).toFixed(1)}% | beta=${beta.toFixed(2)} persistence=${momentumPersistence.toFixed(2)} move=${moveFromOpenPct.toFixed(1)}%`);
  }

  // Cap at top 3 signals -- macro days = concentrate on best names
  signals.sort((a, b) => b.confidence - a.confidence || b.beta - a.beta);
  return signals.slice(0, 3);
}

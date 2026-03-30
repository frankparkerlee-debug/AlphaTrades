import { checkBounceStructure } from './support-check.js';
import { checkConfluence } from '../indicators/confluence.js';
import { analyzeCandle } from '../indicators/candle-patterns.js';

/**
 * Correlation Cascade Strategy
 *
 * When a sector leader (SPY/QQQ) makes a big move, correlated stocks in the
 * same cluster follow with a delay. This strategy trades the laggards before
 * they catch up.
 *
 * Entry criteria:
 *   1. SPY or QQQ moving >= 0.5% (significant leader move)
 *   2. Stock has beta >= 0.5 to SPY or QQQ (correlated enough)
 *   3. Stock has NOT caught up yet (catch-up ratio < 0.6)
 *   4. Stock is not moving opposite (catch-up ratio > -0.3)
 *   5. Time window: 10:00-14:00 ET (cascades need time, not too late)
 *   6. Not near earnings (within 3 days)
 *
 * Targets: catch half (T1) to most (T2) of the expected gap
 * Stop: structural -- new extreme against cascade direction
 *
 * @param {Object} snapshots        - { ticker: { open, price, volume, windowKey, high, low } }
 * @param {Object} prevCloses       - { ticker: number }
 * @param {number} spyChange        - SPY intraday change as decimal (e.g. 0.008 = +0.8%)
 * @param {number} qqqChange        - QQQ intraday change as decimal
 * @param {Object} volumeBaselines  - { "TICKER:windowKey": number }
 * @param {Object} levelData        - { todayLows, todayHighs, dailyBars, vwaps, intradayBars, earningsDates }
 * @param {Object} profiles         - { ticker: { beta_spy, beta_qqq, sector_etf_correlation } }
 * @returns {Array} array of signal objects
 */
export function scanCorrelationCascade(snapshots, prevCloses, spyChange, qqqChange, volumeBaselines, levelData = {}, profiles = {}) {
  const signals = [];

  // Hard gate: SPY or QQQ must be moving significantly (>= 0.5%)
  if (Math.abs(spyChange) < 0.005 && Math.abs(qqqChange) < 0.005) return signals;

  // Determine market direction: use the stronger of SPY/QQQ
  const marketMove = Math.abs(spyChange) > Math.abs(qqqChange) ? spyChange : qqqChange;
  const marketDir = marketMove > 0 ? 'CALL' : 'PUT';
  const marketLeader = Math.abs(spyChange) > Math.abs(qqqChange) ? 'SPY' : 'QQQ';
  const bothSameDir = (spyChange > 0 && qqqChange > 0) || (spyChange < 0 && qqqChange < 0);

  // Time gate: 10:00-14:00 ET -- cascades need time to develop but not too late
  const now = new Date();
  const etHour = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
  const etMinute = now.toLocaleString('en-US', { timeZone: 'America/New_York', minute: 'numeric' });
  const etTimeMinutes = parseInt(etHour, 10) * 60 + parseInt(etMinute, 10);
  if (etTimeMinutes < 600 || etTimeMinutes > 840) return signals; // before 10:00 or after 14:00

  const {
    todayLows = {},
    todayHighs = {},
    dailyBars = {},
    vwaps = {},
    intradayBars = {},
    earningsDates = {},
  } = levelData;

  for (const ticker of Object.keys(snapshots)) {
    const snap = snapshots[ticker];
    const prevClose = prevCloses[ticker];

    if (!snap || !prevClose || !snap.price || !snap.open) continue;

    const currentPrice = snap.price;
    const todayOpen = snap.open;

    // Skip SPY/QQQ themselves -- we trade laggards, not leaders
    if (ticker === 'SPY' || ticker === 'QQQ') continue;

    // Need profile with beta
    const profile = profiles[ticker];
    const beta = profile?.beta_spy || profile?.beta_qqq || 1.0;

    // Skip if beta < 0.5 (not correlated enough to expect a cascade)
    if (beta < 0.5) continue;

    // Earnings gate: skip if earnings within 3 days (they move on their own dynamics)
    const earningsDate = earningsDates[ticker];
    if (earningsDate) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const earnings = new Date(earningsDate);
      earnings.setHours(0, 0, 0, 0);
      const daysToEarnings = (earnings - today) / (1000 * 60 * 60 * 24);
      if (Math.abs(daysToEarnings) <= 3) continue;
    }

    // Calculate expected move based on leader signal and stock's beta
    const expectedMove = marketMove * beta;

    // Calculate actual move (intraday from open)
    const actualMove = (currentPrice - todayOpen) / todayOpen;

    // Catch-up ratio: how much of the expected move has the stock made
    if (expectedMove === 0) continue;
    const catchupRatio = actualMove / expectedMove;

    // The signal: stock HASN'T caught up yet
    // Skip if already moved most of the way (>= 0.6)
    if (catchupRatio > 0.6) continue;

    // Skip if moving opposite (< -0.3) -- something else is going on
    if (catchupRatio < -0.3) continue;

    // Best zone: catchupRatio between -0.1 and 0.4 (barely moved or moving slowly)
    // We still allow 0.4-0.6 but they score lower on confidence

    // Volume check: stock's volume should not be collapsing
    const windowKey = snap.windowKey;
    let volumeRatio = null;
    if (windowKey) {
      const baseline = volumeBaselines[`${ticker}:${windowKey}`];
      if (baseline && baseline > 0) {
        volumeRatio = snap.volume / baseline;
        // Skip if volume is truly dead (< 0.3x baseline)
        if (volumeRatio < 0.3) continue;
      }
    }

    // VWAP alignment check
    const vwap = vwaps[ticker];
    let vwapAligned = false;
    if (vwap && vwap > 0) {
      if (marketDir === 'CALL') {
        // For cascade up, price near or above VWAP is better
        vwapAligned = currentPrice >= vwap * 0.995; // within 0.5% below VWAP or above
      } else {
        // For cascade down, price near or below VWAP is better
        vwapAligned = currentPrice <= vwap * 1.005;
      }
    }

    // ── Candle quality gate ──────────────────────────────────────────
    const bars = intradayBars[ticker] || [];
    const candleResult = bars.length > 0 ? analyzeCandle(bars[bars.length - 1]) : null;
    if (candleResult && candleResult.body_pct <= 0.4) {
      // Weak candle in the opposite direction -- skip
      const candleBullish = candleResult.direction === 'BULL';
      if ((marketDir === 'CALL' && !candleBullish) || (marketDir === 'PUT' && candleBullish)) continue;
    }

    // ── Confluence check ────────────────────────────────────────────
    let confluenceResult = null;
    if (bars.length >= 10) {
      confluenceResult = checkConfluence(bars, marketDir, { vwap, volumeRatio, currentPrice }, { minFactors: 3 });
      if (!confluenceResult.passed) continue;
    }

    // Trend structure for additional context
    const structure = checkBounceStructure(currentPrice, dailyBars[ticker], {
      todayLow: todayLows[ticker],
      todayHigh: todayHighs[ticker],
      todayOpen,
      vwap,
      intradayBars: intradayBars[ticker] || [],
    }, 'intraday');

    const trend_flags = [...(structure.flags || [])];

    // Sector ETF correlation from profile
    const sectorCorrelation = profile?.sector_etf_correlation || null;

    // -- Confidence scoring (base 72) --
    let confidence = 72;

    // Candle quality
    if (candleResult) {
      if (candleResult.pattern === 'MARUBOZU') confidence += 6;
      else if (candleResult.strength === 'STRONG') confidence += 4;
      else confidence += 2;
    }

    // Market move strength
    const absMarketMove = Math.abs(marketMove);
    if (absMarketMove >= 0.01) {
      confidence += 5;
    } else if (absMarketMove >= 0.007) {
      confidence += 3;
    }

    // High beta (should catch up faster)
    if (beta >= 1.5) confidence += 4;

    // Catch-up ratio sweet spots
    if (catchupRatio >= 0.0 && catchupRatio < 0.2) {
      confidence += 5; // barely moved yet -- biggest opportunity
    } else if (catchupRatio >= 0.2 && catchupRatio < 0.4) {
      confidence += 3;
    }

    // Volume not collapsing
    if (volumeRatio !== null && volumeRatio >= 0.8) confidence += 2;

    // VWAP aligned
    if (vwapAligned) confidence += 2;

    // Sector ETF correlation
    if (sectorCorrelation !== null && sectorCorrelation >= 0.7) confidence += 3;

    // Market consensus (both SPY AND QQQ same direction)
    if (bothSameDir) confidence += 3;

    // Confluence factor scoring
    if (confluenceResult) {
      confidence += (confluenceResult.confirming || 0) * 2;
      confidence -= (confluenceResult.opposing || 0) * 2;
    }

    // Cap and floor
    confidence = Math.max(60, Math.min(95, confidence));

    // -- Stop price: structural --
    // If CALL, below today's low (new low against cascade = thesis broken)
    // If PUT, above today's high (new high against cascade = thesis broken)
    const todayLow = todayLows[ticker] || currentPrice * 0.97;
    const todayHigh = todayHighs[ticker] || currentPrice * 1.03;
    const stopPrice = marketDir === 'CALL'
      ? +(todayLow * 0.998).toFixed(2)   // just below today's low
      : +(todayHigh * 1.002).toFixed(2);  // just above today's high

    // -- Targets: catch the gap --
    // expectedMove is a decimal (e.g. 0.012 for 1.2%), convert to price delta
    const expectedDelta = currentPrice * expectedMove;
    const t1Target = +(currentPrice + expectedDelta * 0.5).toFixed(2); // catch half the gap
    const t2Target = +(currentPrice + expectedDelta * 0.8).toFixed(2); // catch most of the gap

    const expectedMovePct = +(expectedMove * 100).toFixed(2);
    const actualMovePct = +(actualMove * 100).toFixed(2);

    signals.push({
      ticker,
      direction: marketDir,
      strategy: 'CORRELATION_CASCADE',
      entry_price: currentPrice,
      stop_price: stopPrice,
      t1_target: t1Target,
      t2_target: t2Target,
      confidence,
      exit_by: null,
      hold: 'STRUCTURAL',
      beta: +beta.toFixed(2),
      expected_move_pct: expectedMovePct,
      actual_move_pct: actualMovePct,
      catchup_ratio: +catchupRatio.toFixed(3),
      spy_change_pct: +(spyChange * 100).toFixed(2),
      qqq_change_pct: +(qqqChange * 100).toFixed(2),
      market_leader: marketLeader,
      sector_correlation: sectorCorrelation !== null ? +sectorCorrelation.toFixed(2) : null,
      trend: structure.trend,
      trend_flags,
      candle_type: candleResult ? candleResult.pattern : null,
      confluence: confluenceResult ? { confirming: confluenceResult.confirming, opposing: confluenceResult.opposing, factors: confluenceResult.factors } : null,
      note: `${marketLeader} ${marketDir === 'CALL' ? '+' : ''}${(marketMove * 100).toFixed(1)}% but ${ticker} only ${actualMovePct >= 0 ? '+' : ''}${actualMovePct}% (catchup ${(catchupRatio * 100).toFixed(0)}%) beta=${beta.toFixed(1)}${candleResult ? ' candle=' + candleResult.pattern : ''}${confluenceResult ? ' confluence=' + confluenceResult.confirming + '/' + (confluenceResult.confirming + confluenceResult.opposing) : ''} -- expect cascade ${marketDir === 'CALL' ? 'up' : 'down'}`,
    });

    console.log(`[CASCADE] ${ticker} lagging ${marketLeader} | expected ${expectedMovePct >= 0 ? '+' : ''}${expectedMovePct}% actual ${actualMovePct >= 0 ? '+' : ''}${actualMovePct}% catchup=${(catchupRatio * 100).toFixed(0)}% beta=${beta.toFixed(1)} conf=${confidence} -> ${marketDir}`);
  }

  // Cap at top 5 by confidence (only trade the biggest laggards)
  signals.sort((a, b) => b.confidence - a.confidence || a.catchup_ratio - b.catchup_ratio);
  return signals.slice(0, 5);
}

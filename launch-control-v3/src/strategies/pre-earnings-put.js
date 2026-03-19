/**
 * Pre-Earnings Put Strategy
 *
 * Identifies conviction put setups entering earnings catalysts. Requires:
 * - Conviction score >= 65
 * - Earnings 7-21 days away
 * - IV rank < 35 (options cheap relative to history)
 * - Price 15-35% below 52-week high (damaged but not capitulated)
 * - Analyst consensus still contains "BUY" (lagging thesis)
 *
 * Position sizing: 1.5% of account. Hard exit: earnings_date + 1 day.
 *
 * @param {Array} convictionScores - array of conviction scorer results
 * @param {Object} tickerIntelligence - { ticker: { earnings_date, iv_rank_30d, ... } }
 * @returns {Array} array of signal objects
 */
export function scanPreEarningsPut(convictionScores, tickerIntelligence) {
  const signals = [];
  const now = new Date();

  for (const cs of convictionScores) {
    // ── Conviction gate: score >= 65 ──────────────────────────────────
    if (cs.conviction_score < 65) continue;

    const ti = tickerIntelligence[cs.ticker];
    if (!ti) continue;

    // ── Earnings window: 7-21 days away ──────────────────────────────
    const earningsDate = cs.earnings_date || ti.earnings_date;
    if (!earningsDate) continue;

    const ed = new Date(earningsDate);
    const daysToEarnings = Math.round((ed - now) / 86400000);
    if (daysToEarnings < 7 || daysToEarnings > 21) continue;

    // ── IV rank gate: below 35 ───────────────────────────────────────
    const ivRank = cs.iv_rank_30d ?? (ti.iv_rank_30d != null ? parseFloat(ti.iv_rank_30d) : null);
    if (ivRank == null || ivRank >= 35) continue;

    // ── Price position: 15-35% below 52-week high ───────────────────
    const priceFromHigh = cs.price_vs_52w_high_pct;
    if (priceFromHigh == null) continue;
    // priceFromHigh is negative (e.g., -22 means 22% below high)
    const pctBelow = Math.abs(priceFromHigh);
    if (pctBelow < 15 || pctBelow > 35) continue;

    // ── Analyst consensus: must contain "BUY" ───────────────────────
    const consensus = (ti.analyst_consensus || '').toUpperCase();
    if (!consensus.includes('BUY')) continue;

    // ── All conditions met — generate signal ────────────────────────
    const currentPrice = cs.current_price || ti.current_price;
    if (!currentPrice) continue;

    // Strike: 10-15% OTM (below current price for puts)
    const strike10 = +(currentPrice * 0.90).toFixed(2);
    const strike15 = +(currentPrice * 0.85).toFixed(2);

    // Hard exit: earnings_date + 1 trading day
    const hardExit = new Date(ed);
    hardExit.setDate(hardExit.getDate() + 1);
    const hardExitStr = hardExit.toISOString().split('T')[0];

    // Confidence scales with conviction score: 65→70, 80→80, 100→90
    const confidence = Math.min(90, Math.round(cs.conviction_score * 0.7 + 24));

    signals.push({
      ticker: cs.ticker,
      direction: 'PUT',
      strategy: 'PRE_EARNINGS_PUT',
      entry_price: currentPrice,
      confidence,
      hold: 'MULTIDAY',
      conviction_score: cs.conviction_score,
      earnings_date: earningsDate,
      days_to_earnings: daysToEarnings,
      iv_rank: +ivRank.toFixed(0),
      pct_below_high: +pctBelow.toFixed(1),
      strike_range: `$${strike15} - $${strike10}`,
      strike_low: strike15,
      strike_high: strike10,
      expiry: hardExitStr,
      hard_exit: hardExitStr,
      position_size_pct: 1.5,
      exit_within_days: daysToEarnings + 1,
      top_risk_factors: cs.top_risk_factors || [],
      note: `conviction=${cs.conviction_score} ER=${daysToEarnings}d IV=${ivRank.toFixed(0)}% below52wH=${pctBelow.toFixed(1)}%`,
    });
  }

  return signals;
}

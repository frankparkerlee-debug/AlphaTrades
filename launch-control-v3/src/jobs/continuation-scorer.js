/**
 * Continuation Scorer
 *
 * Rules:
 *   1. STOP_HIT — exit if unrealized P&L < -38%
 *   2. VWAP_CROSS — intraday: exit when price crosses unfavorable side of VWAP
 *      after 5+ bars on favorable side
 *   3. RSI_DIVERGENCE — bearish divergence >10pts → PARTIAL_EXIT
 *   4. NEAR_T1 — partial exit at 85% gain
 *   5. THETA_EXCEEDING_GAIN — exit after 30 min if theta outpaces gains
 *   6. CONSEC_BOUNCE — only STOP_HIT and new session low below entry
 *   7. Default HOLD
 */

// ── Strategy-specific thesis checks ─────────────────────────────────────────

function checkGapReversalThesis(trade, recentBars, marketContext) {
  const reasons = [];
  let intact = true;
  const dir = trade.direction === 'CALL' ? 1 : -1;
  const stopPrice = parseFloat(trade.entry_stop) || 0;

  const lastPrice = recentBars.length > 0 ? recentBars[recentBars.length - 1].close : 0;
  if (stopPrice > 0 && lastPrice < stopPrice && dir === 1) {
    intact = false;
    reasons.push('price_below_stop');
  }
  if (stopPrice > 0 && lastPrice > stopPrice && dir === -1) {
    intact = false;
    reasons.push('price_above_stop');
  }

  if (recentBars.length >= 3) {
    const last3 = recentBars.slice(-3);
    const higherLows = last3[1].low > last3[0].low && last3[2].low > last3[1].low;
    if (!higherLows && dir === 1) reasons.push('no_higher_lows');
  }

  if (recentBars.length >= 6) {
    const last6 = recentBars.slice(-6);
    let greenVol = 0, redVol = 0;
    for (const b of last6) {
      if (b.close >= b.open) greenVol += b.volume;
      else redVol += b.volume;
    }
    if (dir === 1 && redVol > greenVol) reasons.push('red_volume_dominant');
    if (dir === -1 && greenVol > redVol) reasons.push('green_volume_dominant');
  }

  if (marketContext.spyChangeSinceEntry != null && marketContext.spyChangeSinceEntry <= 0) {
    reasons.push('spy_turned_negative');
  }

  if (reasons.length >= 2) intact = false;
  return { intact, reasons };
}

function checkSectorRotationThesis(trade, recentBars, marketContext) {
  const reasons = [];
  let intact = true;

  if (marketContext.spyChangeSinceEntry != null && marketContext.spyChangeSinceEntry <= 0) {
    intact = false;
    reasons.push('spy_turned_negative');
  }

  if (recentBars.length >= 3) {
    const last3 = recentBars.slice(-3);
    if (!(last3[1].low > last3[0].low && last3[2].low > last3[1].low)) reasons.push('no_higher_lows');
  }

  if (recentBars.length >= 6) {
    const last6 = recentBars.slice(-6);
    let upVol = 0, downVol = 0;
    for (const b of last6) {
      if (b.close >= b.open) upVol += b.volume;
      else downVol += b.volume;
    }
    if (downVol > upVol) reasons.push('down_volume_exceeds_up');
  }

  if (reasons.length >= 2) intact = false;
  return { intact, reasons };
}

function checkCapitulationThesis(trade, recentBars) {
  const reasons = [];
  let intact = true;

  if (recentBars.length < 3) return { intact: true, reasons: [] };

  const entryPrice = parseFloat(trade.entry_stock_price) || 0;
  const sessionLow = Math.min(...recentBars.map(b => b.low));
  const lastPrice = recentBars[recentBars.length - 1].close;

  if (lastPrice <= sessionLow && recentBars.length > 5) {
    intact = false;
    reasons.push('at_session_low');
  }
  if (sessionLow < entryPrice * 0.99) reasons.push('new_low_below_entry');

  const redBars = recentBars.filter(b => b.close < b.open);
  if (redBars.length >= 3) {
    const rr = redBars.slice(-3);
    if (rr[1].volume > rr[0].volume && rr[2].volume > rr[1].volume) reasons.push('red_volume_increasing');
  }

  if (reasons.length >= 2) intact = false;
  return { intact, reasons };
}

function checkBreakdownPutThesis(trade, recentBars, marketContext) {
  const reasons = [];
  let intact = true;
  const entryPrice = parseFloat(trade.entry_stock_price) || 0;
  const stopPrice = parseFloat(trade.entry_stop) || 0;

  if (recentBars.length === 0) return { intact: true, reasons: [] };

  const lastPrice = recentBars[recentBars.length - 1].close;

  // PUT thesis broken if price reclaims stop (above VWAP)
  if (stopPrice > 0 && lastPrice > stopPrice) {
    intact = false;
    reasons.push('price_above_stop');
  }

  // Buyers stepping in: 3 consecutive green bars with increasing volume
  if (recentBars.length >= 3) {
    const last3 = recentBars.slice(-3);
    const allGreen = last3.every(b => b.close > b.open);
    const volIncreasing = last3[1].volume > last3[0].volume && last3[2].volume > last3[1].volume;
    if (allGreen && volIncreasing) reasons.push('green_volume_reversal');
  }

  // SPY turned positive (for BREAKDOWN_PUT, market was originally red)
  if (marketContext.spyChangeSinceEntry != null && marketContext.spyChangeSinceEntry > 0.003) {
    reasons.push('spy_turned_positive');
  }

  if (reasons.length >= 2) intact = false;
  return { intact, reasons };
}

function checkConsecBounceThesis(trade, recentBars) {
  const entryPrice = parseFloat(trade.entry_stock_price) || 0;
  if (recentBars.length === 0) return { intact: true, reasons: [] };

  const sessionLow = Math.min(...recentBars.map(b => b.low));
  if (sessionLow < entryPrice) {
    return { intact: false, reasons: ['new_session_low_below_entry'] };
  }
  return { intact: true, reasons: [] };
}

function checkThesis(strategy, trade, recentBars, marketContext) {
  switch (strategy) {
    case 'GAP_REVERSAL':             return checkGapReversalThesis(trade, recentBars, marketContext);
    case 'GAP_UP_REVERSAL':          return checkGapReversalThesis(trade, recentBars, marketContext);
    case 'SECTOR_ROTATION_BOUNCE':   return checkSectorRotationThesis(trade, recentBars, marketContext);
    case 'CAPITULATION_BOUNCE':      return checkCapitulationThesis(trade, recentBars);
    case 'CONSEC_BOUNCE':            return checkConsecBounceThesis(trade, recentBars);
    case 'VOL_DROP_PUT':             return checkCapitulationThesis(trade, recentBars);
    case 'BREAKDOWN_PUT':            return checkBreakdownPutThesis(trade, recentBars, marketContext);
    case 'RELATIVE_WEAKNESS_PUT':    return checkBreakdownPutThesis(trade, recentBars, marketContext);
    default:                         return { intact: true, reasons: [] };
  }
}

// ── VWAP cross detection ────────────────────────────────────────────────────

function checkVwapCross(sessionBars, currentBarIndex, direction) {
  if (!sessionBars || sessionBars.length < 7 || currentBarIndex < 6) {
    return { crossed: false, favorableStreak: 0 };
  }

  let cumVol = 0, cumTpVol = 0;
  const vwaps = [];
  for (let i = 0; i <= currentBarIndex; i++) {
    const b = sessionBars[i];
    const tp = (b.high + b.low + b.close) / 3;
    cumVol += b.volume;
    cumTpVol += tp * b.volume;
    vwaps.push(cumVol > 0 ? cumTpVol / cumVol : b.close);
  }

  const isFavorable = (price, vwap) =>
    direction === 'CALL' ? price > vwap : price < vwap;

  let favorableStreak = 0;
  for (let i = currentBarIndex - 1; i >= 0; i--) {
    if (isFavorable(sessionBars[i].close, vwaps[i])) favorableStreak++;
    else break;
  }

  const currentBar = sessionBars[currentBarIndex];
  const currentVwap = vwaps[currentBarIndex];
  const crossed = !isFavorable(currentBar.close, currentVwap) && favorableStreak >= 5;

  return { crossed, favorableStreak, vwap: currentVwap };
}

// ── RSI divergence detection ────────────────────────────────────────────────

function checkRsiDivergence(bars) {
  if (!bars || bars.length < 20) {
    return { bearishDivergence: false, rsiDiff: 0 };
  }

  const period = 14;
  const prices = bars.map(b => b.close);
  const rsi = new Array(prices.length).fill(null);
  let avgGain = 0, avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  const lastIdx = prices.length - 1;
  const last3High = Math.max(prices[lastIdx], prices[lastIdx - 1], prices[lastIdx - 2]);
  const last3HighIdx = [lastIdx, lastIdx - 1, lastIdx - 2].find(i => prices[i] === last3High);

  let prevHighIdx = -1, prevHighPrice = -Infinity;
  for (let i = lastIdx - 3; i >= Math.max(0, lastIdx - 20); i--) {
    if (prices[i] > prevHighPrice) { prevHighPrice = prices[i]; prevHighIdx = i; }
  }

  if (prevHighIdx < 0 || rsi[last3HighIdx] === null || rsi[prevHighIdx] === null) {
    return { bearishDivergence: false, rsiDiff: 0 };
  }

  const priceNewHigh = last3High >= prevHighPrice;
  const rsiDiff = rsi[prevHighIdx] - rsi[last3HighIdx];

  return {
    bearishDivergence: priceNewHigh && rsiDiff > 10,
    rsiDiff,
    currentRsi: rsi[lastIdx],
  };
}

// ── Theta vs gain ───────────────────────────────────────────────────────────

function computeThetaVsGain(trade, minutesHeld, unrealizedPnl) {
  const cumulativeTheta = parseFloat(trade.cumulative_theta) || 0;
  const thetaRate = minutesHeld > 0 ? Math.abs(cumulativeTheta) / minutesHeld : 0;
  const gainRate = minutesHeld > 0 ? unrealizedPnl / minutesHeld : 0;
  return { thetaRate, gainRate };
}

// ── Main scorer ──────────────────────────────────────────────────────────────

/**
 * @param {Object} paperTrade - row from lc_v3.paper_trades
 * @param {Array} recentBars - last ~30 1-min bars for this ticker
 * @param {Object} marketContext - { spyChangeSinceEntry, currentRegime }
 * @param {Object} currentGreeks - { delta, iv, spread, theta }
 * @param {import('pg').Pool} db - Postgres pool
 * @param {Object} [opts] - optional: { sessionBars } full session bars for VWAP
 */
export async function scoreContinuation(paperTrade, recentBars, marketContext, currentGreeks, db, opts = {}) {
  const strategy = paperTrade.strategy || '';
  const direction = paperTrade.direction || 'CALL';
  const entryTime = new Date(paperTrade.entry_time);
  const minutesHeld = Math.max(1, (Date.now() - entryTime.getTime()) / 60_000);
  const unrealizedPnl = parseFloat(paperTrade.unrealized_pnl_pct) || 0;

  const thesis = checkThesis(strategy, paperTrade, recentBars, marketContext);
  const isConsecBounce = strategy === 'CONSEC_BOUNCE';

  // VWAP for intraday strategies
  const INTRADAY = ['GAP_REVERSAL', 'GAP_UP_REVERSAL', 'SECTOR_ROTATION_BOUNCE', 'CAPITULATION_BOUNCE', 'BREAKDOWN_PUT', 'RELATIVE_WEAKNESS_PUT'];
  const isIntraday = INTRADAY.includes(strategy);
  let vwapResult = { crossed: false, favorableStreak: 0 };
  if (isIntraday) {
    const sessionBars = opts.sessionBars || recentBars;
    vwapResult = checkVwapCross(sessionBars, sessionBars.length - 1, direction);
  }

  // RSI for non-CONSEC_BOUNCE
  let rsiResult = { bearishDivergence: false, rsiDiff: 0 };
  if (!isConsecBounce && recentBars.length >= 20) {
    rsiResult = checkRsiDivergence(recentBars);
  }

  // Theta vs gain
  const { thetaRate, gainRate } = computeThetaVsGain(paperTrade, minutesHeld, unrealizedPnl);

  let action, reason;

  // Rule 1: STOP_HIT
  if (unrealizedPnl < -38) {
    action = 'EXIT';
    reason = 'STOP_HIT';
  }
  // Rule 2: VWAP_CROSS (intraday only)
  else if (isIntraday && vwapResult.crossed) {
    action = 'EXIT';
    reason = 'VWAP_CROSS';
  }
  // Rule 3: RSI_DIVERGENCE (not CONSEC_BOUNCE)
  else if (!isConsecBounce && rsiResult.bearishDivergence) {
    action = 'PARTIAL_EXIT';
    reason = 'RSI_DIVERGENCE';
  }
  // Rule 4: NEAR_T1
  else if (unrealizedPnl > 85) {
    action = 'PARTIAL_EXIT';
    reason = 'NEAR_T1';
  }
  // Rule 5: THETA_EXCEEDING_GAIN (after 30 min, not CONSEC_BOUNCE)
  else if (!isConsecBounce && thetaRate > gainRate && gainRate >= 0 && minutesHeld > 30) {
    action = 'EXIT';
    reason = 'THETA_EXCEEDING_GAIN';
  }
  // Rule 6: CONSEC_BOUNCE thesis (new session low below entry)
  else if (isConsecBounce && !thesis.intact) {
    action = 'EXIT';
    reason = 'THESIS_BROKEN';
  }
  // Rule 7: Default HOLD
  else {
    action = 'HOLD';
    reason = 'THESIS_INTACT';
  }

  const details = {
    thesisIntact: thesis.intact,
    thesisIssues: thesis.reasons,
    minutesHeld: Math.round(minutesHeld),
    unrealizedPnl,
    vwapCross: vwapResult.crossed,
    vwapFavorableStreak: vwapResult.favorableStreak,
    rsiDivergence: rsiResult.bearishDivergence,
    rsiDiff: rsiResult.rsiDiff,
    thetaRate,
    gainRate,
  };

  // Store result
  try {
    await db.query(`
      UPDATE lc_v3.paper_trades SET
        continuation_action = $1,
        continuation_reason = $2,
        continuation_details = $3,
        continuation_scored_at = NOW()
      WHERE paper_id = $4
    `, [action, reason, JSON.stringify(details), paperTrade.paper_id]);
  } catch (err) {
    console.error(`[CONTINUATION] DB update failed for ${paperTrade.ticker}: ${err.message}`);
  }

  console.log(
    `[CONTINUATION] ${paperTrade.ticker} ${strategy} → ${action} (${reason})` +
    ` pnl=${unrealizedPnl.toFixed(1)}% held=${Math.round(minutesHeld)}min` +
    ` thesis=${thesis.intact ? 'OK' : 'BROKEN:' + thesis.reasons.join(',')}` +
    (vwapResult.crossed ? ` VWAP_CROSS(${vwapResult.favorableStreak}bars)` : '') +
    (rsiResult.bearishDivergence ? ` RSI_DIV(${rsiResult.rsiDiff.toFixed(1)}pts)` : '')
  );

  // Auto-close auto_traded positions on EXIT
  if (action === 'EXIT' && paperTrade.auto_traded === true) {
    try {
      const pnl = unrealizedPnl;
      const outcome = pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'FLAT';
      await db.query(`
        UPDATE lc_v3.paper_trades SET
          status = 'CLOSED', exit_time = NOW(), exit_reason = $1,
          final_pnl_pct = $2, outcome = $3
        WHERE paper_id = $4
      `, [reason, pnl, outcome, paperTrade.paper_id]);
      console.log(`[AUTO-PAPER] ${paperTrade.ticker} — auto-closed reason=${reason} pnl=${pnl.toFixed(2)}%`);
    } catch (closeErr) {
      console.error(`[AUTO-PAPER] ${paperTrade.ticker} close failed: ${closeErr.message}`);
    }
  }

  return { action, reason, details };
}

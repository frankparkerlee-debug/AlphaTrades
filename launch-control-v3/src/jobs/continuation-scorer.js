/**
 * Continuation Scorer
 *
 * Evaluates whether the original entry thesis is still intact for open
 * paper trades. Uses strategy-specific rules, momentum analysis, theta vs
 * gain comparison, and (for ambiguous cases) an LLM tiebreaker.
 *
 * Returns an action recommendation: HOLD, PARTIAL_EXIT, EXIT, ACCELERATE.
 */

import Anthropic from '@anthropic-ai/sdk';

const anthropicKey = process.env.ANTHROPIC_API_KEY;
const claude = anthropicKey ? new Anthropic({ apiKey: anthropicKey }) : null;

// ── Strategy-specific thesis checks ─────────────────────────────────────────

function checkGapReversalThesis(trade, recentBars, marketContext) {
  const reasons = [];
  let intact = true;
  const dir = trade.direction === 'CALL' ? 1 : -1;
  const stopPrice = parseFloat(trade.entry_stop) || 0;

  // Price above stop (first candle low for CALL)
  const lastPrice = recentBars.length > 0 ? recentBars[recentBars.length - 1].close : 0;
  if (stopPrice > 0 && lastPrice < stopPrice && dir === 1) {
    intact = false;
    reasons.push('price_below_stop');
  }
  if (stopPrice > 0 && lastPrice > stopPrice && dir === -1) {
    intact = false;
    reasons.push('price_above_stop');
  }

  // Higher lows in last 3 bars
  if (recentBars.length >= 3) {
    const last3 = recentBars.slice(-3);
    const higherLows = last3[1].low > last3[0].low && last3[2].low > last3[1].low;
    if (!higherLows && dir === 1) {
      reasons.push('no_higher_lows');
    }
  }

  // Volume: green bars > red bars in last 6
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

  // SPY still positive from entry
  if (marketContext.spyChangeSinceEntry != null && marketContext.spyChangeSinceEntry <= 0) {
    reasons.push('spy_turned_negative');
  }

  if (reasons.length >= 2) intact = false;
  return { intact, reasons };
}

function checkGapUpReversalThesis(trade, recentBars, marketContext) {
  // Mirror of gap reversal but for PUT direction
  return checkGapReversalThesis(trade, recentBars, marketContext);
}

function checkSectorRotationThesis(trade, recentBars, marketContext) {
  const reasons = [];
  let intact = true;

  // SPY still positive
  if (marketContext.spyChangeSinceEntry != null && marketContext.spyChangeSinceEntry <= 0) {
    intact = false;
    reasons.push('spy_turned_negative');
  }

  // Higher lows
  if (recentBars.length >= 3) {
    const last3 = recentBars.slice(-3);
    const higherLows = last3[1].low > last3[0].low && last3[2].low > last3[1].low;
    if (!higherLows) reasons.push('no_higher_lows');
  }

  // Up bar volume > down bar volume
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

  // Price above session low
  if (lastPrice <= sessionLow && recentBars.length > 5) {
    intact = false;
    reasons.push('at_session_low');
  }

  // New session low below entry
  if (sessionLow < entryPrice * 0.99) {
    reasons.push('new_low_below_entry');
  }

  // Volume declining on red bars (bearish exhaustion is good for bounce thesis)
  const redBars = recentBars.filter(b => b.close < b.open);
  if (redBars.length >= 3) {
    const recentRed = redBars.slice(-3);
    const volIncreasing = recentRed[1].volume > recentRed[0].volume && recentRed[2].volume > recentRed[1].volume;
    if (volIncreasing) reasons.push('red_volume_increasing');
  }

  if (reasons.length >= 2) intact = false;
  return { intact, reasons };
}

function checkConsecBounceThesis(trade, recentBars, dailyCloses) {
  const reasons = [];
  let intact = true;

  const entryPrice = parseFloat(trade.entry_stock_price) || 0;

  // Each session close above prior (if we have daily close data)
  if (dailyCloses && dailyCloses.length >= 2) {
    const lastTwo = dailyCloses.slice(-2);
    if (lastTwo[1] < lastTwo[0]) reasons.push('session_close_declined');
  }

  // Volume declining on red days — checked via recent bars as proxy
  const redBars = recentBars.filter(b => b.close < b.open);
  if (redBars.length >= 3) {
    const recentRed = redBars.slice(-3);
    const volIncreasing = recentRed[1].volume > recentRed[0].volume && recentRed[2].volume > recentRed[1].volume;
    if (volIncreasing) reasons.push('red_volume_increasing');
  }

  // Stock above entry low
  if (recentBars.length > 0) {
    const sessionLow = Math.min(...recentBars.map(b => b.low));
    if (sessionLow < entryPrice * 0.97) {
      intact = false;
      reasons.push('below_entry_low');
    }
  }

  if (reasons.length >= 2) intact = false;
  return { intact, reasons };
}

// ── Thesis check dispatcher ─────────────────────────────────────────────────

function checkThesis(strategy, trade, recentBars, marketContext) {
  switch (strategy) {
    case 'GAP_REVERSAL':             return checkGapReversalThesis(trade, recentBars, marketContext);
    case 'GAP_UP_REVERSAL':          return checkGapUpReversalThesis(trade, recentBars, marketContext);
    case 'SECTOR_ROTATION_BOUNCE':   return checkSectorRotationThesis(trade, recentBars, marketContext);
    case 'CAPITULATION_BOUNCE':      return checkCapitulationThesis(trade, recentBars);
    case 'CONSEC_BOUNCE':            return checkConsecBounceThesis(trade, recentBars);
    case 'VOL_DROP_PUT':             return checkCapitulationThesis(trade, recentBars); // similar structure
    default:                         return { intact: true, reasons: [] };
  }
}

// ── Momentum computation ─────────────────────────────────────────────────────

function computeMomentum(trade, recentBars) {
  const dir = trade.direction === 'CALL' ? 1 : -1;
  const entryTime = new Date(trade.entry_time);
  const minutesHeld = Math.max(1, (Date.now() - entryTime.getTime()) / 60_000);
  const unrealizedPnl = parseFloat(trade.unrealized_pnl_pct) || 0;
  const maxAdverse = parseFloat(trade.max_adverse_pnl_pct) || 0;

  const valueVelocity = unrealizedPnl / minutesHeld;         // pnl pct per minute
  const adverseVelocity = Math.abs(maxAdverse) / minutesHeld; // adverse pct per minute

  // Count consecutive favorable/unfavorable bars at the tail
  let consecutiveFavorable = 0;
  let consecutiveUnfavorable = 0;
  for (let i = recentBars.length - 1; i >= 0; i--) {
    const b = recentBars[i];
    const favorable = (b.close - b.open) * dir > 0;
    if (favorable) {
      if (consecutiveUnfavorable === 0) consecutiveFavorable++;
      else break;
    } else {
      if (consecutiveFavorable === 0) consecutiveUnfavorable++;
      else break;
    }
  }

  // Volume trend on last 4 bars (expanding = each bar higher vol than prior)
  let volumeExpanding = false;
  if (recentBars.length >= 4) {
    const last4 = recentBars.slice(-4);
    volumeExpanding = last4[1].volume > last4[0].volume &&
                      last4[2].volume > last4[1].volume &&
                      last4[3].volume > last4[2].volume;
  }

  return {
    minutesHeld,
    unrealizedPnl,
    valueVelocity,
    adverseVelocity,
    consecutiveFavorable,
    consecutiveUnfavorable,
    volumeExpanding,
  };
}

// ── Theta vs gain comparison ─────────────────────────────────────────────────

function computeThetaVsGain(trade, momentum) {
  const cumulativeTheta = parseFloat(trade.cumulative_theta) || 0;
  const thetaRate = momentum.minutesHeld > 0 ? Math.abs(cumulativeTheta) / momentum.minutesHeld : 0;
  const gainRate = momentum.minutesHeld > 0 ? momentum.unrealizedPnl / momentum.minutesHeld : 0;

  return { thetaRate, gainRate };
}

// ── LLM tiebreaker for ambiguous cases ──────────────────────────────────────

async function llmTiebreaker(trade, momentum, thesis, marketContext) {
  if (!claude) return 'HOLD'; // fallback if no API key

  try {
    const prompt = `You are a short-term options trading assistant. Decide: HOLD or EXIT.

POSITION: ${trade.ticker} ${trade.direction} ${trade.strategy}
Entry: $${trade.entry_stock_price} | Current: $${trade.current_stock_price}
Unrealized P&L: ${momentum.unrealizedPnl.toFixed(2)}%
Minutes held: ${Math.round(momentum.minutesHeld)}
Consecutive unfavorable bars: ${momentum.consecutiveUnfavorable}
Value velocity: ${(momentum.valueVelocity * 100).toFixed(3)}% per min

THESIS CHECK: ${thesis.intact ? 'MOSTLY INTACT' : 'WEAKENING'}
Issues: ${thesis.reasons.join(', ') || 'none'}

MARKET: SPY change since entry: ${marketContext.spyChangeSinceEntry != null ? (marketContext.spyChangeSinceEntry * 100).toFixed(2) + '%' : 'unknown'}

The position shows 3+ consecutive unfavorable bars but no clear thesis breakdown. Is momentum just pausing, or is the trade failing?

Reply with exactly one word: HOLD or EXIT`;

    const response = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages: [{ role: 'user', content: prompt }],
    });

    const answer = (response.content[0]?.text || '').trim().toUpperCase();
    console.log(`[CONTINUATION] LLM tiebreaker for ${trade.ticker}: ${answer}`);
    return answer === 'EXIT' ? 'EXIT' : 'HOLD';
  } catch (err) {
    console.warn(`[CONTINUATION] LLM call failed for ${trade.ticker}: ${err.message}`);
    return 'HOLD'; // default to hold on API failure
  }
}

// ── Main scorer ──────────────────────────────────────────────────────────────

/**
 * Score whether a paper trade should continue or exit.
 *
 * @param {Object} paperTrade - row from lc_v3.paper_trades
 * @param {Array} recentBars - last ~30 1-min bars for this ticker
 * @param {Object} marketContext - { spyChangeSinceEntry, currentRegime }
 * @param {Object} currentGreeks - { delta, iv, spread, theta } from options monitor
 * @param {import('pg').Pool} db - Postgres pool
 * @returns {{ action: string, reason: string, details: Object }}
 */
export async function scoreContinuation(paperTrade, recentBars, marketContext, currentGreeks, db) {
  const strategy = paperTrade.strategy || '';
  const momentum = computeMomentum(paperTrade, recentBars);
  const thesis = checkThesis(strategy, paperTrade, recentBars, marketContext);
  const { thetaRate, gainRate } = computeThetaVsGain(paperTrade, momentum);

  let action, reason;

  // Rule 1: Thesis broken
  if (!thesis.intact) {
    action = 'EXIT';
    reason = 'THESIS_BROKEN';
  }
  // Rule 2: Hard stop at -38%
  else if (momentum.unrealizedPnl < -38) {
    action = 'EXIT';
    reason = 'STOP_HIT';
  }
  // Rule 3: Momentum exhausting (ambiguous — may need LLM)
  else if (momentum.consecutiveUnfavorable >= 3 && momentum.valueVelocity < 0.01) {
    // Ambiguous between Rule 3 and Rule 7 — ask LLM
    const llmDecision = await llmTiebreaker(paperTrade, momentum, thesis, marketContext);
    if (llmDecision === 'EXIT') {
      action = 'EXIT';
      reason = 'MOMENTUM_EXHAUSTED_LLM';
    } else {
      action = 'HOLD';
      reason = 'THESIS_INTACT_LLM';
    }
  }
  // Rule 4: Theta exceeds gain rate (only after 15 min)
  else if (thetaRate > gainRate && gainRate >= 0 && momentum.minutesHeld > 15) {
    action = 'EXIT';
    reason = 'THETA_EXCEEDING_GAIN';
  }
  // Rule 5: Near T1 — consider partial exit
  else if (momentum.unrealizedPnl > 85) {
    action = 'PARTIAL_EXIT';
    reason = 'NEAR_T1';
  }
  // Rule 6: Momentum accelerating
  else if (momentum.consecutiveFavorable >= 4 && momentum.volumeExpanding) {
    action = 'ACCELERATE';
    reason = 'MOMENTUM_BUILDING';
  }
  // Rule 7: Default — thesis intact, keep holding
  else {
    action = 'HOLD';
    reason = 'THESIS_INTACT';
  }

  const details = {
    thesisIntact: thesis.intact,
    thesisIssues: thesis.reasons,
    minutesHeld: Math.round(momentum.minutesHeld),
    unrealizedPnl: momentum.unrealizedPnl,
    valueVelocity: momentum.valueVelocity,
    consecutiveFavorable: momentum.consecutiveFavorable,
    consecutiveUnfavorable: momentum.consecutiveUnfavorable,
    thetaRate,
    gainRate,
    volumeExpanding: momentum.volumeExpanding,
  };

  // Store result in paper_trades
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
    ` pnl=${momentum.unrealizedPnl.toFixed(1)}% held=${Math.round(momentum.minutesHeld)}min` +
    ` thesis=${thesis.intact ? 'OK' : 'BROKEN:' + thesis.reasons.join(',')}`
  );

  // Auto-close auto_traded positions on EXIT or STOP_HIT
  if ((action === 'EXIT' || reason === 'STOP_HIT') && paperTrade.auto_traded === true) {
    try {
      const pnl = momentum.unrealizedPnl;
      const outcome = pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'FLAT';
      await db.query(`
        UPDATE lc_v3.paper_trades SET
          status = 'CLOSED',
          exit_time = NOW(),
          exit_reason = $1,
          final_pnl_pct = $2,
          outcome = $3
        WHERE paper_id = $4
      `, [reason, pnl, outcome, paperTrade.paper_id]);
      console.log(`[AUTO-PAPER] ${paperTrade.ticker} — auto-closed reason=${reason} pnl=${pnl.toFixed(2)}%`);
    } catch (closeErr) {
      console.error(`[AUTO-PAPER] ${paperTrade.ticker} close failed: ${closeErr.message}`);
    }
  }

  return { action, reason, details };
}

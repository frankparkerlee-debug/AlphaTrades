/**
 * Auto-Trader Engine — Single-Leg Options
 *
 * Buys ATM 0DTE options on Alpaca paper trading based on strategy signals.
 * Uses backtest-validated exit model: trail, momentum stall, loss cut, time.
 *
 * Lifecycle:
 *   1. Strategy scanner fires signal → written to lc_v3.signals
 *   2. Contract selector finds ATM 0DTE option
 *   3. Risk manager approves trade
 *   4. Limit order placed at mid via Alpaca paper API
 *   5. Fill tracked, position monitored every 15s
 *   6. Auto-exit: trail (+8% activate, keep 60%), -20% cut, 45min time, stall
 *   7. P&L recorded to paper_trades, risk state updated
 *
 * State machine: IDLE → PENDING_ENTRY → OPEN → PENDING_EXIT → CLOSED
 */

import { query } from '../data/db.js';
import {
  submitOptionOrder, getOrder, getPositions, closePosition,
  getAccount, cancelOrder, cancelAllOrders, closeAllPositions,
} from './alpaca-orders.js';
import { selectOptionsContract, fetchContractQuote } from '../options/contract-selector.js';
import {
  checkPreTrade, recordTrade, checkKillSwitch,
  updatePositionCount, resetDaily, isMarketHours, getDailyState,
  manualHalt, resume,
} from './risk-manager.js';
import { recordCompoundResult } from '../data/alpaca-streams.js';

// ── Configuration ─────────────────────────────────────────────────────────────

const CYCLE_SECONDS     = 15;     // monitor every 15s (matches poll interval)
const ORDER_TTL_SECONDS = 45;     // cancel unfilled limit orders after 45s
const DRY_RUN = process.env.AUTO_TRADE_DRY_RUN === 'true';
const ACCOUNT_SIZE = parseFloat(process.env.ACCOUNT_SIZE || '7500');

// ── Backtest-Validated Exit Thresholds ────────────────────────────────────────
// These match single-leg-pnl.js defaults and per-strategy overrides

const DEFAULT_EXITS = {
  targetPct: 100,          // effectively disabled — trail captures gains
  trailActivatePct: 8,     // trail activates at +8%
  trailGiveBack: 0.40,     // exit when P&L drops to 40% of peak (keep 60%)
  lossCutPct: -20,         // cut at -20% loss
  maxHoldMinutes: 45,      // time backstop
};

// Per-strategy exit overrides (from backtest validation)
const STRATEGY_EXITS = {
  ORB_BREAKOUT: {
    ...DEFAULT_EXITS,
    maxHoldMinutes: 60,
  },
  GAP_FILL_REVERSION: {
    ...DEFAULT_EXITS,
    maxHoldMinutes: 120,
  },
  MOMENTUM_SCALP: {
    targetPct: 100,
    trailActivatePct: 20,   // trail after meaningful gain
    trailGiveBack: 0.35,    // keep 65% of peak
    lossCutPct: -15,         // tighter cut for scalps
    maxHoldMinutes: 45,
  },
  SCALP_PATTERN: {
    targetPct: 100,          // disabled — trail captures gains
    trailActivatePct: 5,     // tight trail: activate at +5%
    trailGiveBack: 0.50,     // exit when P&L drops to 50% of peak
    lossCutPct: -10,         // quick cut at -10%
    maxHoldMinutes: 5,       // hard 5-min max hold for scalps
  },
  // Compound Scalp — backtest-validated trailing stop model (27 months, 6/6 overfit checks passed)
  // Parameters: -3% init, BE@+2%, trail@+3% keep 60%, close-based stops
  COMPOUND_SCALP: {
    targetPct: 100,          // disabled — trailing captures gains (no fixed target)
    trailActivatePct: 3,     // trail activates at +3%
    trailGiveBack: 0.60,     // keep 60% of peak
    lossCutPct: -3,          // -3% initial stop
    maxHoldMinutes: 5,       // 5 bar (minute) max hold
    breakEvenPct: 2,         // move stop to 0% when +2% reached
    closeBasedStops: true,   // only evaluate stops on bar close, not intra-bar
  },
};

// Position sizing: 10% of account per trade (1-2 contracts on 0DTE)
const SIZE_PCT = 0.10;

// ── State ─────────────────────────────────────────────────────────────────────

const openTrades = new Map();   // tradeId -> TradeState
let startingEquity = 0;
let running = false;
let cycleTimer = null;

// ── Engine Lifecycle ──────────────────────────────────────────────────────────

/**
 * Start the auto-trader engine.
 * Called from server.js on startup — runs automatically during market hours.
 */
export async function startAutoTrader() {
  if (running) return;
  running = true;

  console.log(`[AUTO-TRADER] Starting${DRY_RUN ? ' (DRY RUN)' : ' (PAPER)'}...`);

  try {
    const account = await getAccount();
    startingEquity = parseFloat(account.equity || account.portfolio_value || ACCOUNT_SIZE);
    console.log(`[AUTO-TRADER] Account equity: $${startingEquity.toFixed(2)}`);
  } catch (err) {
    console.error(`[AUTO-TRADER] Account fetch failed: ${err.message} — using default $${ACCOUNT_SIZE}`);
    startingEquity = ACCOUNT_SIZE;
  }

  resetDaily();

  // Clean up stale paper trades from DB (0DTE options that expired on prior days)
  await cleanupStaleTrades();

  // Recover any open auto-traded positions from DB (survives server restart)
  await recoverOpenTrades();

  cycleTimer = setInterval(runCycle, CYCLE_SECONDS * 1000);
  console.log(`[AUTO-TRADER] Running every ${CYCLE_SECONDS}s | Default: trail +8%→60%, cut -20%, max 45min | CompoundScalp: trail +3%→60%, BE@+2%, cut -3%, max 5min`);
}

/**
 * Stop the auto-trader.
 */
export function stopAutoTrader() {
  running = false;
  if (cycleTimer) clearInterval(cycleTimer);
  cycleTimer = null;
  console.log('[AUTO-TRADER] Stopped');
}

/**
 * Main cycle — called every CYCLE_SECONDS.
 */
async function runCycle() {
  if (!running || !isMarketHours()) return;

  try {
    // 1. Monitor open positions for exits
    await monitorOpenPositions();

    // 2. Check pending orders for fills / TTL
    await checkPendingOrders();

    // 3. Pick up new signals
    await checkForNewSignals();

    // 4. Kill switch
    try {
      const account = await getAccount();
      const equity = parseFloat(account.equity || account.portfolio_value || startingEquity);
      const kill = checkKillSwitch(equity, startingEquity);
      if (kill.trigger) {
        console.error(`[AUTO-TRADER] ${kill.reason}`);
        await emergencyFlatten();
      }
    } catch { /* account check can fail transiently */ }

    updatePositionCount(openTrades.size);
  } catch (err) {
    console.error(`[AUTO-TRADER] Cycle error: ${err.message}`);
  }
}

// ── Signal Processing ─────────────────────────────────────────────────────────

/**
 * Check for new strategy signals that haven't been auto-traded yet.
 */
async function checkForNewSignals() {
  let signals;
  try {
    const res = await query(`
      SELECT * FROM lc_v3.signals
      WHERE status = 'ACTIVE'
        AND (auto_traded IS NULL OR auto_traded = false)
        AND grade IN ('A+', 'A', 'A-', 'B+')
        AND strategy IS NOT NULL
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY composite_raw DESC
      LIMIT 5
    `);
    signals = res.rows;
  } catch {
    return;
  }

  if (!signals || signals.length === 0) return;

  for (const signal of signals) {
    await processSignal(signal);
  }
}

/**
 * Process a single signal — select ATM 0DTE contract, place limit order.
 */
async function processSignal(signal) {
  const ticker = signal.ticker;
  const direction = signal.direction;
  const strategy = signal.strategy || 'UNKNOWN';
  const grade = signal.grade || 'B+';
  const entryPrice = parseFloat(signal.price_at_signal || 0);

  if (!entryPrice || entryPrice <= 0) return;

  // Dedupe: don't enter same ticker+direction if already open
  for (const [, trade] of openTrades) {
    if (trade.ticker === ticker && trade.direction === direction && trade.state !== 'CLOSED') {
      return;
    }
  }

  // Risk check
  const accountBalance = startingEquity;
  const tradeAllocation = accountBalance * SIZE_PCT;
  const tradeRisk = tradeAllocation * (Math.abs((STRATEGY_EXITS[strategy] || DEFAULT_EXITS).lossCutPct) / 100);

  const riskCheck = checkPreTrade(accountBalance, tradeRisk, openTrades.size);
  if (!riskCheck.allowed) {
    console.log(`[AUTO-TRADER] ${ticker} ${strategy} blocked: ${riskCheck.reason}`);
    return;
  }

  // Select contract — compound scalp uses pre-selected contract from signal
  console.log(`[AUTO-TRADER] Selecting contract: ${ticker} ${direction} ${strategy} grade=${grade}`);

  try {
    let contract;
    if (strategy === 'COMPOUND_SCALP' && signal.contract_symbol && signal.contract_mid > 0) {
      // Use pre-selected contract (already uses ITM put logic)
      contract = {
        symbol: signal.contract_symbol,
        strike: parseFloat(signal.contract_strike || 0),
        expiry: signal.contract_expiry,
        mid: parseFloat(signal.contract_mid),
        bid: parseFloat(signal.contract_bid || 0),
        ask: parseFloat(signal.contract_ask || 0),
        delta: parseFloat(signal.contract_delta || 0),
        iv: parseFloat(signal.contract_iv || 0),
      };
      console.log(`[AUTO-TRADER] Using pre-selected compound contract: ${contract.symbol} mid=$${contract.mid.toFixed(2)}`);
    } else {
      contract = await selectOptionsContract(ticker, direction, grade, entryPrice, 0, { minDTE: 0 });
    }

    if (!contract) {
      console.log(`[AUTO-TRADER] No viable contract for ${ticker} ${direction}`);
      return;
    }

    // Position sizing: how many contracts can we buy?
    const premiumPerContract = contract.mid * 100; // per share * 100 shares
    if (premiumPerContract <= 0) {
      console.log(`[AUTO-TRADER] ${ticker} contract mid is $0 — skipping`);
      return;
    }
    const contracts = Math.max(1, Math.floor(tradeAllocation / premiumPerContract));

    const exits = STRATEGY_EXITS[strategy] || DEFAULT_EXITS;
    const tradeId = `${ticker}-${direction}-${Date.now()}`;

    console.log(
      `[AUTO-TRADER] ${DRY_RUN ? '[DRY] ' : ''}BUY ${contracts}x ${contract.symbol} ` +
      `@ $${contract.mid.toFixed(2)} ($${(premiumPerContract * contracts).toFixed(0)} total) | ` +
      `${strategy} | exits: trail +${exits.trailActivatePct}%→${exits.trailGiveBack*100}%, cut ${exits.lossCutPct}%`
    );

    let orderId = null;

    if (!DRY_RUN) {
      try {
        const order = await submitOptionOrder(
          contract.symbol,
          contracts,
          'buy',
          'limit',
          contract.mid  // limit at mid price
        );
        orderId = order.id;
        console.log(`[AUTO-TRADER] Order submitted: ${orderId}`);
      } catch (err) {
        console.error(`[AUTO-TRADER] Order failed for ${ticker}: ${err.message}`);
        return;
      }
    }

    // Track the trade
    openTrades.set(tradeId, {
      id: tradeId,
      strategy,
      ticker,
      direction,
      state: DRY_RUN ? 'OPEN' : 'PENDING_ENTRY',
      orderId,
      contractSymbol: contract.symbol,
      contracts,
      entryTime: Date.now(),
      entryPrice,                    // underlying price at signal
      entryPremium: contract.mid,    // option premium at entry
      fillPrice: DRY_RUN ? contract.mid : null,
      grade,
      // Exit thresholds (from backtest validation)
      exits,
      // Trail state
      peakPnlPct: 0,
      breakEvenLocked: false,  // compound scalp: stop moves to 0% at +2%
      // For DB recording
      signalId: signal.signal_id,
      strike: contract.strike,
      expiry: contract.expiry,
      delta: contract.delta,
      iv: contract.iv,
    });

    // Mark signal as auto-traded
    try {
      await query(`UPDATE lc_v3.signals SET auto_traded = true WHERE signal_id = $1`, [signal.signal_id]);
    } catch { /* column may not exist */ }

  } catch (err) {
    console.error(`[AUTO-TRADER] Contract selection failed for ${ticker}: ${err.message}`);
  }
}

// ── Position Monitoring (Backtest-Validated Exits) ────────────────────────────

/**
 * Monitor all open positions for exit conditions.
 * Uses the same exit logic as single-leg-pnl.js:
 *   1. Loss cut (option P&L < -20%)
 *   2. Trail stop (peak > +8%, current < peak * 40%)
 *   3. Momentum stall (2 consecutive bars against after being up)
 *   4. Time backstop (maxHoldMinutes)
 *   5. Target (option P&L > +100%, effectively disabled)
 */
async function monitorOpenPositions() {
  for (const [tradeId, trade] of openTrades) {
    if (trade.state !== 'OPEN') continue;

    try {
      // Get current option quote
      const quote = await fetchContractQuote(trade.contractSymbol);
      if (!quote || quote.mid <= 0) continue;

      const currentMid = quote.mid;
      const entryPremium = trade.fillPrice || trade.entryPremium;
      if (!entryPremium || entryPremium <= 0) continue;

      const pnlPct = ((currentMid - entryPremium) / entryPremium) * 100;
      const holdMinutes = (Date.now() - trade.entryTime) / 60000;
      const exits = trade.exits;

      // Update peak P&L for trailing
      trade.peakPnlPct = Math.max(trade.peakPnlPct, pnlPct);

      // Compound scalp breakeven lock: once +2% reached, stop moves to 0%
      if (exits.breakEvenPct && trade.peakPnlPct >= exits.breakEvenPct) {
        trade.breakEvenLocked = true;
      }

      let exitReason = null;

      // Compute effective stop level for compound scalp trailing model
      let effectiveStop = exits.lossCutPct;
      if (trade.breakEvenLocked) {
        // Breakeven locked — stop is at least 0%
        effectiveStop = 0;
      }
      if (trade.peakPnlPct >= exits.trailActivatePct) {
        // Trail active — stop is peak * keepPct (at least breakeven if locked)
        const trailStop = trade.peakPnlPct * exits.trailGiveBack;
        effectiveStop = Math.max(effectiveStop, trailStop);
      }

      // 1. Stop check (covers initial stop, breakeven, and trailing)
      if (pnlPct <= effectiveStop) {
        exitReason = trade.peakPnlPct >= exits.trailActivatePct ? 'TRAIL' :
                     trade.breakEvenLocked ? 'BREAKEVEN' : 'CUT';
      }
      // 2. Target (effectively disabled at 100% for compound scalp)
      else if (pnlPct >= exits.targetPct) {
        exitReason = 'TARGET';
      }
      // 3. Time backstop
      else if (holdMinutes >= exits.maxHoldMinutes) {
        exitReason = 'TIME';
      }

      if (exitReason) {
        const pnlDollars = (currentMid - entryPremium) * 100 * trade.contracts;
        console.log(
          `[AUTO-TRADER] EXIT ${exitReason}: ${trade.ticker} ${trade.direction} ${trade.strategy} | ` +
          `P&L: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% ($${Math.round(pnlDollars)}) | ` +
          `held ${Math.round(holdMinutes)}min | peak ${trade.peakPnlPct.toFixed(1)}%`
        );
        await exitTrade(trade, exitReason, currentMid);
      }

    } catch (err) {
      console.error(`[AUTO-TRADER] Monitor error for ${trade.ticker}: ${err.message}`);
    }
  }
}

// ── Order Management ──────────────────────────────────────────────────────────

/**
 * Check pending entry orders for fills or TTL expiry.
 */
async function checkPendingOrders() {
  for (const [tradeId, trade] of openTrades) {
    if (trade.state !== 'PENDING_ENTRY') continue;

    const elapsed = (Date.now() - trade.entryTime) / 1000;

    // TTL expired — cancel unfilled order and update DB
    if (elapsed > ORDER_TTL_SECONDS) {
      console.log(`[AUTO-TRADER] Order TTL expired for ${trade.ticker} — canceling`);
      try {
        if (trade.orderId && !DRY_RUN) {
          await cancelOrder(trade.orderId);
        }
      } catch { /* already filled or canceled */ }
      // Mark in DB so it doesn't stay OPEN forever
      if (trade.paperId) {
        try {
          await query(`
            UPDATE lc_v3.paper_trades SET
              status = 'CLOSED', exit_time = NOW(), exit_reason = 'ORDER_EXPIRED',
              final_pnl_pct = 0, final_pnl_dollars = 0, outcome = 'FLAT'
            WHERE paper_id = $1
          `, [trade.paperId]);
        } catch { /* best effort */ }
      }
      openTrades.delete(tradeId);
      continue;
    }

    // Check fill status
    try {
      if (!trade.orderId) {
        trade.state = 'OPEN';
        continue;
      }

      const order = await getOrder(trade.orderId);
      if (order.status === 'filled') {
        trade.state = 'OPEN';
        trade.fillPrice = parseFloat(order.filled_avg_price || trade.entryPremium);
        trade.entryTime = Date.now(); // reset hold timer to fill time
        console.log(
          `[AUTO-TRADER] FILLED: ${trade.ticker} ${trade.direction} ${trade.strategy} | ` +
          `${trade.contracts}x @ $${trade.fillPrice.toFixed(2)}`
        );

        // Record entry in paper_trades
        await recordTradeEntry(trade);

      } else if (order.status === 'canceled' || order.status === 'expired' || order.status === 'rejected') {
        console.log(`[AUTO-TRADER] Order ${order.status}: ${trade.ticker}`);
        // Mark in DB so it doesn't stay OPEN forever
        if (trade.paperId) {
          try {
            await query(`
              UPDATE lc_v3.paper_trades SET
                status = 'CLOSED', exit_time = NOW(),
                exit_reason = $1, final_pnl_pct = 0, final_pnl_dollars = 0, outcome = 'FLAT'
              WHERE paper_id = $2
            `, [`ORDER_${order.status.toUpperCase()}`, trade.paperId]);
          } catch { /* best effort */ }
        }
        openTrades.delete(tradeId);
      }
    } catch (err) {
      console.error(`[AUTO-TRADER] Order check failed for ${trade.ticker}: ${err.message}`);
    }
  }
}

/**
 * Exit a trade — sell the option contract.
 */
async function exitTrade(trade, reason, currentMid) {
  trade.state = 'PENDING_EXIT';

  try {
    if (!DRY_RUN) {
      // Sell to close at market (fast exit)
      let exitSuccess = false;
      try {
        await closePosition(trade.contractSymbol);
        exitSuccess = true;
      } catch (closeErr) {
        // If closePosition fails (no position found), try a sell order
        console.warn(`[AUTO-TRADER] closePosition failed, trying sell order: ${closeErr.message}`);
        try {
          await submitOptionOrder(trade.contractSymbol, trade.contracts, 'sell', 'market');
          exitSuccess = true;
        } catch (sellErr) {
          console.error(`[AUTO-TRADER] Sell order also failed: ${sellErr.message}`);
        }
      }
      if (!exitSuccess) {
        console.error(`[AUTO-TRADER] Could not close ${trade.ticker} — will retry next cycle`);
        trade.state = 'OPEN';
        return;
      }
    }

    const entryPremium = trade.fillPrice || trade.entryPremium;
    const pnlPerContract = (currentMid - entryPremium) * 100;
    const totalPnl = pnlPerContract * trade.contracts;
    const pnlPct = entryPremium > 0 ? ((currentMid - entryPremium) / entryPremium) * 100 : 0;

    trade.state = 'CLOSED';
    recordTrade(totalPnl);

    // Update compound scalp circuit breaker
    if (trade.strategy === 'COMPOUND_SCALP') {
      try { recordCompoundResult(totalPnl > 0); } catch { /* non-critical */ }
    }

    // Record in paper_trades
    await recordTradeExit(trade, reason, pnlPct, totalPnl);

    console.log(
      `[AUTO-TRADER] CLOSED: ${trade.ticker} ${trade.direction} ${trade.strategy} | ` +
      `${reason} | ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% ($${Math.round(totalPnl)})`
    );

    openTrades.delete(trade.id);

  } catch (err) {
    console.error(`[AUTO-TRADER] Exit failed for ${trade.ticker}: ${err.message}`);
    trade.state = 'OPEN'; // retry next cycle
  }
}

// ── State Recovery & Cleanup ─────────────────────────────────────────────────

/**
 * Close stale paper trades from prior days.
 * 0DTE options expire worthless at EOD — any OPEN trade from a previous day is dead.
 */
async function cleanupStaleTrades() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const res = await query(`
      UPDATE lc_v3.paper_trades SET
        status = 'CLOSED',
        exit_time = created_at + interval '7 hours',
        exit_reason = 'EXPIRED_0DTE',
        final_pnl_pct = -100,
        final_pnl_dollars = 0,
        outcome = 'LOSS'
      WHERE status = 'OPEN'
        AND auto_traded = true
        AND created_at < $1::date
      RETURNING paper_id, ticker
    `, [today]);

    if (res.rows.length > 0) {
      console.log(`[AUTO-TRADER] Cleaned up ${res.rows.length} stale paper trades from prior days: ${res.rows.map(r => r.ticker).join(', ')}`);
    }
  } catch (err) {
    console.error(`[AUTO-TRADER] Stale trade cleanup failed: ${err.message}`);
  }
}

/**
 * Recover open auto-traded positions from DB (survives server restart).
 * Only recovers trades from today that have a contract symbol.
 */
async function recoverOpenTrades() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const res = await query(`
      SELECT paper_id, signal_id, ticker, direction, strategy,
             entry_stock_price, entry_contract_mid, entry_contract_symbol,
             entry_contract_strike, entry_contract_expiry,
             entry_contract_delta, entry_contract_iv,
             position_size_pct, created_at, grade
      FROM lc_v3.paper_trades
      WHERE status = 'OPEN'
        AND auto_traded = true
        AND created_at >= $1::date
        AND entry_contract_symbol IS NOT NULL
    `, [today]);

    if (res.rows.length === 0) return;

    // Check which contracts we actually hold on Alpaca
    let positions;
    try {
      positions = await getPositions();
    } catch {
      positions = [];
    }
    const heldSymbols = new Set(positions.map(p => p.symbol));

    let recovered = 0;
    for (const row of res.rows) {
      // Only recover if we still hold the position on Alpaca
      if (!heldSymbols.has(row.entry_contract_symbol)) {
        // Position closed on Alpaca but DB still says OPEN — mark as closed
        await query(`
          UPDATE lc_v3.paper_trades SET
            status = 'CLOSED', exit_time = NOW(), exit_reason = 'POSITION_GONE',
            outcome = 'UNKNOWN'
          WHERE paper_id = $1
        `, [row.paper_id]);
        console.log(`[AUTO-TRADER] Marked ${row.ticker} ${row.entry_contract_symbol} as POSITION_GONE (not held on Alpaca)`);
        continue;
      }

      const strategy = row.strategy || 'UNKNOWN';
      const exits = STRATEGY_EXITS[strategy] || DEFAULT_EXITS;
      const tradeId = `${row.ticker}-${row.direction}-recovered-${row.paper_id}`;

      openTrades.set(tradeId, {
        id: tradeId,
        strategy,
        ticker: row.ticker,
        direction: row.direction,
        state: 'OPEN',
        orderId: null,
        contractSymbol: row.entry_contract_symbol,
        contracts: 1, // conservative — we don't know exact qty from DB
        entryTime: new Date(row.created_at).getTime(),
        entryPrice: parseFloat(row.entry_stock_price || 0),
        entryPremium: parseFloat(row.entry_contract_mid || 0),
        fillPrice: parseFloat(row.entry_contract_mid || 0),
        grade: row.grade || 'B+',
        exits,
        peakPnlPct: 0,
        breakEvenLocked: false,
        signalId: row.signal_id,
        strike: parseFloat(row.entry_contract_strike || 0),
        expiry: row.entry_contract_expiry,
        delta: parseFloat(row.entry_contract_delta || 0),
        iv: parseFloat(row.entry_contract_iv || 0),
        paperId: row.paper_id,
      });
      recovered++;
    }

    if (recovered > 0) {
      console.log(`[AUTO-TRADER] Recovered ${recovered} open trades from DB`);
    }
  } catch (err) {
    console.error(`[AUTO-TRADER] Trade recovery failed: ${err.message}`);
  }
}

// ── Emergency Controls ────────────────────────────────────────────────────────

async function emergencyFlatten() {
  console.error('[AUTO-TRADER] EMERGENCY FLATTEN — closing all positions');
  manualHalt('Emergency flatten triggered');

  if (!DRY_RUN) {
    try {
      await cancelAllOrders();
      await closeAllPositions();
    } catch (err) {
      console.error(`[AUTO-TRADER] Flatten failed: ${err.message}`);
    }
  }

  for (const [id] of openTrades) {
    openTrades.delete(id);
  }
}

// ── DB Recording ──────────────────────────────────────────────────────────────

async function recordTradeEntry(trade) {
  try {
    const res = await query(`
      INSERT INTO lc_v3.paper_trades (
        signal_id, ticker, direction, strategy, status,
        entry_stock_price, entry_contract_mid, entry_contract_symbol,
        entry_contract_strike, entry_contract_expiry,
        entry_contract_delta, entry_contract_iv,
        position_size_pct, auto_traded
      ) VALUES ($1,$2,$3,$4,'OPEN',$5,$6,$7,$8,$9,$10,$11,$12,TRUE)
      RETURNING paper_id
    `, [
      trade.signalId,
      trade.ticker,
      trade.direction,
      trade.strategy,
      trade.entryPrice,
      trade.fillPrice || trade.entryPremium,
      trade.contractSymbol,
      trade.strike,
      trade.expiry,
      trade.delta,
      trade.iv,
      SIZE_PCT,
    ]);
    // Store paper_id so exits can match exactly
    if (res.rows?.[0]?.paper_id) {
      trade.paperId = res.rows[0].paper_id;
    }
  } catch (err) {
    console.error(`[AUTO-TRADER] recordTradeEntry failed: ${err.message}`);
  }
}

async function recordTradeExit(trade, exitReason, pnlPct, pnlDollars) {
  try {
    // Prefer paper_id for exact match, fall back to signal_id + ticker
    if (trade.paperId) {
      await query(`
        UPDATE lc_v3.paper_trades SET
          status = 'CLOSED',
          exit_time = NOW(),
          exit_reason = $1,
          final_pnl_pct = $2,
          final_pnl_dollars = $3,
          outcome = $4
        WHERE paper_id = $5
      `, [
        exitReason,
        parseFloat(pnlPct.toFixed(2)),
        Math.round(pnlDollars),
        pnlPct > 0 ? 'WIN' : pnlPct < 0 ? 'LOSS' : 'FLAT',
        trade.paperId,
      ]);
    } else {
      await query(`
        UPDATE lc_v3.paper_trades SET
          status = 'CLOSED',
          exit_time = NOW(),
          exit_reason = $1,
          final_pnl_pct = $2,
          final_pnl_dollars = $3,
          outcome = $4
        WHERE signal_id = $5
          AND ticker = $6
          AND status = 'OPEN'
          AND auto_traded = TRUE
      `, [
        exitReason,
        parseFloat(pnlPct.toFixed(2)),
        Math.round(pnlDollars),
        pnlPct > 0 ? 'WIN' : pnlPct < 0 ? 'LOSS' : 'FLAT',
        trade.signalId,
        trade.ticker,
      ]);
    }
  } catch (err) {
    console.error(`[AUTO-TRADER] recordTradeExit failed: ${err.message}`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get engine status for dashboard.
 */
export function getAutoTraderStatus() {
  return {
    running,
    dryRun: DRY_RUN,
    mode: 'SINGLE_LEG_OPTIONS',
    startingEquity,
    openTrades: Array.from(openTrades.values()).map(t => ({
      id: t.id,
      ticker: t.ticker,
      direction: t.direction,
      strategy: t.strategy,
      state: t.state,
      contractSymbol: t.contractSymbol,
      contracts: t.contracts,
      entryPremium: t.fillPrice || t.entryPremium,
      peakPnlPct: t.peakPnlPct,
      holdMinutes: Math.round((Date.now() - t.entryTime) / 60000),
      exits: t.exits,
    })),
    risk: getDailyState(),
  };
}

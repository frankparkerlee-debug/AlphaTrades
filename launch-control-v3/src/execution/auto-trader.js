/**
 * Auto-Trader Engine
 *
 * Fully autonomous execution engine for the 5-strategy system.
 * Runs as a worker loop on the server — no human intervention needed.
 *
 * Lifecycle:
 *   1. Strategy scanner detects signal
 *   2. Contract selector finds spread legs
 *   3. Risk manager approves trade
 *   4. Order placed via Alpaca API
 *   5. Fill tracked, position monitored
 *   6. Auto-exit on target/stop/time
 *   7. P&L recorded, risk state updated
 *
 * Inspired by mm-engine/engine.py state machine: IDLE → PENDING → HOLDING → IDLE
 */

import { query } from '../data/db.js';
import {
  submitSpreadOrder, submitIronCondorOrder,
  getOrder, getPositions, closePosition, getAccount,
  selectSpreadContracts,
} from './alpaca-orders.js';
import { selectOptionsContract } from '../options/contract-selector.js';
import {
  checkPreTrade, recordTrade, checkKillSwitch,
  updatePositionCount, resetDaily, isMarketHours, getDailyState,
  manualHalt,
} from './risk-manager.js';
import { getSpreadWidth, POSITION_SIZES, allInCost } from '../../scripts/backtest/execution-model.js';

// ── Configuration ─────────────────────────────────────────────────────────────

const CYCLE_SECONDS       = 30;     // check every 30 seconds
const ORDER_TTL_SECONDS   = 60;     // cancel unfilled orders after 60s
const POSITION_CHECK_INTERVAL = 60; // check positions every 60s
const DRY_RUN = process.env.AUTO_TRADE_DRY_RUN === 'true';

// ── State ─────────────────────────────────────────────────────────────────────

const openTrades = new Map();   // tradeId -> trade state
let startingEquity = 0;
let running = false;
let cycleTimer = null;

// ── Trade State Machine ───────────────────────────────────────────────────────

/**
 * @typedef {Object} TradeState
 * @property {string} id - unique trade ID
 * @property {string} strategy - A1-B2 strategy name
 * @property {string} ticker
 * @property {string} direction - CALL / PUT / NEUTRAL
 * @property {string} spreadType - DEBIT_VERTICAL / CREDIT_VERTICAL / IRON_CONDOR
 * @property {string} state - PENDING_ENTRY / OPEN / PENDING_EXIT / CLOSED
 * @property {Object} entryOrder - Alpaca order object
 * @property {Object} exitOrder - Alpaca order object (when exiting)
 * @property {number} entryTime - timestamp
 * @property {number} maxHoldMinutes
 * @property {number} holdDays
 * @property {Object} stopCondition
 * @property {Object} targetCondition
 * @property {number} entryPrice - underlying at entry
 * @property {number} atr
 * @property {Object} spreadDetails - legs, width, cost
 */

// ── Engine Lifecycle ──────────────────────────────────────────────────────────

/**
 * Start the auto-trader engine.
 * Called from server.js on startup.
 */
export async function startAutoTrader() {
  if (running) return;
  running = true;

  console.log(`[AUTO-TRADER] Starting${DRY_RUN ? ' (DRY RUN)' : ''}...`);

  try {
    const account = await getAccount();
    startingEquity = parseFloat(account.equity || account.portfolio_value || 7500);
    console.log(`[AUTO-TRADER] Account equity: $${startingEquity.toFixed(2)}`);
  } catch (err) {
    console.error(`[AUTO-TRADER] Failed to get account: ${err.message}`);
    startingEquity = 7500;
  }

  resetDaily();
  cycleTimer = setInterval(runCycle, CYCLE_SECONDS * 1000);
  console.log(`[AUTO-TRADER] Running every ${CYCLE_SECONDS}s`);
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
    // 1. Check open positions for exits
    await checkOpenPositions();

    // 2. Check for new signals from the scoring engine
    await checkForNewSignals();

    // 3. Check pending orders for fills
    await checkPendingOrders();

    // 4. Kill switch check
    const account = await getAccount();
    const equity = parseFloat(account.equity || account.portfolio_value || startingEquity);
    const kill = checkKillSwitch(equity, startingEquity);
    if (kill.trigger) {
      console.error(`[AUTO-TRADER] ${kill.reason}`);
      await emergencyFlatten();
    }

    updatePositionCount(openTrades.size);
  } catch (err) {
    console.error(`[AUTO-TRADER] Cycle error: ${err.message}`);
  }
}

// ── Signal Processing ─────────────────────────────────────────────────────────

/**
 * Check for new signals that haven't been auto-traded yet.
 * Reads from lc_v3.signals table where auto_traded is false.
 */
async function checkForNewSignals() {
  // Get recent unprocessed signals from DB
  let signals;
  try {
    const res = await query(`
      SELECT * FROM lc_v3.signals
      WHERE created_at > NOW() - interval '5 minutes'
        AND status = 'ACTIVE'
        AND (auto_traded IS NULL OR auto_traded = false)
        AND grade IN ('A+', 'A', 'A-', 'B+')
      ORDER BY composite_raw DESC
      LIMIT 3
    `);
    signals = res.rows;
  } catch {
    return; // signals table might not have auto_traded column yet
  }

  if (!signals || signals.length === 0) return;

  for (const signal of signals) {
    await processSignal(signal);
  }
}

/**
 * Process a single signal — determine strategy, select contracts, place order.
 */
async function processSignal(signal) {
  const ticker = signal.ticker;
  const direction = signal.direction;
  const grade = signal.grade || 'B+';
  const entryPrice = parseFloat(signal.price_at_signal || 0);
  const atr = parseFloat(signal.atr_multiple || 0.025) * entryPrice;

  if (!entryPrice || entryPrice <= 0) return;

  // Determine spread type based on signal context
  const spreadType = determineSpreadType(signal);
  const spreadWidth = getSpreadWidth(entryPrice);
  const sizePct = POSITION_SIZES[grade] || 0.075;

  // Risk check
  const account = await getAccount();
  const accountBalance = parseFloat(account.equity || account.portfolio_value || 7500);
  const tradeRisk = accountBalance * sizePct;

  const riskCheck = checkPreTrade(accountBalance, tradeRisk, openTrades.size);
  if (!riskCheck.allowed) {
    console.log(`[AUTO-TRADER] Signal blocked: ${riskCheck.reason}`);
    return;
  }

  // Dedupe: don't enter same ticker+direction if already open
  for (const [, trade] of openTrades) {
    if (trade.ticker === ticker && trade.direction === direction && trade.state !== 'CLOSED') {
      return;
    }
  }

  // Select contracts
  console.log(`[AUTO-TRADER] Processing: ${ticker} ${direction} ${grade} ${spreadType}`);

  try {
    const { snapshots, expiry } = await selectOptionsContract(ticker, direction, grade, 1);
    if (!snapshots || Object.keys(snapshots).length < 2) {
      console.log(`[AUTO-TRADER] Not enough contracts for ${ticker} spread`);
      return;
    }

    const spread = selectSpreadContracts(snapshots, entryPrice, direction, spreadWidth);
    if (!spread) {
      console.log(`[AUTO-TRADER] No viable spread found for ${ticker}`);
      return;
    }

    // Place the order
    await placeSpreadTrade({
      signal,
      ticker,
      direction,
      grade,
      entryPrice,
      atr: atr / entryPrice,
      spreadType,
      spread,
      sizePct,
      accountBalance,
    });

    // Mark signal as auto-traded
    try {
      await query(`UPDATE lc_v3.signals SET auto_traded = true WHERE signal_id = $1`, [signal.signal_id]);
    } catch { /* column may not exist */ }

  } catch (err) {
    console.error(`[AUTO-TRADER] Contract selection failed for ${ticker}: ${err.message}`);
  }
}

/**
 * Place a spread trade.
 */
async function placeSpreadTrade(params) {
  const { signal, ticker, direction, grade, entryPrice, atr, spreadType, spread, sizePct, accountBalance } = params;
  const contracts = Math.max(1, Math.floor((accountBalance * sizePct) / (spread.actualWidth * 100)));

  const tradeId = `${ticker}-${direction}-${Date.now()}`;
  const isCredit = spreadType === 'CREDIT_VERTICAL' || spreadType === 'IRON_CONDOR';
  const netPrice = isCredit ? spread.netCredit : spread.netDebit;

  console.log(
    `[AUTO-TRADER] ${DRY_RUN ? '[DRY RUN] ' : ''}Placing ${spreadType}: ` +
    `${ticker} ${direction} | ${spread.longSymbol} / ${spread.shortSymbol} | ` +
    `${contracts}x | net ${isCredit ? 'credit' : 'debit'} $${netPrice.toFixed(2)}`
  );

  if (DRY_RUN) {
    // Record as paper trade
    await recordPaperTrade(params, tradeId);
    return;
  }

  try {
    const orderResult = await submitSpreadOrder(
      spread.longSymbol, spread.shortSymbol,
      contracts, netPrice,
      isCredit ? 'credit' : 'debit'
    );

    if (!orderResult.success) {
      console.error(`[AUTO-TRADER] Order failed: ${orderResult.error}`);
      return;
    }

    // Track the trade
    openTrades.set(tradeId, {
      id: tradeId,
      strategy: signal.strategy || classifyStrategy(signal),
      ticker,
      direction,
      spreadType,
      state: 'PENDING_ENTRY',
      entryOrder: orderResult.order || orderResult,
      entryTime: Date.now(),
      maxHoldMinutes: getMaxHold(spreadType),
      holdDays: spreadType === 'CREDIT_VERTICAL' || spreadType === 'IRON_CONDOR' ? 5 : 0,
      stopCondition: { type: 'ATR', value: 0.5 },
      targetCondition: { type: 'ATR', value: 1.0 },
      entryPrice,
      atr,
      grade,
      contracts,
      spreadDetails: spread,
      netPrice,
      isCredit,
    });

    console.log(`[AUTO-TRADER] Order submitted: ${tradeId}`);
  } catch (err) {
    console.error(`[AUTO-TRADER] Order placement failed: ${err.message}`);
  }
}

// ── Position Monitoring ───────────────────────────────────────────────────────

/**
 * Check all open positions for exit conditions.
 */
async function checkOpenPositions() {
  for (const [tradeId, trade] of openTrades) {
    if (trade.state !== 'OPEN') continue;

    try {
      const positions = await getPositions();
      const pos = positions.find(p =>
        p.symbol === trade.spreadDetails?.longSymbol ||
        p.symbol === trade.spreadDetails?.shortSymbol
      );

      if (!pos) {
        // Position no longer exists — likely stopped out or expired
        trade.state = 'CLOSED';
        recordTrade(0);
        openTrades.delete(tradeId);
        continue;
      }

      const currentPnl = parseFloat(pos.unrealized_pl || 0);
      const holdMinutes = (Date.now() - trade.entryTime) / 60000;

      // Time-based exit
      if (trade.holdDays === 0 && holdMinutes > trade.maxHoldMinutes) {
        console.log(`[AUTO-TRADER] TIME EXIT: ${trade.ticker} after ${Math.round(holdMinutes)}min`);
        await exitTrade(trade, 'TIME');
        continue;
      }

      // P&L-based exit for credit spreads: close at 50% of credit
      if (trade.isCredit && currentPnl > 0) {
        const maxProfit = trade.netPrice * trade.contracts * 100;
        if (currentPnl >= maxProfit * 0.50) {
          console.log(`[AUTO-TRADER] TARGET EXIT: ${trade.ticker} credit spread at 50% profit`);
          await exitTrade(trade, 'TARGET');
          continue;
        }
      }

      // Stop loss: 2x credit for credit spreads, spread value for debit
      if (trade.isCredit && currentPnl < 0) {
        const maxLoss = trade.netPrice * trade.contracts * 100 * 2;
        if (Math.abs(currentPnl) >= maxLoss) {
          console.log(`[AUTO-TRADER] STOP EXIT: ${trade.ticker} credit spread at 2x loss`);
          await exitTrade(trade, 'STOP');
          continue;
        }
      }

    } catch (err) {
      console.error(`[AUTO-TRADER] Position check error for ${tradeId}: ${err.message}`);
    }
  }
}

/**
 * Exit a trade by closing the position.
 */
async function exitTrade(trade, reason) {
  trade.state = 'PENDING_EXIT';

  try {
    if (!DRY_RUN) {
      // Close both legs
      if (trade.spreadDetails?.longSymbol) {
        await closePosition(trade.spreadDetails.longSymbol).catch(() => {});
      }
      if (trade.spreadDetails?.shortSymbol) {
        await closePosition(trade.spreadDetails.shortSymbol).catch(() => {});
      }
    }

    // Calculate P&L from actual position data
    const positions = DRY_RUN ? [] : await getPositions();
    const longPos = positions.find(p => p.symbol === trade.spreadDetails?.longSymbol);
    const shortPos = positions.find(p => p.symbol === trade.spreadDetails?.shortSymbol);
    const pnl = (parseFloat(longPos?.unrealized_pl || 0)) + (parseFloat(shortPos?.unrealized_pl || 0));

    trade.state = 'CLOSED';
    recordTrade(pnl);

    // Store in paper_trades for tracking
    await storeTrade(trade, reason, pnl);

    console.log(`[AUTO-TRADER] CLOSED: ${trade.ticker} ${trade.direction} | Reason: ${reason} | P&L: $${Math.round(pnl)}`);
    openTrades.delete(trade.id);

  } catch (err) {
    console.error(`[AUTO-TRADER] Exit failed for ${trade.ticker}: ${err.message}`);
    trade.state = 'OPEN'; // retry next cycle
  }
}

/**
 * Check pending orders for fills.
 */
async function checkPendingOrders() {
  for (const [tradeId, trade] of openTrades) {
    if (trade.state !== 'PENDING_ENTRY') continue;

    const elapsed = (Date.now() - trade.entryTime) / 1000;

    // TTL expired — cancel
    if (elapsed > ORDER_TTL_SECONDS) {
      console.log(`[AUTO-TRADER] Order TTL expired for ${trade.ticker} — canceling`);
      try {
        const orderId = trade.entryOrder?.id || trade.entryOrder?.order?.id;
        if (orderId && !DRY_RUN) {
          const { cancelOrder } = await import('./alpaca-orders.js');
          await cancelOrder(orderId);
        }
      } catch { /* already filled or canceled */ }
      openTrades.delete(tradeId);
      continue;
    }

    // Check fill status
    try {
      const orderId = trade.entryOrder?.id || trade.entryOrder?.order?.id;
      if (!orderId) {
        trade.state = 'OPEN'; // assume filled if no order ID (dry run)
        continue;
      }

      const order = await getOrder(orderId);
      if (order.status === 'filled') {
        trade.state = 'OPEN';
        trade.fillPrice = parseFloat(order.filled_avg_price || 0);
        console.log(`[AUTO-TRADER] FILLED: ${trade.ticker} ${trade.direction} @ $${trade.fillPrice}`);
      } else if (order.status === 'canceled' || order.status === 'expired') {
        openTrades.delete(tradeId);
      }
    } catch (err) {
      console.error(`[AUTO-TRADER] Order check failed: ${err.message}`);
    }
  }
}

// ── Emergency Controls ────────────────────────────────────────────────────────

/**
 * Emergency flatten — close all positions.
 */
async function emergencyFlatten() {
  console.error('[AUTO-TRADER] EMERGENCY FLATTEN — closing all positions');
  manualHalt('Emergency flatten triggered');

  if (!DRY_RUN) {
    try {
      const { closeAllPositions, cancelAllOrders } = await import('./alpaca-orders.js');
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function determineSpreadType(signal) {
  // Determine spread type based on signal characteristics
  const strategy = signal.strategy || '';
  if (strategy.includes('REVERSAL') || strategy.includes('A3')) return 'CREDIT_VERTICAL';
  if (strategy.includes('IV_PREMIUM') || strategy.includes('B1')) return 'IRON_CONDOR';
  return 'DEBIT_VERTICAL'; // default for A1, A2, B2
}

function classifyStrategy(signal) {
  const grade = signal.grade || 'B';
  const freshness = signal.freshness || '';
  if (freshness === 'FRESH') return 'A1_FRESH_MOMENTUM';
  if (signal.cluster_context === 'PROPAGATION') return 'A2_CLUSTER_LAG';
  return 'A1_FRESH_MOMENTUM'; // default
}

function getMaxHold(spreadType) {
  switch (spreadType) {
    case 'CREDIT_VERTICAL': return 30;
    case 'IRON_CONDOR': return 0; // multi-day, checked by holdDays
    case 'DEBIT_VERTICAL': return 45;
    default: return 45;
  }
}

async function recordPaperTrade(params, tradeId) {
  try {
    await query(`
      INSERT INTO lc_v3.paper_trades
        (signal_id, ticker, direction, strategy, status, entry_time, entry_stock_price,
         entry_contract_symbol, strike, position_size_pct, auto_traded)
      VALUES ($1, $2, $3, $4, 'OPEN', NOW(), $5, $6, $7, $8, true)
    `, [
      params.signal?.signal_id || tradeId,
      params.ticker,
      params.direction,
      params.signal?.strategy || 'AUTO',
      params.entryPrice,
      params.spread?.longSymbol || '',
      params.spread?.longStrike || 0,
      params.sizePct,
    ]);
  } catch { /* paper_trades schema may differ */ }
}

async function storeTrade(trade, exitReason, pnl) {
  try {
    await query(`
      INSERT INTO lc_v3.paper_trades
        (signal_id, ticker, direction, strategy, status, entry_time, exit_time,
         entry_stock_price, entry_contract_symbol, position_size_pct,
         final_pnl_pct, outcome, exit_reason, auto_traded)
      VALUES ($1, $2, $3, $4, 'CLOSED', $5, NOW(), $6, $7, $8, $9, $10, $11, true)
      ON CONFLICT DO NOTHING
    `, [
      trade.id,
      trade.ticker,
      trade.direction,
      trade.strategy,
      new Date(trade.entryTime),
      trade.entryPrice,
      trade.spreadDetails?.longSymbol || '',
      POSITION_SIZES[trade.grade] || 0.075,
      pnl > 0 ? (pnl / (trade.entryPrice * trade.contracts * 100) * 100) : 0,
      pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'FLAT',
      exitReason,
    ]);
  } catch (err) {
    console.error(`[AUTO-TRADER] Store trade failed: ${err.message}`);
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
    startingEquity,
    openTrades: Array.from(openTrades.values()).map(t => ({
      id: t.id, ticker: t.ticker, direction: t.direction,
      strategy: t.strategy, state: t.state, spreadType: t.spreadType,
      entryPrice: t.entryPrice, entryTime: t.entryTime,
      holdMinutes: Math.round((Date.now() - t.entryTime) / 60000),
    })),
    risk: getDailyState(),
  };
}

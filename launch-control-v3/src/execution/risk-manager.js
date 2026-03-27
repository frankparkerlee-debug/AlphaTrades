/**
 * Risk Manager
 *
 * Portfolio-level risk controls for the auto-execution engine.
 * Enforces:
 *   - Max concurrent positions
 *   - Daily loss limit
 *   - Per-trade risk cap
 *   - Consecutive loss cooldown
 *   - Kill switch on catastrophic drawdown
 *   - Market hours enforcement
 */

// ── Configuration ─────────────────────────────────────────────────────────────

const MAX_CONCURRENT_POSITIONS = 5;
const MAX_DAILY_LOSS_PCT       = 0.08;   // -8% of account = halt all trading
const MAX_PER_TRADE_RISK_PCT   = 0.05;   // 5% of account max risk per trade
const MAX_DAILY_TRADES         = 20;      // max trades per day
const CONSECUTIVE_LOSS_COOLDOWN = 3;      // 3 consecutive losses → 5 min cooldown
const COOLDOWN_MINUTES         = 5;
const KILL_SWITCH_PCT          = -0.15;   // -15% = emergency flatten everything

// Market hours (ET): 9:30 - 16:00
const MARKET_OPEN_HOUR  = 9;
const MARKET_OPEN_MIN   = 30;
const MARKET_CLOSE_HOUR = 16;
const MARKET_CLOSE_MIN  = 0;

// ── State ─────────────────────────────────────────────────────────────────────

let dailyState = {
  date: null,
  trades: 0,
  pnl: 0,
  consecutiveLosses: 0,
  lastLossTime: 0,
  openPositions: 0,
  halted: false,
  haltReason: null,
};

/**
 * Reset daily state (call at market open).
 */
export function resetDaily() {
  const today = new Date().toISOString().split('T')[0];
  dailyState = {
    date: today,
    trades: 0,
    pnl: 0,
    consecutiveLosses: 0,
    lastLossTime: 0,
    openPositions: 0,
    halted: false,
    haltReason: null,
  };
  console.log(`[RISK] Daily state reset for ${today}`);
}

/**
 * Pre-trade risk check. Returns { allowed, reason }.
 */
export function checkPreTrade(accountBalance, tradeRiskDollars, openPositionCount) {
  const today = new Date().toISOString().split('T')[0];
  if (dailyState.date !== today) resetDaily();

  // Kill switch
  if (dailyState.halted) {
    return { allowed: false, reason: `HALTED: ${dailyState.haltReason}` };
  }

  // Market hours
  if (!isMarketHours()) {
    return { allowed: false, reason: 'Outside market hours' };
  }

  // Max concurrent positions
  if (openPositionCount >= MAX_CONCURRENT_POSITIONS) {
    return { allowed: false, reason: `Max ${MAX_CONCURRENT_POSITIONS} concurrent positions reached` };
  }

  // Max daily trades
  if (dailyState.trades >= MAX_DAILY_TRADES) {
    return { allowed: false, reason: `Max ${MAX_DAILY_TRADES} daily trades reached` };
  }

  // Daily loss limit
  if (dailyState.pnl <= -(accountBalance * MAX_DAILY_LOSS_PCT)) {
    dailyState.halted = true;
    dailyState.haltReason = `Daily loss limit hit: $${Math.round(dailyState.pnl)}`;
    return { allowed: false, reason: dailyState.haltReason };
  }

  // Per-trade risk cap
  if (tradeRiskDollars > accountBalance * MAX_PER_TRADE_RISK_PCT) {
    return { allowed: false, reason: `Trade risk $${Math.round(tradeRiskDollars)} > ${MAX_PER_TRADE_RISK_PCT * 100}% of account` };
  }

  // Consecutive loss cooldown
  if (dailyState.consecutiveLosses >= CONSECUTIVE_LOSS_COOLDOWN) {
    const cooldownEnd = dailyState.lastLossTime + (COOLDOWN_MINUTES * 60 * 1000);
    if (Date.now() < cooldownEnd) {
      const remaining = Math.ceil((cooldownEnd - Date.now()) / 60000);
      return { allowed: false, reason: `${CONSECUTIVE_LOSS_COOLDOWN} consecutive losses — cooling down (${remaining}min)` };
    }
    // Cooldown expired, reset
    dailyState.consecutiveLosses = 0;
  }

  return { allowed: true, reason: null };
}

/**
 * Record a completed trade (called after position closes).
 */
export function recordTrade(pnlDollars) {
  dailyState.trades++;
  dailyState.pnl += pnlDollars;

  if (pnlDollars < 0) {
    dailyState.consecutiveLosses++;
    dailyState.lastLossTime = Date.now();
  } else {
    dailyState.consecutiveLosses = 0;
  }

  console.log(`[RISK] Trade #${dailyState.trades}: $${Math.round(pnlDollars)} | Daily P&L: $${Math.round(dailyState.pnl)} | Streak: ${dailyState.consecutiveLosses} losses`);
}

/**
 * Check if kill switch should trigger.
 * Call this with current account equity.
 */
export function checkKillSwitch(currentEquity, startingEquity) {
  const drawdown = (currentEquity - startingEquity) / startingEquity;
  if (drawdown <= KILL_SWITCH_PCT) {
    dailyState.halted = true;
    dailyState.haltReason = `KILL SWITCH: ${(drawdown * 100).toFixed(1)}% drawdown`;
    return { trigger: true, reason: dailyState.haltReason };
  }
  return { trigger: false };
}

/**
 * Update open position count.
 */
export function updatePositionCount(count) {
  dailyState.openPositions = count;
}

/**
 * Check if within market hours (ET).
 */
export function isMarketHours() {
  const now = new Date();
  // Convert to ET (rough: UTC-5 in winter, UTC-4 in summer)
  const etOffset = isDST(now) ? -4 : -5;
  const etHour = (now.getUTCHours() + etOffset + 24) % 24;
  const etMin = now.getUTCMinutes();

  const afterOpen = etHour > MARKET_OPEN_HOUR || (etHour === MARKET_OPEN_HOUR && etMin >= MARKET_OPEN_MIN);
  const beforeClose = etHour < MARKET_CLOSE_HOUR || (etHour === MARKET_CLOSE_HOUR && etMin === 0);

  return afterOpen && beforeClose;
}

function isDST(date) {
  const jan = new Date(date.getFullYear(), 0, 1);
  const jul = new Date(date.getFullYear(), 6, 1);
  return date.getTimezoneOffset() < Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
}

/**
 * Get current daily state (for dashboard display).
 */
export function getDailyState() {
  return { ...dailyState };
}

/**
 * Manual halt (emergency stop from dashboard).
 */
export function manualHalt(reason = 'Manual halt from dashboard') {
  dailyState.halted = true;
  dailyState.haltReason = reason;
  console.log(`[RISK] MANUAL HALT: ${reason}`);
}

/**
 * Resume trading after manual halt.
 */
export function resume() {
  dailyState.halted = false;
  dailyState.haltReason = null;
  console.log('[RISK] Trading resumed');
}

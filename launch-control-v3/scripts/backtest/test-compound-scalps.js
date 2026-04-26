/**
 * Compound Scalp Backtest
 *
 * Tests the compounding layer: 4 directional patterns targeting 3-5% contract
 * moves, 3-5 trades/day on IWM 0DTE options.
 *
 * Exit model: +3% target / -3% stop / 5 bar max / 2 bar stall
 *
 * Usage: node scripts/backtest/test-compound-scalps.js [startDate] [endDate]
 */

import { query } from '../../src/data/db.js';
import { fetchAllDataFromDB } from './data-fetcher-db.js';
import { detectCompoundSignals } from '../../src/scalper/compound-detector.js';
import { emaSeries } from '../../src/indicators/technical.js';

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = process.argv.filter(a => a.startsWith('--'));
const endDate = args[1] || new Date().toISOString().split('T')[0];
const startDate = args[0] || (() => { const d = new Date(); d.setDate(d.getDate() - 45); return d.toISOString().split('T')[0]; })();

const TICKER = 'IWM';
const CONTRACTS_PER_TRADE = 1;
const MAX_SIGNALS_PER_DAY = flags.includes('--nocap') ? 999 : 7;
const COOLDOWN_BARS = 5;
const balFlag = flags.find(f => f.startsWith('--bal='));
const STARTING_BALANCE = balFlag ? parseInt(balFlag.split('=')[1]) : 7500;
let MIN_CONTRACT_PRICE = 0.75; // floor: don't trade cheap contracts with wild % swings
const PUT_MIN_CONTRACT_PRICE = 1.00; // PUTs need higher floor — cheap puts have noise-level stops
const PUT_ITM_RANGE = 3.0; // allow searching up to $3 ITM for puts (vs $1 ATM for calls)

// Exit model — symmetric now that PUTs use ITM contracts with similar pricing to CALLs
// ITM puts ($1.00+ entry) have higher delta, more stable % moves, tighter spreads
const EXIT = {
  callTargetPct: 5,    // +5% call target
  putTargetPct: 5,     // +5% put target (symmetric — ITM puts behave like calls)
  callStopPct: -3,     // -3% call stop
  putStopPct: -3,      // -3% put stop (symmetric — $1.00+ contracts can handle tight stops)
  maxBars: 5,          // 5 min max hold
  stallBars: 2,        // 2 bars against = exit
};

// Spread / slippage model — IWM 0DTE bid-ask cost per side
// Half-spread = what you lose on each side (entry: pay ask, exit: sell at bid)
const SPREAD = {
  tight: 0.02,     // liquid ATM strikes, fast fills
  typical: 0.03,   // realistic for ITM IWM 0DTE
  wide: 0.05,      // volatile periods, less liquid strikes
};

console.log('='.repeat(80));
console.log('  COMPOUND SCALP BACKTEST');
console.log('='.repeat(80));
console.log(`  Range: ${startDate} → ${endDate}`);
console.log(`  Ticker: ${TICKER}`);
console.log(`  Exit: CALL +${EXIT.callTargetPct}%/${EXIT.callStopPct}%  PUT +${EXIT.putTargetPct}%/${EXIT.putStopPct}%  ${EXIT.maxBars} bars / ${EXIT.stallBars}-bar stall`);
console.log(`  PUT selection: ITM preferred ($${PUT_MIN_CONTRACT_PRICE}+ floor, up to $${PUT_ITM_RANGE} ITM)`);
console.log(`  Max signals/day: ${MAX_SIGNALS_PER_DAY}`);
console.log(`  Account: $${STARTING_BALANCE}`);
console.log('='.repeat(80));

// ── Load Data ──────────────────────────────────────────────────────────────────

const allData = await fetchAllDataFromDB({ startDate, endDate }, [TICKER]);
const minuteBars = allData.minuteBars[TICKER] || {};
const etfMinuteBars = allData.etfMinuteBars;
const dailyBars = allData.dailyBars;
const tradingDays = allData.tradingDays;

console.log(`\n[DATA] ${tradingDays.length} trading days loaded`);

// Load real options bars
console.log('[DATA] Loading real options bars...');
const optRes = await query(`
  SELECT symbol, ticker, ts, expiry, strike, option_type,
         open, high, low, close, volume
  FROM lc_v3.options_bars_1m
  WHERE ticker = $1
    AND expiry >= $2 AND expiry <= $3
  ORDER BY ts
`, [TICKER, startDate, endDate]);

const optionsBars = {};
for (const row of optRes.rows) {
  const expiry = row.expiry.toISOString().split('T')[0];
  const optType = row.option_type;
  const strike = parseFloat(row.strike);
  const ts = new Date(row.ts);
  const minuteKey = ts.toISOString().slice(0, 16);
  if (!optionsBars[expiry]) optionsBars[expiry] = {};
  if (!optionsBars[expiry][optType]) optionsBars[expiry][optType] = {};
  if (!optionsBars[expiry][optType][strike]) optionsBars[expiry][optType][strike] = {};
  optionsBars[expiry][optType][strike][minuteKey] = {
    o: parseFloat(row.open), h: parseFloat(row.high),
    l: parseFloat(row.low), c: parseFloat(row.close),
    v: parseInt(row.volume || 0),
  };
}

const optDays = new Set(Object.keys(optionsBars));
console.log(`[DATA] ${optRes.rows.length} options bars loaded across ${optDays.size} days`);
console.log(`[DATA] Using REAL contract prices\n`);

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Detect break of structure. Three confluence factors:
 * 1. 3-bar pivot swing point violated (7-bar pattern: 3 left, center, 3 right)
 * 2. Volume confirms the break (current bar volume > 1.3x rolling avg)
 * 3. OR failure: price fell back below OR high (failed bullish breakout)
 *    or rallied back above OR low (failed bearish breakdown)
 *
 * Bearish BoS: broke swing low + volume + below OR high → uptrend structure broken
 * Bullish BoS: broke swing high + volume + above OR low → downtrend structure broken
 */
function detectStructureBreak(bars, ctx) {
  if (bars.length < 10) return { bullish: false, bearish: false };

  // 1. 3-bar pivot swing detection
  const pivotLB = 3;
  const swingHighs = [];
  const swingLows = [];

  for (let i = pivotLB; i < bars.length - pivotLB; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= pivotLB; j++) {
      if (bars[i].h <= bars[i - j].h || bars[i].h <= bars[i + j].h) isHigh = false;
      if (bars[i].l >= bars[i - j].l || bars[i].l >= bars[i + j].l) isLow = false;
    }
    if (isHigh) swingHighs.push(bars[i].h);
    if (isLow) swingLows.push(bars[i].l);
  }

  const curr = bars[bars.length - 1];

  // Swing point violated?
  const brokeSwingLow = swingLows.length > 0 && curr.c < swingLows[swingLows.length - 1];
  const brokeSwingHigh = swingHighs.length > 0 && curr.c > swingHighs[swingHighs.length - 1];

  // 2. Volume confirmation — current bar volume > 1.3x rolling average
  const vols = bars.map(b => b.v || 0);
  const avgVol = vols.slice(0, -1).reduce((s, v) => s + v, 0) / Math.max(1, vols.length - 1);
  const currVol = vols[vols.length - 1];
  const volConfirm = avgVol > 0 && currVol > avgVol * 1.3;

  // 3. OR failure — price reversed back through the opening range
  // Use 30-min OR (wider = more meaningful), fall back to 15-min
  const orHigh = ctx.or30High || ctx.or15High || ctx.orHigh;
  const orLow = ctx.or30Low || ctx.or15Low || ctx.orLow;

  // Bearish: price fell back below OR high = failed bullish breakout
  // (if price is above VWAP/open but below OR high, the breakout reversed)
  const orBearish = orHigh && curr.c < orHigh;
  // Bullish: price rallied back above OR low = failed bearish breakdown
  const orBullish = orLow && curr.c > orLow;

  const bearish = brokeSwingLow && volConfirm && orBearish;
  const bullish = brokeSwingHigh && volConfirm && orBullish;

  return { bullish, bearish };
}

function isEDT(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const mar1Day = new Date(y, 2, 1).getDay();
  const secondSunMar = mar1Day === 0 ? 8 : (14 - mar1Day + 1);
  const nov1Day = new Date(y, 10, 1).getDay();
  const firstSunNov = nov1Day === 0 ? 1 : (7 - nov1Day + 1);
  const mmdd = m * 100 + d;
  return mmdd >= (300 + secondSunMar) && mmdd < (1100 + firstSunNov);
}

function getRTHBounds(dateStr) {
  return isEDT(dateStr)
    ? { start: '13:30', end: '20:00' }
    : { start: '14:30', end: '21:00' };
}

function findRealContract(date, isCall, stockPrice, signalTime) {
  const optType = isCall ? 'C' : 'P';
  const dayContracts = optionsBars[date]?.[optType];
  if (!dayContracts) return null;

  const signalMinute = signalTime.slice(0, 16);
  const availableStrikes = Object.keys(dayContracts).map(Number).sort((a, b) => a - b);
  if (availableStrikes.length === 0) return null;

  // PUTs: search wider range to find ITM contracts ($1.00+)
  // ITM put = strike ABOVE stock price (higher delta, better pricing)
  // CALLs: stay ATM within $1
  const maxDist = isCall ? 1.0 : PUT_ITM_RANGE;
  const minPrice = isCall ? MIN_CONTRACT_PRICE : PUT_MIN_CONTRACT_PRICE;

  let candidates;
  if (isCall) {
    // CALLs: closest to ATM first (same as before)
    candidates = availableStrikes
      .map(s => ({ strike: s, dist: Math.abs(s - stockPrice) }))
      .filter(s => s.dist <= maxDist)
      .sort((a, b) => a.dist - b.dist);
  } else {
    // PUTs: prefer 1-2 strikes ITM (strike above stock price)
    // Sort by: ITM strikes first (closest ITM), then ATM, then OTM
    candidates = availableStrikes
      .map(s => ({ strike: s, dist: Math.abs(s - stockPrice), itm: s - stockPrice }))
      .filter(s => s.dist <= maxDist)
      .sort((a, b) => {
        // Prefer slightly ITM: target $1-2 above stock price
        const aScore = a.itm >= 0 && a.itm <= 2 ? 0 : a.itm > 2 ? 1 : 2;
        const bScore = b.itm >= 0 && b.itm <= 2 ? 0 : b.itm > 2 ? 1 : 2;
        if (aScore !== bScore) return aScore - bScore;
        // Within same bucket, sort by distance to stock price
        return a.dist - b.dist;
      });
  }

  for (const { strike } of candidates) {
    const contractBars = dayContracts[strike];
    if (!contractBars) continue;
    const barKeys = Object.keys(contractBars).sort();
    let entryIdx = -1;
    for (let i = barKeys.length - 1; i >= 0; i--) {
      if (barKeys[i] <= signalMinute) { entryIdx = i; break; }
    }
    if (entryIdx < 0) continue;
    const entryBar = contractBars[barKeys[entryIdx]];
    if (entryBar.c < minPrice) continue; // direction-specific min price

    const forwardKeys = barKeys.slice(entryIdx + 1);
    const forwardBars = forwardKeys.map(k => contractBars[k]);

    return { strike, entryBar, entryKey: barKeys[entryIdx], entryPrice: entryBar.c, forwardBars, forwardKeys };
  }
  return null;
}

function simulateTrade(signal, date) {
  const isCall = signal.direction === 'CALL';
  const contract = findRealContract(date, isCall, signal.entry, signal.timestamp_key);
  if (!contract) return null;

  const contractEntry = contract.entryPrice;
  const fwdBars = contract.forwardBars.slice(0, EXIT.maxBars);

  const result = {
    pattern: signal.pattern,
    ticker: TICKER,
    direction: signal.direction,
    confidence: signal.confidence,
    strike: contract.strike,
    contractEntry,
    stockEntry: signal.entry,
    holdBars: fwdBars.length,
    exitReason: 'TIME',
    pnlPct: 0,
    everInProfit: false,
    maxFavorable: 0,
    maxAdverse: 0,
    barByBarPnl: [],
    barDetails: [], // per-bar {h, l, c} as % from entry — for re-simulation
    lossCause: null,
  };

  if (fwdBars.length === 0) {
    result.exitReason = 'NO_DATA';
    return result;
  }

  let againstCount = 0;
  let prevClose = contractEntry;

  for (let i = 0; i < fwdBars.length; i++) {
    const bar = fwdBars[i];
    if (!bar) continue;

    const bestPct = ((bar.h - contractEntry) / contractEntry) * 100;
    const worstPct = ((bar.l - contractEntry) / contractEntry) * 100;
    const closePct = ((bar.c - contractEntry) / contractEntry) * 100;

    if (bestPct > result.maxFavorable) result.maxFavorable = +bestPct.toFixed(2);
    if (worstPct < result.maxAdverse) result.maxAdverse = +worstPct.toFixed(2);
    if (bestPct > 0) result.everInProfit = true;

    result.barByBarPnl.push(+closePct.toFixed(2));
    result.barDetails.push({ h: +bestPct.toFixed(2), l: +worstPct.toFixed(2), c: +closePct.toFixed(2) });

    // STOP — close-based: evaluate stop on bar CLOSE, not intra-bar LOW
    // 0DTE options have massive intra-bar wicks that trigger wick-stops
    // on noise. 33% of PUT stops were wick-kills (bar close was profitable).
    // Close-based is more realistic for manual scalping — you evaluate at bar close.
    const stopLevel = isCall ? EXIT.callStopPct : EXIT.putStopPct;
    if (closePct <= stopLevel) {
      result.pnlPct = stopLevel;
      result.exitReason = 'STOP';
      result.holdBars = i + 1;
      result.lossCause = result.everInProfit ? 'FAKEOUT' : 'WRONG_DIRECTION';
      break;
    }

    // TARGET — direction-aware (puts need wider target due to higher volatility)
    const targetLevel = isCall ? EXIT.callTargetPct : EXIT.putTargetPct;
    if (bestPct >= targetLevel) {
      result.pnlPct = targetLevel;
      result.exitReason = 'TARGET';
      result.holdBars = i + 1;
      break;
    }

    // STALL
    const barAgainst = bar.c < prevClose;
    againstCount = barAgainst ? againstCount + 1 : 0;
    if (againstCount >= EXIT.stallBars) {
      result.pnlPct = +closePct.toFixed(2);
      result.exitReason = 'STALL';
      result.holdBars = i + 1;
      if (result.pnlPct < 0) {
        result.lossCause = result.everInProfit ? 'STALLED_AFTER_MOVE' : 'NO_FOLLOW_THROUGH';
      }
      break;
    }

    prevClose = bar.c;
    result.pnlPct = +closePct.toFixed(2);
  }

  if (result.exitReason === 'TIME' && result.pnlPct < 0) {
    result.lossCause = result.everInProfit ? 'DECAYED_WITH_TIME' : 'NEVER_MOVED';
  }

  result.pnlDollars = +(contractEntry * (result.pnlPct / 100) * 100 * CONTRACTS_PER_TRADE).toFixed(2);

  // Track stop bar detail for diagnostic (which bar triggered stop, what was the close?)
  if (result.exitReason === 'STOP') {
    const stopBar = result.holdBars - 1; // 0-indexed
    const bar = fwdBars[stopBar];
    if (bar) {
      result.stopBarClose = +((bar.c - contractEntry) / contractEntry * 100).toFixed(2);
      result.stopBarLow = +((bar.l - contractEntry) / contractEntry * 100).toFixed(2);
      result.stopBarHigh = +((bar.h - contractEntry) / contractEntry * 100).toFixed(2);
      result.stoppedOnBar = stopBar + 1;
      // Would we have won if we used close-based stop?
      result.closeWouldHaveHeld = result.stopBarClose > (isCall ? EXIT.callStopPct : EXIT.putStopPct);
    }
  }

  return result;
}

// ── Process Days ───────────────────────────────────────────────────────────────

const allSignals = [];
let noContractCount = 0;
let trendFilterBlocked = 0;
let bosOverrideAllowed = 0;
let levelFilterBlocked = 0;
let circuitBreakerDays = 0;
const byPattern = {};

for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
  const date = tradingDays[dayIdx];
  if (dayIdx % 10 === 0) process.stdout.write(`  Processing day ${dayIdx + 1}/${tradingDays.length}...\r`);

  const { start, end } = getRTHBounds(date);
  const rthStart = `${date}T${start}`;
  const rthEnd = `${date}T${end}`;

  const dayKeys = Object.keys(minuteBars)
    .filter(k => k >= rthStart && k <= rthEnd)
    .sort();
  if (dayKeys.length < 20) continue;

  // Compute opening ranges: 5min (existing), 15min, 30min
  let orHigh = 0, orLow = Infinity;
  let or15High = 0, or15Low = Infinity;
  let or30High = 0, or30Low = Infinity;
  for (let i = 0; i < Math.min(30, dayKeys.length); i++) {
    const b = minuteBars[dayKeys[i]];
    if (i < 5) {
      if (b.h > orHigh) orHigh = b.h;
      if (b.l < orLow) orLow = b.l;
    }
    if (i < 15) {
      if (b.h > or15High) or15High = b.h;
      if (b.l < or15Low) or15Low = b.l;
    }
    if (b.h > or30High) or30High = b.h;
    if (b.l < or30Low) or30Low = b.l;
  }

  const prevDayBar = (() => {
    const tickerBars = dailyBars[TICKER];
    if (!tickerBars) return null;
    const dates = Object.keys(tickerBars).sort();
    const idx = dates.indexOf(date);
    return idx > 0 ? tickerBars[dates[idx - 1]] : null;
  })();

  let daySignals = 0;
  let lastSignalIdx = -COOLDOWN_BARS;
  let dayWins = 0, dayLosses = 0;
  let dayCircuitBroken = false;

  for (let i = 10; i < dayKeys.length; i++) {
    if (daySignals >= MAX_SIGNALS_PER_DAY) break;
    if (i - lastSignalIdx < COOLDOWN_BARS) continue;

    // Circuit breaker: 2 consecutive losses before a win → stop trading today
    if (dayCircuitBroken) break;

    const key = dayKeys[i];
    // Build rolling bars up to this point
    const startIdx = Math.max(0, i - 30);
    const bars = dayKeys.slice(startIdx, i + 1).map(k => ({ ...minuteBars[k], t: k }));
    if (bars.length < 10) continue;

    const curr = bars[bars.length - 1];

    // Compute session high/low
    let sessionHigh = 0, sessionLow = Infinity;
    for (let j = 0; j <= i; j++) {
      const b = minuteBars[dayKeys[j]];
      if (b.h > sessionHigh) sessionHigh = b.h;
      if (b.l < sessionLow) sessionLow = b.l;
    }

    // Compute VWAP
    let cumVol = 0, cumPV = 0;
    for (let j = 0; j <= i; j++) {
      const b = minuteBars[dayKeys[j]];
      const tp = (b.h + b.l + b.c) / 3;
      cumVol += (b.v || 0);
      cumPV += tp * (b.v || 0);
    }
    const vwap = cumVol > 0 ? cumPV / cumVol : curr.c;

    // EMA9 slope
    const closes = bars.map(b => b.c);
    const ema9Arr = emaSeries(closes, 9);
    let ema9Slope = 0;
    if (ema9Arr && ema9Arr.length >= 15) {
      const now = ema9Arr[ema9Arr.length - 1];
      const ago = ema9Arr[ema9Arr.length - 6];
      ema9Slope = (now && ago && ago > 0) ? (now - ago) / ago : 0;
    }

    const ctx = {
      vwap,
      orHigh: orHigh || null,
      orLow: orLow < Infinity ? orLow : null,
      or15High: or15High || null,
      or15Low: or15Low < Infinity ? or15Low : null,
      or30High: or30High || null,
      or30Low: or30Low < Infinity ? or30Low : null,
      sessionHigh,
      sessionLow,
      sessionOpen: minuteBars[dayKeys[0]]?.o,
      ema9Slope,
      barsFromOpen: i,
      prevDayHigh: prevDayBar?.h || null,
      prevDayLow: prevDayBar?.l || null,
    };

    const signals = detectCompoundSignals(TICKER, bars, ctx);

    // Session trend: trade with the intraday direction
    // Symmetric filter — same logic for both sides
    const sessionOpen = minuteBars[dayKeys[0]]?.o || curr.c;
    const aboveVwap = curr.c > vwap;
    const aboveOpen = curr.c > sessionOpen;

    // CALLs: need price above VWAP or above open
    const callOK = aboveVwap || aboveOpen;
    // PUTs: need price below VWAP or below open (symmetric)
    const putOK = !aboveVwap || !aboveOpen;

    // Break of structure override — disabled for now (v15 showed 21.7% WR on BoS trades)
    // const bosOverride = detectStructureBreak(bars, ctx);

    for (const sig of signals) {
      if (sig.confidence < 65) continue;
      if (daySignals >= MAX_SIGNALS_PER_DAY) break;

      // Directional filter — trade with the market
      if (sig.direction === 'CALL' && !callOK) { trendFilterBlocked++; continue; }
      if (sig.direction === 'PUT' && !putOK) { trendFilterBlocked++; continue; }

      // Attach time key for contract lookup
      sig.timestamp_key = key;

      const result = simulateTrade(sig, date);
      if (!result) { noContractCount++; continue; }

      result.date = date;
      result.time = key;
      result.bosOverride = sig.metadata?.bosOverride || false;

      // Stock-level directional analysis: did the stock move our way within 5 bars?
      const fwdStockBars = dayKeys.slice(i + 1, i + 6).map(k => minuteBars[k]).filter(Boolean);
      if (fwdStockBars.length > 0) {
        const stockEntry = curr.c;
        const isCall = sig.direction === 'CALL';
        let maxFavStock = 0, maxAdvStock = 0;
        // Track bar-by-bar stock movement
        const stockMoves = [];
        for (const fb of fwdStockBars) {
          const movePct = (fb.c - stockEntry) / stockEntry * 100;
          const favPct = isCall
            ? (fb.h - stockEntry) / stockEntry * 100
            : (stockEntry - fb.l) / stockEntry * 100;
          const advPct = isCall
            ? (stockEntry - fb.l) / stockEntry * 100
            : (fb.h - stockEntry) / stockEntry * 100;
          if (favPct > maxFavStock) maxFavStock = favPct;
          if (advPct > maxAdvStock) maxAdvStock = advPct;
          stockMoves.push(isCall ? movePct : -movePct);
        }
        result.stockDirectionCorrect = maxFavStock > 0.02; // moved at least 0.02% our way
        result.stockMoved005 = maxFavStock >= 0.05;
        result.stockMoved010 = maxFavStock >= 0.10;
        result.stockMoved015 = maxFavStock >= 0.15;
        result.stockMaxFav = maxFavStock;
        result.stockMaxAdv = maxAdvStock;
        result.stockMoves = stockMoves;
      }

      allSignals.push(result);

      if (!byPattern[result.pattern]) byPattern[result.pattern] = [];
      byPattern[result.pattern].push(result);

      daySignals++;
      lastSignalIdx = i;

      // Circuit breaker: track day wins/losses
      if (result.pnlPct > 0) { dayWins++; dayLosses = 0; }
      else if (result.pnlPct < 0) { dayLosses++; }
      if (dayLosses >= 2 && dayWins === 0) { dayCircuitBroken = true; circuitBreakerDays++; }

      break; // one signal per bar
    }
  }
}

console.log(`\n\n[SIGNALS] ${allSignals.length} total trades across ${tradingDays.length} days`);
console.log(`[RATE] ${(allSignals.length / tradingDays.length).toFixed(1)} trades/day`);
console.log(`[SKIPPED] ${noContractCount} signals had no matching options contract`);
console.log(`[FILTERED] ${trendFilterBlocked} signals blocked by session trend filter (don't trade against market)`);
console.log(`[BOS] ${bosOverrideAllowed} counter-trend signals allowed through via break of structure`);
console.log(`[CIRCUIT] ${circuitBreakerDays} days stopped early (2 losses before a win)`);
console.log(`[LEVELS] Level filter active in detector (no room to run → blocked)`);

if (allSignals.length === 0) {
  console.log('No signals. Exiting.');
  process.exit(0);
}

// ── Results ────────────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(80));
console.log('  PER-PATTERN BREAKDOWN');
console.log('='.repeat(80));

console.log(`\n  ${'Pattern'.padEnd(22)} ${'Trades'.padStart(7)} ${'WR'.padStart(7)} ${'Avg%'.padStart(8)} ${'PF'.padStart(7)} ${'StopRate'.padStart(9)}`);
console.log('  ' + '-'.repeat(60));

for (const [pattern, trades] of Object.entries(byPattern).sort((a, b) => b[1].length - a[1].length)) {
  const wins = trades.filter(t => t.pnlPct > 0).length;
  const losses = trades.filter(t => t.pnlPct < 0).length;
  const wr = wins / trades.length * 100;
  const avgPnl = trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length;
  const grossWins = trades.filter(t => t.pnlPct > 0).reduce((s, t) => s + t.pnlPct, 0);
  const grossLosses = Math.abs(trades.filter(t => t.pnlPct < 0).reduce((s, t) => s + t.pnlPct, 0));
  const pf = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 99 : 0;
  const stops = trades.filter(t => t.exitReason === 'STOP').length;
  const stopRate = (stops / trades.length * 100).toFixed(1);

  console.log(`  ${pattern.padEnd(22)} ${String(trades.length).padStart(7)} ${wr.toFixed(1).padStart(6)}% ${avgPnl.toFixed(2).padStart(7)}% ${pf.toFixed(2).padStart(7)} ${(stopRate + '%').padStart(9)}`);
}

// Overall stats
const allWins = allSignals.filter(t => t.pnlPct > 0);
const allLosses = allSignals.filter(t => t.pnlPct < 0);
const wr = allWins.length / allSignals.length * 100;
const avgPnl = allSignals.reduce((s, t) => s + t.pnlPct, 0) / allSignals.length;
const grossWin = allWins.reduce((s, t) => s + t.pnlPct, 0);
const grossLoss = Math.abs(allLosses.reduce((s, t) => s + t.pnlPct, 0));
const pf = grossLoss > 0 ? grossWin / grossLoss : 99;

console.log('  ' + '-'.repeat(60));
console.log(`  ${'TOTAL'.padEnd(22)} ${String(allSignals.length).padStart(7)} ${wr.toFixed(1).padStart(6)}% ${avgPnl.toFixed(2).padStart(7)}% ${pf.toFixed(2).padStart(7)}`);

// Exit reason breakdown
console.log('\n  EXIT REASONS:');
const exits = {};
for (const t of allSignals) {
  exits[t.exitReason] = (exits[t.exitReason] || 0) + 1;
}
for (const [reason, count] of Object.entries(exits).sort((a, b) => b[1] - a[1])) {
  const pct = (count / allSignals.length * 100).toFixed(1);
  console.log(`    ${reason.padEnd(12)} ${String(count).padStart(5)} (${pct}%)`);
}

// Direction breakdown
const calls = allSignals.filter(t => t.direction === 'CALL');
const puts = allSignals.filter(t => t.direction === 'PUT');
console.log(`\n  DIRECTION: CALL ${calls.length} (WR ${(calls.filter(t => t.pnlPct > 0).length / calls.length * 100).toFixed(1)}%)  |  PUT ${puts.length} (WR ${puts.length > 0 ? (puts.filter(t => t.pnlPct > 0).length / puts.length * 100).toFixed(1) : 'N/A'}%)`);

// PUT contract pricing diagnostic
if (puts.length > 0) {
  const putEntries = puts.map(t => t.contractEntry).sort((a, b) => a - b);
  const putStrikes = puts.map(t => t.strike);
  const putStockPrices = puts.map(t => t.stockEntry);
  const putITMAmts = puts.map(t => t.strike - t.stockEntry); // positive = ITM for puts
  const avgITM = putITMAmts.reduce((a, b) => a + b, 0) / putITMAmts.length;
  const avgPutEntry = putEntries.reduce((a, b) => a + b, 0) / putEntries.length;
  const callEntries = calls.map(t => t.contractEntry);
  const avgCallEntry = callEntries.length > 0 ? callEntries.reduce((a, b) => a + b, 0) / callEntries.length : 0;
  console.log(`\n  PUT CONTRACT SELECTION:`);
  console.log(`    Avg PUT entry: $${avgPutEntry.toFixed(2)} (was $0.60 with ATM)  |  Avg CALL entry: $${avgCallEntry.toFixed(2)}`);
  console.log(`    Avg PUT ITM amount: $${avgITM.toFixed(2)} (strike above stock)`);
  console.log(`    PUT entry range: $${putEntries[0].toFixed(2)} - $${putEntries[putEntries.length - 1].toFixed(2)}`);
  console.log(`    PUT R:R: risk ${Math.abs(EXIT.putStopPct)}% to make ${EXIT.putTargetPct}% = ${(EXIT.putTargetPct / Math.abs(EXIT.putStopPct)).toFixed(2)}:1`);
  console.log(`    CALL R:R: risk ${Math.abs(EXIT.callStopPct)}% to make ${EXIT.callTargetPct}% = ${(EXIT.callTargetPct / Math.abs(EXIT.callStopPct)).toFixed(2)}:1`);
}

// Per-pattern direction breakdown
console.log('\n  PER-PATTERN x DIRECTION:');
console.log(`  ${'Pattern'.padEnd(22)} ${'CALL Trades'.padStart(11)} ${'CALL WR'.padStart(8)} ${'CALL Avg'.padStart(9)}   ${'PUT Trades'.padStart(10)} ${'PUT WR'.padStart(7)} ${'PUT Avg'.padStart(8)}`);
console.log('  ' + '-'.repeat(78));
for (const [pattern, trades] of Object.entries(byPattern).sort((a, b) => b[1].length - a[1].length)) {
  const pc = trades.filter(t => t.direction === 'CALL');
  const pp = trades.filter(t => t.direction === 'PUT');
  const cWR = pc.length > 0 ? (pc.filter(t => t.pnlPct > 0).length / pc.length * 100).toFixed(1) : 'N/A';
  const pWR = pp.length > 0 ? (pp.filter(t => t.pnlPct > 0).length / pp.length * 100).toFixed(1) : 'N/A';
  const cAvg = pc.length > 0 ? (pc.reduce((s, t) => s + t.pnlPct, 0) / pc.length).toFixed(2) : 'N/A';
  const pAvg = pp.length > 0 ? (pp.reduce((s, t) => s + t.pnlPct, 0) / pp.length).toFixed(2) : 'N/A';
  console.log(`  ${pattern.padEnd(22)} ${String(pc.length).padStart(11)} ${(cWR + '%').padStart(8)} ${(cAvg + '%').padStart(9)}   ${String(pp.length).padStart(10)} ${(pWR + '%').padStart(7)} ${(pAvg + '%').padStart(8)}`);
}

// CALL-only simulation
console.log('\n  CALL-ONLY SIMULATION:');
{
  const callTrades = [...allSignals].filter(t => t.direction === 'CALL').sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  let bal = STARTING_BALANCE, pk = STARTING_BALANCE, mdd = 0;
  for (const trade of callTrades) {
    const riskAmt = bal * 0.10;
    const contracts = Math.max(1, Math.floor(riskAmt / (trade.contractEntry * 100)));
    const pnl = trade.contractEntry * (trade.pnlPct / 100) * 100 * contracts;
    bal += pnl;
    if (bal > pk) pk = bal;
    const dd = (pk - bal) / pk * 100;
    if (dd > mdd) mdd = dd;
  }
  const ret = (bal - STARTING_BALANCE) / STARTING_BALANCE * 100;
  console.log(`    ${callTrades.length} trades (${(callTrades.length / tradingDays.length).toFixed(1)}/day), Final: $${bal.toFixed(0)}, Return: ${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%, MaxDD: ${mdd.toFixed(1)}%`);
}

// BoS override trade performance
{
  const bosTrades = allSignals.filter(t => t.bosOverride);
  if (bosTrades.length > 0) {
    const wins = bosTrades.filter(t => t.pnlPct > 0).length;
    const avgPnl = bosTrades.reduce((s, t) => s + t.pnlPct, 0) / bosTrades.length;
    console.log(`\n  BREAK-OF-STRUCTURE OVERRIDE TRADES:`);
    console.log(`    ${bosTrades.length} trades, WR: ${(wins/bosTrades.length*100).toFixed(1)}%, Avg: ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(2)}%`);
    const bosCalls = bosTrades.filter(t => t.direction === 'CALL');
    const bosPuts = bosTrades.filter(t => t.direction === 'PUT');
    if (bosCalls.length) {
      const cw = bosCalls.filter(t => t.pnlPct > 0).length;
      console.log(`    CALL: ${bosCalls.length} trades, WR: ${(cw/bosCalls.length*100).toFixed(1)}%`);
    }
    if (bosPuts.length) {
      const pw = bosPuts.filter(t => t.pnlPct > 0).length;
      console.log(`    PUT: ${bosPuts.length} trades, WR: ${(pw/bosPuts.length*100).toFixed(1)}%`);
    }
  }
}

// Daily distribution
console.log('\n' + '='.repeat(80));
console.log('  DAILY SIGNAL DISTRIBUTION');
console.log('='.repeat(80));

const dailyCounts = {};
for (const t of allSignals) {
  dailyCounts[t.date] = (dailyCounts[t.date] || 0) + 1;
}
const countValues = Object.values(dailyCounts);
const daysWithSignals = countValues.length;
const daysWithout = tradingDays.length - daysWithSignals;
const avgPerDay = allSignals.length / tradingDays.length;

console.log(`  Days with signals: ${daysWithSignals}/${tradingDays.length} (${(daysWithSignals/tradingDays.length*100).toFixed(0)}%)`);
console.log(`  Days without: ${daysWithout}`);
console.log(`  Avg signals/day: ${avgPerDay.toFixed(1)}`);
console.log(`  Max in one day: ${Math.max(...countValues)}`);

const distBuckets = [0, 1, 2, 3, 4, 5, 6, 7];
console.log('\n  Signals/day distribution:');
for (const b of distBuckets) {
  const n = b === 0 ? daysWithout : countValues.filter(c => c === b).length;
  const bar = '#'.repeat(Math.round(n / tradingDays.length * 60));
  console.log(`    ${String(b).padStart(2)}: ${String(n).padStart(4)} days (${(n / tradingDays.length * 100).toFixed(0)}%) ${bar}`);
}
const over7 = countValues.filter(c => c > 7).length;
if (over7) console.log(`    >7: ${over7} days`);

// ── Compounding Simulation ─────────────────────────────────────────────────────

console.log('\n' + '='.repeat(80));
console.log('  COMPOUNDING SIMULATION');
console.log('='.repeat(80));

// Simple compounding: each trade uses 1 contract, profits reinvested
// Strategy I-like sizing: bet proportional to account balance
const sortedTrades = [...allSignals].sort((a, b) => (a.time || '').localeCompare(b.time || ''));

let balance = STARTING_BALANCE;
let peak = balance;
let maxDD = 0;
let maxDDPct = 0;
const monthlyEquity = {};
let consecutiveWins = 0, maxConsecWins = 0;
let consecutiveLosses = 0, maxConsecLosses = 0;

for (const trade of sortedTrades) {
  // Risk 10% of balance per trade (conservative compounding)
  const riskAmt = balance * 0.10;
  const contracts = Math.max(1, Math.floor(riskAmt / (trade.contractEntry * 100)));
  const pnl = trade.contractEntry * (trade.pnlPct / 100) * 100 * contracts;

  balance += pnl;
  if (balance > peak) peak = balance;
  const dd = peak - balance;
  if (dd > maxDD) { maxDD = dd; maxDDPct = dd / peak * 100; }

  // Monthly tracking
  const month = trade.date.slice(0, 7);
  if (!monthlyEquity[month]) monthlyEquity[month] = { start: balance - pnl, end: balance };
  monthlyEquity[month].end = balance;

  // Consecutive tracking
  if (trade.pnlPct > 0) {
    consecutiveWins++;
    consecutiveLosses = 0;
    if (consecutiveWins > maxConsecWins) maxConsecWins = consecutiveWins;
  } else if (trade.pnlPct < 0) {
    consecutiveLosses++;
    consecutiveWins = 0;
    if (consecutiveLosses > maxConsecLosses) maxConsecLosses = consecutiveLosses;
  }
}

const totalReturn = (balance - STARTING_BALANCE) / STARTING_BALANCE * 100;

console.log(`\n  Starting balance: $${STARTING_BALANCE}`);
console.log(`  Final balance:    $${balance.toFixed(0)}`);
console.log(`  Total return:     ${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(1)}%`);
console.log(`  Max drawdown:     $${maxDD.toFixed(0)} (${maxDDPct.toFixed(1)}%)`);
console.log(`  Max consec wins:  ${maxConsecWins}`);
console.log(`  Max consec losses: ${maxConsecLosses}`);

console.log('\n  MONTHLY EQUITY:');
for (const [month, eq] of Object.entries(monthlyEquity).sort()) {
  const change = eq.end - eq.start;
  const pct = (change / eq.start * 100).toFixed(1);
  const bar = change >= 0 ? '+'.repeat(Math.min(30, Math.round(parseFloat(pct)))) : '-'.repeat(Math.min(30, Math.round(Math.abs(parseFloat(pct)))));
  console.log(`    ${month}  $${eq.end.toFixed(0).padStart(8)}  ${change >= 0 ? '+' : ''}$${change.toFixed(0).padStart(6)} (${pct}%)  ${bar}`);
}

// ── Cash Account Model ───────────────────────────────────────────────────────

console.log('\n' + '='.repeat(80));
console.log('  CASH ACCOUNT MODEL — $7,500 start, money reused same day');
console.log('='.repeat(80));

// Model multiple position sizing strategies
const sizingModels = [
  { name: '5% per trade',  pct: 0.05 },
  { name: '10% per trade', pct: 0.10 },
  { name: '15% per trade', pct: 0.15 },
  { name: '20% per trade', pct: 0.20 },
];

for (const model of sizingModels) {
  let bal = STARTING_BALANCE, pk = bal, mdd = 0, mddPct = 0;
  const mEq = {};
  let prevMonth = null;

  for (const trade of sortedTrades) {
    const alloc = bal * model.pct;
    // How many contracts can we buy? (each contract = entry price * 100)
    const costPer = trade.contractEntry * 100;
    const contracts = Math.max(1, Math.floor(alloc / costPer));
    const totalCost = contracts * costPer;

    // P&L on this trade
    const pnl = trade.contractEntry * (trade.pnlPct / 100) * 100 * contracts;
    bal += pnl;
    if (bal > pk) pk = bal;
    const dd = pk - bal;
    if (dd > mdd) { mdd = dd; mddPct = dd / pk * 100; }

    const month = trade.date.slice(0, 7);
    if (!mEq[month]) mEq[month] = { start: bal - pnl, end: bal, trades: 0, wins: 0, pnl: 0 };
    mEq[month].end = bal;
    mEq[month].trades++;
    if (trade.pnlPct > 0) mEq[month].wins++;
    mEq[month].pnl += pnl;
  }

  const ret = (bal - STARTING_BALANCE) / STARTING_BALANCE * 100;
  console.log(`\n  ${model.name}: $${STARTING_BALANCE} → $${bal.toFixed(0)} (${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%)  MaxDD: ${mddPct.toFixed(1)}%`);
  console.log(`    Month      Balance     Change      %Chg   Trades  WR     Avg $/trade`);
  console.log(`    ` + '-'.repeat(70));
  for (const [month, eq] of Object.entries(mEq).sort()) {
    const change = eq.end - eq.start;
    const pctChg = (change / eq.start * 100).toFixed(1);
    const wr = eq.trades > 0 ? (eq.wins / eq.trades * 100).toFixed(0) : '0';
    const avgDollar = eq.trades > 0 ? (eq.pnl / eq.trades).toFixed(0) : '0';
    console.log(`    ${month}  $${eq.end.toFixed(0).padStart(8)}  ${change >= 0 ? '+' : ''}$${change.toFixed(0).padStart(7)}  ${pctChg.padStart(6)}%  ${String(eq.trades).padStart(5)}  ${wr.padStart(3)}%  $${avgDollar.padStart(5)}`);
  }
}

// ── MFE Analysis ───────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(80));
console.log('  MAX FAVORABLE EXCURSION (how far trades go before exit)');
console.log('='.repeat(80));

const mfeValues = allSignals.map(t => t.maxFavorable);
const mfeSorted = [...mfeValues].sort((a, b) => a - b);
const pctile = (arr, p) => arr[Math.floor(arr.length * p / 100)] || 0;

console.log(`\n  MFE percentiles (contract %):`);
console.log(`    P10: ${pctile(mfeSorted, 10).toFixed(1)}%  P25: ${pctile(mfeSorted, 25).toFixed(1)}%  P50: ${pctile(mfeSorted, 50).toFixed(1)}%  P75: ${pctile(mfeSorted, 75).toFixed(1)}%  P90: ${pctile(mfeSorted, 90).toFixed(1)}%`);

const callHit = calls.filter(t => t.maxFavorable >= EXIT.callTargetPct).length;
const putHit = puts.filter(t => t.maxFavorable >= EXIT.putTargetPct).length;
console.log(`  CALL hit ${EXIT.callTargetPct}%+: ${callHit}/${calls.length} (${(callHit/calls.length*100).toFixed(1)}%)`);
console.log(`  PUT hit ${EXIT.putTargetPct}%+: ${putHit}/${puts.length} (${(putHit/puts.length*100).toFixed(1)}%)`);

// MFE by direction
for (const dir of ['CALL', 'PUT']) {
  const dirTrades = allSignals.filter(t => t.direction === dir);
  if (dirTrades.length === 0) continue;
  const dirMFE = dirTrades.map(t => t.maxFavorable).sort((a, b) => a - b);
  const dirMAE = dirTrades.map(t => t.maxAdverse).sort((a, b) => a - b);
  const dirTarget = dir === 'CALL' ? EXIT.callTargetPct : EXIT.putTargetPct;
  const dirHit = dirTrades.filter(t => t.maxFavorable >= dirTarget).length;
  console.log(`\n  ${dir} MFE: P25=${pctile(dirMFE, 25).toFixed(1)}% P50=${pctile(dirMFE, 50).toFixed(1)}% P75=${pctile(dirMFE, 75).toFixed(1)}%  Hit ${dirTarget}%+: ${dirHit}/${dirTrades.length} (${(dirHit/dirTrades.length*100).toFixed(1)}%)`);
  console.log(`  ${dir} MAE: P25=${pctile(dirMAE, 25).toFixed(1)}% P50=${pctile(dirMAE, 50).toFixed(1)}% P75=${pctile(dirMAE, 75).toFixed(1)}%`);
  // Avg hold bars for wins vs losses
  const dirWins = dirTrades.filter(t => t.pnlPct > 0);
  const dirLosses = dirTrades.filter(t => t.pnlPct < 0);
  const avgWinBars = dirWins.length > 0 ? (dirWins.reduce((s,t) => s + t.holdBars, 0) / dirWins.length).toFixed(1) : 'N/A';
  const avgLossBars = dirLosses.length > 0 ? (dirLosses.reduce((s,t) => s + t.holdBars, 0) / dirLosses.length).toFixed(1) : 'N/A';
  console.log(`  ${dir} Avg hold: wins=${avgWinBars} bars, losses=${avgLossBars} bars`);
}

// Sample losing PUT trades — show contract behavior
console.log('\n  SAMPLE LOSING PUT TRADES (first 10):');
console.log(`  ${'Date'.padEnd(12)} ${'Time'.padEnd(18)} ${'Pattern'.padEnd(16)} ${'Stock'.padStart(7)} ${'Strike'.padStart(7)} ${'Entry$'.padStart(7)} ${'MFE%'.padStart(6)} ${'MAE%'.padStart(7)} ${'PnL%'.padStart(6)} ${'Exit'.padEnd(6)} ${'BarByBar'}`);
const losingPuts = allSignals.filter(t => t.direction === 'PUT' && t.pnlPct < 0).slice(0, 10);
for (const t of losingPuts) {
  console.log(`  ${t.date}  ${(t.time || '').slice(11, 16)}  ${t.pattern.padEnd(16)} $${t.stockEntry.toFixed(1)} $${t.strike.toFixed(0).padStart(5)} $${t.contractEntry.toFixed(2).padStart(6)} ${('+' + t.maxFavorable.toFixed(1) + '%').padStart(6)} ${(t.maxAdverse.toFixed(1) + '%').padStart(7)} ${(t.pnlPct.toFixed(1) + '%').padStart(6)} ${t.exitReason.padEnd(6)} [${t.barByBarPnl.map(p => (p >= 0 ? '+' : '') + p.toFixed(1)).join(', ')}]`);
}

// ── PUT Stop Mechanics Diagnostic ──────────────────────────────────────────────

console.log('\n' + '='.repeat(80));
console.log('  PUT STOP MECHANICS — Why are puts losing?');
console.log('='.repeat(80));

{
  const putStopped = allSignals.filter(t => t.direction === 'PUT' && t.exitReason === 'STOP');
  const callStopped = allSignals.filter(t => t.direction === 'CALL' && t.exitReason === 'STOP');

  console.log(`\n  Stopped trades: CALL ${callStopped.length}/${calls.length} (${(callStopped.length/calls.length*100).toFixed(0)}%)  |  PUT ${putStopped.length}/${puts.length} (${(putStopped.length/puts.length*100).toFixed(0)}%)`);

  // Which bar do they get stopped on?
  for (const [label, stopped] of [['CALL', callStopped], ['PUT', putStopped]]) {
    if (stopped.length === 0) continue;
    const byBar = {};
    for (const t of stopped) {
      const b = t.stoppedOnBar || '?';
      byBar[b] = (byBar[b] || 0) + 1;
    }
    const barStr = Object.entries(byBar).sort((a, b) => a[0] - b[0])
      .map(([bar, n]) => `bar${bar}: ${n} (${(n/stopped.length*100).toFixed(0)}%)`).join('  ');
    console.log(`\n  ${label} stopped on: ${barStr}`);
  }

  // Key diagnostic: of PUT stops, how many had the bar CLOSE above the stop level?
  // (i.e., the wick triggered the stop but the close was fine)
  const putWickKills = putStopped.filter(t => t.closeWouldHaveHeld);
  const callWickKills = callStopped.filter(t => t.closeWouldHaveHeld);

  console.log(`\n  WICK-KILLED (bar low hit stop, but bar CLOSE was above stop):`);
  console.log(`    CALL: ${callWickKills.length}/${callStopped.length} (${callStopped.length > 0 ? (callWickKills.length/callStopped.length*100).toFixed(1) : 0}%) were wick-killed`);
  console.log(`    PUT:  ${putWickKills.length}/${putStopped.length} (${putStopped.length > 0 ? (putWickKills.length/putStopped.length*100).toFixed(1) : 0}%) were wick-killed`);

  // Of those wick-killed puts, what was the eventual outcome?
  if (putWickKills.length > 0) {
    const avgClose = putWickKills.reduce((s, t) => s + t.stopBarClose, 0) / putWickKills.length;
    const avgMFE = putWickKills.reduce((s, t) => s + t.maxFavorable, 0) / putWickKills.length;
    const wouldWin = putWickKills.filter(t => t.maxFavorable >= EXIT.putTargetPct).length;
    console.log(`\n    Wick-killed PUT detail:`);
    console.log(`    Avg bar close when stopped: ${avgClose >= 0 ? '+' : ''}${avgClose.toFixed(1)}% (stop was at ${EXIT.putStopPct}%)`);
    console.log(`    Avg MFE of these trades: +${avgMFE.toFixed(1)}%`);
    console.log(`    Would have hit ${EXIT.putTargetPct}%+ target: ${wouldWin}/${putWickKills.length} (${(wouldWin/putWickKills.length*100).toFixed(1)}%)`);

    // Show first 10 examples
    console.log(`\n    Examples (wick killed the put, but close was fine):`);
    console.log(`    ${'Date'.padEnd(12)} ${'Bar#'.padStart(4)} ${'BarLow%'.padStart(8)} ${'BarClose%'.padStart(10)} ${'MFE%'.padStart(7)} ${'Entry$'.padStart(7)}`);
    for (const t of putWickKills.slice(0, 15)) {
      console.log(`    ${t.date}  ${String(t.stoppedOnBar).padStart(4)} ${(t.stopBarLow.toFixed(1) + '%').padStart(8)} ${((t.stopBarClose >= 0 ? '+' : '') + t.stopBarClose.toFixed(1) + '%').padStart(10)} ${('+' + t.maxFavorable.toFixed(1) + '%').padStart(7)} $${t.contractEntry.toFixed(2).padStart(6)}`);
    }
  }

  // Simulate: What if PUT stops used CLOSE instead of LOW?
  console.log(`\n  SIMULATION: Close-based stops vs Low-based (wick) stops:`);
  console.log(`  (Re-simulated using stored per-bar high/low/close data)\n`);

  // Proper re-simulation function using stored barDetails
  function resimTrade(trade, opts) {
    const isCall = trade.direction === 'CALL';
    const stopLevel = opts.cStop !== undefined ? (isCall ? opts.cStop : opts.pStop) : (isCall ? EXIT.callStopPct : EXIT.putStopPct);
    const targetLevel = opts.cTgt !== undefined ? (isCall ? opts.cTgt : opts.pTgt) : (isCall ? EXIT.callTargetPct : EXIT.putTargetPct);
    const useCloseStop = opts.closeStopFor === 'all' || (opts.closeStopFor === 'put' && !isCall);
    const maxBars = opts.maxBars || EXIT.maxBars;
    const graceBar = opts.graceBar || 0; // skip stop check on first N bars

    let pnl = 0;
    let againstCount = 0;
    const bars = trade.barDetails.slice(0, maxBars);

    for (let i = 0; i < bars.length; i++) {
      const { h, l, c } = bars[i];

      // STOP — wick or close based
      if (i >= graceBar) {
        const stopVal = useCloseStop ? c : l;
        if (stopVal <= stopLevel) {
          pnl = useCloseStop ? Math.max(c, stopLevel) : stopLevel;
          break;
        }
      }

      // TARGET — always wick-based (limit order fills on touch)
      if (h >= targetLevel) {
        pnl = targetLevel;
        break;
      }

      // STALL
      const prevC = i > 0 ? bars[i - 1].c : 0;
      againstCount = (c < prevC) ? againstCount + 1 : 0;
      if (againstCount >= EXIT.stallBars) {
        pnl = c;
        break;
      }

      pnl = c;
    }
    return pnl;
  }

  const stopTests = [
    { label: 'Close stop (current)',                opts: { closeStopFor: 'all' } },
    { label: 'Wick stop (old model)',               opts: { closeStopFor: 'none' } },
    { label: 'Close stop + P wider -5%/-5%',        opts: { closeStopFor: 'all', pStop: -5, cStop: -5 } },
    { label: 'Close stop + 7/3 targets',            opts: { closeStopFor: 'all', cTgt: 7, pTgt: 7 } },
    { label: 'Close stop + C7/3 P7/5',              opts: { closeStopFor: 'all', cTgt: 7, pTgt: 7, pStop: -5 } },
    { label: 'Close stop + 1-bar grace',            opts: { closeStopFor: 'all', graceBar: 1 } },
  ];

  console.log(`  ${'Mode'.padEnd(40)} ${'WR'.padStart(6)} ${'PF'.padStart(6)} ${'Return'.padStart(9)} ${'MaxDD'.padStart(7)}  ${'C-WR'.padStart(6)} ${'P-WR'.padStart(6)} ${'P-Avg'.padStart(7)}`);
  console.log('  ' + '-'.repeat(92));

  for (const { label, opts } of stopTests) {
    let bal = STARTING_BALANCE, pk = bal, mdd = 0;
    let wins = 0, total = 0, grossW = 0, grossL = 0;
    let putWins = 0, putTotal = 0, putSum = 0;
    let callWins = 0, callTotal = 0;

    for (const trade of sortedTrades) {
      if (!trade.barDetails || trade.barDetails.length === 0) continue;
      const pnl = resimTrade(trade, opts);
      const isCall = trade.direction === 'CALL';

      total++;
      if (!isCall) { putTotal++; if (pnl > 0) putWins++; putSum += pnl; }
      else { callTotal++; if (pnl > 0) callWins++; }
      if (pnl > 0) { wins++; grossW += pnl; }
      if (pnl < 0) { grossL += Math.abs(pnl); }

      const riskAmt = bal * 0.10;
      const contracts = Math.max(1, Math.floor(riskAmt / (trade.contractEntry * 100)));
      const dollarPnl = trade.contractEntry * (pnl / 100) * 100 * contracts;
      bal += dollarPnl;
      if (bal > pk) pk = bal;
      const dd = (pk - bal) / pk * 100;
      if (dd > mdd) mdd = dd;
    }

    const wr = (wins / total * 100).toFixed(1);
    const pf = grossL > 0 ? (grossW / grossL).toFixed(2) : '99';
    const ret = ((bal - STARTING_BALANCE) / STARTING_BALANCE * 100).toFixed(1);
    const cWr = callTotal > 0 ? (callWins / callTotal * 100).toFixed(1) : '0';
    const pWr = putTotal > 0 ? (putWins / putTotal * 100).toFixed(1) : '0';
    const pAvg = putTotal > 0 ? (putSum / putTotal).toFixed(2) : '0';
    console.log(`  ${label.padEnd(40)} ${wr.padStart(6)}% ${pf.padStart(6)} ${(ret + '%').padStart(9)} ${(mdd.toFixed(1) + '%').padStart(7)}  ${(cWr + '%').padStart(6)} ${(pWr + '%').padStart(6)} ${(pAvg + '%').padStart(7)}`);
  }
}

// ── SPREAD / SLIPPAGE IMPACT ─────────────────────────────────────────────────

console.log('\n' + '='.repeat(80));
console.log('  SPREAD / SLIPPAGE IMPACT — Does the edge survive execution costs?');
console.log('='.repeat(80));

// Show round-trip spread cost at different contract prices
console.log('\n  Round-trip spread cost as % of contract price:');
console.log('  ' + '-'.repeat(60));
console.log(`  ${'Contract'.padEnd(12)} ${'$0.02/side'.padStart(12)} ${'$0.03/side'.padStart(12)} ${'$0.05/side'.padStart(12)}`);
for (const price of [0.75, 1.00, 1.30, 1.50, 2.00]) {
  const costs = [0.02, 0.03, 0.05].map(hs => ((hs * 2) / price * 100).toFixed(1) + '%');
  console.log(`  $${price.toFixed(2).padEnd(11)} ${costs.map(c => c.padStart(12)).join('')}`);
}

// Actual spread cost for our trades
{
  const avgEntry = sortedTrades.reduce((s, t) => s + t.contractEntry, 0) / sortedTrades.length;
  const avgTypicalCost = sortedTrades.reduce((s, t) => s + (SPREAD.typical * 2) / t.contractEntry * 100, 0) / sortedTrades.length;
  console.log(`\n  Our trades -- avg entry: $${avgEntry.toFixed(2)}, avg round-trip cost at $0.03/side: ${avgTypicalCost.toFixed(1)}%`);
}

// Re-simulation: adjusts entry to ask price, exit to bid price, re-evaluates stops/targets
function resimWithSpread(trade, halfSpread) {
  if (halfSpread === 0) return { pnl: trade.pnlPct, exit: trade.exitReason };

  const origEntry = trade.contractEntry;
  const effEntry = origEntry + halfSpread;             // buy at ask
  const exitSlip = halfSpread / effEntry * 100;        // exit cost as % of effective entry
  const isCall = trade.direction === 'CALL';
  const stopLevel = isCall ? EXIT.callStopPct : EXIT.putStopPct;
  const targetLevel = isCall ? EXIT.callTargetPct : EXIT.putTargetPct;

  const bars = trade.barDetails;
  if (!bars || bars.length === 0) return { pnl: 0, exit: 'NO_DATA' };

  let againstCount = 0;
  let pnl = 0;
  let exit = 'TIME';

  for (let i = 0; i < Math.min(bars.length, EXIT.maxBars); i++) {
    // Convert bar prices from original entry basis to effective entry basis
    const barHigh  = origEntry * (1 + bars[i].h / 100);
    const barClose = origEntry * (1 + bars[i].c / 100);

    const hPct = (barHigh - effEntry)  / effEntry * 100;
    const cPct = (barClose - effEntry) / effEntry * 100;

    // STOP -- close-based (higher cost basis makes stops trigger sooner)
    // Stop-limit fills at stop level, then pay exit spread to sell at bid
    if (cPct <= stopLevel) {
      pnl = stopLevel - exitSlip;
      exit = 'STOP';
      break;
    }

    // TARGET -- high must reach target from higher cost basis (harder to reach)
    // Limit sell fills at target price -- no additional exit spread on limit fills
    if (hPct >= targetLevel) {
      pnl = targetLevel;
      exit = 'TARGET';
      break;
    }

    // STALL
    let prevCPct = 0;
    if (i > 0) {
      const prevP = origEntry * (1 + bars[i - 1].c / 100);
      prevCPct = (prevP - effEntry) / effEntry * 100;
    }
    againstCount = (cPct < prevCPct) ? againstCount + 1 : 0;
    if (againstCount >= EXIT.stallBars) {
      pnl = cPct - exitSlip;
      exit = 'STALL';
      break;
    }

    pnl = cPct - exitSlip;  // TIME exit: sell at bid
  }

  return { pnl: +pnl.toFixed(2), exit };
}

// Run all spread scenarios with full re-simulation
const spreadScenarios = [
  { name: 'No spread (current)',  hs: 0 },
  { name: 'Tight ($0.02/side)',   hs: SPREAD.tight },
  { name: 'Typical ($0.03/side)', hs: SPREAD.typical },
  { name: 'Wide ($0.05/side)',    hs: SPREAD.wide },
];

console.log('\n  Full re-simulation (entry at ask, exit at bid, stops/targets re-evaluated):');
console.log('  ' + '-'.repeat(92));
console.log(`  ${'Scenario'.padEnd(26)} ${'WR'.padStart(7)} ${'PF'.padStart(6)} ${'Avg%'.padStart(7)} ${'C-WR'.padStart(7)} ${'P-WR'.padStart(7)}  ${'Final'.padStart(10)} ${'Return'.padStart(10)} ${'MaxDD'.padStart(7)}`);
console.log('  ' + '-'.repeat(92));

for (const { name, hs } of spreadScenarios) {
  let bal = STARTING_BALANCE, pk = bal, mdd = 0;
  let wins = 0, total = 0, grossW = 0, grossL = 0, sumPnl = 0;
  let cWins = 0, cTotal = 0, pWins = 0, pTotal = 0;

  for (const trade of sortedTrades) {
    if (!trade.barDetails || trade.barDetails.length === 0) continue;
    const { pnl } = resimWithSpread(trade, hs);

    total++;
    sumPnl += pnl;
    if (trade.direction === 'CALL') { cTotal++; if (pnl > 0) cWins++; }
    else { pTotal++; if (pnl > 0) pWins++; }
    if (pnl > 0) { wins++; grossW += pnl; }
    if (pnl < 0) grossL += Math.abs(pnl);

    const riskAmt = bal * 0.10;
    const contracts = Math.max(1, Math.floor(riskAmt / (trade.contractEntry * 100)));
    const dollarPnl = trade.contractEntry * (pnl / 100) * 100 * contracts;
    bal += dollarPnl;
    if (bal > pk) pk = bal;
    const dd = (pk - bal) / pk * 100;
    if (dd > mdd) mdd = dd;
  }

  const wr = (wins / total * 100).toFixed(1);
  const pf = grossL > 0 ? (grossW / grossL).toFixed(2) : '99';
  const avg = (sumPnl / total).toFixed(2);
  const ret = ((bal - STARTING_BALANCE) / STARTING_BALANCE * 100).toFixed(1);
  const cWr = cTotal > 0 ? (cWins / cTotal * 100).toFixed(1) : '0';
  const pWr = pTotal > 0 ? (pWins / pTotal * 100).toFixed(1) : '0';

  console.log(`  ${name.padEnd(26)} ${(wr + '%').padStart(7)} ${pf.padStart(6)} ${(avg + '%').padStart(7)} ${(cWr + '%').padStart(7)} ${(pWr + '%').padStart(7)}  $${bal.toFixed(0).padStart(9)} ${((ret >= 0 ? '+' : '') + ret + '%').padStart(10)} ${(mdd.toFixed(1) + '%').padStart(7)}`);
}

// Exit reason shift -- does spread cause more stops to trigger?
console.log('\n  Exit reason shift (typical $0.03/side):');
{
  const noSpr = {}, withSpr = {};
  for (const trade of sortedTrades) {
    if (!trade.barDetails || trade.barDetails.length === 0) continue;
    noSpr[trade.exitReason] = (noSpr[trade.exitReason] || 0) + 1;
    const { exit } = resimWithSpread(trade, SPREAD.typical);
    withSpr[exit] = (withSpr[exit] || 0) + 1;
  }
  console.log(`  ${'Exit'.padEnd(10)} ${'No Spread'.padStart(12)} ${'With Spread'.padStart(14)} ${'Change'.padStart(10)}`);
  for (const reason of ['TARGET', 'STOP', 'STALL', 'TIME']) {
    const ns = noSpr[reason] || 0;
    const ws = withSpr[reason] || 0;
    const diff = ws - ns;
    console.log(`  ${reason.padEnd(10)} ${String(ns).padStart(12)} ${String(ws).padStart(14)} ${((diff >= 0 ? '+' : '') + diff).padStart(10)}`);
  }
}

// PF degradation curve and break-even spread
{
  console.log('\n  PF degradation by spread level:');
  console.log(`  ${'Spread/side'.padEnd(14)} ${'WR'.padStart(7)} ${'PF'.padStart(6)} ${'Targets'.padStart(9)} ${'Stops'.padStart(7)}`);
  console.log('  ' + '-'.repeat(50));
  let beSpread = 0;
  for (let testHS = 0.001; testHS <= 0.05; testHS += 0.001) {
    let gW = 0, gL = 0, wins = 0, total = 0, targets = 0, stops = 0;
    for (const trade of sortedTrades) {
      if (!trade.barDetails || trade.barDetails.length === 0) continue;
      const { pnl, exit } = resimWithSpread(trade, testHS);
      total++;
      if (pnl > 0) { gW += pnl; wins++; }
      if (pnl < 0) gL += Math.abs(pnl);
      if (exit === 'TARGET') targets++;
      if (exit === 'STOP') stops++;
    }
    const pf = gL > 0 ? gW / gL : 99;
    const wr = (wins / total * 100);
    if (pf >= 1.0) beSpread = testHS;
    // Print every $0.005 and at key thresholds
    if (testHS < 0.006 || Math.abs(testHS * 1000 % 5) < 1.5 || (beSpread === testHS)) {
      console.log(`  $${testHS.toFixed(3)}        ${(wr.toFixed(1) + '%').padStart(7)} ${pf.toFixed(2).padStart(6)} ${String(targets).padStart(9)} ${String(stops).padStart(7)}`);
    }
  }
  const avgEntry = sortedTrades.reduce((s, t) => s + t.contractEntry, 0) / sortedTrades.length;
  console.log(`\n  Break-even: PF hits 1.0 at ~$${beSpread.toFixed(3)}/side ($${(beSpread * 2).toFixed(3)} round-trip)`);
  console.log(`  = ${(beSpread * 2 / avgEntry * 100).toFixed(1)}% of avg contract ($${avgEntry.toFixed(2)})`);
  if (beSpread >= SPREAD.typical) {
    console.log(`  Typical IWM 0DTE spread ($0.03/side) is WITHIN the safety margin`);
  } else if (beSpread > 0) {
    console.log(`  Typical IWM 0DTE spread ($0.03/side) is BEYOND break-even -- edge does NOT survive`);
    console.log(`  The +${EXIT.callTargetPct}% target is too thin to absorb ${(SPREAD.typical / avgEntry * 100).toFixed(1)}% entry shift`);
  } else {
    console.log(`  Strategy loses edge at ANY spread level -- targets barely reached in frictionless model`);
  }
}

// Sizing comparison with typical spread
console.log('\n  Sizing models with typical spread ($0.03/side):');
console.log('  ' + '-'.repeat(65));
for (const pct of [0.05, 0.10, 0.15, 0.20]) {
  let bal = STARTING_BALANCE, pk = bal, mdd = 0;
  for (const trade of sortedTrades) {
    if (!trade.barDetails || trade.barDetails.length === 0) continue;
    const { pnl } = resimWithSpread(trade, SPREAD.typical);
    const riskAmt = bal * pct;
    const contracts = Math.max(1, Math.floor(riskAmt / (trade.contractEntry * 100)));
    const dollarPnl = trade.contractEntry * (pnl / 100) * 100 * contracts;
    bal += dollarPnl;
    if (bal > pk) pk = bal;
    const dd = (pk - bal) / pk * 100;
    if (dd > mdd) mdd = dd;
  }
  const ret = ((bal - STARTING_BALANCE) / STARTING_BALANCE * 100).toFixed(1);
  console.log(`  ${(pct * 100)}% per trade: $${STARTING_BALANCE} -> $${bal.toFixed(0)} (${ret >= 0 ? '+' : ''}${ret}%)  MaxDD: ${mdd.toFixed(1)}%`);
}

// ── EXIT OPTIMIZATION WITH SPREAD ────────────────────────────────────────────

console.log('\n' + '='.repeat(80));
console.log('  EXIT OPTIMIZATION — Best target/stop with $0.02/side spread');
console.log('='.repeat(80));

const OPT_HS = SPREAD.tight; // $0.02/side realistic for ITM/ATM IWM

// Parameterized resim: spread + custom target/stop/stall
function resimOpt(trade, hs, opts = {}) {
  const origEntry = trade.contractEntry;
  const effEntry = origEntry + hs;
  const exitSlip = hs > 0 ? hs / effEntry * 100 : 0;
  const isCall = trade.direction === 'CALL';

  const stp = opts.stop !== undefined ? opts.stop : (isCall ? EXIT.callStopPct : EXIT.putStopPct);
  const tgt = opts.target !== undefined ? opts.target : (isCall ? EXIT.callTargetPct : EXIT.putTargetPct);
  const mb = opts.maxBars || EXIT.maxBars;
  const sb = opts.stallBars !== undefined ? opts.stallBars : EXIT.stallBars;

  const bars = trade.barDetails;
  if (!bars || bars.length === 0) return { pnl: 0, exit: 'NO_DATA' };

  let againstCount = 0, pnl = 0, exit = 'TIME';

  for (let i = 0; i < Math.min(bars.length, mb); i++) {
    const bH = origEntry * (1 + bars[i].h / 100);
    const bC = origEntry * (1 + bars[i].c / 100);
    const hPct = (bH - effEntry) / effEntry * 100;
    const cPct = (bC - effEntry) / effEntry * 100;

    if (cPct <= stp) { pnl = stp - exitSlip; exit = 'STOP'; break; }
    if (hPct >= tgt) { pnl = tgt; exit = 'TARGET'; break; }

    if (sb > 0) {
      let prev = 0;
      if (i > 0) { const p = origEntry * (1 + bars[i-1].c / 100); prev = (p - effEntry) / effEntry * 100; }
      againstCount = (cPct < prev) ? againstCount + 1 : 0;
      if (againstCount >= sb) { pnl = cPct - exitSlip; exit = 'STALL'; break; }
    }
    pnl = cPct - exitSlip;
  }
  return { pnl: +pnl.toFixed(2), exit };
}

// Trailing stop resim
function resimTrail(trade, hs, opts = {}) {
  const origEntry = trade.contractEntry;
  const effEntry = origEntry + hs;
  const exitSlip = hs > 0 ? hs / effEntry * 100 : 0;
  const initStop = opts.initStop || -3;
  const beLevel = opts.beLevel || 3;
  const trailStart = opts.trailStart || 5;
  const trailKeep = opts.trailKeep || 0.5;
  const mb = opts.maxBars || 5;

  const bars = trade.barDetails;
  if (!bars || bars.length === 0) return { pnl: 0 };

  let peak = 0, stopLevel = initStop;

  for (let i = 0; i < Math.min(bars.length, mb); i++) {
    const bH = origEntry * (1 + bars[i].h / 100);
    const bC = origEntry * (1 + bars[i].c / 100);
    const hPct = (bH - effEntry) / effEntry * 100;
    const cPct = (bC - effEntry) / effEntry * 100;

    if (hPct > peak) peak = hPct;
    if (peak >= trailStart) stopLevel = Math.max(stopLevel, peak * trailKeep);
    else if (peak >= beLevel) stopLevel = Math.max(stopLevel, 0);

    if (cPct <= stopLevel) {
      return { pnl: +(stopLevel - exitSlip).toFixed(2) };
    }
  }
  const lastC = origEntry * (1 + bars[Math.min(bars.length - 1, mb - 1)].c / 100);
  return { pnl: +((lastC - effEntry) / effEntry * 100 - exitSlip).toFixed(2) };
}

// Helper: run a set of trades through resimOpt and return stats
function evalParams(trades, hs, opts) {
  let wins = 0, gW = 0, gL = 0, sum = 0;
  for (const t of trades) {
    const { pnl } = resimOpt(t, hs, opts);
    if (pnl > 0) { wins++; gW += pnl; }
    if (pnl < 0) gL += Math.abs(pnl);
    sum += pnl;
  }
  return { wins, total: trades.length, wr: wins / trades.length * 100, pf: gL > 0 ? gW / gL : 99, avg: sum / trades.length, gW, gL };
}

// Split by direction and filter for valid barDetails
const optCalls = sortedTrades.filter(t => t.direction === 'CALL' && t.barDetails?.length > 0);
const optPuts = sortedTrades.filter(t => t.direction === 'PUT' && t.barDetails?.length > 0);

// ── 1. Grid search per direction ────────────────────────────────────────────

const targets = [3, 4, 5, 6, 7, 8, 10];
const stops = [-2, -3, -4, -5, -7];

function gridSearch(trades, label) {
  const results = [];
  for (const tgt of targets) {
    for (const stp of stops) {
      for (const sb of [2, 3]) {
        const r = evalParams(trades, OPT_HS, { target: tgt, stop: stp, stallBars: sb });
        results.push({ tgt, stp, sb, ...r });
      }
    }
  }
  // Top 10 by avg PnL with PF >= 1.0
  const viable = results.filter(r => r.pf >= 1.0).sort((a, b) => b.avg - a.avg);
  console.log(`\n  ${label} (${trades.length} trades) -- Top 10 by avg PnL (PF >= 1.0):`);
  console.log(`  ${'Tgt'.padStart(5)} ${'Stp'.padStart(5)} ${'Stl'.padStart(4)} ${'WR'.padStart(7)} ${'PF'.padStart(6)} ${'Avg%'.padStart(8)} ${'R:R'.padStart(5)}`);
  console.log('  ' + '-'.repeat(45));
  for (const r of viable.slice(0, 10)) {
    console.log(`  ${('+' + r.tgt + '%').padStart(5)} ${(r.stp + '%').padStart(5)} ${String(r.sb).padStart(4)} ${(r.wr.toFixed(1) + '%').padStart(7)} ${r.pf.toFixed(2).padStart(6)} ${(r.avg.toFixed(2) + '%').padStart(8)} ${(r.tgt / Math.abs(r.stp)).toFixed(1).padStart(4)}:1`);
  }
  // Also: best with WR >= 55%
  const highWR = results.filter(r => r.wr >= 55 && r.pf >= 1.0).sort((a, b) => b.avg - a.avg);
  if (highWR.length > 0) {
    console.log(`\n  ${label} -- Best with WR >= 55%:`);
    console.log(`  ${'Tgt'.padStart(5)} ${'Stp'.padStart(5)} ${'Stl'.padStart(4)} ${'WR'.padStart(7)} ${'PF'.padStart(6)} ${'Avg%'.padStart(8)} ${'R:R'.padStart(5)}`);
    console.log('  ' + '-'.repeat(45));
    for (const r of highWR.slice(0, 5)) {
      console.log(`  ${('+' + r.tgt + '%').padStart(5)} ${(r.stp + '%').padStart(5)} ${String(r.sb).padStart(4)} ${(r.wr.toFixed(1) + '%').padStart(7)} ${r.pf.toFixed(2).padStart(6)} ${(r.avg.toFixed(2) + '%').padStart(8)} ${(r.tgt / Math.abs(r.stp)).toFixed(1).padStart(4)}:1`);
    }
  }
  return results;
}

const callGrid = gridSearch(optCalls, 'CALL');
const putGrid = gridSearch(optPuts, 'PUT');

// ── 2. Contract price floor with spread ─────────────────────────────────────

console.log('\n  CONTRACT PRICE FLOOR with $0.02/side spread:');
console.log(`  ${'Floor'.padEnd(10)} ${'Trades'.padStart(7)} ${'WR'.padStart(7)} ${'PF'.padStart(6)} ${'Avg%'.padStart(7)} ${'C-WR'.padStart(7)} ${'P-WR'.padStart(7)} ${'SpreadCost'.padStart(11)} ${'$7.5K->'.padStart(10)}`);
console.log('  ' + '-'.repeat(80));

for (const floor of [0.75, 1.00, 1.25, 1.50, 1.75]) {
  const filtered = sortedTrades.filter(t => t.contractEntry >= floor && t.barDetails?.length > 0);
  if (filtered.length < 50) continue;
  let bal = STARTING_BALANCE, pk = bal, mdd = 0;
  let wins = 0, gW = 0, gL = 0, sum = 0, cW = 0, cT = 0, pW = 0, pT = 0;
  const spreadCosts = [];
  for (const t of filtered) {
    const { pnl } = resimWithSpread(t, OPT_HS);
    spreadCosts.push((OPT_HS * 2) / t.contractEntry * 100);
    if (pnl > 0) { wins++; gW += pnl; } if (pnl < 0) gL += Math.abs(pnl); sum += pnl;
    if (t.direction === 'CALL') { cT++; if (pnl > 0) cW++; } else { pT++; if (pnl > 0) pW++; }
    const riskAmt = bal * 0.10;
    const contracts = Math.max(1, Math.floor(riskAmt / (t.contractEntry * 100)));
    bal += t.contractEntry * (pnl / 100) * 100 * contracts;
    if (bal > pk) pk = bal; const dd = (pk - bal) / pk * 100; if (dd > mdd) mdd = dd;
  }
  const total = filtered.length;
  const avgSpread = (spreadCosts.reduce((a,b) => a+b, 0) / total).toFixed(1);
  console.log(`  $${floor.toFixed(2).padEnd(8)} ${String(total).padStart(7)} ${((wins/total*100).toFixed(1) + '%').padStart(7)} ${(gL > 0 ? (gW/gL).toFixed(2) : '99').padStart(6)} ${((sum/total).toFixed(2) + '%').padStart(7)} ${((cT > 0 ? (cW/cT*100).toFixed(1) : '0') + '%').padStart(7)} ${((pT > 0 ? (pW/pT*100).toFixed(1) : '0') + '%').padStart(7)} ${(avgSpread + '%').padStart(11)} $${bal.toFixed(0).padStart(9)}`);
}

// ── 3. Asymmetric model: different params per direction ─────────────────────

console.log('\n  ASYMMETRIC EXIT MODELS with $0.02/side spread:');
console.log('  ' + '-'.repeat(92));
console.log(`  ${'Model'.padEnd(42)} ${'WR'.padStart(7)} ${'PF'.padStart(6)} ${'Avg%'.padStart(7)} ${'C-WR'.padStart(7)} ${'P-WR'.padStart(7)} ${'$7.5K->'.padStart(10)} ${'MaxDD'.padStart(7)}`);
console.log('  ' + '-'.repeat(92));

const asymModels = [
  { name: 'Current: C+5/-3 P+5/-3 stall=2',  call: { target: 5, stop: -3, stallBars: 2 }, put: { target: 5, stop: -3, stallBars: 2 } },
  { name: 'C+5/-3 P+5/-5 stall=2',            call: { target: 5, stop: -3, stallBars: 2 }, put: { target: 5, stop: -5, stallBars: 2 } },
  { name: 'C+5/-3 P+7/-5 stall=2',            call: { target: 5, stop: -3, stallBars: 2 }, put: { target: 7, stop: -5, stallBars: 2 } },
  { name: 'C+7/-3 P+7/-5 stall=2',            call: { target: 7, stop: -3, stallBars: 2 }, put: { target: 7, stop: -5, stallBars: 2 } },
  { name: 'C+6/-3 P+6/-5 stall=2',            call: { target: 6, stop: -3, stallBars: 2 }, put: { target: 6, stop: -5, stallBars: 2 } },
  { name: 'C+6/-3 P+7/-5 stall=3',            call: { target: 6, stop: -3, stallBars: 2 }, put: { target: 7, stop: -5, stallBars: 3 } },
  { name: 'C+7/-3 P+7/-5 stall=3',            call: { target: 7, stop: -3, stallBars: 3 }, put: { target: 7, stop: -5, stallBars: 3 } },
  { name: 'C+8/-4 P+8/-5 stall=3',            call: { target: 8, stop: -4, stallBars: 3 }, put: { target: 8, stop: -5, stallBars: 3 } },
  { name: 'C+5/-3 P+5/-5 stall=3',            call: { target: 5, stop: -3, stallBars: 3 }, put: { target: 5, stop: -5, stallBars: 3 } },
  { name: 'C+6/-4 P+6/-5 stall=2',            call: { target: 6, stop: -4, stallBars: 2 }, put: { target: 6, stop: -5, stallBars: 2 } },
  { name: 'C+5/-4 P+5/-5 stall=2',            call: { target: 5, stop: -4, stallBars: 2 }, put: { target: 5, stop: -5, stallBars: 2 } },
  { name: 'C+4/-3 P+4/-5 stall=2',            call: { target: 4, stop: -3, stallBars: 2 }, put: { target: 4, stop: -5, stallBars: 2 } },
  { name: 'C+4/-3 P+5/-5 stall=3',            call: { target: 4, stop: -3, stallBars: 2 }, put: { target: 5, stop: -5, stallBars: 3 } },
  { name: 'C+3/-3 P+3/-5 stall=2',            call: { target: 3, stop: -3, stallBars: 2 }, put: { target: 3, stop: -5, stallBars: 2 } },
];

for (const m of asymModels) {
  let bal = STARTING_BALANCE, pk = bal, mdd = 0;
  let wins = 0, gW = 0, gL = 0, sum = 0, cW = 0, cT = 0, pW = 0, pT = 0;
  for (const t of sortedTrades) {
    if (!t.barDetails?.length) continue;
    const isCall = t.direction === 'CALL';
    const opts = isCall ? m.call : m.put;
    const { pnl } = resimOpt(t, OPT_HS, opts);
    if (pnl > 0) { wins++; gW += pnl; } if (pnl < 0) gL += Math.abs(pnl); sum += pnl;
    if (isCall) { cT++; if (pnl > 0) cW++; } else { pT++; if (pnl > 0) pW++; }
    const riskAmt = bal * 0.10;
    const contracts = Math.max(1, Math.floor(riskAmt / (t.contractEntry * 100)));
    bal += t.contractEntry * (pnl / 100) * 100 * contracts;
    if (bal > pk) pk = bal; const dd = (pk - bal) / pk * 100; if (dd > mdd) mdd = dd;
  }
  const total = sortedTrades.filter(t => t.barDetails?.length).length;
  const wr = (wins / total * 100).toFixed(1);
  const pf = gL > 0 ? (gW / gL).toFixed(2) : '99';
  const avg = (sum / total).toFixed(2);
  const ret = ((bal - STARTING_BALANCE) / STARTING_BALANCE * 100).toFixed(1);
  console.log(`  ${m.name.padEnd(42)} ${(wr + '%').padStart(7)} ${pf.padStart(6)} ${(avg + '%').padStart(7)} ${((cT > 0 ? (cW/cT*100).toFixed(1) : '0') + '%').padStart(7)} ${((pT > 0 ? (pW/pT*100).toFixed(1) : '0') + '%').padStart(7)} $${bal.toFixed(0).padStart(9)} ${(mdd.toFixed(1) + '%').padStart(7)}`);
}

// ── 4. Trailing stop model ──────────────────────────────────────────────────

console.log('\n  TRAILING STOP MODELS with $0.02/side spread:');
console.log('  ' + '-'.repeat(92));
console.log(`  ${'Model'.padEnd(48)} ${'WR'.padStart(7)} ${'PF'.padStart(6)} ${'Avg%'.padStart(7)} ${'C-WR'.padStart(7)} ${'P-WR'.padStart(7)} ${'$7.5K->'.padStart(10)}`);
console.log('  ' + '-'.repeat(92));

const trailModels = [
  { name: 'Fixed +5/-3 (current, for reference)',       fn: t => resimOpt(t, OPT_HS, {}) },
  { name: 'Trail: -3 init, BE@+2, trail@+4 keep 50%',  fn: t => resimTrail(t, OPT_HS, { initStop: -3, beLevel: 2, trailStart: 4, trailKeep: 0.5 }) },
  { name: 'Trail: -3 init, BE@+3, trail@+5 keep 50%',  fn: t => resimTrail(t, OPT_HS, { initStop: -3, beLevel: 3, trailStart: 5, trailKeep: 0.5 }) },
  { name: 'Trail: -4 init, BE@+3, trail@+5 keep 50%',  fn: t => resimTrail(t, OPT_HS, { initStop: -4, beLevel: 3, trailStart: 5, trailKeep: 0.5 }) },
  { name: 'Trail: -5 init, BE@+3, trail@+5 keep 50%',  fn: t => resimTrail(t, OPT_HS, { initStop: -5, beLevel: 3, trailStart: 5, trailKeep: 0.5 }) },
  { name: 'Trail: -3 init, BE@+2, trail@+3 keep 60%',  fn: t => resimTrail(t, OPT_HS, { initStop: -3, beLevel: 2, trailStart: 3, trailKeep: 0.6 }) },
  { name: 'Trail: -5 init, BE@+3, trail@+5 keep 60%',  fn: t => resimTrail(t, OPT_HS, { initStop: -5, beLevel: 3, trailStart: 5, trailKeep: 0.6 }) },
  { name: 'Trail: -4 init, BE@+2, trail@+4 keep 60%',  fn: t => resimTrail(t, OPT_HS, { initStop: -4, beLevel: 2, trailStart: 4, trailKeep: 0.6 }) },
];

for (const m of trailModels) {
  let bal = STARTING_BALANCE, pk = bal, mdd = 0;
  let wins = 0, gW = 0, gL = 0, sum = 0, cW = 0, cT = 0, pW = 0, pT = 0;
  for (const t of sortedTrades) {
    if (!t.barDetails?.length) continue;
    const { pnl } = m.fn(t);
    if (pnl > 0) { wins++; gW += pnl; } if (pnl < 0) gL += Math.abs(pnl); sum += pnl;
    if (t.direction === 'CALL') { cT++; if (pnl > 0) cW++; } else { pT++; if (pnl > 0) pW++; }
    const riskAmt = bal * 0.10;
    const contracts = Math.max(1, Math.floor(riskAmt / (t.contractEntry * 100)));
    bal += t.contractEntry * (pnl / 100) * 100 * contracts;
    if (bal > pk) pk = bal; const dd = (pk - bal) / pk * 100; if (dd > mdd) mdd = dd;
  }
  const total = sortedTrades.filter(t => t.barDetails?.length).length;
  console.log(`  ${m.name.padEnd(48)} ${((wins/total*100).toFixed(1) + '%').padStart(7)} ${(gL > 0 ? (gW/gL).toFixed(2) : '99').padStart(6)} ${((sum/total).toFixed(2) + '%').padStart(7)} ${((cT > 0 ? (cW/cT*100).toFixed(1) : '0') + '%').padStart(7)} ${((pT > 0 ? (pW/pT*100).toFixed(1) : '0') + '%').padStart(7)} $${bal.toFixed(0).padStart(9)}`);
}

// ── 5. Confidence threshold ─────────────────────────────────────────────────

console.log('\n  CONFIDENCE THRESHOLD with $0.02/side spread:');
console.log(`  ${'MinConf'.padEnd(10)} ${'Trades'.padStart(7)} ${'WR'.padStart(7)} ${'PF'.padStart(6)} ${'Avg%'.padStart(7)} ${'C-WR'.padStart(7)} ${'P-WR'.padStart(7)} ${'$7.5K->'.padStart(10)}`);
console.log('  ' + '-'.repeat(66));

for (const minConf of [65, 70, 75, 80, 85, 90]) {
  const filtered = sortedTrades.filter(t => t.confidence >= minConf && t.barDetails?.length > 0);
  if (filtered.length < 20) continue;
  let bal = STARTING_BALANCE, pk = bal, mdd = 0;
  let wins = 0, gW = 0, gL = 0, sum = 0, cW = 0, cT = 0, pW = 0, pT = 0;
  for (const t of filtered) {
    const { pnl } = resimWithSpread(t, OPT_HS);
    if (pnl > 0) { wins++; gW += pnl; } if (pnl < 0) gL += Math.abs(pnl); sum += pnl;
    if (t.direction === 'CALL') { cT++; if (pnl > 0) cW++; } else { pT++; if (pnl > 0) pW++; }
    const riskAmt = bal * 0.10;
    const contracts = Math.max(1, Math.floor(riskAmt / (t.contractEntry * 100)));
    bal += t.contractEntry * (pnl / 100) * 100 * contracts;
    if (bal > pk) pk = bal; const dd = (pk - bal) / pk * 100; if (dd > mdd) mdd = dd;
  }
  const total = filtered.length;
  console.log(`  ${('>=' + minConf).padEnd(10)} ${String(total).padStart(7)} ${((wins/total*100).toFixed(1) + '%').padStart(7)} ${(gL > 0 ? (gW/gL).toFixed(2) : '99').padStart(6)} ${((sum/total).toFixed(2) + '%').padStart(7)} ${((cT > 0 ? (cW/cT*100).toFixed(1) : '0') + '%').padStart(7)} ${((pT > 0 ? (pW/pT*100).toFixed(1) : '0') + '%').padStart(7)} $${bal.toFixed(0).padStart(9)}`);
}

// ── 6. Best combined: floor + asymmetric + confidence ───────────────────────

console.log('\n  COMBINED OPTIMIZATIONS with $0.02/side spread:');
console.log('  ' + '-'.repeat(92));
console.log(`  ${'Model'.padEnd(52)} ${'WR'.padStart(7)} ${'PF'.padStart(6)} ${'Avg%'.padStart(7)} ${'C-WR'.padStart(7)} ${'P-WR'.padStart(7)} ${'$7.5K->'.padStart(10)}`);
console.log('  ' + '-'.repeat(92));

const combos = [
  { name: 'Baseline: current params, all trades',           floor: 0.75, minConf: 65, call: { target: 5, stop: -3, stallBars: 2 }, put: { target: 5, stop: -3, stallBars: 2 } },
  { name: 'Floor $1.25 only',                               floor: 1.25, minConf: 65, call: { target: 5, stop: -3, stallBars: 2 }, put: { target: 5, stop: -3, stallBars: 2 } },
  { name: 'Floor $1.25 + P wider stop (-5%)',               floor: 1.25, minConf: 65, call: { target: 5, stop: -3, stallBars: 2 }, put: { target: 5, stop: -5, stallBars: 2 } },
  { name: 'Floor $1.25 + C+6/-3 P+6/-5',                   floor: 1.25, minConf: 65, call: { target: 6, stop: -3, stallBars: 2 }, put: { target: 6, stop: -5, stallBars: 2 } },
  { name: 'Floor $1.25 + C+7/-3 P+7/-5 stall=3',           floor: 1.25, minConf: 65, call: { target: 7, stop: -3, stallBars: 3 }, put: { target: 7, stop: -5, stallBars: 3 } },
  { name: 'Floor $1.25 + conf>=75 + C+5/-3 P+5/-5',        floor: 1.25, minConf: 75, call: { target: 5, stop: -3, stallBars: 2 }, put: { target: 5, stop: -5, stallBars: 2 } },
  { name: 'Floor $1.25 + conf>=75 + C+6/-3 P+7/-5',        floor: 1.25, minConf: 75, call: { target: 6, stop: -3, stallBars: 2 }, put: { target: 7, stop: -5, stallBars: 2 } },
  { name: 'Floor $1.50 + C+5/-3 P+5/-5',                   floor: 1.50, minConf: 65, call: { target: 5, stop: -3, stallBars: 2 }, put: { target: 5, stop: -5, stallBars: 2 } },
  { name: 'Floor $1.50 + C+6/-3 P+6/-5 stall=3',           floor: 1.50, minConf: 65, call: { target: 6, stop: -3, stallBars: 3 }, put: { target: 6, stop: -5, stallBars: 3 } },
  { name: 'Floor $1.50 + C+7/-3 P+7/-5 stall=3',           floor: 1.50, minConf: 65, call: { target: 7, stop: -3, stallBars: 3 }, put: { target: 7, stop: -5, stallBars: 3 } },
];

for (const m of combos) {
  const filtered = sortedTrades.filter(t => t.contractEntry >= m.floor && t.confidence >= m.minConf && t.barDetails?.length > 0);
  if (filtered.length < 20) continue;
  let bal = STARTING_BALANCE, pk = bal, mdd = 0;
  let wins = 0, gW = 0, gL = 0, sum = 0, cW = 0, cT = 0, pW = 0, pT = 0;
  for (const t of filtered) {
    const isCall = t.direction === 'CALL';
    const opts = isCall ? m.call : m.put;
    const { pnl } = resimOpt(t, OPT_HS, opts);
    if (pnl > 0) { wins++; gW += pnl; } if (pnl < 0) gL += Math.abs(pnl); sum += pnl;
    if (isCall) { cT++; if (pnl > 0) cW++; } else { pT++; if (pnl > 0) pW++; }
    const riskAmt = bal * 0.10;
    const contracts = Math.max(1, Math.floor(riskAmt / (t.contractEntry * 100)));
    bal += t.contractEntry * (pnl / 100) * 100 * contracts;
    if (bal > pk) pk = bal; const dd = (pk - bal) / pk * 100; if (dd > mdd) mdd = dd;
  }
  const total = filtered.length;
  console.log(`  ${m.name.padEnd(52)} ${((wins/total*100).toFixed(1) + '%').padStart(7)} ${(gL > 0 ? (gW/gL).toFixed(2) : '99').padStart(6)} ${((sum/total).toFixed(2) + '%').padStart(7)} ${((cT > 0 ? (cW/cT*100).toFixed(1) : '0') + '%').padStart(7)} ${((pT > 0 ? (pW/pT*100).toFixed(1) : '0') + '%').padStart(7)} $${bal.toFixed(0).padStart(9)}`);
}

// ── TRAILING STOP — FULL ANALYSIS ────────────────────────────────────────────

console.log('\n' + '='.repeat(80));
console.log('  TRAILING STOP MODEL — COMPREHENSIVE ANALYSIS');
console.log('  Trail: -3% init, BE@+2%, trail@+3% keep 60%  |  Spread: $0.02/side');
console.log('  Starting balance: $' + STARTING_BALANCE);
console.log('='.repeat(80));

{
  // Run all trades through trailing model with spread
  const trailTrades = [];
  let bal = STARTING_BALANCE, pk = bal, maxDD = 0, maxDDPct = 0;
  let consW = 0, maxConsW = 0, consL = 0, maxConsL = 0;
  const monthlyEq = {};
  const weeklyPnl = {};
  const dailyPnl = {};

  for (const trade of sortedTrades) {
    if (!trade.barDetails?.length) continue;
    const pnl = resimTrail(trade, OPT_HS, { initStop: -3, beLevel: 2, trailStart: 3, trailKeep: 0.6 }).pnl;

    // Sizing
    const riskAmt = bal * 0.10;
    const contracts = Math.max(1, Math.floor(riskAmt / (trade.contractEntry * 100)));
    const dollarPnl = trade.contractEntry * (pnl / 100) * 100 * contracts;

    trailTrades.push({ ...trade, trailPnl: pnl, dollarPnl, contracts, balBefore: bal });
    bal += dollarPnl;
    if (bal > pk) pk = bal;
    const dd = pk - bal; const ddPct = dd / pk * 100;
    if (ddPct > maxDDPct) { maxDD = dd; maxDDPct = ddPct; }

    // Consecutive tracking
    if (pnl > 0) { consW++; consL = 0; if (consW > maxConsW) maxConsW = consW; }
    else if (pnl < 0) { consL++; consW = 0; if (consL > maxConsL) maxConsL = consL; }

    // Monthly equity
    const month = trade.date.slice(0, 7);
    if (!monthlyEq[month]) monthlyEq[month] = { start: bal - dollarPnl, end: bal, trades: 0, wins: 0, pnl: 0 };
    monthlyEq[month].end = bal; monthlyEq[month].trades++; monthlyEq[month].pnl += dollarPnl;
    if (pnl > 0) monthlyEq[month].wins++;

    // Weekly PnL
    const d = new Date(trade.date);
    const weekStart = new Date(d); weekStart.setDate(d.getDate() - d.getDay() + 1);
    const weekKey = weekStart.toISOString().split('T')[0];
    if (!weeklyPnl[weekKey]) weeklyPnl[weekKey] = { pnl: 0, trades: 0 };
    weeklyPnl[weekKey].pnl += dollarPnl; weeklyPnl[weekKey].trades++;

    // Daily PnL
    if (!dailyPnl[trade.date]) dailyPnl[trade.date] = { pnl: 0, trades: 0, wins: 0 };
    dailyPnl[trade.date].pnl += dollarPnl; dailyPnl[trade.date].trades++;
    if (pnl > 0) dailyPnl[trade.date].wins++;
  }

  const total = trailTrades.length;
  const wins = trailTrades.filter(t => t.trailPnl > 0).length;
  const losses = trailTrades.filter(t => t.trailPnl < 0).length;
  const calls = trailTrades.filter(t => t.direction === 'CALL');
  const puts = trailTrades.filter(t => t.direction === 'PUT');
  const cWins = calls.filter(t => t.trailPnl > 0).length;
  const pWins = puts.filter(t => t.trailPnl > 0).length;
  const grossW = trailTrades.filter(t => t.trailPnl > 0).reduce((s, t) => s + t.trailPnl, 0);
  const grossL = Math.abs(trailTrades.filter(t => t.trailPnl < 0).reduce((s, t) => s + t.trailPnl, 0));
  const avgWin = wins > 0 ? grossW / wins : 0;
  const avgLoss = losses > 0 ? grossL / losses : 0;
  const totalReturn = (bal - STARTING_BALANCE) / STARTING_BALANCE * 100;

  console.log(`\n  HEADLINE:`);
  console.log(`  $${STARTING_BALANCE.toLocaleString()} --> $${bal.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}  (${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(1)}%)`);
  console.log(`  ${total} trades over ${tradingDays.length} days (${(total / tradingDays.length).toFixed(1)}/day)`);

  console.log(`\n  CORE STATS:`);
  console.log(`  Win Rate:       ${(wins / total * 100).toFixed(1)}% (${wins}W / ${losses}L)`);
  console.log(`  Profit Factor:  ${(grossW / grossL).toFixed(2)}`);
  console.log(`  Avg Win:        +${avgWin.toFixed(2)}%    Avg Loss: ${(-avgLoss).toFixed(2)}%`);
  console.log(`  R:R (avg):      ${(avgWin / avgLoss).toFixed(2)}:1`);
  console.log(`  Max Drawdown:   $${maxDD.toFixed(0)} (${maxDDPct.toFixed(1)}%)`);
  console.log(`  Max Consec Win: ${maxConsW}    Max Consec Loss: ${maxConsL}`);

  console.log(`\n  BY DIRECTION:`);
  console.log(`  CALL: ${calls.length} trades, ${(cWins / calls.length * 100).toFixed(1)}% WR`);
  const cGW = calls.filter(t => t.trailPnl > 0).reduce((s, t) => s + t.trailPnl, 0);
  const cGL = Math.abs(calls.filter(t => t.trailPnl < 0).reduce((s, t) => s + t.trailPnl, 0));
  console.log(`         PF: ${cGL > 0 ? (cGW / cGL).toFixed(2) : '99'}  Avg: ${(calls.reduce((s, t) => s + t.trailPnl, 0) / calls.length).toFixed(2)}%`);
  console.log(`  PUT:  ${puts.length} trades, ${(pWins / puts.length * 100).toFixed(1)}% WR`);
  const pGW = puts.filter(t => t.trailPnl > 0).reduce((s, t) => s + t.trailPnl, 0);
  const pGL = Math.abs(puts.filter(t => t.trailPnl < 0).reduce((s, t) => s + t.trailPnl, 0));
  console.log(`         PF: ${pGL > 0 ? (pGW / pGL).toFixed(2) : '99'}  Avg: ${(puts.reduce((s, t) => s + t.trailPnl, 0) / puts.length).toFixed(2)}%`);

  // By pattern
  console.log(`\n  BY PATTERN:`);
  console.log(`  ${'Pattern'.padEnd(22)} ${'Trades'.padStart(7)} ${'WR'.padStart(7)} ${'Avg%'.padStart(7)} ${'PF'.padStart(6)}`);
  console.log('  ' + '-'.repeat(52));
  const byPat = {};
  for (const t of trailTrades) {
    if (!byPat[t.pattern]) byPat[t.pattern] = [];
    byPat[t.pattern].push(t);
  }
  for (const [pat, trades] of Object.entries(byPat).sort((a, b) => b[1].length - a[1].length)) {
    const w = trades.filter(t => t.trailPnl > 0).length;
    const gw = trades.filter(t => t.trailPnl > 0).reduce((s, t) => s + t.trailPnl, 0);
    const gl = Math.abs(trades.filter(t => t.trailPnl < 0).reduce((s, t) => s + t.trailPnl, 0));
    const avg = trades.reduce((s, t) => s + t.trailPnl, 0) / trades.length;
    console.log(`  ${pat.padEnd(22)} ${String(trades.length).padStart(7)} ${((w / trades.length * 100).toFixed(1) + '%').padStart(7)} ${(avg.toFixed(2) + '%').padStart(7)} ${(gl > 0 ? (gw / gl).toFixed(2) : '99').padStart(6)}`);
  }

  // Sizing models
  console.log(`\n  POSITION SIZING ($${STARTING_BALANCE} start):`);
  console.log('  ' + '-'.repeat(65));
  for (const pct of [0.05, 0.10, 0.15, 0.20]) {
    let b = STARTING_BALANCE, p = b, md = 0;
    for (const t of trailTrades) {
      const alloc = b * pct;
      const c = Math.max(1, Math.floor(alloc / (t.contractEntry * 100)));
      b += t.contractEntry * (t.trailPnl / 100) * 100 * c;
      if (b > p) p = b; const d = (p - b) / p * 100; if (d > md) md = d;
    }
    const r = (b - STARTING_BALANCE) / STARTING_BALANCE * 100;
    console.log(`  ${(pct * 100)}% per trade: $${STARTING_BALANCE} --> $${b.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} (${r >= 0 ? '+' : ''}${r.toFixed(1)}%)  MaxDD: ${md.toFixed(1)}%`);
  }

  // Monthly equity
  console.log(`\n  MONTHLY EQUITY (10% sizing):`);
  console.log(`  ${'Month'.padEnd(10)} ${'Balance'.padStart(10)} ${'Change'.padStart(10)} ${'%Chg'.padStart(8)} ${'Trades'.padStart(7)} ${'WR'.padStart(5)} ${'Avg$/trade'.padStart(11)}`);
  console.log('  ' + '-'.repeat(65));
  for (const [month, eq] of Object.entries(monthlyEq).sort()) {
    const change = eq.end - eq.start;
    const pctChg = (change / eq.start * 100).toFixed(1);
    const wr = eq.trades > 0 ? (eq.wins / eq.trades * 100).toFixed(0) : '0';
    const avgDollar = eq.trades > 0 ? (eq.pnl / eq.trades).toFixed(0) : '0';
    console.log(`  ${month.padEnd(10)} $${eq.end.toFixed(0).padStart(9)} ${(change >= 0 ? '+' : '') + '$' + change.toFixed(0).padStart(8)} ${pctChg.padStart(7)}% ${String(eq.trades).padStart(7)} ${wr.padStart(4)}% $${avgDollar.padStart(10)}`);
  }

  // Worst weeks
  const weekEntries = Object.entries(weeklyPnl).sort((a, b) => a[1].pnl - b[1].pnl);
  console.log(`\n  WORST 5 WEEKS:`);
  for (const [wk, data] of weekEntries.slice(0, 5)) {
    console.log(`    ${wk}: ${data.pnl >= 0 ? '+' : ''}$${data.pnl.toFixed(0)} (${data.trades} trades)`);
  }
  console.log(`\n  BEST 5 WEEKS:`);
  for (const [wk, data] of weekEntries.slice(-5).reverse()) {
    console.log(`    ${wk}: +$${data.pnl.toFixed(0)} (${data.trades} trades)`);
  }

  // Daily win rate
  const dayEntries = Object.values(dailyPnl);
  const profitDays = dayEntries.filter(d => d.pnl > 0).length;
  const lossDays = dayEntries.filter(d => d.pnl < 0).length;
  console.log(`\n  DAILY PERFORMANCE:`);
  console.log(`  Profitable days: ${profitDays}/${dayEntries.length} (${(profitDays / dayEntries.length * 100).toFixed(0)}%)`);
  console.log(`  Loss days:       ${lossDays}/${dayEntries.length} (${(lossDays / dayEntries.length * 100).toFixed(0)}%)`);
  console.log(`  Avg P&L on win day:  +$${(dayEntries.filter(d => d.pnl > 0).reduce((s, d) => s + d.pnl, 0) / Math.max(profitDays, 1)).toFixed(0)}`);
  console.log(`  Avg P&L on loss day: -$${Math.abs(dayEntries.filter(d => d.pnl < 0).reduce((s, d) => s + d.pnl, 0) / Math.max(lossDays, 1)).toFixed(0)}`);
}

// ── Directional Correctness — Actual Numbers ─────────────────────────────────

console.log('\n' + '='.repeat(80));
console.log('  DIRECTIONAL ANALYSIS — Real stock $ and contract % within 5 bars');
console.log('='.repeat(80));

{
  const withData = allSignals.filter(t => t.stockMaxFav !== undefined);
  const pctile = (arr, p) => { const s = [...arr].sort((a,b) => a-b); return s[Math.floor(s.length * p / 100)] || 0; };

  // Contract entry prices
  const entryPrices = withData.map(t => t.contractEntry);
  console.log(`\n  CONTRACT ENTRY PRICES:`);
  console.log(`    P10: $${pctile(entryPrices, 10).toFixed(2)}  P25: $${pctile(entryPrices, 25).toFixed(2)}  P50: $${pctile(entryPrices, 50).toFixed(2)}  P75: $${pctile(entryPrices, 75).toFixed(2)}  P90: $${pctile(entryPrices, 90).toFixed(2)}`);
  console.log(`    Mean: $${(entryPrices.reduce((a,b)=>a+b,0)/entryPrices.length).toFixed(2)}`);

  // Convert stock moves to actual $ on IWM
  const stockPrices = withData.map(t => t.stockEntry);
  const avgStock = stockPrices.reduce((a,b)=>a+b,0)/stockPrices.length;

  // Max favorable stock move in $ terms
  const favDollars = withData.map(t => t.stockMaxFav / 100 * t.stockEntry);
  const advDollars = withData.map(t => t.stockMaxAdv / 100 * t.stockEntry);

  console.log(`\n  STOCK MOVES (within 5 bars of signal):`);
  console.log(`    Avg IWM price at entry: $${avgStock.toFixed(2)}`);
  console.log(`    Max favorable: P25=$${pctile(favDollars,25).toFixed(2)}  P50=$${pctile(favDollars,50).toFixed(2)}  P75=$${pctile(favDollars,75).toFixed(2)}  P90=$${pctile(favDollars,90).toFixed(2)}`);
  console.log(`    Max adverse:   P25=$${pctile(advDollars,25).toFixed(2)}  P50=$${pctile(advDollars,50).toFixed(2)}  P75=$${pctile(advDollars,75).toFixed(2)}  P90=$${pctile(advDollars,90).toFixed(2)}`);

  // Contract MFE (already have this) cross-referenced with stock move
  console.log(`\n  STOCK → CONTRACT TRANSLATION (actual observed):`);
  console.log(`    Stock Move (fav)   Count    Avg Contract MFE    Avg Contract MAE    Options WR`);
  console.log(`    ` + '-'.repeat(75));
  const buckets = [
    { label: '$0.00-0.05', min: 0, max: 0.05 },
    { label: '$0.05-0.10', min: 0.05, max: 0.10 },
    { label: '$0.10-0.15', min: 0.10, max: 0.15 },
    { label: '$0.15-0.20', min: 0.15, max: 0.20 },
    { label: '$0.20-0.30', min: 0.20, max: 0.30 },
    { label: '$0.30-0.50', min: 0.30, max: 0.50 },
    { label: '$0.50+     ', min: 0.50, max: 999 },
  ];
  for (const b of buckets) {
    const sub = withData.filter(t => {
      const favD = t.stockMaxFav / 100 * t.stockEntry;
      return favD >= b.min && favD < b.max;
    });
    if (sub.length < 3) continue;
    const avgMFE = sub.reduce((s,t) => s + t.maxFavorable, 0) / sub.length;
    const avgMAE = sub.reduce((s,t) => s + Math.abs(t.maxAdverse), 0) / sub.length;
    const wr = sub.filter(t => t.pnlPct > 0).length / sub.length * 100;
    console.log(`    ${b.label}         ${String(sub.length).padStart(5)}    ${avgMFE.toFixed(1).padStart(8)}%           ${avgMAE.toFixed(1).padStart(8)}%          ${wr.toFixed(1).padStart(5)}%`);
  }

  // Same but by CALL vs PUT
  for (const dir of ['CALL', 'PUT']) {
    const dirData = withData.filter(t => t.direction === dir);
    console.log(`\n    ${dir}:`);
    console.log(`    Stock Move (fav)   Count    Avg Contract MFE    Avg Contract MAE    Options WR`);
    console.log(`    ` + '-'.repeat(75));
    for (const b of buckets) {
      const sub = dirData.filter(t => {
        const favD = t.stockMaxFav / 100 * t.stockEntry;
        return favD >= b.min && favD < b.max;
      });
      if (sub.length < 3) continue;
      const avgMFE = sub.reduce((s,t) => s + t.maxFavorable, 0) / sub.length;
      const avgMAE = sub.reduce((s,t) => s + Math.abs(t.maxAdverse), 0) / sub.length;
      const wr = sub.filter(t => t.pnlPct > 0).length / sub.length * 100;
      const avgEntry = sub.reduce((s,t) => s + t.contractEntry, 0) / sub.length;
      console.log(`    ${b.label}         ${String(sub.length).padStart(5)}    ${avgMFE.toFixed(1).padStart(8)}%           ${avgMAE.toFixed(1).padStart(8)}%          ${wr.toFixed(1).padStart(5)}%    (avg $${avgEntry.toFixed(2)} entry)`);
    }
  }

  // The key question: when stock goes our way, what happens bar-by-bar on the contract?
  // Show trades where stock moved >=0.10% favorably but we lost
  const dirRightLost = withData.filter(t => {
    const favD = t.stockMaxFav / 100 * t.stockEntry;
    return favD >= 0.10 && t.pnlPct <= 0;
  });
  console.log(`\n  STOCK MOVED >=$0.10 OUR WAY BUT LOST ON CONTRACT: ${dirRightLost.length} trades`);
  if (dirRightLost.length > 0) {
    const byDir = { CALL: dirRightLost.filter(t => t.direction === 'CALL'), PUT: dirRightLost.filter(t => t.direction === 'PUT') };
    for (const [dir, sub] of Object.entries(byDir)) {
      if (sub.length === 0) continue;
      const avgPnl = sub.reduce((s,t) => s + t.pnlPct, 0) / sub.length;
      const avgMAE = sub.reduce((s,t) => s + t.maxAdverse, 0) / sub.length;
      const avgMFE = sub.reduce((s,t) => s + t.maxFavorable, 0) / sub.length;
      const avgEntry = sub.reduce((s,t) => s + t.contractEntry, 0) / sub.length;
      const avgStockFav = sub.reduce((s,t) => s + t.stockMaxFav / 100 * t.stockEntry, 0) / sub.length;
      const avgStockAdv = sub.reduce((s,t) => s + t.stockMaxAdv / 100 * t.stockEntry, 0) / sub.length;
      console.log(`    ${dir}: ${sub.length} trades`);
      console.log(`      Avg contract entry: $${avgEntry.toFixed(2)}, Avg PnL: ${avgPnl.toFixed(1)}%, Avg MFE: +${avgMFE.toFixed(1)}%, Avg MAE: ${avgMAE.toFixed(1)}%`);
      console.log(`      Avg stock fav: $${avgStockFav.toFixed(2)}, Avg stock adv: $${avgStockAdv.toFixed(2)}`);
    }
    // Show first 10 examples with bar-by-bar
    console.log(`\n    Examples (stock moved our way but contract lost):`);
    console.log(`    Date         Dir    Stock$  Entry$  StockFav  StockAdv  ContMFE  ContMAE  PnL%  Exit`);
    for (const t of dirRightLost.slice(0, 15)) {
      const sf = (t.stockMaxFav / 100 * t.stockEntry).toFixed(2);
      const sa = (t.stockMaxAdv / 100 * t.stockEntry).toFixed(2);
      console.log(`    ${t.date} ${t.time?.slice(11,16)||''}  ${t.direction.padEnd(4)}  $${t.stockEntry.toFixed(0)}  $${t.contractEntry.toFixed(2).padStart(5)}   +$${sf.padStart(5)}   -$${sa.padStart(5)}    +${t.maxFavorable.toFixed(1)}%   ${t.maxAdverse.toFixed(1)}%  ${t.pnlPct.toFixed(1)}%  ${t.exitReason}`);
    }
  }

  // Win rate by contract entry price bucket (cheap vs expensive contracts)
  console.log(`\n  WIN RATE BY CONTRACT ENTRY PRICE:`);
  const priceBuckets = [
    { label: '$0.30-0.50', min: 0.30, max: 0.50 },
    { label: '$0.50-0.75', min: 0.50, max: 0.75 },
    { label: '$0.75-1.00', min: 0.75, max: 1.00 },
    { label: '$1.00-1.50', min: 1.00, max: 1.50 },
    { label: '$1.50-2.00', min: 1.50, max: 2.00 },
    { label: '$2.00+     ', min: 2.00, max: 999 },
  ];
  for (const b of priceBuckets) {
    const sub = withData.filter(t => t.contractEntry >= b.min && t.contractEntry < b.max);
    if (sub.length < 5) continue;
    const wr = sub.filter(t => t.pnlPct > 0).length / sub.length * 100;
    const avgPnl = sub.reduce((s,t) => s + t.pnlPct, 0) / sub.length;
    const calls = sub.filter(t => t.direction === 'CALL');
    const puts = sub.filter(t => t.direction === 'PUT');
    const cWr = calls.length > 3 ? (calls.filter(t => t.pnlPct > 0).length / calls.length * 100).toFixed(1) : 'n/a';
    const pWr = puts.length > 3 ? (puts.filter(t => t.pnlPct > 0).length / puts.length * 100).toFixed(1) : 'n/a';
    console.log(`    ${b.label}  ${String(sub.length).padStart(5)} trades  WR: ${wr.toFixed(1)}%  Avg: ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(2)}%  CALL: ${cWr}%  PUT: ${pWr}%`);
  }
}

// ── P1/P2 Regime Split ─────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(80));
console.log('  REGIME SPLIT (P1 vs P2 at 2025-10-01)');
console.log('='.repeat(80));

const p1 = allSignals.filter(t => t.date < '2025-10-01');
const p2 = allSignals.filter(t => t.date >= '2025-10-01');

for (const [label, trades] of [['P1', p1], ['P2', p2]]) {
  if (trades.length === 0) continue;
  const w = trades.filter(t => t.pnlPct > 0).length;
  const avg = trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length;
  const gw = trades.filter(t => t.pnlPct > 0).reduce((s, t) => s + t.pnlPct, 0);
  const gl = Math.abs(trades.filter(t => t.pnlPct < 0).reduce((s, t) => s + t.pnlPct, 0));

  console.log(`\n  ${label}: ${trades.length} trades, ${(w / trades.length * 100).toFixed(1)}% WR, ${avg.toFixed(2)}% avg, PF ${gl > 0 ? (gw / gl).toFixed(2) : 'inf'}`);

  for (const [pat, arr] of Object.entries(byPattern).sort((a, b) => b[1].length - a[1].length)) {
    const pt = arr.filter(t => label === 'P1' ? t.date < '2025-10-01' : t.date >= '2025-10-01');
    if (pt.length < 3) continue;
    const pw = pt.filter(t => t.pnlPct > 0).length;
    const pa = pt.reduce((s, t) => s + t.pnlPct, 0) / pt.length;
    console.log(`    ${pat.padEnd(20)} ${String(pt.length).padStart(5)} trades  WR: ${(pw / pt.length * 100).toFixed(0)}%  Avg: ${pa.toFixed(2)}%`);
  }
}

// ── P2 Diagnostic: Why Does P2 Underperform? ─────────────────────────────────

if (p2.length > 0) {
  console.log('\n' + '='.repeat(80));
  console.log('  P2 DIAGNOSTIC — WHY DOES P2 UNDERPERFORM?');
  console.log('='.repeat(80));

  // ── 1. P2 Monthly Breakdown ──────────────────────────────────────────────────

  console.log('\n  --- P2 Monthly Breakdown (Oct 2025 - Apr 2026) ---\n');
  const p2Months = {};
  for (const t of p2) {
    const month = t.date.slice(0, 7);
    if (!p2Months[month]) p2Months[month] = [];
    p2Months[month].push(t);
  }

  console.log(`  ${'Month'.padEnd(10)} ${'Trades'.padStart(7)} ${'WR'.padStart(7)} ${'Avg%'.padStart(8)} ${'PF'.padStart(7)} ${'Wins'.padStart(6)} ${'Losses'.padStart(7)} ${'Calls'.padStart(6)} ${'Puts'.padStart(6)} ${'C-WR'.padStart(6)} ${'P-WR'.padStart(6)}`);
  console.log('  ' + '-'.repeat(90));

  for (const [month, trades] of Object.entries(p2Months).sort()) {
    const wins = trades.filter(t => t.pnlPct > 0);
    const losses = trades.filter(t => t.pnlPct < 0);
    const avgPnl = trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length;
    const wr = (wins.length / trades.length * 100).toFixed(1);
    const gw = wins.reduce((s, t) => s + t.pnlPct, 0);
    const gl = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0));
    const pf = gl > 0 ? (gw / gl).toFixed(2) : 'inf';
    const calls = trades.filter(t => t.direction === 'CALL');
    const puts = trades.filter(t => t.direction === 'PUT');
    const cWr = calls.length > 0 ? (calls.filter(t => t.pnlPct > 0).length / calls.length * 100).toFixed(1) : 'n/a';
    const pWr = puts.length > 0 ? (puts.filter(t => t.pnlPct > 0).length / puts.length * 100).toFixed(1) : 'n/a';
    console.log(`  ${month.padEnd(10)} ${String(trades.length).padStart(7)} ${wr.padStart(6)}% ${avgPnl.toFixed(2).padStart(7)}% ${pf.padStart(7)} ${String(wins.length).padStart(6)} ${String(losses.length).padStart(7)} ${String(calls.length).padStart(6)} ${String(puts.length).padStart(6)} ${cWr.padStart(5)}% ${pWr.padStart(5)}%`);
  }

  // Totals row
  {
    const wins = p2.filter(t => t.pnlPct > 0);
    const losses = p2.filter(t => t.pnlPct < 0);
    const avgPnl = p2.reduce((s, t) => s + t.pnlPct, 0) / p2.length;
    const wr = (wins.length / p2.length * 100).toFixed(1);
    const gw = wins.reduce((s, t) => s + t.pnlPct, 0);
    const gl = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0));
    const pf = gl > 0 ? (gw / gl).toFixed(2) : 'inf';
    console.log('  ' + '-'.repeat(90));
    console.log(`  ${'TOTAL'.padEnd(10)} ${String(p2.length).padStart(7)} ${wr.padStart(6)}% ${avgPnl.toFixed(2).padStart(7)}% ${pf.padStart(7)} ${String(wins.length).padStart(6)} ${String(losses.length).padStart(7)}`);
  }

  // ── 2. VIX Correlation ───────────────────────────────────────────────────────

  console.log('\n  --- VIX (VIXY Proxy) Correlation ---\n');

  const vixByTime = allData.vixByTime || {};
  const vixKeys = Object.keys(vixByTime).sort();

  // Helper: find nearest VIX value for a given ISO minute key
  function findNearestVix(timeKey) {
    if (!timeKey || vixKeys.length === 0) return null;
    // Exact match first
    if (vixByTime[timeKey] !== undefined) return vixByTime[timeKey];
    // Binary search for nearest key <= timeKey
    let lo = 0, hi = vixKeys.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (vixKeys[mid] <= timeKey) lo = mid;
      else hi = mid - 1;
    }
    // Use the closest key that is <= trade time (same day preferred)
    const candidate = vixKeys[lo];
    if (candidate && candidate.slice(0, 10) === timeKey.slice(0, 10)) {
      return vixByTime[candidate];
    }
    return null;
  }

  // Attach VIX level to each trade and bucket
  const vixBuckets = { low: [], medium: [], high: [], unknown: [] };
  const vixBucketsP2 = { low: [], medium: [], high: [], unknown: [] };

  for (const t of allSignals) {
    t.vixAtTrade = findNearestVix(t.time);
  }

  for (const t of allSignals) {
    const v = t.vixAtTrade;
    if (v === null || v === undefined) { vixBuckets.unknown.push(t); }
    else if (v < 18) { vixBuckets.low.push(t); }
    else if (v <= 25) { vixBuckets.medium.push(t); }
    else { vixBuckets.high.push(t); }
  }

  for (const t of p2) {
    const v = t.vixAtTrade;
    if (v === null || v === undefined) { vixBucketsP2.unknown.push(t); }
    else if (v < 18) { vixBucketsP2.low.push(t); }
    else if (v <= 25) { vixBucketsP2.medium.push(t); }
    else { vixBucketsP2.high.push(t); }
  }

  console.log(`  VIX data points loaded: ${vixKeys.length}`);
  console.log(`  Trades with VIX match: ${allSignals.filter(t => t.vixAtTrade != null).length} / ${allSignals.length}\n`);

  console.log(`  ALL TRADES by VIX bucket:`);
  console.log(`  ${'Bucket'.padEnd(18)} ${'Trades'.padStart(7)} ${'WR'.padStart(7)} ${'Avg%'.padStart(8)} ${'PF'.padStart(7)}`);
  console.log('  ' + '-'.repeat(50));

  for (const [label, trades] of [['Low (<18)', vixBuckets.low], ['Medium (18-25)', vixBuckets.medium], ['High (>25)', vixBuckets.high], ['No VIX data', vixBuckets.unknown]]) {
    if (trades.length === 0) continue;
    const w = trades.filter(t => t.pnlPct > 0).length;
    const avg = trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length;
    const gw = trades.filter(t => t.pnlPct > 0).reduce((s, t) => s + t.pnlPct, 0);
    const gl = Math.abs(trades.filter(t => t.pnlPct < 0).reduce((s, t) => s + t.pnlPct, 0));
    const pf = gl > 0 ? (gw / gl).toFixed(2) : 'inf';
    console.log(`  ${label.padEnd(18)} ${String(trades.length).padStart(7)} ${(w / trades.length * 100).toFixed(1).padStart(6)}% ${avg.toFixed(2).padStart(7)}% ${pf.padStart(7)}`);
  }

  console.log(`\n  P2 ONLY by VIX bucket:`);
  console.log(`  ${'Bucket'.padEnd(18)} ${'Trades'.padStart(7)} ${'WR'.padStart(7)} ${'Avg%'.padStart(8)} ${'PF'.padStart(7)}`);
  console.log('  ' + '-'.repeat(50));

  for (const [label, trades] of [['Low (<18)', vixBucketsP2.low], ['Medium (18-25)', vixBucketsP2.medium], ['High (>25)', vixBucketsP2.high], ['No VIX data', vixBucketsP2.unknown]]) {
    if (trades.length === 0) continue;
    const w = trades.filter(t => t.pnlPct > 0).length;
    const avg = trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length;
    const gw = trades.filter(t => t.pnlPct > 0).reduce((s, t) => s + t.pnlPct, 0);
    const gl = Math.abs(trades.filter(t => t.pnlPct < 0).reduce((s, t) => s + t.pnlPct, 0));
    const pf = gl > 0 ? (gw / gl).toFixed(2) : 'inf';
    console.log(`  ${label.padEnd(18)} ${String(trades.length).padStart(7)} ${(w / trades.length * 100).toFixed(1).padStart(6)}% ${avg.toFixed(2).padStart(7)}% ${pf.padStart(7)}`);
  }

  // ── 3. Drawdown / Consecutive Loss Streaks in P2 ────────────────────────────

  console.log('\n  --- P2 Max Consecutive Loss Streaks ---\n');

  const p2Sorted = [...p2].sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  const streaks = [];
  let currentStreak = 0;
  let streakStart = null;
  let streakEnd = null;

  for (const t of p2Sorted) {
    if (t.pnlPct < 0) {
      if (currentStreak === 0) streakStart = t;
      currentStreak++;
      streakEnd = t;
    } else {
      if (currentStreak >= 3) {
        streaks.push({ length: currentStreak, start: streakStart, end: streakEnd });
      }
      currentStreak = 0;
      streakStart = null;
      streakEnd = null;
    }
  }
  // Flush last streak
  if (currentStreak >= 3) {
    streaks.push({ length: currentStreak, start: streakStart, end: streakEnd });
  }

  streaks.sort((a, b) => b.length - a.length);
  const maxStreak = streaks.length > 0 ? streaks[0].length : 0;

  console.log(`  Max consecutive losses: ${maxStreak}`);
  console.log(`  Streaks of 3+ losses: ${streaks.length}\n`);

  if (streaks.length > 0) {
    console.log(`  ${'Len'.padStart(4)} ${'Start Date'.padEnd(12)} ${'End Date'.padEnd(12)} ${'Start Time'.padEnd(18)} ${'End Time'.padEnd(18)} ${'Cum PnL%'.padStart(9)}`);
    console.log('  ' + '-'.repeat(75));

    for (const s of streaks.slice(0, 10)) {
      // Calculate cumulative PnL of the streak
      const startIdx = p2Sorted.indexOf(s.start);
      const endIdx = p2Sorted.indexOf(s.end);
      let cumPnl = 0;
      for (let i = startIdx; i <= endIdx; i++) {
        cumPnl += p2Sorted[i].pnlPct;
      }
      console.log(`  ${String(s.length).padStart(4)} ${(s.start.date || '').padEnd(12)} ${(s.end.date || '').padEnd(12)} ${(s.start.time || '').slice(11, 16).padEnd(18)} ${(s.end.time || '').slice(11, 16).padEnd(18)} ${cumPnl.toFixed(2).padStart(8)}%`);
    }
  }

  // Equity curve within P2 — show cumulative PnL% by week
  console.log('\n  --- P2 Weekly Equity Trend ---\n');
  const p2Weeks = {};
  for (const t of p2Sorted) {
    // ISO week key: use Monday of the week
    const d = new Date(t.date + 'T12:00:00Z');
    const day = d.getUTCDay();
    const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(d);
    monday.setUTCDate(diff);
    const weekKey = monday.toISOString().slice(0, 10);
    if (!p2Weeks[weekKey]) p2Weeks[weekKey] = [];
    p2Weeks[weekKey].push(t);
  }

  console.log(`  ${'Week of'.padEnd(12)} ${'Trades'.padStart(7)} ${'WR'.padStart(7)} ${'Avg%'.padStart(8)} ${'Sum%'.padStart(8)} ${'W'.padStart(4)} ${'L'.padStart(4)}`);
  console.log('  ' + '-'.repeat(55));

  for (const [week, trades] of Object.entries(p2Weeks).sort()) {
    const w = trades.filter(t => t.pnlPct > 0).length;
    const l = trades.filter(t => t.pnlPct < 0).length;
    const avg = trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length;
    const sum = trades.reduce((s, t) => s + t.pnlPct, 0);
    const wr = (w / trades.length * 100).toFixed(1);
    console.log(`  ${week.padEnd(12)} ${String(trades.length).padStart(7)} ${wr.padStart(6)}% ${avg.toFixed(2).padStart(7)}% ${sum.toFixed(2).padStart(7)}% ${String(w).padStart(4)} ${String(l).padStart(4)}`);
  }
}

// ── Variant Testing ────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(80));
console.log('  EXIT VARIANT TESTING');
console.log('='.repeat(80));

const variants = [
  { name: 'V0: sym 5/3 (current)',    cTgt: 5, pTgt: 5, cStop: -3, pStop: -3, maxBars: 5 },
  { name: 'V1: sym 5/5',              cTgt: 5, pTgt: 5, cStop: -5, pStop: -5, maxBars: 5 },
  { name: 'V2: C5/3 P5/5',            cTgt: 5, pTgt: 5, cStop: -3, pStop: -5, maxBars: 5 },
  { name: 'V3: C5/3 P7/5',            cTgt: 5, pTgt: 7, cStop: -3, pStop: -5, maxBars: 5 },
  { name: 'V4: sym 7/3',              cTgt: 7, pTgt: 7, cStop: -3, pStop: -3, maxBars: 5 },
  { name: 'V5: sym 7/5',              cTgt: 7, pTgt: 7, cStop: -5, pStop: -5, maxBars: 5 },
  { name: 'V6: sym 5/3 7bars',        cTgt: 5, pTgt: 5, cStop: -3, pStop: -3, maxBars: 7 },
  { name: 'V7: C5/3 P7/3',            cTgt: 5, pTgt: 7, cStop: -3, pStop: -3, maxBars: 5 },
];

console.log(`\n  ${'Variant'.padEnd(30)} ${'WR'.padStart(7)} ${'Avg%'.padStart(8)} ${'PF'.padStart(7)} ${'Final$'.padStart(9)} ${'Return'.padStart(9)} ${'MaxDD'.padStart(7)}`);
console.log('  ' + '-'.repeat(78));

for (const v of variants) {
  // Re-simulate using stored per-bar details with close-based stops
  let bal = STARTING_BALANCE, pk = bal, mdd = 0;
  let wins = 0, total = 0, sumPnl = 0, grossW = 0, grossL = 0;
  let putWins = 0, putTotal = 0;

  for (const trade of sortedTrades) {
    if (!trade.barDetails || trade.barDetails.length === 0) continue;

    const isCall = trade.direction === 'CALL';
    const stopLevel = isCall ? v.cStop : v.pStop;
    const targetLevel = isCall ? v.cTgt : v.pTgt;
    const maxBars = v.maxBars || EXIT.maxBars;

    // Close-based stop re-sim using barDetails
    let pnl = 0;
    let againstCount = 0;
    const bars = trade.barDetails.slice(0, maxBars);

    for (let i = 0; i < bars.length; i++) {
      const { h, l, c } = bars[i];
      // Close-based stop
      if (c <= stopLevel) { pnl = stopLevel; break; }
      // Target on high (limit order fills on touch)
      if (h >= targetLevel) { pnl = targetLevel; break; }
      // Stall
      const prevC = i > 0 ? bars[i - 1].c : 0;
      againstCount = (c < prevC) ? againstCount + 1 : 0;
      if (againstCount >= EXIT.stallBars) { pnl = c; break; }
      pnl = c;
    }

    total++;
    if (!isCall) { putTotal++; if (pnl > 0) putWins++; }
    if (pnl > 0) { wins++; grossW += pnl; }
    if (pnl < 0) { grossL += Math.abs(pnl); }
    sumPnl += pnl;

    const riskAmt = bal * 0.10;
    const contracts = Math.max(1, Math.floor(riskAmt / (trade.contractEntry * 100)));
    const dollarPnl = trade.contractEntry * (pnl / 100) * 100 * contracts;
    bal += dollarPnl;
    if (bal > pk) pk = bal;
    const dd = (pk - bal) / pk * 100;
    if (dd > mdd) mdd = dd;
  }

  const vWR = (wins / total * 100).toFixed(1);
  const vAvg = (sumPnl / total).toFixed(2);
  const vPF = grossL > 0 ? (grossW / grossL).toFixed(2) : '99';
  const vRet = ((bal - STARTING_BALANCE) / STARTING_BALANCE * 100).toFixed(1);
  const pWR = putTotal > 0 ? (putWins / putTotal * 100).toFixed(1) : 'n/a';

  console.log(`  ${v.name.padEnd(30)} ${vWR.padStart(6)}% ${vAvg.padStart(7)}% ${vPF.padStart(7)} $${bal.toFixed(0).padStart(8)} ${(vRet + '%').padStart(9)} ${(mdd.toFixed(1) + '%').padStart(7)}  P-WR: ${pWR}%`);
}

// ── Contract Price Floor Testing ──────────────────────────────────────────────
// Can't re-sim from stored trades — the floor changes WHICH trades are taken.
// Filter from allSignals by contract entry price and re-compute.

console.log('\n' + '='.repeat(80));
console.log('  CONTRACT PRICE FLOOR TESTING');
console.log('='.repeat(80));

const floors = [0.30, 0.50, 0.75, 1.00, 1.25, 1.50];
console.log(`\n  ${'Floor'.padEnd(12)} ${'Trades'.padStart(7)} ${'Rate'.padStart(7)} ${'WR'.padStart(7)} ${'Avg%'.padStart(8)} ${'PF'.padStart(7)} ${'Final$'.padStart(9)} ${'Return'.padStart(9)} ${'MaxDD'.padStart(7)}  CALL WR  PUT WR  PUT#`);
console.log('  ' + '-'.repeat(105));

for (const floor of floors) {
  const sub = sortedTrades.filter(t => t.contractEntry >= floor);
  if (sub.length < 50) continue;

  let bal = STARTING_BALANCE, pk = bal, mdd = 0;
  let wins = 0, sumPnl = 0, grossW = 0, grossL = 0;

  for (const trade of sub) {
    const pnl = trade.pnlPct;
    if (pnl > 0) { wins++; grossW += pnl; }
    if (pnl < 0) grossL += Math.abs(pnl);
    sumPnl += pnl;

    const riskAmt = bal * 0.10;
    const contracts = Math.max(1, Math.floor(riskAmt / (trade.contractEntry * 100)));
    const dollarPnl = trade.contractEntry * (pnl / 100) * 100 * contracts;
    bal += dollarPnl;
    if (bal > pk) pk = bal;
    const dd = (pk - bal) / pk * 100;
    if (dd > mdd) mdd = dd;
  }

  const wr = (wins / sub.length * 100).toFixed(1);
  const avg = (sumPnl / sub.length).toFixed(2);
  const pf = grossL > 0 ? (grossW / grossL).toFixed(2) : '99';
  const ret = ((bal - STARTING_BALANCE) / STARTING_BALANCE * 100).toFixed(1);
  const rate = (sub.length / tradingDays.length).toFixed(1);
  const calls = sub.filter(t => t.direction === 'CALL');
  const puts = sub.filter(t => t.direction === 'PUT');
  const cWr = calls.length > 0 ? (calls.filter(t => t.pnlPct > 0).length / calls.length * 100).toFixed(1) : 'n/a';
  const pWr = puts.length > 0 ? (puts.filter(t => t.pnlPct > 0).length / puts.length * 100).toFixed(1) : 'n/a';

  const marker = floor === MIN_CONTRACT_PRICE ? ' <<<' : '';
  console.log(`  >= $${floor.toFixed(2)}     ${String(sub.length).padStart(6)} ${rate.padStart(6)}/d ${wr.padStart(6)}% ${avg.padStart(7)}% ${pf.padStart(7)} $${bal.toFixed(0).padStart(8)} ${(ret + '%').padStart(9)} ${(mdd.toFixed(1) + '%').padStart(7)}  ${cWr.padStart(6)}%  ${pWr.padStart(5)}%  ${String(puts.length).padStart(4)}${marker}`);
}

console.log('\n' + '='.repeat(80));

// ── Dump trades for overfitting analysis ────────────────────────────────────
if (flags.includes('--dump')) {
  const dumpPath = '/tmp/compound-trades.json';
  const dumpData = sortedTrades
    .filter(t => t.barDetails?.length > 0)
    .map(t => ({
      date: t.date, time: t.time, pattern: t.pattern, direction: t.direction,
      confidence: t.confidence, contractEntry: t.contractEntry, stockEntry: t.stockEntry,
      strike: t.strike, pnlPct: t.pnlPct, exitReason: t.exitReason,
      barDetails: t.barDetails,
    }));
  const fs = await import('fs');
  fs.writeFileSync(dumpPath, JSON.stringify(dumpData));
  console.log(`[DUMP] ${dumpData.length} trades written to ${dumpPath}`);
}

process.exit(0);

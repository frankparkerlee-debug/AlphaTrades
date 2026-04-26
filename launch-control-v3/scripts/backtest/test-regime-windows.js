#!/usr/bin/env node
/**
 * Multi-Window Regime Backtest
 *
 * Runs the compound scalp strategy across 6-month windows to validate
 * performance across different market regimes. Each window is tested
 * independently with fresh starting balance.
 *
 * Regimes covered:
 *   2024-H1: Rate cut anticipation, IWM consolidation
 *   2024-H2: Election vol, rate cuts begin, IWM rally
 *   2025-H1: Bull continuation, tariff fears emerge
 *   2025-H2: Bear/correction regime, high vol
 *   2026-Q1: Continued volatility, recovery attempts
 *
 * Also tests rolling 3-month windows for finer-grained regime analysis.
 *
 * Usage: node scripts/backtest/test-regime-windows.js
 */

import { query } from '../../src/data/db.js';
import { fetchAllDataFromDB } from './data-fetcher-db.js';
import { detectCompoundSignals } from '../../src/scalper/compound-detector.js';
import { emaSeries } from '../../src/indicators/technical.js';

const flags = process.argv.filter(a => a.startsWith('--'));
const balFlag = flags.find(f => f.startsWith('--bal='));

const TICKER = 'IWM';
const STARTING_BALANCE = balFlag ? parseInt(balFlag.split('=')[1]) : 7500;
const MAX_SIGNALS_PER_DAY = 7;
const COOLDOWN_BARS = 5;
const MIN_CONTRACT_PRICE = 0.75;
const PUT_MIN_CONTRACT_PRICE = 1.00;
const PUT_ITM_RANGE = 3.0;

const EXIT = {
  callTargetPct: 5,
  putTargetPct: 5,
  callStopPct: -3,
  putStopPct: -3,
  maxBars: 5,
  stallBars: 2,
};

// Spread model
const SPREAD_HS = 0.02; // $0.02/side realistic for ITM/ATM IWM

// Trailing stop parameters (best from optimization)
const TRAIL = {
  initStop: -3,
  beLevel: 2,      // move stop to breakeven at +2%
  trailStart: 3,   // start trailing at +3%
  trailKeep: 0.60, // keep 60% of peak
};

// ── Windows ────────────────────────────────────────────────────────────────────

const SIX_MONTH_WINDOWS = [
  { label: '2024-H1 (rate anticipation)',  start: '2024-01-19', end: '2024-06-30' },
  { label: '2024-H2 (election + cuts)',    start: '2024-07-01', end: '2024-12-31' },
  { label: '2025-H1 (bull continuation)',  start: '2025-01-02', end: '2025-06-30' },
  { label: '2025-H2 (correction/bear)',    start: '2025-07-01', end: '2025-12-31' },
  { label: '2026-Q1 (vol/recovery)',       start: '2026-01-02', end: '2026-04-17' },
];

const THREE_MONTH_WINDOWS = [
  { label: '2024-Q1 (Jan-Mar)',  start: '2024-01-19', end: '2024-03-31' },
  { label: '2024-Q2 (Apr-Jun)',  start: '2024-04-01', end: '2024-06-30' },
  { label: '2024-Q3 (Jul-Sep)',  start: '2024-07-01', end: '2024-09-30' },
  { label: '2024-Q4 (Oct-Dec)',  start: '2024-10-01', end: '2024-12-31' },
  { label: '2025-Q1 (Jan-Mar)',  start: '2025-01-02', end: '2025-03-31' },
  { label: '2025-Q2 (Apr-Jun)',  start: '2025-04-01', end: '2025-06-30' },
  { label: '2025-Q3 (Jul-Sep)',  start: '2025-07-01', end: '2025-09-30' },
  { label: '2025-Q4 (Oct-Dec)',  start: '2025-10-01', end: '2025-12-31' },
  { label: '2026-Q1 (Jan-Mar)',  start: '2026-01-02', end: '2026-03-31' },
  { label: '2026-Q1b (Mar-Apr)', start: '2026-03-01', end: '2026-04-17' },
];

// ── Helpers (same as test-compound-scalps.js) ──────────────────────────────────

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

// ── Spread + trailing stop re-simulation ─────────────────────────────────────

function resimTrailing(trade, hs) {
  const origEntry = trade.contractEntry;
  const effEntry = origEntry + hs;
  const exitSlip = hs > 0 ? hs / effEntry * 100 : 0;
  const bars = trade.barDetails;
  if (!bars || bars.length === 0) return 0;

  let peak = 0, stopLevel = TRAIL.initStop;

  for (let i = 0; i < Math.min(bars.length, EXIT.maxBars); i++) {
    const bH = origEntry * (1 + bars[i].h / 100);
    const bC = origEntry * (1 + bars[i].c / 100);
    const hPct = (bH - effEntry) / effEntry * 100;
    const cPct = (bC - effEntry) / effEntry * 100;

    if (hPct > peak) peak = hPct;
    if (peak >= TRAIL.trailStart) stopLevel = Math.max(stopLevel, peak * TRAIL.trailKeep);
    else if (peak >= TRAIL.beLevel) stopLevel = Math.max(stopLevel, 0);

    if (cPct <= stopLevel) return +(stopLevel - exitSlip).toFixed(2);
  }
  const lastC = origEntry * (1 + bars[Math.min(bars.length - 1, EXIT.maxBars - 1)].c / 100);
  return +((lastC - effEntry) / effEntry * 100 - exitSlip).toFixed(2);
}

function resimFixed(trade, hs) {
  const origEntry = trade.contractEntry;
  const effEntry = origEntry + hs;
  const exitSlip = hs > 0 ? hs / effEntry * 100 : 0;
  const isCall = trade.direction === 'CALL';
  const stp = isCall ? EXIT.callStopPct : EXIT.putStopPct;
  const tgt = isCall ? EXIT.callTargetPct : EXIT.putTargetPct;
  const bars = trade.barDetails;
  if (!bars || bars.length === 0) return 0;

  let againstCount = 0, pnl = 0;
  for (let i = 0; i < Math.min(bars.length, EXIT.maxBars); i++) {
    const bH = origEntry * (1 + bars[i].h / 100);
    const bC = origEntry * (1 + bars[i].c / 100);
    const hPct = (bH - effEntry) / effEntry * 100;
    const cPct = (bC - effEntry) / effEntry * 100;

    if (cPct <= stp) return +(stp - exitSlip).toFixed(2);
    if (hPct >= tgt) return +tgt.toFixed(2);

    let prev = 0;
    if (i > 0) { const p = origEntry * (1 + bars[i-1].c / 100); prev = (p - effEntry) / effEntry * 100; }
    againstCount = (cPct < prev) ? againstCount + 1 : 0;
    if (againstCount >= EXIT.stallBars) return +(cPct - exitSlip).toFixed(2);
    pnl = cPct - exitSlip;
  }
  return +pnl.toFixed(2);
}

// Evaluate a set of trades with a given resim function
function evalTrades(results, resimFn) {
  let bal = STARTING_BALANCE, pk = bal, mdd = 0;
  let wins = 0, gW = 0, gL = 0, sum = 0, cW = 0, cT = 0, pW = 0, pT = 0;
  const sorted = [...results].sort((a, b) => (a.time || '').localeCompare(b.time || ''));

  for (const t of sorted) {
    if (!t.barDetails?.length) continue;
    const pnl = resimFn(t);
    if (pnl > 0) { wins++; gW += pnl; } if (pnl < 0) gL += Math.abs(pnl); sum += pnl;
    if (t.direction === 'CALL') { cT++; if (pnl > 0) cW++; } else { pT++; if (pnl > 0) pW++; }
    const riskAmt = bal * 0.10;
    const contracts = Math.max(1, Math.floor(riskAmt / (t.contractEntry * 100)));
    bal += t.contractEntry * (pnl / 100) * 100 * contracts;
    if (bal > pk) pk = bal; const dd = (pk - bal) / pk * 100; if (dd > mdd) mdd = dd;
  }
  const total = sorted.filter(t => t.barDetails?.length).length;
  return {
    total, wins, wr: total > 0 ? (wins / total * 100) : 0,
    pf: gL > 0 ? gW / gL : 99, avg: total > 0 ? sum / total : 0,
    cWr: cT > 0 ? cW / cT * 100 : 0, pWr: pT > 0 ? pW / pT * 100 : 0,
    final: bal, ret: (bal - STARTING_BALANCE) / STARTING_BALANCE * 100, mdd,
  };
}

// ── Run a single window ────────────────────────────────────────────────────────

async function runWindow(window, optionsBars, allData) {
  const { start, end, label } = window;
  const minuteBars = allData.minuteBars[TICKER] || {};
  const dailyBars = allData.dailyBars;
  const tradingDays = allData.tradingDays.filter(d => d >= start && d <= end);

  if (tradingDays.length < 5) return null;

  const results = [];
  let noContractCount = 0;
  let trendFilterBlocked = 0;
  let circuitBreakerDays = 0;

  for (const date of tradingDays) {
    const { start: rthStart, end: rthEnd } = getRTHBounds(date);
    const dayKeys = Object.keys(minuteBars)
      .filter(k => k >= `${date}T${rthStart}` && k <= `${date}T${rthEnd}`)
      .sort();
    if (dayKeys.length < 20) continue;

    let orHigh = 0, orLow = Infinity;
    for (let i = 0; i < Math.min(5, dayKeys.length); i++) {
      const b = minuteBars[dayKeys[i]];
      if (b.h > orHigh) orHigh = b.h;
      if (b.l < orLow) orLow = b.l;
    }

    const prevDayBar = (() => {
      const tickerBars = dailyBars[TICKER];
      if (!tickerBars) return null;
      const dates = Object.keys(tickerBars).sort();
      const idx = dates.indexOf(date);
      return idx > 0 ? tickerBars[dates[idx - 1]] : null;
    })();

    let daySignals = 0, lastSignalIdx = -COOLDOWN_BARS;
    let dayWins = 0, dayLosses = 0, dayCircuitBroken = false;

    for (let i = 10; i < dayKeys.length; i++) {
      if (daySignals >= MAX_SIGNALS_PER_DAY) break;
      if (i - lastSignalIdx < COOLDOWN_BARS) continue;
      if (dayCircuitBroken) break;

      const key = dayKeys[i];
      const startIdx = Math.max(0, i - 30);
      const bars = dayKeys.slice(startIdx, i + 1).map(k => ({ ...minuteBars[k], t: k }));
      if (bars.length < 10) continue;

      const curr = bars[bars.length - 1];

      let sessionHigh = 0, sessionLow = Infinity;
      for (let j = 0; j <= i; j++) {
        const b = minuteBars[dayKeys[j]];
        if (b.h > sessionHigh) sessionHigh = b.h;
        if (b.l < sessionLow) sessionLow = b.l;
      }

      let cumVol = 0, cumPV = 0;
      for (let j = 0; j <= i; j++) {
        const b = minuteBars[dayKeys[j]];
        const tp = (b.h + b.l + b.c) / 3;
        cumVol += (b.v || 0);
        cumPV += tp * (b.v || 0);
      }
      const vwap = cumVol > 0 ? cumPV / cumVol : curr.c;

      const closes = bars.map(b => b.c);
      const ema9Arr = emaSeries(closes, 9);
      let ema9Slope = 0;
      if (ema9Arr && ema9Arr.length >= 15) {
        const now = ema9Arr[ema9Arr.length - 1];
        const ago = ema9Arr[ema9Arr.length - 6];
        ema9Slope = (now && ago && ago > 0) ? (now - ago) / ago : 0;
      }

      const ctx = {
        vwap, orHigh: orHigh || null, orLow: orLow < Infinity ? orLow : null,
        sessionHigh, sessionLow, sessionOpen: minuteBars[dayKeys[0]]?.o,
        ema9Slope, barsFromOpen: i,
        prevDayHigh: prevDayBar?.h || null, prevDayLow: prevDayBar?.l || null,
      };

      const signals = detectCompoundSignals(TICKER, bars, ctx);
      const sessionOpen = minuteBars[dayKeys[0]]?.o || curr.c;
      const aboveVwap = curr.c > vwap;
      const aboveOpen = curr.c > sessionOpen;
      const callOK = aboveVwap || aboveOpen;
      const putOK = !aboveVwap || !aboveOpen;

      for (const sig of signals) {
        if (sig.confidence < 65) continue;
        if (daySignals >= MAX_SIGNALS_PER_DAY) break;
        if (sig.direction === 'CALL' && !callOK) { trendFilterBlocked++; continue; }
        if (sig.direction === 'PUT' && !putOK) { trendFilterBlocked++; continue; }

        sig.timestamp_key = key;
        const result = simulateTrade(sig, date, optionsBars);
        if (!result) { noContractCount++; continue; }

        result.date = date;
        result.time = key;
        results.push(result);
        daySignals++;
        lastSignalIdx = i;

        if (result.pnlPct > 0) { dayWins++; dayLosses = 0; }
        else if (result.pnlPct < 0) { dayLosses++; }
        if (dayLosses >= 2 && dayWins === 0) { dayCircuitBroken = true; circuitBreakerDays++; }

        break;
      }
    }
  }

  if (results.length === 0) return null;

  // Compute stats
  const wins = results.filter(t => t.pnlPct > 0).length;
  const wr = wins / results.length * 100;
  const avgPnl = results.reduce((s, t) => s + t.pnlPct, 0) / results.length;
  const grossW = results.filter(t => t.pnlPct > 0).reduce((s, t) => s + t.pnlPct, 0);
  const grossL = Math.abs(results.filter(t => t.pnlPct < 0).reduce((s, t) => s + t.pnlPct, 0));
  const pf = grossL > 0 ? grossW / grossL : 99;

  const calls = results.filter(t => t.direction === 'CALL');
  const puts = results.filter(t => t.direction === 'PUT');
  const cWr = calls.length > 0 ? calls.filter(t => t.pnlPct > 0).length / calls.length * 100 : 0;
  const pWr = puts.length > 0 ? puts.filter(t => t.pnlPct > 0).length / puts.length * 100 : 0;

  // Compounding sim
  let bal = STARTING_BALANCE, pk = bal, mdd = 0;
  const sorted = [...results].sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  for (const trade of sorted) {
    const riskAmt = bal * 0.10;
    const contracts = Math.max(1, Math.floor(riskAmt / (trade.contractEntry * 100)));
    const pnl = trade.contractEntry * (trade.pnlPct / 100) * 100 * contracts;
    bal += pnl;
    if (bal > pk) pk = bal;
    const dd = (pk - bal) / pk * 100;
    if (dd > mdd) mdd = dd;
  }
  const ret = (bal - STARTING_BALANCE) / STARTING_BALANCE * 100;

  // Sentiment correlation (if available)
  let sentimentNote = '';
  const sentimentBars = allData.sentimentBars || {};
  if (sentimentBars.HYG && Object.keys(sentimentBars.HYG).length > 0) {
    const hygKeys = Object.keys(sentimentBars.HYG).filter(k => k >= start && k <= end + 'T23:59').sort();
    if (hygKeys.length > 10) {
      const hygFirst = sentimentBars.HYG[hygKeys[0]]?.c;
      const hygLast = sentimentBars.HYG[hygKeys[hygKeys.length - 1]]?.c;
      if (hygFirst && hygLast) {
        const hygChg = ((hygLast - hygFirst) / hygFirst * 100).toFixed(1);
        sentimentNote = `HYG: ${hygChg > 0 ? '+' : ''}${hygChg}%`;
      }
    }
  }
  if (sentimentBars.TLT && Object.keys(sentimentBars.TLT).length > 0) {
    const tltKeys = Object.keys(sentimentBars.TLT).filter(k => k >= start && k <= end + 'T23:59').sort();
    if (tltKeys.length > 10) {
      const tltFirst = sentimentBars.TLT[tltKeys[0]]?.c;
      const tltLast = sentimentBars.TLT[tltKeys[tltKeys.length - 1]]?.c;
      if (tltFirst && tltLast) {
        const tltChg = ((tltLast - tltFirst) / tltFirst * 100).toFixed(1);
        sentimentNote += (sentimentNote ? '  ' : '') + `TLT: ${tltChg > 0 ? '+' : ''}${tltChg}%`;
      }
    }
  }

  return {
    label, start, end,
    days: tradingDays.length,
    trades: results.length,
    rate: (results.length / tradingDays.length).toFixed(1),
    wr: wr.toFixed(1),
    avgPnl: avgPnl.toFixed(2),
    pf: pf.toFixed(2),
    calls: calls.length,
    puts: puts.length,
    cWr: cWr.toFixed(1),
    pWr: pWr.toFixed(1),
    final: bal.toFixed(0),
    ret: ret.toFixed(1),
    mdd: mdd.toFixed(1),
    circuitBreakerDays,
    sentimentNote,
    rawResults: results,  // for re-simulation with spread/trailing
  };
}

function simulateTrade(signal, date, optionsBars) {
  const isCall = signal.direction === 'CALL';
  const contract = findRealContract(date, isCall, signal.entry, signal.timestamp_key, optionsBars);
  if (!contract) return null;

  const contractEntry = contract.entryPrice;
  const fwdBars = contract.forwardBars.slice(0, EXIT.maxBars);

  const result = {
    pattern: signal.pattern, direction: signal.direction,
    confidence: signal.confidence, strike: contract.strike,
    contractEntry, stockEntry: signal.entry,
    holdBars: fwdBars.length, exitReason: 'TIME',
    pnlPct: 0, maxFavorable: 0, maxAdverse: 0,
    barDetails: [],
  };

  if (fwdBars.length === 0) { result.exitReason = 'NO_DATA'; return result; }

  let againstCount = 0, prevClose = contractEntry;
  const stopLevel = isCall ? EXIT.callStopPct : EXIT.putStopPct;
  const targetLevel = isCall ? EXIT.callTargetPct : EXIT.putTargetPct;

  for (let i = 0; i < fwdBars.length; i++) {
    const bar = fwdBars[i];
    if (!bar) continue;
    const bestPct = ((bar.h - contractEntry) / contractEntry) * 100;
    const worstPct = ((bar.l - contractEntry) / contractEntry) * 100;
    const closePct = ((bar.c - contractEntry) / contractEntry) * 100;
    if (bestPct > result.maxFavorable) result.maxFavorable = +bestPct.toFixed(2);
    if (worstPct < result.maxAdverse) result.maxAdverse = +worstPct.toFixed(2);
    result.barDetails.push({ h: +bestPct.toFixed(2), l: +worstPct.toFixed(2), c: +closePct.toFixed(2) });

    // Close-based stop
    if (closePct <= stopLevel) {
      result.pnlPct = stopLevel; result.exitReason = 'STOP'; result.holdBars = i + 1; break;
    }
    // Target on high (limit order)
    if (bestPct >= targetLevel) {
      result.pnlPct = targetLevel; result.exitReason = 'TARGET'; result.holdBars = i + 1; break;
    }
    // Stall
    const barAgainst = bar.c < prevClose;
    againstCount = barAgainst ? againstCount + 1 : 0;
    if (againstCount >= EXIT.stallBars) {
      result.pnlPct = +closePct.toFixed(2); result.exitReason = 'STALL'; result.holdBars = i + 1; break;
    }
    prevClose = bar.c;
    result.pnlPct = +closePct.toFixed(2);
  }

  result.pnlDollars = +(contractEntry * (result.pnlPct / 100) * 100).toFixed(2);
  return result;
}

function findRealContract(date, isCall, stockPrice, signalTime, optionsBars) {
  const optType = isCall ? 'C' : 'P';
  const dayContracts = optionsBars[date]?.[optType];
  if (!dayContracts) return null;

  const signalMinute = signalTime.slice(0, 16);
  const availableStrikes = Object.keys(dayContracts).map(Number).sort((a, b) => a - b);
  if (availableStrikes.length === 0) return null;

  const maxDist = isCall ? 1.0 : PUT_ITM_RANGE;
  const minPrice = isCall ? MIN_CONTRACT_PRICE : PUT_MIN_CONTRACT_PRICE;

  let candidates;
  if (isCall) {
    candidates = availableStrikes
      .map(s => ({ strike: s, dist: Math.abs(s - stockPrice) }))
      .filter(s => s.dist <= maxDist)
      .sort((a, b) => a.dist - b.dist);
  } else {
    candidates = availableStrikes
      .map(s => ({ strike: s, dist: Math.abs(s - stockPrice), itm: s - stockPrice }))
      .filter(s => s.dist <= maxDist)
      .sort((a, b) => {
        const aScore = a.itm >= 0 && a.itm <= 2 ? 0 : a.itm > 2 ? 1 : 2;
        const bScore = b.itm >= 0 && b.itm <= 2 ? 0 : b.itm > 2 ? 1 : 2;
        if (aScore !== bScore) return aScore - bScore;
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
    if (entryBar.c < minPrice) continue;
    const forwardKeys = barKeys.slice(entryIdx + 1);
    const forwardBars = forwardKeys.map(k => contractBars[k]);
    return { strike, entryBar, entryKey: barKeys[entryIdx], entryPrice: entryBar.c, forwardBars, forwardKeys };
  }
  return null;
}

// ── Main ────────────────────────────────────────────────────────────────────────

console.log('='.repeat(90));
console.log('  MULTI-WINDOW REGIME BACKTEST — COMPOUND SCALP STRATEGY');
console.log('  Exit: CALL +5%/-3% PUT +5%/-3% (close-based stops, ITM puts)');
console.log('  Account: $7,500 per window (independent)');
console.log('='.repeat(90));

// Load full date range
const fullStart = '2024-01-19';
const fullEnd = '2026-04-17';

console.log(`\n  Loading data for full range: ${fullStart} → ${fullEnd}...\n`);

const allData = await fetchAllDataFromDB({ startDate: fullStart, endDate: fullEnd }, [TICKER]);

// Load options bars for full range
const optRes = await query(`
  SELECT symbol, ticker, ts, expiry, strike, option_type,
         open, high, low, close, volume
  FROM lc_v3.options_bars_1m
  WHERE ticker = $1
    AND expiry >= $2 AND expiry <= $3
  ORDER BY ts
`, [TICKER, fullStart, fullEnd]);

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
console.log(`[DATA] ${optRes.rows.length} options bars across ${optDays.size} days`);
console.log(`[DATA] Trading days: ${allData.tradingDays.length}\n`);

// ── Run 6-month windows ──────────────────────────────────────────────────────

console.log('='.repeat(90));
console.log('  6-MONTH WINDOWS');
console.log('='.repeat(90));
console.log(`\n  ${'Window'.padEnd(35)} ${'Days'.padStart(5)} ${'Trades'.padStart(7)} ${'Rate'.padStart(5)} ${'WR'.padStart(6)} ${'Avg%'.padStart(7)} ${'PF'.padStart(6)} ${'$Final'.padStart(8)} ${'Return'.padStart(8)} ${'MaxDD'.padStart(6)} ${'C-WR'.padStart(6)} ${'P-WR'.padStart(6)} ${'Sentiment'}`);
console.log('  ' + '-'.repeat(130));

const sixMonthResults = [];
for (const w of SIX_MONTH_WINDOWS) {
  process.stdout.write(`  Running ${w.label}...\r`);
  const r = await runWindow(w, optionsBars, allData);
  if (r) {
    sixMonthResults.push(r);
    console.log(`  ${r.label.padEnd(35)} ${r.days.toString().padStart(5)} ${r.trades.toString().padStart(7)} ${r.rate.padStart(5)} ${(r.wr + '%').padStart(6)} ${(r.avgPnl + '%').padStart(7)} ${r.pf.padStart(6)} $${r.final.padStart(7)} ${(r.ret + '%').padStart(8)} ${(r.mdd + '%').padStart(6)} ${(r.cWr + '%').padStart(6)} ${(r.pWr + '%').padStart(6)} ${r.sentimentNote}`);
  } else {
    console.log(`  ${w.label.padEnd(35)} — insufficient data`);
  }
}

// Summary row
if (sixMonthResults.length > 0) {
  const avgWR = (sixMonthResults.reduce((s, r) => s + parseFloat(r.wr), 0) / sixMonthResults.length).toFixed(1);
  const avgPF = (sixMonthResults.reduce((s, r) => s + parseFloat(r.pf), 0) / sixMonthResults.length).toFixed(2);
  const avgRet = (sixMonthResults.reduce((s, r) => s + parseFloat(r.ret), 0) / sixMonthResults.length).toFixed(1);
  const worstWR = Math.min(...sixMonthResults.map(r => parseFloat(r.wr))).toFixed(1);
  const bestWR = Math.max(...sixMonthResults.map(r => parseFloat(r.wr))).toFixed(1);
  const allPositive = sixMonthResults.every(r => parseFloat(r.ret) > 0);

  console.log('  ' + '-'.repeat(130));
  console.log(`  SUMMARY: ${sixMonthResults.length} windows | Avg WR: ${avgWR}% | Avg PF: ${avgPF} | Avg Return: ${avgRet}%/window | WR Range: ${worstWR}-${bestWR}% | All Positive: ${allPositive ? 'YES' : 'NO'}`);
}

// ── Run 3-month windows ──────────────────────────────────────────────────────

console.log('\n' + '='.repeat(90));
console.log('  3-MONTH (QUARTERLY) WINDOWS');
console.log('='.repeat(90));
console.log(`\n  ${'Window'.padEnd(35)} ${'Days'.padStart(5)} ${'Trades'.padStart(7)} ${'Rate'.padStart(5)} ${'WR'.padStart(6)} ${'Avg%'.padStart(7)} ${'PF'.padStart(6)} ${'$Final'.padStart(8)} ${'Return'.padStart(8)} ${'MaxDD'.padStart(6)} ${'C-WR'.padStart(6)} ${'P-WR'.padStart(6)} ${'Sentiment'}`);
console.log('  ' + '-'.repeat(130));

const threeMonthResults = [];
for (const w of THREE_MONTH_WINDOWS) {
  process.stdout.write(`  Running ${w.label}...\r`);
  const r = await runWindow(w, optionsBars, allData);
  if (r) {
    threeMonthResults.push(r);
    console.log(`  ${r.label.padEnd(35)} ${r.days.toString().padStart(5)} ${r.trades.toString().padStart(7)} ${r.rate.padStart(5)} ${(r.wr + '%').padStart(6)} ${(r.avgPnl + '%').padStart(7)} ${r.pf.padStart(6)} $${r.final.padStart(7)} ${(r.ret + '%').padStart(8)} ${(r.mdd + '%').padStart(6)} ${(r.cWr + '%').padStart(6)} ${(r.pWr + '%').padStart(6)} ${r.sentimentNote}`);
  } else {
    console.log(`  ${w.label.padEnd(35)} — insufficient data`);
  }
}

if (threeMonthResults.length > 0) {
  const avgWR = (threeMonthResults.reduce((s, r) => s + parseFloat(r.wr), 0) / threeMonthResults.length).toFixed(1);
  const avgPF = (threeMonthResults.reduce((s, r) => s + parseFloat(r.pf), 0) / threeMonthResults.length).toFixed(2);
  const positiveWindows = threeMonthResults.filter(r => parseFloat(r.ret) > 0).length;
  const negativeWindows = threeMonthResults.filter(r => parseFloat(r.ret) < 0);
  const worstWindow = threeMonthResults.reduce((a, b) => parseFloat(a.ret) < parseFloat(b.ret) ? a : b);
  const bestWindow = threeMonthResults.reduce((a, b) => parseFloat(a.ret) > parseFloat(b.ret) ? a : b);

  console.log('  ' + '-'.repeat(130));
  console.log(`  SUMMARY: ${threeMonthResults.length} quarters | Avg WR: ${avgWR}% | Avg PF: ${avgPF}`);
  console.log(`  Positive: ${positiveWindows}/${threeMonthResults.length} | Best: ${bestWindow.label} (${bestWindow.ret}%) | Worst: ${worstWindow.label} (${worstWindow.ret}%)`);
  if (negativeWindows.length > 0) {
    console.log(`  Negative quarters: ${negativeWindows.map(w => `${w.label} (${w.ret}%)`).join(', ')}`);
  }
}

// ── Consistency check ────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(90));
console.log('  ROBUSTNESS SCORECARD');
console.log('='.repeat(90));

const allWindows = [...threeMonthResults];
if (allWindows.length > 0) {
  const profitable = allWindows.filter(r => parseFloat(r.ret) > 0).length;
  const aboveCoinFlip = allWindows.filter(r => parseFloat(r.wr) > 50).length;
  const pfAboveOne = allWindows.filter(r => parseFloat(r.pf) > 1).length;
  const putAboveCoinFlip = allWindows.filter(r => parseFloat(r.pWr) > 50).length;
  const worstDD = Math.max(...allWindows.map(r => parseFloat(r.mdd)));

  console.log(`\n  Windows tested:          ${allWindows.length}`);
  console.log(`  Profitable:              ${profitable}/${allWindows.length} (${(profitable/allWindows.length*100).toFixed(0)}%)`);
  console.log(`  WR > 50%:                ${aboveCoinFlip}/${allWindows.length} (${(aboveCoinFlip/allWindows.length*100).toFixed(0)}%)`);
  console.log(`  PF > 1.0:                ${pfAboveOne}/${allWindows.length} (${(pfAboveOne/allWindows.length*100).toFixed(0)}%)`);
  console.log(`  PUT WR > 50%:            ${putAboveCoinFlip}/${allWindows.length} (${(putAboveCoinFlip/allWindows.length*100).toFixed(0)}%)`);
  console.log(`  Worst single-window DD:  ${worstDD.toFixed(1)}%`);
  console.log(`  Verdict:                 ${profitable >= allWindows.length * 0.8 && pfAboveOne >= allWindows.length * 0.7 ? 'ROBUST' : 'NEEDS WORK'}`);
}

// ── SPREAD + TRAILING STOP REGIME COMPARISON ──────────────────────────────────

console.log('\n' + '='.repeat(90));
console.log('  TRAILING STOP vs FIXED TARGET — Per-regime with $0.02/side spread');
console.log('  Trail: -3% init, BE@+2%, trail@+3% keep 60%');
console.log('='.repeat(90));

const allWindowResults = [...sixMonthResults, ...threeMonthResults].filter(r => r);

// Run 3-month windows side by side
console.log(`\n  3-MONTH WINDOWS — FIXED +5/-3 with $0.02 spread vs TRAILING STOP with $0.02 spread:`);
console.log('  ' + '-'.repeat(120));
console.log(`  ${'Window'.padEnd(30)} ${'--- Fixed +5/-3 + spread ---'.padStart(40)} ${''.padStart(5)} ${'--- Trailing + spread ---'.padStart(40)}`);
console.log(`  ${''.padEnd(30)} ${'WR'.padStart(7)} ${'PF'.padStart(6)} ${'C-WR'.padStart(7)} ${'P-WR'.padStart(7)} ${'$Final'.padStart(8)}  ${'WR'.padStart(7)} ${'PF'.padStart(6)} ${'C-WR'.padStart(7)} ${'P-WR'.padStart(7)} ${'$Final'.padStart(8)}`);
console.log('  ' + '-'.repeat(120));

const fixedResults3M = [];
const trailResults3M = [];

for (const wr of threeMonthResults) {
  if (!wr?.rawResults?.length) continue;
  const f = evalTrades(wr.rawResults, t => resimFixed(t, SPREAD_HS));
  const tr = evalTrades(wr.rawResults, t => resimTrailing(t, SPREAD_HS));
  fixedResults3M.push({ ...f, label: wr.label });
  trailResults3M.push({ ...tr, label: wr.label });

  console.log(`  ${wr.label.padEnd(30)} ${(f.wr.toFixed(1) + '%').padStart(7)} ${(f.pf.toFixed(2)).padStart(6)} ${(f.cWr.toFixed(1) + '%').padStart(7)} ${(f.pWr.toFixed(1) + '%').padStart(7)} $${f.final.toFixed(0).padStart(7)}  ${(tr.wr.toFixed(1) + '%').padStart(7)} ${(tr.pf.toFixed(2)).padStart(6)} ${(tr.cWr.toFixed(1) + '%').padStart(7)} ${(tr.pWr.toFixed(1) + '%').padStart(7)} $${tr.final.toFixed(0).padStart(7)}`);
}

// Summary
if (fixedResults3M.length > 0) {
  console.log('  ' + '-'.repeat(120));

  const fProfitable = fixedResults3M.filter(r => r.ret > 0).length;
  const tProfitable = trailResults3M.filter(r => r.ret > 0).length;
  const fAvgWR = fixedResults3M.reduce((s, r) => s + r.wr, 0) / fixedResults3M.length;
  const tAvgWR = trailResults3M.reduce((s, r) => s + r.wr, 0) / trailResults3M.length;
  const fAvgPF = fixedResults3M.reduce((s, r) => s + Math.min(r.pf, 10), 0) / fixedResults3M.length;
  const tAvgPF = trailResults3M.reduce((s, r) => s + Math.min(r.pf, 10), 0) / trailResults3M.length;
  const fPutAbove50 = fixedResults3M.filter(r => r.pWr > 50).length;
  const tPutAbove50 = trailResults3M.filter(r => r.pWr > 50).length;
  const fWorstDD = Math.max(...fixedResults3M.map(r => r.mdd));
  const tWorstDD = Math.max(...trailResults3M.map(r => r.mdd));

  console.log(`\n  ROBUSTNESS SCORECARD — Fixed vs Trailing (with $0.02/side spread):`);
  console.log('  ' + '-'.repeat(55));
  console.log(`  ${'Metric'.padEnd(30)} ${'Fixed'.padStart(12)} ${'Trailing'.padStart(12)}`);
  console.log('  ' + '-'.repeat(55));
  console.log(`  ${'Avg WR'.padEnd(30)} ${(fAvgWR.toFixed(1) + '%').padStart(12)} ${(tAvgWR.toFixed(1) + '%').padStart(12)}`);
  console.log(`  ${'Avg PF'.padEnd(30)} ${fAvgPF.toFixed(2).padStart(12)} ${tAvgPF.toFixed(2).padStart(12)}`);
  console.log(`  ${'Profitable windows'.padEnd(30)} ${(fProfitable + '/' + fixedResults3M.length).padStart(12)} ${(tProfitable + '/' + trailResults3M.length).padStart(12)}`);
  console.log(`  ${'PUT WR > 50% windows'.padEnd(30)} ${(fPutAbove50 + '/' + fixedResults3M.length).padStart(12)} ${(tPutAbove50 + '/' + trailResults3M.length).padStart(12)}`);
  console.log(`  ${'Worst single-window DD'.padEnd(30)} ${(fWorstDD.toFixed(1) + '%').padStart(12)} ${(tWorstDD.toFixed(1) + '%').padStart(12)}`);

  const trailWins = trailResults3M.filter((t, i) => t.ret > fixedResults3M[i].ret).length;
  console.log(`  ${'Trail beats Fixed'.padEnd(30)} ${(trailWins + '/' + trailResults3M.length + ' windows').padStart(12)}`);

  const verdict = tProfitable >= trailResults3M.length * 0.8 && tAvgPF >= 1.5 ? 'ROBUST' :
                  tProfitable >= trailResults3M.length * 0.6 && tAvgPF >= 1.0 ? 'VIABLE' : 'NEEDS WORK';
  console.log(`\n  Trailing stop verdict: ${verdict}`);
}

console.log('\n' + '='.repeat(90));
process.exit(0);

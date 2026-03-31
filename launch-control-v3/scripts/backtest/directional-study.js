/**
 * Directional Study — Raw Price Movement Analysis
 *
 * Studies directional accuracy of signals INDEPENDENT of the option PnL model.
 * For each signal, tracks raw underlying price movement after entry at multiple
 * time horizons.
 *
 * Purpose: Answer "when this strategy fires a signal, does price actually move
 * in the predicted direction?" separately from "did the option trade make money?"
 */

const TIME_HORIZONS = [5, 10, 15, 30, 45, 60, 90, 120];
const HORIZON_LABELS = TIME_HORIZONS.map(m => `${m}min`);
const CAPTURE_THRESHOLD_ATR = 0.3;

// Directional correctness: did price ever move >= $0.05 in our direction?
// Simple, clear, binary. Measured using bar high (CALL) or bar low (PUT).
// On stocks at $100-500, $0.05 is noise. This intentionally sets a LOW bar --
// it identifies signals that were immediately and totally wrong (price never
// went even $0.05 our way). Strategies should aim for 90%+ on this metric.
const DIRECTIONAL_THRESHOLD_DOLLARS = 0.05;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Determine if a date falls within EDT (Eastern Daylight Time).
 */
function isEDT(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // Second Sunday of March
  let secondSunMar = 8;
  while (new Date(y, 2, secondSunMar).getDay() !== 0) secondSunMar++;
  // First Sunday of November
  let firstSunNov = 1;
  while (new Date(y, 10, firstSunNov).getDay() !== 0) firstSunNov++;
  const mmdd = m * 100 + d;
  return mmdd >= (300 + secondSunMar) && mmdd < (1100 + firstSunNov);
}

/**
 * Get RTH (Regular Trading Hours) UTC time boundaries for a given date.
 */
function getRTHBounds(dateStr) {
  return isEDT(dateStr)
    ? { start: '13:30', end: '20:00' }
    : { start: '14:30', end: '21:00' };
}

/**
 * Get sorted minute bar keys for a ticker on a given date within RTH.
 */
function getMinuteKeys(minuteBars, ticker, date) {
  const tickerMinutes = minuteBars[ticker] || {};
  const { start, end } = getRTHBounds(date);
  const rthStart = `${date}T${start}`;
  const rthEnd = `${date}T${end}`;
  return Object.keys(tickerMinutes)
    .filter(k => k >= rthStart && k <= rthEnd)
    .sort();
}

/**
 * Parse a minute-bar time key into a Date.
 * Keys look like '2026-03-15T14:45' — append ':00Z' for proper UTC parsing.
 */
function parseTimeKey(key) {
  const raw = key.length <= 16 ? key + ':00Z' : key;
  return new Date(raw);
}

/**
 * Compute median of a numeric array.
 */
function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ── Core Study ───────────────────────────────────────────────────────────────

/**
 * Run directional study across all signals.
 *
 * @param {Object[]} signals - Array of signal objects from strategy generation
 * @param {Object} minuteBars - minuteBars[ticker][timeKey] = { o, h, l, c, v }
 * @param {Object} etfMinuteBars - same structure, but for ETFs (SPY, etc.)
 * @returns {Object[]} Array of per-strategy result objects
 */
export function runDirectionalStudy(signals, minuteBars, etfMinuteBars) {
  if (!signals || signals.length === 0) return [];

  console.log(`[DIRECTIONAL] Analyzing ${signals.length} signals across ${TIME_HORIZONS.length} time horizons...`);

  // Group signals by strategy
  const byStrategy = {};
  for (const sig of signals) {
    const strat = sig.strategy || 'UNKNOWN';
    if (!byStrategy[strat]) byStrategy[strat] = [];
    byStrategy[strat].push(sig);
  }

  const results = [];

  for (const [stratName, stratSignals] of Object.entries(byStrategy)) {
    const result = analyzeStrategy(stratName, stratSignals, minuteBars, etfMinuteBars);
    results.push(result);
  }

  // Log summary
  for (const r of results) {
    console.log(
      `[DIRECTIONAL] ${r.strategyName}: ${r.totalSignals} sigs | ` +
      `directional=${r.directionalAccuracy}% (${r.directionalCorrectCount}/${r.totalSignals} moved $0.05+) | ` +
      `MFE/MAE=${r.mfeMaeRatio.toFixed(2)} | ` +
      `capture=${(r.captureRate * 100).toFixed(0)}%`
    );
  }

  return results;
}

/**
 * Analyze a single strategy's signals for directional accuracy.
 */
function analyzeStrategy(stratName, signals, minuteBars, etfMinuteBars) {
  const signalDetails = [];

  // Per-horizon accumulators
  const horizonCorrect = {};
  const horizonTotal = {};
  const horizonMoves = {};  // in ATR units
  for (const label of HORIZON_LABELS) {
    horizonCorrect[label] = 0;
    horizonTotal[label] = 0;
    horizonMoves[label] = [];
  }

  // MFE / MAE accumulators
  const mfeValues = [];     // in ATR
  const maeValues = [];     // in ATR (positive = adverse)
  const mfeMinutes = [];    // time to MFE
  let captureCount = 0;
  let directionalCorrectCount = 0;

  for (const sig of signals) {
    const detail = analyzeSignal(sig, minuteBars, etfMinuteBars);
    if (!detail) continue;

    signalDetails.push(detail);

    // Aggregate horizon data
    for (const label of HORIZON_LABELS) {
      const move = detail.moves[label];
      if (move !== null && move !== undefined) {
        horizonTotal[label]++;
        horizonMoves[label].push(move);
        if (move > 0) horizonCorrect[label]++;
      }
    }

    // MFE / MAE
    if (detail.mfe !== null) {
      mfeValues.push(detail.mfe);
      mfeMinutes.push(detail.mfeMinutes);
    }
    if (detail.mae !== null) {
      maeValues.push(Math.abs(detail.mae));
    }

    // Capture rate: did price move > threshold ATR in the right direction at any point?
    if (detail.mfe !== null && detail.mfe >= CAPTURE_THRESHOLD_ATR) {
      captureCount++;
    }

    // Directional correctness: any bar moved >= $0.05 in trade direction
    if (detail.directionallyCorrect) {
      directionalCorrectCount++;
    }
  }

  // Build direction accuracy
  const directionAccuracy = {};
  for (const label of HORIZON_LABELS) {
    directionAccuracy[label] = {
      correct: horizonCorrect[label],
      total: horizonTotal[label],
      pct: horizonTotal[label] > 0
        ? parseFloat((horizonCorrect[label] / horizonTotal[label] * 100).toFixed(1))
        : 0,
    };
  }

  // Average move in ATR at each horizon
  const avgMoveATR = {};
  for (const label of HORIZON_LABELS) {
    const moves = horizonMoves[label];
    avgMoveATR[label] = moves.length > 0
      ? parseFloat((moves.reduce((a, b) => a + b, 0) / moves.length).toFixed(3))
      : 0;
  }

  // MFE stats
  const mfeStats = {
    avgATR: mfeValues.length > 0
      ? parseFloat((mfeValues.reduce((a, b) => a + b, 0) / mfeValues.length).toFixed(3))
      : 0,
    avgMinutesToMFE: mfeMinutes.length > 0
      ? Math.round(mfeMinutes.reduce((a, b) => a + b, 0) / mfeMinutes.length)
      : 0,
    medianATR: parseFloat(median(mfeValues).toFixed(3)),
  };

  // MAE stats
  const maeStats = {
    avgATR: maeValues.length > 0
      ? parseFloat((maeValues.reduce((a, b) => a + b, 0) / maeValues.length).toFixed(3))
      : 0,
    medianATR: parseFloat(median(maeValues).toFixed(3)),
  };

  // MFE / MAE ratio
  const mfeMaeRatio = maeStats.avgATR > 0
    ? parseFloat((mfeStats.avgATR / maeStats.avgATR).toFixed(2))
    : (mfeStats.avgATR > 0 ? 999 : 0);

  // Capture rate
  const captureRate = signalDetails.length > 0
    ? parseFloat((captureCount / signalDetails.length).toFixed(3))
    : 0;

  // Directional accuracy: % of signals where price moved >= $0.05 in trade direction
  const directionalAccuracy = signalDetails.length > 0
    ? parseFloat((directionalCorrectCount / signalDetails.length * 100).toFixed(1))
    : 0;

  return {
    strategyName: stratName,
    totalSignals: signalDetails.length,
    directionalAccuracy,     // PRIMARY metric: % where any bar moved $0.05+ in our direction
    directionalCorrectCount,
    directionByHorizon: directionAccuracy,  // secondary: time-horizon breakdown
    avgMoveATR,
    mfeStats,
    maeStats,
    mfeMaeRatio,
    captureRate,
    signalDetails,
  };
}

/**
 * Analyze a single signal's directional outcome.
 *
 * @returns {Object|null} Signal detail object, or null if no data available
 */
function analyzeSignal(sig, minuteBars, etfMinuteBars) {
  const ticker = sig.ticker;
  const date = sig.date;
  const entryPrice = sig.entryPrice;
  const direction = sig.direction; // 'CALL' or 'PUT'

  if (!ticker || !date || !entryPrice || !direction) return null;

  // Dollar ATR for normalization
  const atrPct = sig.atr || 0.025;
  const dollarATR = atrPct * entryPrice;
  if (dollarATR <= 0) return null;

  const mult = direction === 'CALL' ? 1 : -1;
  const maxHold = sig.maxHoldMinutes || 120;

  // Get all minute keys for this ticker on this date
  const allKeys = getMinuteKeys(minuteBars, ticker, date);
  if (allKeys.length === 0) return null;

  const tickerMinutes = minuteBars[ticker] || {};

  // Find entry time index
  const entryTime = sig.time;
  let entryIdx = -1;
  for (let i = 0; i < allKeys.length; i++) {
    if (allKeys[i] >= entryTime) {
      entryIdx = i;
      break;
    }
  }
  if (entryIdx < 0) return null;

  const entryTimeMs = parseTimeKey(allKeys[entryIdx]).getTime();

  // Scan forward from entry, bounded by maxHoldMinutes and available bars
  let mfe = 0;        // best move in signal direction (ATR units)
  let mae = 0;        // worst move against signal direction (ATR units, negative)
  let mfeMinutes = 0;
  const movesByHorizon = {};
  for (const label of HORIZON_LABELS) {
    movesByHorizon[label] = null;
  }

  // Track which horizons we've filled
  const horizonMinutes = [...TIME_HORIZONS];
  let nextHorizonIdx = 0;

  for (let i = entryIdx + 1; i < allKeys.length; i++) {
    const key = allKeys[i];
    const bar = tickerMinutes[key];
    if (!bar) continue;

    const barTimeMs = parseTimeKey(key).getTime();
    const minutesAfterEntry = (barTimeMs - entryTimeMs) / 60000;

    // Stop if we've exceeded the hold window
    if (minutesAfterEntry > maxHold) break;

    // Directional move for this bar (using close for horizons, high/low for MFE/MAE)
    const closeMove = ((bar.c - entryPrice) * mult) / dollarATR;

    // MFE: best favorable move using high (CALL) or low (PUT)
    const favPrice = direction === 'CALL' ? bar.h : bar.l;
    const favMove = ((favPrice - entryPrice) * mult) / dollarATR;
    if (favMove > mfe) {
      mfe = favMove;
      mfeMinutes = Math.round(minutesAfterEntry);
    }

    // MAE: worst adverse move using low (CALL) or high (PUT)
    const advPrice = direction === 'CALL' ? bar.l : bar.h;
    const advMove = ((advPrice - entryPrice) * mult) / dollarATR;
    if (advMove < mae) {
      mae = advMove;
    }

    // Fill horizon slots
    while (nextHorizonIdx < horizonMinutes.length &&
           minutesAfterEntry >= horizonMinutes[nextHorizonIdx]) {
      const label = `${horizonMinutes[nextHorizonIdx]}min`;
      movesByHorizon[label] = parseFloat(closeMove.toFixed(3));
      nextHorizonIdx++;
    }
  }

  // If we ran out of bars before filling all horizons, leave remaining as null

  // SPY correlation at time of MFE
  let spyMoveAtMFE = null;
  if (mfeMinutes > 0 && etfMinuteBars) {
    const spyKeys = getMinuteKeys(etfMinuteBars, 'SPY', date);
    const spyMinutes = etfMinuteBars['SPY'] || {};

    if (spyKeys.length > 0) {
      // Find SPY bar at entry time
      let spyEntryIdx = -1;
      for (let i = 0; i < spyKeys.length; i++) {
        if (spyKeys[i] >= entryTime) {
          spyEntryIdx = i;
          break;
        }
      }

      if (spyEntryIdx >= 0) {
        const spyEntry = spyMinutes[spyKeys[spyEntryIdx]];
        // Find SPY bar approximately mfeMinutes after entry
        const targetMs = entryTimeMs + mfeMinutes * 60000;
        let spyMfeBar = null;
        for (let i = spyEntryIdx; i < spyKeys.length; i++) {
          const barMs = parseTimeKey(spyKeys[i]).getTime();
          if (barMs >= targetMs) {
            spyMfeBar = spyMinutes[spyKeys[i]];
            break;
          }
        }

        if (spyEntry && spyMfeBar) {
          const spyEntryPrice = spyEntry.c;
          const spyDollarATR = (atrPct * spyEntryPrice); // rough estimate
          if (spyDollarATR > 0) {
            spyMoveAtMFE = parseFloat(
              (((spyMfeBar.c - spyEntryPrice) * mult) / spyDollarATR).toFixed(3)
            );
          }
        }
      }
    }
  }

  // MFE/MAE in dollar terms (not ATR-normalized)
  const mfeDollars = parseFloat((mfe * dollarATR).toFixed(2));
  const maeDollars = parseFloat((Math.abs(mae) * dollarATR).toFixed(2));

  // Directional correctness: did price ever move >= $0.05 in our direction?
  const directionallyCorrect = mfeDollars >= DIRECTIONAL_THRESHOLD_DOLLARS;

  return {
    ticker,
    date,
    direction,
    entryPrice,
    moves: movesByHorizon,
    mfe: parseFloat(mfe.toFixed(3)),
    mae: parseFloat(mae.toFixed(3)),
    mfeDollars,
    maeDollars,
    directionallyCorrect,
    mfeMinutes,
    spyMoveAtMFE,
  };
}

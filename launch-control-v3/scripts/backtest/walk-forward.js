/**
 * Walk-Forward Validation
 *
 * Splits historical signals into sequential train/test windows and measures
 * out-of-sample degradation. If the strategy is overfit to the backtest
 * period, the test windows will show significantly worse performance.
 *
 * Method: Anchored walk-forward
 *   Window 1: Train days 1-10, Test days 11-14
 *   Window 2: Train days 1-14, Test days 15-18
 *   Window 3: Train days 1-18, Test days 19-22
 *   etc.
 *
 * Measures:
 *   - In-sample vs out-of-sample win rate
 *   - In-sample vs out-of-sample avg P&L
 *   - Degradation ratio (OOS / IS metric)
 *   - Consistency across windows
 */

const TEST_WINDOW_DAYS = 4;  // test on 4 days per window
const MIN_SIGNALS_PER_WINDOW = 5;

function mean(arr) {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function winRate(signals) {
  if (signals.length === 0) return 0;
  return (signals.filter(s => s.pnlDollars > 0).length / signals.length) * 100;
}

function totalPnl(signals) {
  return signals.reduce((a, b) => a + b.pnlDollars, 0);
}

function avgPnl(signals) {
  return signals.length > 0 ? totalPnl(signals) / signals.length : 0;
}

function profitFactor(signals) {
  const wins = signals.filter(s => s.pnlDollars > 0).reduce((a, b) => a + b.pnlDollars, 0);
  const losses = Math.abs(signals.filter(s => s.pnlDollars < 0).reduce((a, b) => a + b.pnlDollars, 0));
  return losses > 0 ? wins / losses : (wins > 0 ? 999 : 0);
}

/**
 * Run walk-forward validation on backtest results.
 * @param {Object} backtestResults - Full backtest results with signals array
 * @returns {Object} Walk-forward analysis
 */
export function runWalkForward(backtestResults) {
  const signals = backtestResults.signals || [];
  if (signals.length < 20) {
    return { error: 'Not enough signals for walk-forward (need 20+)', signalCount: signals.length };
  }

  // Get sorted unique dates
  const dates = [...new Set(signals.map(s => s.date))].sort();
  if (dates.length < 8) {
    return { error: 'Not enough trading days for walk-forward (need 8+)', tradingDays: dates.length };
  }

  // Group signals by date
  const byDate = {};
  for (const s of signals) {
    if (!byDate[s.date]) byDate[s.date] = [];
    byDate[s.date].push(s);
  }

  // ── Anchored walk-forward windows ──────────────────────────────────────
  const windows = [];
  const minTrainDays = Math.max(4, Math.floor(dates.length * 0.4));

  for (let testStart = minTrainDays; testStart + TEST_WINDOW_DAYS <= dates.length; testStart += TEST_WINDOW_DAYS) {
    const trainDates = dates.slice(0, testStart);
    const testDates = dates.slice(testStart, testStart + TEST_WINDOW_DAYS);

    const trainSet = new Set(trainDates);
    const testSet = new Set(testDates);
    const trainSignals = signals.filter(s => trainSet.has(s.date));
    const testSignals = signals.filter(s => testSet.has(s.date));

    if (trainSignals.length < MIN_SIGNALS_PER_WINDOW || testSignals.length < MIN_SIGNALS_PER_WINDOW) continue;

    windows.push({
      window: windows.length + 1,
      trainPeriod: `${trainDates[0]} to ${trainDates[trainDates.length - 1]}`,
      testPeriod: `${testDates[0]} to ${testDates[testDates.length - 1]}`,
      trainDays: trainDates.length,
      testDays: testDates.length,
      train: {
        signals: trainSignals.length,
        winRate: parseFloat(winRate(trainSignals).toFixed(1)),
        avgPnl: Math.round(avgPnl(trainSignals)),
        totalPnl: Math.round(totalPnl(trainSignals)),
        profitFactor: parseFloat(profitFactor(trainSignals).toFixed(2)),
      },
      test: {
        signals: testSignals.length,
        winRate: parseFloat(winRate(testSignals).toFixed(1)),
        avgPnl: Math.round(avgPnl(testSignals)),
        totalPnl: Math.round(totalPnl(testSignals)),
        profitFactor: parseFloat(profitFactor(testSignals).toFixed(2)),
      },
    });
  }

  if (windows.length === 0) {
    return { error: 'Could not create walk-forward windows', tradingDays: dates.length };
  }

  // ── Compute degradation metrics ────────────────────────────────────────
  const trainWRs = windows.map(w => w.train.winRate);
  const testWRs = windows.map(w => w.test.winRate);
  const trainAvgPnls = windows.map(w => w.train.avgPnl);
  const testAvgPnls = windows.map(w => w.test.avgPnl);
  const trainPFs = windows.map(w => w.train.profitFactor);
  const testPFs = windows.map(w => w.test.profitFactor);

  const avgTrainWR = mean(trainWRs);
  const avgTestWR = mean(testWRs);
  const avgTrainPnl = mean(trainAvgPnls);
  const avgTestPnl = mean(testAvgPnls);
  const avgTrainPF = mean(trainPFs.filter(p => p < 900));
  const avgTestPF = mean(testPFs.filter(p => p < 900));

  // Degradation ratio: test / train (1.0 = no degradation, <1.0 = overfit)
  const wrDegradation = avgTrainWR > 0 ? avgTestWR / avgTrainWR : 0;
  const pnlDegradation = avgTrainPnl !== 0 ? avgTestPnl / avgTrainPnl : 0;

  // Consistency: how many test windows were profitable?
  const profitableWindows = windows.filter(w => w.test.totalPnl > 0).length;
  const consistency = windows.length > 0 ? (profitableWindows / windows.length) * 100 : 0;

  // ── Rolling out-of-sample equity curve ─────────────────────────────────
  let cumOOS = 0;
  const oosCurve = windows.map(w => {
    cumOOS += w.test.totalPnl;
    return { window: w.window, period: w.testPeriod, pnl: w.test.totalPnl, cumPnl: cumOOS };
  });

  // ── Grade-level walk-forward ───────────────────────────────────────────
  const grades = ['A+', 'A', 'A-', 'B+', 'B'];
  const byGrade = {};
  for (const g of grades) {
    const gSignals = signals.filter(s => s.grade === g);
    if (gSignals.length < 10) continue;

    const gDates = [...new Set(gSignals.map(s => s.date))].sort();
    const mid = Math.floor(gDates.length / 2);
    if (mid < 2) continue;

    const firstHalfDates = new Set(gDates.slice(0, mid));
    const firstHalf = gSignals.filter(s => firstHalfDates.has(s.date));
    const secondHalf = gSignals.filter(s => !firstHalfDates.has(s.date));

    byGrade[g] = {
      firstHalf: {
        signals: firstHalf.length,
        winRate: parseFloat(winRate(firstHalf).toFixed(1)),
        avgPnl: Math.round(avgPnl(firstHalf)),
      },
      secondHalf: {
        signals: secondHalf.length,
        winRate: parseFloat(winRate(secondHalf).toFixed(1)),
        avgPnl: Math.round(avgPnl(secondHalf)),
      },
      stable: Math.abs(winRate(firstHalf) - winRate(secondHalf)) < 10,
    };
  }

  // ── Verdict ────────────────────────────────────────────────────────────
  let verdict, verdictDetail;
  if (wrDegradation >= 0.85 && consistency >= 60 && avgTestPnl > 0) {
    verdict = 'ROBUST';
    verdictDetail = 'Out-of-sample performance holds up. Strategy likely has real edge.';
  } else if (wrDegradation >= 0.70 && consistency >= 40) {
    verdict = 'MODERATE';
    verdictDetail = 'Some degradation in OOS. Edge exists but may be partially curve-fit.';
  } else {
    verdict = 'FRAGILE';
    verdictDetail = 'Significant OOS degradation. High risk of overfitting.';
  }

  return {
    windows,
    summary: {
      totalWindows: windows.length,
      avgTrainWinRate: parseFloat(avgTrainWR.toFixed(1)),
      avgTestWinRate: parseFloat(avgTestWR.toFixed(1)),
      winRateDegradation: parseFloat(wrDegradation.toFixed(2)),
      avgTrainPnl: Math.round(avgTrainPnl),
      avgTestPnl: Math.round(avgTestPnl),
      pnlDegradation: parseFloat(pnlDegradation.toFixed(2)),
      avgTrainPF: parseFloat(avgTrainPF.toFixed(2)),
      avgTestPF: parseFloat(avgTestPF.toFixed(2)),
      profitableWindows,
      consistency: parseFloat(consistency.toFixed(1)),
      verdict,
      verdictDetail,
    },
    oosCurve,
    byGrade,
  };
}

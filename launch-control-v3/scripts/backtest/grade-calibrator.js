/**
 * Grade Calibrator
 *
 * Derives per-strategy grade thresholds from actual backtest performance.
 * Instead of one universal grade mapping (95/90/84/74/60), each strategy
 * gets thresholds calibrated to where its win rate and profit factor
 * actually cross grade-worthy levels.
 *
 * Algorithm:
 * 1. Collect all (confidence, win/loss, pnl) tuples for the strategy
 * 2. Sliding windows of width 8, step 2 across confidence range
 * 3. Find thresholds where win rate and PF cross grade-worthy levels
 * 4. Bayesian smoothing with universal priors (prior weight = 20 equivalent signals)
 * 5. Enforce monotonicity (higher grade must have better outcomes)
 */

const UNIVERSAL_THRESHOLDS = {
  'A+': 95,
  'A':  90,
  'A-': 84,
  'B+': 74,
  'B':  60,
};

const GRADE_PERFORMANCE_TARGETS = {
  'A+': { winRate: 65, profitFactor: 2.0 },
  'A':  { winRate: 58, profitFactor: 1.6 },
  'A-': { winRate: 52, profitFactor: 1.3 },
  'B+': { winRate: 45, profitFactor: 1.1 },
  'B':  { winRate: 35, profitFactor: 0.8 },
};

const MIN_SIGNALS_FOR_CALIBRATION = 15;
const PRIOR_WEIGHT = 20;
const WINDOW_WIDTH = 8;
const WINDOW_STEP = 2;

/**
 * Calibrate grade thresholds for a specific strategy.
 *
 * @param {string} strategyName
 * @param {Array} signals - Array with { composite, pnlDollars } fields
 * @returns {Object} { thresholds, performanceAtGrade, monotonic, calibrationQuality, sampleSize }
 */
export function calibrateGrades(strategyName, signals) {
  if (!signals || signals.length < MIN_SIGNALS_FOR_CALIBRATION) {
    return {
      thresholds: { ...UNIVERSAL_THRESHOLDS },
      performanceAtGrade: {},
      monotonic: true,
      calibrationQuality: 'UNCALIBRATED',
      sampleSize: signals ? signals.length : 0,
    };
  }

  const tuples = signals
    .filter(s => s.composite != null && s.pnlDollars != null)
    .map(s => ({
      confidence: s.composite,
      won: s.pnlDollars > 0,
      pnl: s.pnlDollars,
    }))
    .sort((a, b) => a.confidence - b.confidence);

  if (tuples.length < MIN_SIGNALS_FOR_CALIBRATION) {
    return {
      thresholds: { ...UNIVERSAL_THRESHOLDS },
      performanceAtGrade: {},
      monotonic: true,
      calibrationQuality: 'UNCALIBRATED',
      sampleSize: tuples.length,
    };
  }

  // Sliding window analysis across confidence range
  const windowResults = [];
  const minConf = Math.min(...tuples.map(t => t.confidence));
  const maxConf = Math.max(...tuples.map(t => t.confidence));

  for (let center = minConf; center <= maxConf; center += WINDOW_STEP) {
    const low = center - WINDOW_WIDTH / 2;
    const high = center + WINDOW_WIDTH / 2;
    const windowTuples = tuples.filter(t => t.confidence >= low && t.confidence <= high);

    if (windowTuples.length < 3) continue;

    const wins = windowTuples.filter(t => t.won).length;
    const n = windowTuples.length;
    const grossWin = windowTuples.filter(t => t.won).reduce((a, t) => a + t.pnl, 0);
    const grossLoss = Math.abs(windowTuples.filter(t => !t.won).reduce((a, t) => a + t.pnl, 0));

    // Bayesian smoothing with universal priors
    const priorWR = 0.45;
    const priorPF = 1.0;
    const smoothedWR = ((wins + PRIOR_WEIGHT * priorWR) / (n + PRIOR_WEIGHT)) * 100;
    const smoothedPF = grossLoss > 0
      ? (grossWin + PRIOR_WEIGHT * priorPF) / (grossLoss + PRIOR_WEIGHT)
      : grossWin > 0 ? 999 : priorPF;

    windowResults.push({
      center,
      winRate: smoothedWR,
      profitFactor: smoothedPF,
      sampleSize: n,
    });
  }

  if (windowResults.length < 3) {
    return {
      thresholds: { ...UNIVERSAL_THRESHOLDS },
      performanceAtGrade: {},
      monotonic: true,
      calibrationQuality: 'UNCALIBRATED',
      sampleSize: tuples.length,
    };
  }

  // Find thresholds where performance crosses grade-worthy levels
  const calibrated = {};
  const performanceAtGrade = {};
  const gradeOrder = ['B', 'B+', 'A-', 'A', 'A+'];

  for (const grade of gradeOrder) {
    const target = GRADE_PERFORMANCE_TARGETS[grade];
    let bestCenter = null;

    for (const wr of windowResults) {
      if (wr.winRate >= target.winRate && wr.profitFactor >= target.profitFactor) {
        bestCenter = wr.center;
        break;
      }
    }

    if (bestCenter != null) {
      calibrated[grade] = Math.round(bestCenter);
      const matchingWindow = windowResults.find(w => w.center === bestCenter);
      performanceAtGrade[grade] = {
        winRate: parseFloat(matchingWindow.winRate.toFixed(1)),
        profitFactor: parseFloat(matchingWindow.profitFactor.toFixed(2)),
        sampleSize: matchingWindow.sampleSize,
      };
    } else {
      calibrated[grade] = UNIVERSAL_THRESHOLDS[grade];
      performanceAtGrade[grade] = { winRate: null, profitFactor: null, sampleSize: 0 };
    }
  }

  // Enforce monotonicity: higher grade must require higher confidence
  const preMonotonic = checkNaturalMonotonicity(calibrated, gradeOrder);
  enforceMonotonicity(calibrated, gradeOrder);

  const totalSampleSize = tuples.length;
  let quality;
  if (totalSampleSize >= 50 && preMonotonic) quality = 'HIGH';
  else if (totalSampleSize >= 30) quality = 'MODERATE';
  else quality = 'LOW';

  return {
    thresholds: calibrated,
    performanceAtGrade,
    monotonic: preMonotonic,
    calibrationQuality: quality,
    sampleSize: totalSampleSize,
  };
}

/**
 * Apply a calibration to convert confidence score to grade string.
 *
 * @param {number} confidence
 * @param {Object} calibration - Result from calibrateGrades()
 * @returns {string} Grade string
 */
export function applyCalibration(confidence, calibration) {
  const t = calibration?.thresholds || UNIVERSAL_THRESHOLDS;
  if (confidence >= t['A+']) return 'A+';
  if (confidence >= t['A'])  return 'A';
  if (confidence >= t['A-']) return 'A-';
  if (confidence >= t['B+']) return 'B+';
  return 'B';
}

function enforceMonotonicity(thresholds, gradeOrder) {
  for (let i = 1; i < gradeOrder.length; i++) {
    const curr = gradeOrder[i];
    const prev = gradeOrder[i - 1];
    if (thresholds[curr] <= thresholds[prev]) {
      thresholds[curr] = thresholds[prev] + 2;
    }
  }
  for (const grade of gradeOrder) {
    thresholds[grade] = Math.max(55, Math.min(98, thresholds[grade]));
  }
}

function checkNaturalMonotonicity(thresholds, gradeOrder) {
  for (let i = 1; i < gradeOrder.length; i++) {
    if (thresholds[gradeOrder[i]] <= thresholds[gradeOrder[i - 1]]) {
      return false;
    }
  }
  return true;
}

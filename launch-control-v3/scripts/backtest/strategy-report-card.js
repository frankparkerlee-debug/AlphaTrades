/**
 * Strategy Report Card
 *
 * Assembles three-phase evaluation (setup, direction, exit) + validation
 * + calibration into one report per strategy.
 *
 * Three Phases:
 *   Phase 1 — Pre-Entry (Setup Quality): 0-100 from setup-quality.js
 *   Phase 2 — Post-Entry (Directional Edge): 0-100 from entry validation
 *   Phase 3 — Exit Quality: 0-100 from exit efficiency
 *
 * Produces a DEPLOY / REFINE / SHELVE verdict for each strategy.
 */

import { scoreSetupQuality } from './setup-quality.js';

// ── Phase Scorers ────────────────────────────────────────────────────────────

/**
 * Phase 2: Post-Entry Directional Edge (0-100)
 */
function scoreDirectionalEdge(signal, entryValidationSignal) {
  if (!entryValidationSignal) return null;

  let score = 0;

  // EOD direction correct: +40
  if (entryValidationSignal.dirCorrect) score += 40;

  // Ever moved favorably: +20
  if (entryValidationSignal.everFavorable) score += 20;

  // Max favorable >= 1 ATR (~2.5%): +20
  if (entryValidationSignal.maxFavPct >= 2.5) score += 20;

  // Max adverse < 0.5 ATR (~1.25%): +10
  if (Math.abs(entryValidationSignal.maxAdvPct || 0) < 1.25) score += 10;

  // Time-to-favorable approximation: if favorable and enough bars, +10
  if (entryValidationSignal.everFavorable && entryValidationSignal.barsAfter >= 30) {
    score += 10;
  }

  return Math.min(100, score);
}

/**
 * Phase 3: Exit Quality (0-100)
 *
 * Efficiency >= 75%: 90-100
 * Efficiency 50-75%: 65-89
 * Efficiency 25-50%: 35-64
 * Efficiency < 25%:  0-34
 * Alpha leakage penalty: -20 if MFE > 5% but trade lost
 */
export function scoreExitQuality(signal) {
  const eff = signal.exitEfficiency;
  if (eff == null) return null;

  let score;
  if (eff >= 0.75) score = 90 + Math.round((eff - 0.75) * 40);
  else if (eff >= 0.50) score = 65 + Math.round((eff - 0.50) * 96);
  else if (eff >= 0.25) score = 35 + Math.round((eff - 0.25) * 120);
  else score = Math.round(eff * 140);

  // Alpha leakage penalty
  if ((signal.mfePct || 0) > 5 && (signal.pnlDollars || 0) <= 0) {
    score -= 20;
  }

  return Math.max(0, Math.min(100, score));
}

// ── Report Card Builder ──────────────────────────────────────────────────────

/**
 * Build a full report card for a strategy.
 *
 * @param {string} strategyName
 * @param {Array} signals - Backtest result signals (with pnl, mfe, mae, metadata, etc.)
 * @param {Object} validation - Per-strategy validation results (MC, WF, OOS, stats, entry/exit)
 * @param {Object} entryValidation - Entry validation data ({ byStrategy, signals })
 * @param {Object} calibration - Grade calibration from calibrateGrades()
 * @returns {Object} Full report card
 */
export function buildReportCard(strategyName, signals, validation, entryValidation, calibration) {
  // Index entry validation signals for O(1) lookup
  const entrySignalMap = {};
  if (entryValidation?.signals) {
    for (const ev of entryValidation.signals) {
      const key = `${ev.ticker}:${ev.date}:${ev.strategy}`;
      entrySignalMap[key] = ev;
    }
  }

  // Score each signal across three phases
  const phaseScores = [];
  let setupTotal = 0, dirTotal = 0, exitTotal = 0;
  let setupCount = 0, dirCount = 0, exitCount = 0;
  let alphaLeakageCount = 0;

  for (const signal of signals) {
    // Phase 1: Setup Quality
    const setup = scoreSetupQuality(signal);

    // Phase 2: Directional Edge
    const evKey = `${signal.ticker}:${signal.date}:${signal.strategy}`;
    const evSignal = entrySignalMap[evKey];
    const dirScore = scoreDirectionalEdge(signal, evSignal);

    // Phase 3: Exit Quality
    const exitScore = scoreExitQuality(signal);

    if (setup.score != null) { setupTotal += setup.score; setupCount++; }
    if (dirScore != null) { dirTotal += dirScore; dirCount++; }
    if (exitScore != null) { exitTotal += exitScore; exitCount++; }

    if ((signal.mfePct || 0) > 5 && (signal.pnlDollars || 0) <= 0) {
      alphaLeakageCount++;
    }

    phaseScores.push({
      ticker: signal.ticker,
      date: signal.date,
      setup: setup.score,
      setupFactors: setup.factors,
      direction: dirScore,
      exit: exitScore,
      pnlDollars: signal.pnlDollars,
    });
  }

  const winnableCount = signals.filter(s => (s.mfePct || 0) > 5).length;
  const alphaLeakagePct = winnableCount > 0
    ? parseFloat((alphaLeakageCount / winnableCount * 100).toFixed(1))
    : 0;

  const dirCorrectPct = entryValidation?.byStrategy?.[strategyName]?.dirCorrectPct ?? null;

  // Per-strategy exit efficiency from validation
  const stratExitEff = validation?.entryExitQuality?.byStrategy?.[strategyName]?.avgEfficiency ?? null;

  return {
    strategy: strategyName,
    signalCount: signals.length,
    phases: {
      setup: {
        avgScore: setupCount > 0 ? Math.round(setupTotal / setupCount) : null,
        count: setupCount,
      },
      direction: {
        avgScore: dirCount > 0 ? Math.round(dirTotal / dirCount) : null,
        dirCorrectPct,
        count: dirCount,
      },
      exit: {
        avgScore: exitCount > 0 ? Math.round(exitTotal / exitCount) : null,
        avgEfficiency: stratExitEff,
        alphaLeakagePct,
        count: exitCount,
      },
    },
    calibration: calibration ? {
      thresholds: calibration.thresholds,
      quality: calibration.calibrationQuality,
      monotonic: calibration.monotonic,
      sampleSize: calibration.sampleSize,
    } : null,
    validation: {
      winRate: validation?.summary?.winRate,
      profitFactor: validation?.summary?.profitFactor,
      totalPnl: validation?.summary?.totalPnlDollars,
      monteCarlo: validation?.monteCarlo?.base?.probability?.profit ?? null,
      walkForward: validation?.walkForward?.verdict ?? null,
      outOfSample: validation?.outOfSample?.verdict ?? null,
      statisticalTests: {
        pValue: validation?.statisticalTests?.tTest?.pValue
          ?? validation?.statisticalTests?.pValue ?? null,
      },
    },
    signalDetails: phaseScores,
  };
}

// ── Deployment Verdict ───────────────────────────────────────────────────────

/**
 * Derive deployment verdict from a report card.
 *
 * Merits (positive):
 *   MC P(profit) >= 65%: +2
 *   Win rate >= 55%: +1
 *   PF >= 1.5: +2
 *   Walk-forward ROBUST: +2
 *   OOS ROBUST/PASS: +2
 *   t-test p < 0.05: +1
 *   Setup quality >= 70: +1
 *   Dir correct >= 60%: +1
 *   Exit efficiency >= 0.50: +1
 *   Calibration monotonic: +1
 *
 * Demerits (negative):
 *   MC P(profit) < 55%: +2
 *   Win rate < 40%: +1
 *   PF < 1.0: +2
 *   OOS OVERFIT/FAIL: +2
 *   Dir correct < 50%: +2
 *   Exit efficiency < 0.30: +1
 *   Alpha leakage > 40%: +1
 *
 * Net >= 3: DEPLOY | Net >= -1: REFINE | Net < -1: SHELVE
 * Hard gates -> SHELVE: PF < 0.8, WR < 30%, MC P(profit) < 40%
 */
export function deriveDeploymentVerdict(reportCard) {
  let merits = 0;
  let demerits = 0;
  const strengths = [];
  const weaknesses = [];
  const recommendations = [];

  const v = reportCard.validation;
  const p = reportCard.phases;

  // ── Merits ──
  if (v.monteCarlo != null && v.monteCarlo >= 65) {
    merits += 2;
    strengths.push(`MC P(profit)=${v.monteCarlo}% >= 65%`);
  }
  if (v.winRate != null && v.winRate >= 55) {
    merits += 1;
    strengths.push(`WR=${v.winRate}% >= 55%`);
  }
  if (v.profitFactor != null && v.profitFactor >= 1.5) {
    merits += 2;
    strengths.push(`PF=${v.profitFactor} >= 1.5`);
  }
  if (v.walkForward === 'ROBUST') {
    merits += 2;
    strengths.push('Walk-forward ROBUST');
  }
  if (v.outOfSample === 'ROBUST' || v.outOfSample === 'PASS') {
    merits += 2;
    strengths.push(`OOS ${v.outOfSample}`);
  }
  if (v.statisticalTests?.pValue != null && v.statisticalTests.pValue < 0.05) {
    merits += 1;
    strengths.push(`t-test p=${v.statisticalTests.pValue.toFixed(3)} < 0.05`);
  }
  if (p.setup.avgScore != null && p.setup.avgScore >= 70) {
    merits += 1;
    strengths.push(`Setup quality=${p.setup.avgScore} >= 70`);
  }
  if (p.direction.dirCorrectPct != null && p.direction.dirCorrectPct >= 60) {
    merits += 1;
    strengths.push(`Dir correct=${p.direction.dirCorrectPct}% >= 60%`);
  }
  if (p.exit.avgEfficiency != null && p.exit.avgEfficiency >= 0.50) {
    merits += 1;
    strengths.push(`Exit eff=${(p.exit.avgEfficiency * 100).toFixed(0)}% >= 50%`);
  }
  if (reportCard.calibration?.monotonic) {
    merits += 1;
    strengths.push('Calibration monotonic');
  }

  // ── Demerits ──
  if (v.monteCarlo != null && v.monteCarlo < 55) {
    demerits += 2;
    weaknesses.push(`MC P(profit)=${v.monteCarlo}% < 55%`);
  }
  if (v.winRate != null && v.winRate < 40) {
    demerits += 1;
    weaknesses.push(`WR=${v.winRate}% < 40%`);
  }
  if (v.profitFactor != null && v.profitFactor < 1.0) {
    demerits += 2;
    weaknesses.push(`PF=${v.profitFactor} < 1.0`);
  }
  if (v.outOfSample === 'OVERFIT' || v.outOfSample === 'FAIL') {
    demerits += 2;
    weaknesses.push(`OOS ${v.outOfSample}`);
  }
  if (p.direction.dirCorrectPct != null && p.direction.dirCorrectPct < 50) {
    demerits += 2;
    weaknesses.push(`Dir correct=${p.direction.dirCorrectPct}% < 50%`);
  }
  if (p.exit.avgEfficiency != null && p.exit.avgEfficiency < 0.30) {
    demerits += 1;
    weaknesses.push(`Exit eff=${(p.exit.avgEfficiency * 100).toFixed(0)}% < 30%`);
  }
  if (p.exit.alphaLeakagePct > 40) {
    demerits += 1;
    weaknesses.push(`Alpha leakage=${p.exit.alphaLeakagePct}% > 40%`);
  }

  // ── Net score -> verdict ──
  const netScore = merits - demerits;
  let decision;
  if (netScore >= 3) decision = 'DEPLOY';
  else if (netScore >= -1) decision = 'REFINE';
  else decision = 'SHELVE';

  // ── Hard gates override to SHELVE ──
  const hardGateReasons = [];
  if (v.profitFactor != null && v.profitFactor < 0.8) {
    hardGateReasons.push(`PF=${v.profitFactor} < 0.8`);
  }
  if (v.winRate != null && v.winRate < 30) {
    hardGateReasons.push(`WR=${v.winRate}% < 30%`);
  }
  if (v.monteCarlo != null && v.monteCarlo < 40) {
    hardGateReasons.push(`MC P(profit)=${v.monteCarlo}% < 40%`);
  }

  if (hardGateReasons.length > 0) {
    decision = 'SHELVE';
    weaknesses.push(`HARD GATE: ${hardGateReasons.join(', ')}`);
  }

  // ── Recommendations ──
  if (decision === 'REFINE') {
    if (p.setup.avgScore != null && p.setup.avgScore < 60) {
      recommendations.push('Tighten entry criteria — setup quality is low');
    }
    if (p.direction.dirCorrectPct != null && p.direction.dirCorrectPct < 55) {
      recommendations.push('Review directional thesis — underlying often moves against signal');
    }
    if (p.exit.avgEfficiency != null && p.exit.avgEfficiency < 0.40) {
      recommendations.push('Improve exit timing — capturing less than 40% of favorable move');
    }
    if (p.exit.alphaLeakagePct > 30) {
      recommendations.push('Fix alpha leakage — winning trades being given back');
    }
  }

  return {
    decision,
    merits,
    demerits,
    netScore,
    strengths,
    weaknesses,
    recommendations,
  };
}

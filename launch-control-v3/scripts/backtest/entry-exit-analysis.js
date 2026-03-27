/**
 * Entry & Exit Quality Analysis
 *
 * Institutional-grade analysis of trade execution quality.
 * Answers: "Are our entries well-timed?" and "Do our exits capture the move?"
 *
 * MFE (Maximum Favorable Excursion): best price reached during hold
 * MAE (Maximum Adverse Excursion): worst price reached during hold
 * Exit Efficiency: % of MFE actually captured at exit
 *
 * These metrics separate STRATEGY quality from EXECUTION quality.
 * A strategy can have a real edge but leak alpha through bad exits.
 */

function mean(arr) {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(sorted, p) {
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

/**
 * Comprehensive entry/exit quality analysis.
 * @param {Object} backtestResults - Full results with signals containing mfePct, maePct, exitEfficiency
 * @returns {Object} Entry/exit quality report
 */
export function analyzeEntryExitQuality(backtestResults) {
  const signals = backtestResults.signals || [];
  if (signals.length < 5) {
    return { error: 'Need 5+ signals for entry/exit analysis' };
  }

  // Filter to signals that have MFE/MAE data
  const withMFE = signals.filter(s => s.mfePct !== undefined && s.mfePct !== null);
  if (withMFE.length < 5) {
    return { error: 'Not enough signals with MFE/MAE data' };
  }

  // ── 1. Overall exit efficiency ──────────────────────────────────────────
  const efficiencies = withMFE.map(s => s.exitEfficiency || 0);
  const sortedEff = [...efficiencies].sort((a, b) => a - b);

  const exitQuality = {
    meanEfficiency: parseFloat(mean(efficiencies).toFixed(3)),
    medianEfficiency: parseFloat(median(efficiencies).toFixed(3)),
    p25Efficiency: parseFloat(percentile(sortedEff, 25).toFixed(3)),
    p75Efficiency: parseFloat(percentile(sortedEff, 75).toFixed(3)),
    // What % of trades capture >50% of MFE?
    captureAbove50Pct: parseFloat((efficiencies.filter(e => e >= 0.5).length / efficiencies.length * 100).toFixed(1)),
    captureAbove75Pct: parseFloat((efficiencies.filter(e => e >= 0.75).length / efficiencies.length * 100).toFixed(1)),
  };

  // ── 2. MFE analysis (how much opportunity exists?) ──────────────────────
  const mfes = withMFE.map(s => s.mfePct || 0);
  const sortedMFE = [...mfes].sort((a, b) => a - b);

  const mfeAnalysis = {
    meanMFE: parseFloat(mean(mfes).toFixed(2)),
    medianMFE: parseFloat(median(mfes).toFixed(2)),
    p90MFE: parseFloat(percentile(sortedMFE, 90).toFixed(2)),
    // Trades where MFE > 0 but we still lost money = exit problem
    winnableTrades: withMFE.filter(s => (s.mfePct || 0) > 5).length,
    winnableButLost: withMFE.filter(s => (s.mfePct || 0) > 5 && s.pnlDollars <= 0).length,
  };
  mfeAnalysis.alphaLeakagePct = mfeAnalysis.winnableTrades > 0
    ? parseFloat((mfeAnalysis.winnableButLost / mfeAnalysis.winnableTrades * 100).toFixed(1))
    : 0;

  // ── 3. MAE analysis (how much heat do we take?) ─────────────────────────
  const maes = withMFE.map(s => s.maePct || 0);
  const sortedMAE = [...maes].sort((a, b) => a - b);

  const maeAnalysis = {
    meanMAE: parseFloat(mean(maes).toFixed(2)),
    medianMAE: parseFloat(median(maes).toFixed(2)),
    worstMAE_p5: parseFloat(percentile(sortedMAE, 5).toFixed(2)),
    worstMAE_p1: parseFloat(percentile(sortedMAE, 1).toFixed(2)),
    // Trades where MAE > 50% of risk budget but still won = lucky, not good entry
    luckyWins: withMFE.filter(s => (s.maePct || 0) < -30 && s.pnlDollars > 0).length,
    luckyWinPct: parseFloat((withMFE.filter(s => (s.maePct || 0) < -30 && s.pnlDollars > 0).length / withMFE.length * 100).toFixed(1)),
  };

  // ── 4. By exit type ─────────────────────────────────────────────────────
  const exitTypes = [...new Set(withMFE.map(s => s.exitType))];
  const byExitType = {};
  for (const et of exitTypes) {
    const etSigs = withMFE.filter(s => s.exitType === et);
    const etEff = etSigs.map(s => s.exitEfficiency || 0);
    const etPnl = etSigs.map(s => s.pnlDollars || 0);
    byExitType[et] = {
      count: etSigs.length,
      pctOfTotal: parseFloat((etSigs.length / withMFE.length * 100).toFixed(1)),
      avgEfficiency: parseFloat(mean(etEff).toFixed(3)),
      avgPnl: Math.round(mean(etPnl)),
      totalPnl: Math.round(etPnl.reduce((a, b) => a + b, 0)),
      winRate: parseFloat((etSigs.filter(s => s.pnlDollars > 0).length / etSigs.length * 100).toFixed(1)),
    };
  }

  // ── 5. By strategy ──────────────────────────────────────────────────────
  const strategies = [...new Set(withMFE.map(s => s.strategy))];
  const byStrategy = {};
  for (const strat of strategies) {
    const stratSigs = withMFE.filter(s => s.strategy === strat);
    const stratEff = stratSigs.map(s => s.exitEfficiency || 0);
    const stratMFE = stratSigs.map(s => s.mfePct || 0);
    const stratMAE = stratSigs.map(s => s.maePct || 0);
    byStrategy[strat] = {
      count: stratSigs.length,
      avgEfficiency: parseFloat(mean(stratEff).toFixed(3)),
      avgMFE: parseFloat(mean(stratMFE).toFixed(2)),
      avgMAE: parseFloat(mean(stratMAE).toFixed(2)),
      alphaLeakage: stratSigs.filter(s => (s.mfePct || 0) > 5 && s.pnlDollars <= 0).length,
      luckyWins: stratSigs.filter(s => (s.maePct || 0) < -30 && s.pnlDollars > 0).length,
    };
  }

  // ── 6. Entry timing analysis ────────────────────────────────────────────
  // Group by hour — when do we get the best entries?
  const byHour = {};
  for (const s of withMFE) {
    const hour = parseInt(s.time?.slice(11, 13) || '0');
    if (!byHour[hour]) byHour[hour] = [];
    byHour[hour].push(s);
  }
  const hourlyQuality = Object.entries(byHour)
    .map(([hour, sigs]) => ({
      hour: parseInt(hour),
      etHour: parseInt(hour) - 5,
      signals: sigs.length,
      avgEfficiency: parseFloat(mean(sigs.map(s => s.exitEfficiency || 0)).toFixed(3)),
      winRate: parseFloat((sigs.filter(s => s.pnlDollars > 0).length / sigs.length * 100).toFixed(1)),
      avgPnl: Math.round(mean(sigs.map(s => s.pnlDollars || 0))),
    }))
    .sort((a, b) => a.hour - b.hour);

  // ── 7. Early exit detection ─────────────────────────────────────────────
  // Trades where we exited but MFE was reached AFTER exit = exiting too early
  // Trades where MAE was deep but MFE was also high = wrong stop level
  const earlyExits = withMFE.filter(s =>
    s.exitEfficiency < 0.3 && (s.mfePct || 0) > 10 && s.pnlDollars <= 0
  );
  const wrongStops = withMFE.filter(s =>
    (s.maePct || 0) < -20 && (s.mfePct || 0) > 15 && s.exitType === 'STOP'
  );

  // ── Verdict ─────────────────────────────────────────────────────────────
  const issues = [];
  if (exitQuality.meanEfficiency < 0.30) issues.push('Exit efficiency below 30% — exits leak most of the alpha');
  if (mfeAnalysis.alphaLeakagePct > 40) issues.push(`${mfeAnalysis.alphaLeakagePct}% of winnable trades lost — exit logic needs work`);
  if (maeAnalysis.luckyWinPct > 25) issues.push(`${maeAnalysis.luckyWinPct}% of wins went deep against us first — entry timing poor`);
  if (earlyExits.length > withMFE.length * 0.2) issues.push(`${earlyExits.length} early exits (${(earlyExits.length/withMFE.length*100).toFixed(0)}%) — stops too tight or time exits too early`);
  if (wrongStops.length > 5) issues.push(`${wrongStops.length} stopped out then reversed — stop placement needs calibration`);

  let verdict, verdictDetail;
  if (issues.length === 0) {
    verdict = 'EFFICIENT';
    verdictDetail = 'Entries and exits are capturing available alpha well.';
  } else if (issues.length <= 2) {
    verdict = 'IMPROVABLE';
    verdictDetail = issues.join('. ');
  } else {
    verdict = 'LEAKING_ALPHA';
    verdictDetail = `Significant execution issues: ${issues.join('. ')}`;
  }

  return {
    exitQuality,
    mfeAnalysis,
    maeAnalysis,
    byExitType,
    byStrategy,
    hourlyQuality,
    earlyExits: earlyExits.length,
    wrongStops: wrongStops.length,
    totalAnalyzed: withMFE.length,
    verdict,
    verdictDetail,
    issues,
  };
}

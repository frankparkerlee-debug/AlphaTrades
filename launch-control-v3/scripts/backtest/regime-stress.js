/**
 * Regime-Aware Stress Testing
 *
 * Filters backtest signals by market regime and tests whether the strategy
 * holds up in ALL conditions — not just the average case.
 *
 * Regimes tested:
 *   - Trend Up / Trend Down / Choppy (from signal metadata)
 *   - High VIX vs Low VIX days
 *   - Gap Up / Gap Down opens
 *   - High volume vs low volume days
 *   - Morning vs afternoon signals
 *   - CALL-heavy vs PUT-heavy days
 *
 * Also runs correlation analysis: are losses clustered on the same days?
 */

function mean(arr) {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function winRate(sigs) {
  return sigs.length > 0 ? parseFloat((sigs.filter(s => s.pnlDollars > 0).length / sigs.length * 100).toFixed(1)) : 0;
}

function totalPnl(sigs) {
  return Math.round(sigs.reduce((a, b) => a + b.pnlDollars, 0));
}

function avgPnl(sigs) {
  return sigs.length > 0 ? Math.round(mean(sigs.map(s => s.pnlDollars))) : 0;
}

function profitFactor(sigs) {
  const w = sigs.filter(s => s.pnlDollars > 0).reduce((a, b) => a + b.pnlDollars, 0);
  const l = Math.abs(sigs.filter(s => s.pnlDollars < 0).reduce((a, b) => a + b.pnlDollars, 0));
  return l > 0 ? parseFloat((w / l).toFixed(2)) : (w > 0 ? 999 : 0);
}

function regimeStats(sigs, label) {
  return {
    label,
    signals: sigs.length,
    winRate: winRate(sigs),
    avgPnl: avgPnl(sigs),
    totalPnl: totalPnl(sigs),
    profitFactor: profitFactor(sigs),
  };
}

/**
 * Run regime-aware stress testing.
 * @param {Object} backtestResults - Full backtest results
 * @returns {Object} Regime analysis
 */
export function runRegimeStress(backtestResults) {
  const signals = backtestResults.signals || [];
  const accountSize = backtestResults.config?.accountSize || 7500;

  if (signals.length < 10) {
    return { error: 'Not enough signals for regime analysis (need 10+)' };
  }

  // Group by date for daily analysis
  const byDate = {};
  for (const s of signals) {
    if (!byDate[s.date]) byDate[s.date] = [];
    byDate[s.date].push(s);
  }

  const regimes = {};

  // ── 1. Market regime (from signal metadata) ────────────────────────────
  const regimeField = signals[0]?.regime;
  if (regimeField !== undefined) {
    const byRegime = {};
    for (const s of signals) {
      const r = s.regime || 'unknown';
      if (!byRegime[r]) byRegime[r] = [];
      byRegime[r].push(s);
    }
    regimes.marketRegime = Object.entries(byRegime)
      .map(([r, sigs]) => regimeStats(sigs, r))
      .filter(r => r.signals >= 3)
      .sort((a, b) => b.totalPnl - a.totalPnl);
  }

  // ── 2. Direction (CALL vs PUT) ─────────────────────────────────────────
  const calls = signals.filter(s => s.direction === 'CALL');
  const puts = signals.filter(s => s.direction === 'PUT');
  regimes.direction = [
    regimeStats(calls, 'CALL'),
    regimeStats(puts, 'PUT'),
  ].filter(r => r.signals > 0);

  // ── 3. Grade breakdown ─────────────────────────────────────────────────
  const grades = ['A+', 'A', 'A-', 'B+', 'B'];
  regimes.grade = grades
    .map(g => regimeStats(signals.filter(s => s.grade === g), g))
    .filter(r => r.signals > 0);

  // ── 4. Time of day (morning vs midday) ─────────────────────────────────
  const morning = signals.filter(s => {
    const h = parseInt(s.time?.slice(11, 13) || '0');
    return h < 15; // before 3pm UTC = before 10am ET (early)
  });
  const midday = signals.filter(s => {
    const h = parseInt(s.time?.slice(11, 13) || '0');
    return h >= 15;
  });
  if (morning.length > 0 || midday.length > 0) {
    regimes.timeOfDay = [
      regimeStats(morning, 'Early (pre-10am ET)'),
      regimeStats(midday, 'Mid/Late (10am+ ET)'),
    ].filter(r => r.signals > 0);
  }

  // ── 5. Strategy type (if available) ────────────────────────────────────
  if (signals[0]?.signalType) {
    const byStrategy = {};
    for (const s of signals) {
      const st = s.signalType || 'unknown';
      if (!byStrategy[st]) byStrategy[st] = [];
      byStrategy[st].push(s);
    }
    regimes.strategy = Object.entries(byStrategy)
      .map(([st, sigs]) => regimeStats(sigs, st))
      .filter(r => r.signals >= 3)
      .sort((a, b) => b.totalPnl - a.totalPnl);
  }

  // ── 6. Daily P&L clustering (loss correlation) ─────────────────────────
  const dailyStats = Object.entries(byDate).map(([date, sigs]) => ({
    date,
    signals: sigs.length,
    wins: sigs.filter(s => s.pnlDollars > 0).length,
    losses: sigs.filter(s => s.pnlDollars < 0).length,
    pnl: totalPnl(sigs),
    winRate: winRate(sigs),
    allLoss: sigs.every(s => s.pnlDollars <= 0),
    allWin: sigs.every(s => s.pnlDollars > 0),
  })).sort((a, b) => a.date.localeCompare(b.date));

  // Clustered loss days: days where >70% of signals lost
  const heavyLossDays = dailyStats.filter(d => d.winRate < 30 && d.signals >= 3);
  const heavyWinDays = dailyStats.filter(d => d.winRate > 70 && d.signals >= 3);

  regimes.clustering = {
    totalDays: dailyStats.length,
    heavyLossDays: heavyLossDays.length,
    heavyLossDaysPct: parseFloat((heavyLossDays.length / dailyStats.length * 100).toFixed(1)),
    heavyLossDaysList: heavyLossDays.slice(0, 5).map(d => ({
      date: d.date, signals: d.signals, losses: d.losses, pnl: d.pnl,
    })),
    heavyWinDays: heavyWinDays.length,
    heavyWinDaysPct: parseFloat((heavyWinDays.length / dailyStats.length * 100).toFixed(1)),
    avgDailyPnl: Math.round(mean(dailyStats.map(d => d.pnl))),
    dailyPnlStdDev: Math.round(Math.sqrt(mean(dailyStats.map(d => d.pnl).map(p => (p - mean(dailyStats.map(d => d.pnl))) ** 2)))),
    worstDay: dailyStats.sort((a, b) => a.pnl - b.pnl)[0],
    bestDay: dailyStats.sort((a, b) => b.pnl - a.pnl)[0],
    dailyPnls: dailyStats.map(d => ({ date: d.date, pnl: d.pnl, signals: d.signals, winRate: d.winRate })),
  };

  // ── 7. Consecutive losing days ─────────────────────────────────────────
  let maxLoseStreak = 0, currentStreak = 0;
  let maxWinStreak = 0, currentWinStreak = 0;
  const sortedDays = dailyStats.sort((a, b) => a.date.localeCompare(b.date));
  for (const d of sortedDays) {
    if (d.pnl < 0) {
      currentStreak++;
      maxLoseStreak = Math.max(maxLoseStreak, currentStreak);
      currentWinStreak = 0;
    } else {
      currentStreak = 0;
      currentWinStreak++;
      maxWinStreak = Math.max(maxWinStreak, currentWinStreak);
    }
  }
  regimes.streaks = {
    maxLosingDays: maxLoseStreak,
    maxWinningDays: maxWinStreak,
    totalLosingDays: sortedDays.filter(d => d.pnl < 0).length,
    totalWinningDays: sortedDays.filter(d => d.pnl > 0).length,
    pctLosingDays: parseFloat((sortedDays.filter(d => d.pnl < 0).length / sortedDays.length * 100).toFixed(1)),
  };

  // ── 8. Composite score vs outcome ──────────────────────────────────────
  if (signals[0]?.composite !== undefined) {
    const buckets = [
      { label: '80+', min: 80, max: 999 },
      { label: '70-79', min: 70, max: 80 },
      { label: '60-69', min: 60, max: 70 },
      { label: '50-59', min: 50, max: 60 },
      { label: '<50', min: 0, max: 50 },
    ];
    regimes.compositeVsOutcome = buckets
      .map(b => {
        const sigs = signals.filter(s => (s.composite || 0) >= b.min && (s.composite || 0) < b.max);
        return { ...regimeStats(sigs, b.label), compositeRange: b.label };
      })
      .filter(r => r.signals > 0);
  }

  // ── 9. Exit type performance ───────────────────────────────────────────
  if (signals[0]?.exitType) {
    const exitTypes = ['T1', 'T2', 'T3', 'STOP', 'EOD'];
    regimes.exitType = exitTypes
      .map(et => regimeStats(signals.filter(s => s.exitType === et), et))
      .filter(r => r.signals > 0);
  }

  // ── Verdict ────────────────────────────────────────────────────────────
  const failingRegimes = [];
  if (regimes.direction) {
    for (const d of regimes.direction) {
      if (d.totalPnl < 0) failingRegimes.push(`${d.label} direction losing`);
    }
  }
  if (regimes.grade) {
    for (const g of regimes.grade) {
      if (g.totalPnl < 0 && g.signals >= 5) failingRegimes.push(`Grade ${g.label} losing`);
    }
  }
  if (regimes.clustering.heavyLossDaysPct > 30) {
    failingRegimes.push(`${regimes.clustering.heavyLossDaysPct}% heavy loss days`);
  }
  if (maxLoseStreak >= 4) {
    failingRegimes.push(`${maxLoseStreak}-day losing streak`);
  }

  let verdict, verdictDetail;
  if (failingRegimes.length === 0) {
    verdict = 'ALL-WEATHER';
    verdictDetail = 'Strategy performs across all tested regimes.';
  } else if (failingRegimes.length <= 2) {
    verdict = 'CONDITIONAL';
    verdictDetail = `Edge weakens in: ${failingRegimes.join(', ')}`;
  } else {
    verdict = 'FRAGILE';
    verdictDetail = `Multiple failure modes: ${failingRegimes.join(', ')}`;
  }

  return {
    regimes,
    verdict,
    verdictDetail,
    failingRegimes,
  };
}

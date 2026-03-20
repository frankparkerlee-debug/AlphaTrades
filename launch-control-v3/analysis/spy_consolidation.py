"""
SPY consolidation analysis — find periods where SPY stays within a 2% daily
range for 5+ consecutive trading days.

Measures:
  1. How many such periods in last 6 months, average duration
  2. Realized volatility (annualized) during these periods as VIX proxy
  3. Breakout magnitude after stable period ends
  4. Whether low realized vol correctly identifies calendar spread regime

Run: python3 analysis/spy_consolidation.py
"""

import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from dotenv import load_dotenv
import psycopg2
from psycopg2.extras import RealDictCursor
import numpy as np

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

DATABASE_URL = os.environ.get('DATABASE_URL')
if not DATABASE_URL:
    print('ERROR: DATABASE_URL not set in .env')
    sys.exit(1)

conn = psycopg2.connect(DATABASE_URL, sslmode='require')
cur = conn.cursor(cursor_factory=RealDictCursor)

# ── Load SPY daily bars ──────────────────────────────────────────────────────

print('Loading SPY daily bars from lc_v3.bars (last 6 months)...')
cur.execute("""
    SELECT DATE(ts AT TIME ZONE 'America/New_York') as day,
           (array_agg(open ORDER BY ts))[1] as day_open,
           MAX(high) as day_high,
           MIN(low) as day_low,
           (array_agg(close ORDER BY ts DESC))[1] as day_close,
           SUM(volume) as day_volume
    FROM lc_v3.bars
    WHERE ticker = 'SPY'
      AND session = 'REGULAR'
      AND ts >= NOW() - INTERVAL '6 months'
    GROUP BY DATE(ts AT TIME ZONE 'America/New_York')
    ORDER BY day
""")
rows = cur.fetchall()
conn.close()

print(f'  {len(rows)} trading days loaded')
if len(rows) < 10:
    print('  Not enough SPY bar data for analysis. Exiting.')
    sys.exit(0)

# Build daily array
days = []
for r in rows:
    days.append({
        'day': str(r['day']),
        'open': float(r['day_open']),
        'high': float(r['day_high']),
        'low': float(r['day_low']),
        'close': float(r['day_close']),
        'volume': int(r['day_volume']),
    })

# ── Compute daily range % and daily return ───────────────────────────────────

for i, d in enumerate(days):
    d['range_pct'] = (d['high'] - d['low']) / d['open'] * 100
    d['return_pct'] = ((d['close'] - d['open']) / d['open'] * 100) if d['open'] > 0 else 0
    if i > 0:
        d['close_to_close_pct'] = (d['close'] - days[i-1]['close']) / days[i-1]['close'] * 100
    else:
        d['close_to_close_pct'] = 0

# ── Find consolidation periods (daily range < 2% for 5+ consecutive days) ───

print('\n' + '=' * 70)
print('ANALYSIS: SPY CONSOLIDATION PERIODS (daily range < 2%, 5+ days)')
print('=' * 70)

consolidation_periods = []
streak_start = None
streak_days = []

for i, d in enumerate(days):
    if d['range_pct'] < 2.0:
        if streak_start is None:
            streak_start = i
            streak_days = [d]
        else:
            streak_days.append(d)
    else:
        if streak_start is not None and len(streak_days) >= 5:
            # Record the consolidation period
            breakout_day = d  # the day that broke the streak
            consolidation_periods.append({
                'start': streak_days[0]['day'],
                'end': streak_days[-1]['day'],
                'duration': len(streak_days),
                'days': streak_days.copy(),
                'breakout': breakout_day,
            })
        streak_start = None
        streak_days = []

# Check if we end in a consolidation
if streak_start is not None and len(streak_days) >= 5:
    consolidation_periods.append({
        'start': streak_days[0]['day'],
        'end': streak_days[-1]['day'],
        'duration': len(streak_days),
        'days': streak_days.copy(),
        'breakout': None,  # still ongoing
    })

print(f'\n  Total trading days analyzed: {len(days)}')
print(f'  Date range: {days[0]["day"]} to {days[-1]["day"]}')
print(f'  Consolidation periods found (5+ days < 2% range): {len(consolidation_periods)}')

if len(consolidation_periods) == 0:
    # Show what ranges we're actually seeing
    ranges = [d['range_pct'] for d in days]
    print(f'\n  Daily range stats:')
    print(f'    Min range:  {min(ranges):.2f}%')
    print(f'    Max range:  {max(ranges):.2f}%')
    print(f'    Avg range:  {np.mean(ranges):.2f}%')
    print(f'    Median:     {np.median(ranges):.2f}%')
    below2 = sum(1 for r in ranges if r < 2.0)
    print(f'    Days < 2%:  {below2} ({below2/len(ranges)*100:.1f}%)')
    below1_5 = sum(1 for r in ranges if r < 1.5)
    print(f'    Days < 1.5%: {below1_5} ({below1_5/len(ranges)*100:.1f}%)')

    # Try finding streaks of any length < 2%
    print(f'\n  Longest consecutive streak < 2% range:')
    max_streak = 0
    cur_streak = 0
    cur_start = None
    best_start = None
    best_end = None
    for d in days:
        if d['range_pct'] < 2.0:
            if cur_streak == 0:
                cur_start = d['day']
            cur_streak += 1
            if cur_streak > max_streak:
                max_streak = cur_streak
                best_start = cur_start
                best_end = d['day']
        else:
            cur_streak = 0
    print(f'    {max_streak} days ({best_start} to {best_end})')

    # Also try 2.5% threshold
    print(f'\n  Trying 2.5% threshold:')
    periods_25 = []
    s_start = None
    s_days = []
    for i, d in enumerate(days):
        if d['range_pct'] < 2.5:
            if s_start is None:
                s_start = i
                s_days = [d]
            else:
                s_days.append(d)
        else:
            if s_start is not None and len(s_days) >= 5:
                breakout_d = d
                periods_25.append({
                    'start': s_days[0]['day'],
                    'end': s_days[-1]['day'],
                    'duration': len(s_days),
                    'days': s_days.copy(),
                    'breakout': breakout_d,
                })
            s_start = None
            s_days = []
    if s_start is not None and len(s_days) >= 5:
        periods_25.append({
            'start': s_days[0]['day'],
            'end': s_days[-1]['day'],
            'duration': len(s_days),
            'days': s_days.copy(),
            'breakout': None,
        })
    print(f'    Periods found (5+ days < 2.5%): {len(periods_25)}')
    # Use 2.5% periods for rest of analysis if no 2% periods
    if len(periods_25) > 0:
        consolidation_periods = periods_25
        print(f'    Using 2.5% threshold for remaining analysis')

# ── Detailed period analysis ─────────────────────────────────────────────────

if len(consolidation_periods) > 0:
    durations = [p['duration'] for p in consolidation_periods]
    print(f'\n  Average duration: {np.mean(durations):.1f} days')
    print(f'  Median duration:  {np.median(durations):.0f} days')
    print(f'  Longest:          {max(durations)} days')
    print(f'  Shortest:         {min(durations)} days')

    print(f'\n  Individual periods:')
    print(f'  {"Start":<12} {"End":<12} {"Days":>5} {"Avg Range":>10} {"Real Vol":>10} {"Breakout":>10}')
    print(f'  {"-"*12} {"-"*12} {"-"*5} {"-"*10} {"-"*10} {"-"*10}')

    breakout_magnitudes = []
    realized_vols = []

    for p in consolidation_periods:
        # Avg daily range during period
        avg_range = np.mean([d['range_pct'] for d in p['days']])

        # Realized volatility (annualized) from close-to-close returns
        if len(p['days']) >= 2:
            returns = [d['close_to_close_pct'] / 100 for d in p['days'] if d['close_to_close_pct'] != 0]
            if len(returns) >= 2:
                rv = np.std(returns) * np.sqrt(252) * 100  # annualized %
            else:
                rv = 0
        else:
            rv = 0
        realized_vols.append(rv)

        # Breakout magnitude
        if p['breakout']:
            bo_mag = abs(p['breakout']['return_pct'])
            breakout_magnitudes.append(bo_mag)
            bo_str = f"{p['breakout']['return_pct']:+.2f}%"
        else:
            bo_str = 'ongoing'

        print(f'  {p["start"]:<12} {p["end"]:<12} {p["duration"]:>5} {avg_range:>9.2f}% {rv:>9.1f}% {bo_str:>10}')

    # ── Realized volatility summary ──────────────────────────────────────────

    print(f'\n' + '-' * 70)
    print(f'REALIZED VOLATILITY DURING CONSOLIDATION (VIX PROXY)')
    print(f'-' * 70)
    rv_arr = np.array(realized_vols)
    print(f'  Avg realized vol (annualized): {np.mean(rv_arr):.1f}%')
    print(f'  Range: {np.min(rv_arr):.1f}% to {np.max(rv_arr):.1f}%')
    print(f'  (VIX typically trades 1-3pts above realized vol)')
    print(f'  Estimated VIX during these periods: {np.mean(rv_arr) + 2:.0f} - {np.mean(rv_arr) + 4:.0f}')

    # ── Breakout analysis ────────────────────────────────────────────────────

    if len(breakout_magnitudes) > 0:
        print(f'\n' + '-' * 70)
        print(f'BREAKOUT AFTER CONSOLIDATION')
        print(f'-' * 70)
        bo_arr = np.array(breakout_magnitudes)
        print(f'  Breakouts measured: {len(bo_arr)}')
        print(f'  Avg breakout magnitude: {np.mean(bo_arr):.2f}%')
        print(f'  Median breakout:        {np.median(bo_arr):.2f}%')
        print(f'  Max breakout:           {np.max(bo_arr):.2f}%')
        print(f'  Min breakout:           {np.min(bo_arr):.2f}%')

        # Compare to average daily move
        all_abs_returns = [abs(d['return_pct']) for d in days]
        avg_daily_move = np.mean(all_abs_returns)
        print(f'\n  Avg daily |move| (all days): {avg_daily_move:.2f}%')
        print(f'  Breakout vs avg: {np.mean(bo_arr) / avg_daily_move:.1f}x larger')

    # ── Calendar spread regime assessment ────────────────────────────────────

    print(f'\n' + '-' * 70)
    print(f'CALENDAR SPREAD REGIME ASSESSMENT')
    print(f'-' * 70)

    total_consol_days = sum(p['duration'] for p in consolidation_periods)
    pct_time_in_consol = total_consol_days / len(days) * 100
    print(f'  Total days in consolidation: {total_consol_days} / {len(days)} ({pct_time_in_consol:.1f}%)')
    print(f'  Periods per month: {len(consolidation_periods) / (len(days) / 21):.1f}')

    if np.mean(rv_arr) < 15:
        print(f'  Realized vol {np.mean(rv_arr):.1f}% → LOW VOL regime (calendar spread favorable)')
    elif np.mean(rv_arr) < 20:
        print(f'  Realized vol {np.mean(rv_arr):.1f}% → MODERATE VOL regime')
    else:
        print(f'  Realized vol {np.mean(rv_arr):.1f}% → HIGH VOL regime (calendar spread risky)')

    # VIX filter validation
    print(f'\n  VIX filter validation:')
    print(f'    If VIX < 18 → calendar spread regime likely')
    print(f'    Estimated VIX during consolidations: ~{np.mean(rv_arr) + 3:.0f}')
    if np.mean(rv_arr) + 3 < 18:
        print(f'    VALIDATES VIX < 18 filter for identifying consolidation')
    else:
        print(f'    VIX filter may need adjustment (consolidation occurs at higher vol)')

# ── Overall daily range distribution ─────────────────────────────────────────

print(f'\n' + '=' * 70)
print(f'SPY DAILY RANGE DISTRIBUTION (all {len(days)} days)')
print('=' * 70)

ranges = [d['range_pct'] for d in days]
buckets = [(0, 0.5), (0.5, 1.0), (1.0, 1.5), (1.5, 2.0), (2.0, 2.5), (2.5, 3.0), (3.0, 999)]
for lo, hi in buckets:
    count = sum(1 for r in ranges if lo <= r < hi)
    label = f'  [{lo:.1f}% - {hi:.1f}%)' if hi < 999 else f'  [{lo:.1f}%+)'
    print(f'  {label:20s} {count:4d}  ({count/len(ranges)*100:5.1f}%)')

returns = [d['close_to_close_pct'] for d in days[1:]]
print(f'\n  Close-to-close returns:')
print(f'    Avg:    {np.mean(returns):+.3f}%')
print(f'    Std:    {np.std(returns):.3f}%')
print(f'    Annualized realized vol: {np.std(returns) * np.sqrt(252):.1f}%')

print()

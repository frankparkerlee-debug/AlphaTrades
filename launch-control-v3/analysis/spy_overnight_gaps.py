"""
SPY overnight gap analysis — compute gap between previous close and next open
for every trading day. Identify frequency and magnitude of gaps, day-of-week
breakdown, and correlation with prior-day low volatility.

Run: python3 analysis/spy_overnight_gaps.py
"""

import os
import sys
from collections import defaultdict
from datetime import datetime
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

print('Loading SPY bars from lc_v3.bars...')
cur.execute("""
    SELECT DATE(ts AT TIME ZONE 'America/New_York') as day,
           (array_agg(open ORDER BY ts))[1] as first_open,
           (array_agg(close ORDER BY ts DESC))[1] as last_close,
           MAX(high) as day_high,
           MIN(low) as day_low
    FROM lc_v3.bars
    WHERE ticker = 'SPY'
      AND session = 'REGULAR'
    GROUP BY DATE(ts AT TIME ZONE 'America/New_York')
    ORDER BY day
""")
rows = cur.fetchall()
conn.close()

print(f'  {len(rows)} trading days loaded')
if len(rows) < 10:
    print('  Not enough data. Exiting.')
    sys.exit(0)

days = []
for r in rows:
    d = {
        'day': str(r['day']),
        'date': datetime.strptime(str(r['day']), '%Y-%m-%d'),
        'open': float(r['first_open']),
        'close': float(r['last_close']),
        'high': float(r['day_high']),
        'low': float(r['day_low']),
    }
    d['range_pct'] = (d['high'] - d['low']) / d['open'] * 100
    d['dow'] = d['date'].weekday()  # 0=Mon
    d['dow_name'] = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'][d['dow']]
    days.append(d)

# Compute overnight gaps
gaps = []
for i in range(1, len(days)):
    prev = days[i - 1]
    curr = days[i]
    gap_pct = (curr['open'] - prev['close']) / prev['close'] * 100
    gaps.append({
        'day': curr['day'],
        'dow': curr['dow'],
        'dow_name': curr['dow_name'],
        'gap_pct': gap_pct,
        'abs_gap': abs(gap_pct),
        'prev_range_pct': prev['range_pct'],
        'prev_close': prev['close'],
        'curr_open': curr['open'],
    })

gap_arr = np.array([g['gap_pct'] for g in gaps])
abs_arr = np.array([g['abs_gap'] for g in gaps])

# ═══════════════════════════════════════════════════════════════════════════════
print('\n' + '=' * 70)
print('SPY OVERNIGHT GAP ANALYSIS')
print('=' * 70)
print(f'  Date range: {days[0]["day"]} to {days[-1]["day"]}')
print(f'  Total days analyzed: {len(gaps)}')
print(f'  Average gap magnitude: {np.mean(abs_arr):.3f}%')
print(f'  Median gap magnitude:  {np.median(abs_arr):.3f}%')
print(f'  Average gap (signed):  {np.mean(gap_arr):+.3f}%')
print(f'  Std dev:               {np.std(gap_arr):.3f}%')
print(f'  Max gap up:            {np.max(gap_arr):+.3f}%')
print(f'  Max gap down:          {np.min(gap_arr):+.3f}%')

# ── Threshold breakdown ──────────────────────────────────────────────────────

print(f'\n  Gap Threshold Breakdown:')
print(f'  {"Threshold":>12} {"Count":>6} {"Pct":>7} {"Avg Gap":>9}')
print(f'  {"─" * 12} {"─" * 6} {"─" * 7} {"─" * 9}')

thresholds = [0.5, 1.0, 1.5, 2.0, 3.0]
for t in thresholds:
    count = np.sum(abs_arr >= t)
    pct = count / len(gaps) * 100
    subset = abs_arr[abs_arr >= t]
    avg = np.mean(subset) if len(subset) > 0 else 0
    print(f'  >= {t:.1f}%      {count:>6} {pct:>6.1f}% {avg:>8.3f}%')

# ── Positive vs negative ─────────────────────────────────────────────────────

pos_gaps = gap_arr[gap_arr > 0]
neg_gaps = gap_arr[gap_arr < 0]
flat_gaps = gap_arr[gap_arr == 0]

print(f'\n  Direction:')
print(f'    Gap UP:    {len(pos_gaps):>4} ({len(pos_gaps)/len(gaps)*100:.1f}%)  avg {np.mean(pos_gaps):+.3f}%')
print(f'    Gap DOWN:  {len(neg_gaps):>4} ({len(neg_gaps)/len(gaps)*100:.1f}%)  avg {np.mean(neg_gaps):+.3f}%')
print(f'    Flat:      {len(flat_gaps):>4} ({len(flat_gaps)/len(gaps)*100:.1f}%)')

# ── Day of week breakdown ────────────────────────────────────────────────────

print(f'\n' + '-' * 70)
print(f'DAY OF WEEK BREAKDOWN')
print(f'-' * 70)

dow_names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
print(f'  {"Day":<12} {"Count":>6} {"AvgGap":>8} {"Avg|Gap|":>9} {">0.5%":>6} {">1.0%":>6} {">1.5%":>6} {"GapUp%":>7}')
print(f'  {"─" * 12} {"─" * 6} {"─" * 8} {"─" * 9} {"─" * 6} {"─" * 6} {"─" * 6} {"─" * 7}')

for dow in range(5):
    dow_gaps = [g for g in gaps if g['dow'] == dow]
    if not dow_gaps:
        continue
    g_arr = np.array([g['gap_pct'] for g in dow_gaps])
    a_arr = np.array([g['abs_gap'] for g in dow_gaps])
    gt05 = np.sum(a_arr >= 0.5)
    gt10 = np.sum(a_arr >= 1.0)
    gt15 = np.sum(a_arr >= 1.5)
    gap_up_pct = np.sum(g_arr > 0) / len(g_arr) * 100
    print(f'  {dow_names[dow]:<12} {len(dow_gaps):>6} {np.mean(g_arr):>+7.3f}% {np.mean(a_arr):>8.3f}% {gt05:>5} {gt10:>5} {gt15:>5} {gap_up_pct:>6.1f}%')

# Monday vs rest
mon_gaps = np.array([g['abs_gap'] for g in gaps if g['dow'] == 0])
rest_gaps = np.array([g['abs_gap'] for g in gaps if g['dow'] != 0])
if len(mon_gaps) > 0 and len(rest_gaps) > 0:
    print(f'\n  Monday avg |gap|: {np.mean(mon_gaps):.3f}%  vs  Tue-Fri: {np.mean(rest_gaps):.3f}%')
    print(f'  Monday {np.mean(mon_gaps)/np.mean(rest_gaps):.1f}x larger gaps (weekend risk)')

# ── Low volatility → gap analysis ────────────────────────────────────────────

print(f'\n' + '-' * 70)
print(f'LOW VOLATILITY DAY → OVERNIGHT GAP (calendar spread failure mode)')
print(f'-' * 70)
print(f'  Low vol = previous day range < 1%')

low_vol_gaps = [g for g in gaps if g['prev_range_pct'] < 1.0]
high_vol_gaps = [g for g in gaps if g['prev_range_pct'] >= 1.0]

print(f'\n  After LOW vol day (range < 1%): {len(low_vol_gaps)} instances')
if low_vol_gaps:
    lv_arr = np.array([g['abs_gap'] for g in low_vol_gaps])
    lv_signed = np.array([g['gap_pct'] for g in low_vol_gaps])
    print(f'    Avg |gap|:  {np.mean(lv_arr):.3f}%')
    print(f'    Avg gap:    {np.mean(lv_signed):+.3f}%')
    for t in [0.5, 1.0, 1.5, 2.0]:
        c = np.sum(lv_arr >= t)
        print(f'    >= {t:.1f}%:    {c:>3} ({c/len(low_vol_gaps)*100:.1f}%)')

    # The key question: gaps >1.5% after low vol days
    big_gaps_after_low_vol = [g for g in low_vol_gaps if g['abs_gap'] >= 1.5]
    print(f'\n    CRITICAL: Gaps >= 1.5% after low vol day: {len(big_gaps_after_low_vol)}')
    if big_gaps_after_low_vol:
        for g in big_gaps_after_low_vol:
            print(f'      {g["day"]} ({g["dow_name"]})  gap={g["gap_pct"]:+.2f}%  prev_range={g["prev_range_pct"]:.2f}%')

print(f'\n  After HIGH vol day (range >= 1%): {len(high_vol_gaps)} instances')
if high_vol_gaps:
    hv_arr = np.array([g['abs_gap'] for g in high_vol_gaps])
    hv_signed = np.array([g['gap_pct'] for g in high_vol_gaps])
    print(f'    Avg |gap|:  {np.mean(hv_arr):.3f}%')
    print(f'    Avg gap:    {np.mean(hv_signed):+.3f}%')
    for t in [0.5, 1.0, 1.5, 2.0]:
        c = np.sum(hv_arr >= t)
        print(f'    >= {t:.1f}%:    {c:>3} ({c/len(high_vol_gaps)*100:.1f}%)')

# Comparison
if low_vol_gaps and high_vol_gaps:
    lv_big = sum(1 for g in low_vol_gaps if g['abs_gap'] >= 1.5)
    hv_big = sum(1 for g in high_vol_gaps if g['abs_gap'] >= 1.5)
    lv_rate = lv_big / len(low_vol_gaps) * 100
    hv_rate = hv_big / len(high_vol_gaps) * 100
    print(f'\n  Gap >= 1.5% rate:')
    print(f'    After low vol:   {lv_rate:.1f}% ({lv_big}/{len(low_vol_gaps)})')
    print(f'    After high vol:  {hv_rate:.1f}% ({hv_big}/{len(high_vol_gaps)})')

# ── Calendar spread risk summary ─────────────────────────────────────────────

print(f'\n' + '=' * 70)
print(f'CALENDAR SPREAD OVERNIGHT RISK SUMMARY')
print(f'=' * 70)

total_large = sum(1 for g in gaps if g['abs_gap'] >= 1.5)
total_rate = total_large / len(gaps) * 100

print(f'  Overnight gaps >= 1.5%: {total_large}/{len(gaps)} ({total_rate:.1f}%)')
print(f'  Expected frequency: ~1 every {len(gaps)/total_large:.0f} trading days' if total_large > 0 else '  No gaps >= 1.5% observed')

if low_vol_gaps:
    lv_big = sum(1 for g in low_vol_gaps if g['abs_gap'] >= 1.5)
    lv_rate = lv_big / len(low_vol_gaps) * 100
    print(f'  After low vol days: {lv_big}/{len(low_vol_gaps)} ({lv_rate:.1f}%)')
    if lv_big > 0:
        print(f'  Calendar spreads held overnight after quiet days face')
        print(f'  a {lv_rate:.1f}% chance of a 1.5%+ gap destroying the position')
    else:
        print(f'  No large gaps after low vol days in this sample — but sample is small')

# All gaps sorted by magnitude
print(f'\n  Top 10 largest overnight gaps:')
sorted_gaps = sorted(gaps, key=lambda g: g['abs_gap'], reverse=True)[:10]
print(f'  {"Date":<12} {"Day":<11} {"Gap":>8} {"PrevRange":>10}')
print(f'  {"─"*12} {"─"*11} {"─"*8} {"─"*10}')
for g in sorted_gaps:
    print(f'  {g["day"]:<12} {g["dow_name"]:<11} {g["gap_pct"]:>+7.2f}% {g["prev_range_pct"]:>9.2f}%')

print()

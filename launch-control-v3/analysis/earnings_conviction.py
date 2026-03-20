"""
Earnings conviction analysis — validates whether conviction scorer criteria
predict earnings misses.

Analyses:
  1. Earnings day move distribution (drop rate, avg drop, avg gain)
  2. Near 52-week high (within 10%) 14 days before → correlation with larger drops
  3. Declining revenue (2 quarters before earnings) → avg move vs growing revenue
  4. Statistical significance via t-test

Data sources:
  - lc_v3.ticker_intelligence.historical_earnings (JSONB)
  - lc_v3.bars (stock prices)
  - lc_v3.fundamentals (quarterly revenue)

Run: python3 analysis/earnings_conviction.py
"""

import os
import sys
import json
from collections import defaultdict
from datetime import datetime, timedelta
from dotenv import load_dotenv
import psycopg2
from psycopg2.extras import RealDictCursor
import numpy as np
from scipy import stats

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

DATABASE_URL = os.environ.get('DATABASE_URL')
if not DATABASE_URL:
    print('ERROR: DATABASE_URL not set in .env')
    sys.exit(1)

conn = psycopg2.connect(DATABASE_URL, sslmode='require')
cur = conn.cursor(cursor_factory=RealDictCursor)

# ═══════════════════════════════════════════════════════════════════════════════
# Load data
# ═══════════════════════════════════════════════════════════════════════════════

print('Loading historical earnings from ticker_intelligence...')
cur.execute("""
    SELECT ticker, historical_earnings
    FROM lc_v3.ticker_intelligence
    WHERE historical_earnings IS NOT NULL
      AND jsonb_array_length(historical_earnings) > 0
""")
intel_rows = cur.fetchall()
print(f'  {len(intel_rows)} tickers have historical_earnings data')

# Parse all earnings events
earnings_events = []
for row in intel_rows:
    ticker = row['ticker']
    hist = row['historical_earnings']
    if isinstance(hist, str):
        hist = json.loads(hist)
    for event in hist:
        if event.get('date'):
            earnings_events.append({
                'ticker': ticker,
                'date': event['date'],
                'eps_actual': event.get('eps_actual'),
                'revenue': event.get('revenue'),
                'period': event.get('period'),
            })

print(f'  {len(earnings_events)} total earnings events across all tickers')

# Load daily closes from bars — aggregate minute bars into daily OHLC
print('Loading daily price data from lc_v3.bars...')
cur.execute("""
    SELECT ticker,
           DATE(ts AT TIME ZONE 'America/New_York') as day,
           (array_agg(open ORDER BY ts))[1] as day_open,
           MAX(high) as day_high,
           MIN(low) as day_low,
           (array_agg(close ORDER BY ts DESC))[1] as day_close
    FROM lc_v3.bars
    WHERE session = 'REGULAR'
    GROUP BY ticker, DATE(ts AT TIME ZONE 'America/New_York')
    ORDER BY ticker, day
""")
bar_rows = cur.fetchall()
print(f'  {len(bar_rows)} daily bar records loaded')

# Build lookup: ticker -> { day_str -> {open, high, low, close} }
daily_prices = defaultdict(dict)
for r in bar_rows:
    day_str = str(r['day'])
    daily_prices[r['ticker']][day_str] = {
        'open': float(r['day_open']),
        'high': float(r['day_high']),
        'low': float(r['day_low']),
        'close': float(r['day_close']),
    }

# Load fundamentals
print('Loading fundamentals from lc_v3.fundamentals...')
cur.execute("""
    SELECT ticker, period, revenue, reported_at
    FROM lc_v3.fundamentals
    WHERE revenue IS NOT NULL
    ORDER BY ticker, reported_at
""")
fund_rows = cur.fetchall()
print(f'  {len(fund_rows)} fundamental records loaded')

# Build lookup: ticker -> list of {period, revenue, reported_at} sorted by date
fundamentals = defaultdict(list)
for r in fund_rows:
    fundamentals[r['ticker']].append({
        'period': r['period'],
        'revenue': float(r['revenue']),
        'reported_at': str(r['reported_at']) if r['reported_at'] else None,
    })

conn.close()

# ═══════════════════════════════════════════════════════════════════════════════
# Helper: find closest trading day price
# ═══════════════════════════════════════════════════════════════════════════════

def find_price(ticker, target_date_str, window_days=5):
    """Find close price on or near target_date_str (±window_days)."""
    prices = daily_prices.get(ticker, {})
    target = datetime.strptime(target_date_str, '%Y-%m-%d')
    # Try exact date first, then nearby dates
    for offset in range(0, window_days + 1):
        for delta in [offset, -offset]:
            day_str = (target + timedelta(days=delta)).strftime('%Y-%m-%d')
            if day_str in prices:
                return prices[day_str]
    return None

def find_52w_high(ticker, before_date_str):
    """Find 52-week high ending at before_date_str."""
    prices = daily_prices.get(ticker, {})
    end = datetime.strptime(before_date_str, '%Y-%m-%d')
    start = end - timedelta(days=365)
    highs = []
    for day_str, p in prices.items():
        day = datetime.strptime(day_str, '%Y-%m-%d')
        if start <= day <= end:
            highs.append(p['high'])
    return max(highs) if highs else None

# ═══════════════════════════════════════════════════════════════════════════════
# Analysis 1: Earnings day move distribution
# ═══════════════════════════════════════════════════════════════════════════════

print('\n' + '=' * 70)
print('ANALYSIS 1: EARNINGS DAY MOVE DISTRIBUTION')
print('=' * 70)

earnings_moves = []  # list of {ticker, date, move_pct, price_14d_before, earnings_close}
skipped = {'no_earnings_price': 0, 'no_pre_price': 0}

for event in earnings_events:
    ticker = event['ticker']
    earn_date = event['date']

    # Get earnings day close
    earn_bar = find_price(ticker, earn_date, window_days=2)
    if not earn_bar:
        skipped['no_earnings_price'] += 1
        continue

    # Get price 14 calendar days before
    pre_date = (datetime.strptime(earn_date, '%Y-%m-%d') - timedelta(days=14)).strftime('%Y-%m-%d')
    pre_bar = find_price(ticker, pre_date, window_days=5)
    if not pre_bar:
        skipped['no_pre_price'] += 1
        continue

    move_pct = (earn_bar['close'] - pre_bar['close']) / pre_bar['close'] * 100

    earnings_moves.append({
        'ticker': ticker,
        'date': earn_date,
        'move_pct': move_pct,
        'price_14d_before': pre_bar['close'],
        'earnings_close': earn_bar['close'],
        'high_52w': find_52w_high(ticker, pre_date),
    })

print(f'\nTotal earnings events with price data: {len(earnings_moves)}')
print(f'Skipped — no earnings price: {skipped["no_earnings_price"]}, no pre-price: {skipped["no_pre_price"]}')

if len(earnings_moves) == 0:
    print('\nNo earnings events with matching bar data. Exiting.')
    sys.exit(0)

moves = np.array([e['move_pct'] for e in earnings_moves])
drops = moves[moves < 0]
gains = moves[moves >= 0]

print(f'\n  Sample size:     {len(moves)}')
print(f'  Dropped on earnings: {len(drops)} ({len(drops)/len(moves)*100:.1f}%)')
print(f'  Rose on earnings:    {len(gains)} ({len(gains)/len(moves)*100:.1f}%)')
print(f'  Avg move (all):      {np.mean(moves):+.2f}%')
print(f'  Median move (all):   {np.median(moves):+.2f}%')
print(f'  Avg DROP magnitude:  {np.mean(drops):.2f}%' if len(drops) > 0 else '  No drops')
print(f'  Avg GAIN magnitude:  {np.mean(gains):+.2f}%' if len(gains) > 0 else '  No gains')
print(f'  Std dev:             {np.std(moves):.2f}%')

# Distribution buckets
buckets = [(-999, -10), (-10, -5), (-5, -2), (-2, 0), (0, 2), (2, 5), (5, 10), (10, 999)]
print('\n  Move distribution:')
for lo, hi in buckets:
    count = np.sum((moves >= lo) & (moves < hi))
    label = f'  [{lo:+.0f}% to {hi:+.0f}%)' if hi < 999 else f'  [{lo:+.0f}%+)'
    if lo == -999:
        label = f'  (<{hi:+.0f}%)'
    print(f'    {label:25s} {count:4d}  ({count/len(moves)*100:5.1f}%)')

# ═══════════════════════════════════════════════════════════════════════════════
# Analysis 2: Near 52-week high → larger drops?
# ═══════════════════════════════════════════════════════════════════════════════

print('\n' + '=' * 70)
print('ANALYSIS 2: NEAR 52-WEEK HIGH (within 10%) → EARNINGS DROP CORRELATION')
print('=' * 70)

near_high_moves = []
not_near_high_moves = []

for e in earnings_moves:
    if e['high_52w'] is None:
        continue
    pct_from_high = (e['price_14d_before'] - e['high_52w']) / e['high_52w'] * 100
    if pct_from_high >= -10:  # within 10% of 52w high
        near_high_moves.append(e['move_pct'])
    else:
        not_near_high_moves.append(e['move_pct'])

near = np.array(near_high_moves) if near_high_moves else np.array([])
far = np.array(not_near_high_moves) if not_near_high_moves else np.array([])

print(f'\n  Near 52w high (within 10%): {len(near)} events')
if len(near) > 0:
    print(f'    Avg move:    {np.mean(near):+.2f}%')
    print(f'    Drop rate:   {np.sum(near < 0)/len(near)*100:.1f}%')
    print(f'    Avg drop:    {np.mean(near[near < 0]):.2f}%' if np.sum(near < 0) > 0 else '    No drops')

print(f'\n  Far from 52w high (>10% below): {len(far)} events')
if len(far) > 0:
    print(f'    Avg move:    {np.mean(far):+.2f}%')
    print(f'    Drop rate:   {np.sum(far < 0)/len(far)*100:.1f}%')
    print(f'    Avg drop:    {np.mean(far[far < 0]):.2f}%' if np.sum(far < 0) > 0 else '    No drops')

if len(near) >= 5 and len(far) >= 5:
    t_stat, p_value = stats.ttest_ind(near, far, equal_var=False)
    sig = 'YES' if p_value < 0.05 else 'NO'
    print(f'\n  T-test (near vs far from 52w high):')
    print(f'    t-statistic: {t_stat:.3f}')
    print(f'    p-value:     {p_value:.4f}')
    print(f'    Significant at 95%: {sig}')
else:
    print('\n  Insufficient samples for t-test')

# ═══════════════════════════════════════════════════════════════════════════════
# Analysis 3: Declining revenue → worse earnings moves?
# ═══════════════════════════════════════════════════════════════════════════════

print('\n' + '=' * 70)
print('ANALYSIS 3: DECLINING REVENUE (2Q before) → EARNINGS MOVE')
print('=' * 70)

declining_rev_moves = []
growing_rev_moves = []
no_fund_data = 0

for e in earnings_moves:
    ticker = e['ticker']
    earn_date = datetime.strptime(e['date'], '%Y-%m-%d')
    fund_list = fundamentals.get(ticker, [])

    if len(fund_list) < 2:
        no_fund_data += 1
        continue

    # Find the 2 most recent quarters reported BEFORE this earnings date
    pre_quarters = []
    for f in fund_list:
        if f['reported_at']:
            rep_date = datetime.strptime(f['reported_at'], '%Y-%m-%d')
            if rep_date < earn_date:
                pre_quarters.append(f)

    # Sort by reported_at descending, take most recent 2
    pre_quarters.sort(key=lambda x: x['reported_at'], reverse=True)

    if len(pre_quarters) < 2:
        no_fund_data += 1
        continue

    q1_rev = pre_quarters[0]['revenue']  # most recent
    q2_rev = pre_quarters[1]['revenue']  # one before

    if q1_rev < q2_rev:
        declining_rev_moves.append(e['move_pct'])
    else:
        growing_rev_moves.append(e['move_pct'])

dec = np.array(declining_rev_moves) if declining_rev_moves else np.array([])
grow = np.array(growing_rev_moves) if growing_rev_moves else np.array([])

print(f'\n  Events with fundamental data: {len(dec) + len(grow)}')
print(f'  Events without fund data:     {no_fund_data}')

print(f'\n  DECLINING revenue (Q-over-Q): {len(dec)} events')
if len(dec) > 0:
    print(f'    Avg move:    {np.mean(dec):+.2f}%')
    print(f'    Median move: {np.median(dec):+.2f}%')
    print(f'    Drop rate:   {np.sum(dec < 0)/len(dec)*100:.1f}%')
    print(f'    Avg drop:    {np.mean(dec[dec < 0]):.2f}%' if np.sum(dec < 0) > 0 else '    No drops')
    print(f'    Avg gain:    {np.mean(dec[dec >= 0]):+.2f}%' if np.sum(dec >= 0) > 0 else '    No gains')

print(f'\n  GROWING revenue (Q-over-Q): {len(grow)} events')
if len(grow) > 0:
    print(f'    Avg move:    {np.mean(grow):+.2f}%')
    print(f'    Median move: {np.median(grow):+.2f}%')
    print(f'    Drop rate:   {np.sum(grow < 0)/len(grow)*100:.1f}%')
    print(f'    Avg drop:    {np.mean(grow[grow < 0]):.2f}%' if np.sum(grow < 0) > 0 else '    No drops')
    print(f'    Avg gain:    {np.mean(grow[grow >= 0]):+.2f}%' if np.sum(grow >= 0) > 0 else '    No gains')

if len(dec) >= 5 and len(grow) >= 5:
    t_stat, p_value = stats.ttest_ind(dec, grow, equal_var=False)
    sig = 'YES' if p_value < 0.05 else 'NO'
    print(f'\n  T-test (declining vs growing revenue):')
    print(f'    t-statistic: {t_stat:.3f}')
    print(f'    p-value:     {p_value:.4f}')
    print(f'    Significant at 95%: {sig}')
    print(f'    Difference:  {np.mean(dec) - np.mean(grow):+.2f}% (declining minus growing)')
else:
    print('\n  Insufficient samples for t-test')

# ═══════════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════════

print('\n' + '=' * 70)
print('CONVICTION SCORER VALIDATION SUMMARY')
print('=' * 70)
print(f"""
  Total earnings events analyzed: {len(earnings_moves)}

  Key findings:
  1. Earnings drop rate:  {len(drops)/len(moves)*100:.1f}% of stocks drop on earnings
     Avg drop: {np.mean(drops):.2f}%  |  Avg gain: {np.mean(gains):+.2f}%
""")

if len(near) > 0 and len(far) > 0:
    near_drop_rate = np.sum(near < 0)/len(near)*100
    far_drop_rate = np.sum(far < 0)/len(far)*100
    print(f'  2. Near 52w high → drop rate {near_drop_rate:.1f}% vs {far_drop_rate:.1f}% far from high')
    if len(near) >= 5 and len(far) >= 5:
        _, p = stats.ttest_ind(near, far, equal_var=False)
        print(f'     {"VALIDATES" if p < 0.05 and np.mean(near) < np.mean(far) else "DOES NOT VALIDATE"} conviction scorer thesis (p={p:.4f})')

if len(dec) > 0 and len(grow) > 0:
    dec_drop_rate = np.sum(dec < 0)/len(dec)*100
    grow_drop_rate = np.sum(grow < 0)/len(grow)*100
    print(f'\n  3. Declining rev → drop rate {dec_drop_rate:.1f}% vs {grow_drop_rate:.1f}% growing rev')
    if len(dec) >= 5 and len(grow) >= 5:
        _, p = stats.ttest_ind(dec, grow, equal_var=False)
        print(f'     {"VALIDATES" if p < 0.05 and np.mean(dec) < np.mean(grow) else "DOES NOT VALIDATE"} conviction scorer thesis (p={p:.4f})')

print()

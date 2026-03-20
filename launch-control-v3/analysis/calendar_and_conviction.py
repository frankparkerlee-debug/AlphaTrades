"""
Two analyses:
  1. Calendar spread profitability simulation on SPY consolidation periods
  2. Analyst lag / conviction put candidate screening

Run: python3 analysis/calendar_and_conviction.py
"""

import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from dotenv import load_dotenv
import psycopg2
from psycopg2.extras import RealDictCursor
import numpy as np
import math

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

DATABASE_URL = os.environ.get('DATABASE_URL')
if not DATABASE_URL:
    print('ERROR: DATABASE_URL not set in .env')
    sys.exit(1)

conn = psycopg2.connect(DATABASE_URL, sslmode='require')
cur = conn.cursor(cursor_factory=RealDictCursor)

# ═══════════════════════════════════════════════════════════════════════════════
# Load SPY daily bars
# ═══════════════════════════════════════════════════════════════════════════════

print('Loading SPY daily bars...')
cur.execute("""
    SELECT DATE(ts AT TIME ZONE 'America/New_York') as day,
           (array_agg(open ORDER BY ts))[1] as day_open,
           MAX(high) as day_high,
           MIN(low) as day_low,
           (array_agg(close ORDER BY ts DESC))[1] as day_close
    FROM lc_v3.bars
    WHERE ticker = 'SPY'
      AND session = 'REGULAR'
      AND ts >= NOW() - INTERVAL '6 months'
    GROUP BY DATE(ts AT TIME ZONE 'America/New_York')
    ORDER BY day
""")
spy_rows = cur.fetchall()
print(f'  {len(spy_rows)} SPY trading days')

spy_days = []
spy_by_date = {}
for r in spy_rows:
    d = {
        'day': str(r['day']),
        'date': datetime.strptime(str(r['day']), '%Y-%m-%d'),
        'open': float(r['day_open']),
        'high': float(r['day_high']),
        'low': float(r['day_low']),
        'close': float(r['day_close']),
    }
    d['range_pct'] = (d['high'] - d['low']) / d['open'] * 100
    spy_days.append(d)
    spy_by_date[d['day']] = d

# ═══════════════════════════════════════════════════════════════════════════════
# ANALYSIS 1: Calendar Spread Profitability Simulation
# ═══════════════════════════════════════════════════════════════════════════════

print('\n' + '=' * 70)
print('ANALYSIS 1: SPY CALENDAR SPREAD SIMULATION')
print('=' * 70)
print('Model: sell weekly ATM call, buy 2-week ATM call')
print('Pricing: option = SPY * 0.008 * sqrt(DTE/7)')
print('At expiry: if SPY moved <1.5%, front ~0, back ~0.6x original')
print('           if SPY moved >=1.5%, front has intrinsic, back ~0.8x original')

# Find consolidation periods (same logic as spy_consolidation.py)
consolidation_periods = []
streak_start = None
streak_days = []

for i, d in enumerate(spy_days):
    if d['range_pct'] < 2.0:
        if streak_start is None:
            streak_start = i
            streak_days = [d]
        else:
            streak_days.append(d)
    else:
        if streak_start is not None and len(streak_days) >= 5:
            breakout_day = d
            consolidation_periods.append({
                'start': streak_days[0]['day'],
                'end': streak_days[-1]['day'],
                'duration': len(streak_days),
                'days': streak_days.copy(),
                'breakout': breakout_day,
            })
        streak_start = None
        streak_days = []

if streak_start is not None and len(streak_days) >= 5:
    consolidation_periods.append({
        'start': streak_days[0]['day'],
        'end': streak_days[-1]['day'],
        'duration': len(streak_days),
        'days': streak_days.copy(),
        'breakout': None,
    })

print(f'\nConsolidation periods: {len(consolidation_periods)}')

# For each period, simulate calendar spreads opened every Monday
all_trades = []
total_profit = 0
total_debit = 0

for pi, period in enumerate(consolidation_periods):
    period_trades = []
    period_days_set = {d['day'] for d in period['days']}

    # Find Mondays within period
    mondays = [d for d in period['days'] if d['date'].weekday() == 0]

    for monday in mondays:
        entry_price = monday['close']

        # Front option: 5 DTE (Mon->Fri)
        front_dte = 5
        front_price = entry_price * 0.008 * math.sqrt(front_dte / 7)

        # Back option: 12 DTE (Mon->Fri+7)
        back_dte = 12
        back_price = entry_price * 0.008 * math.sqrt(back_dte / 7)

        net_debit = back_price - front_price

        # Find Friday (expiry day) — 4 calendar days later
        expiry_date = monday['date'] + timedelta(days=4)
        # Find closest trading day
        expiry_bar = None
        for offset in range(0, 3):
            check = (expiry_date + timedelta(days=offset)).strftime('%Y-%m-%d')
            if check in spy_by_date:
                expiry_bar = spy_by_date[check]
                break

        if not expiry_bar:
            continue

        spy_move_pct = abs((expiry_bar['close'] - entry_price) / entry_price * 100)

        if spy_move_pct < 1.5:
            # Front expires near zero, back retains ~60% of value
            front_exit = 0
            back_exit = back_price * 0.6
        else:
            # Front has intrinsic value, back retains more value (~80%)
            intrinsic = abs(expiry_bar['close'] - entry_price)
            front_exit = intrinsic  # ITM, worth intrinsic
            back_exit = back_price * 0.8

        # Calendar spread P&L: we're short front, long back
        # At entry: paid net_debit (back - front)
        # At exit: receive (back_exit - front_exit)
        exit_value = back_exit - front_exit
        profit = exit_value - net_debit

        trade = {
            'entry_date': monday['day'],
            'expiry_date': expiry_bar['day'],
            'entry_price': entry_price,
            'expiry_price': expiry_bar['close'],
            'spy_move_pct': spy_move_pct,
            'front_price': front_price,
            'back_price': back_price,
            'net_debit': net_debit,
            'front_exit': front_exit,
            'back_exit': back_exit,
            'exit_value': exit_value,
            'profit': profit,
            'profit_pct': (profit / net_debit * 100) if net_debit > 0 else 0,
            'period_idx': pi,
        }
        period_trades.append(trade)
        all_trades.append(trade)
        total_profit += profit
        total_debit += net_debit

    # Period summary
    if period_trades:
        wins = [t for t in period_trades if t['profit'] > 0]
        losses = [t for t in period_trades if t['profit'] <= 0]
        p_profit = sum(t['profit'] for t in period_trades)
        print(f'\n  Period {pi+1}: {period["start"]} to {period["end"]} ({period["duration"]}d)')
        print(f'    Trades: {len(period_trades)}  Wins: {len(wins)}  Losses: {len(losses)}')
        print(f'    Win rate: {len(wins)/len(period_trades)*100:.0f}%')
        print(f'    Total P&L: ${p_profit:.2f} per spread')
        for t in period_trades:
            result = 'WIN ' if t['profit'] > 0 else 'LOSS'
            print(f'      {t["entry_date"]} → {t["expiry_date"]}  SPY ${t["entry_price"]:.0f}  move={t["spy_move_pct"]:.2f}%  '
                  f'debit=${t["net_debit"]:.2f}  exit=${t["exit_value"]:.2f}  P&L=${t["profit"]:+.2f} ({t["profit_pct"]:+.0f}%)  {result}')

# Overall summary
print(f'\n' + '-' * 70)
print(f'CALENDAR SPREAD OVERALL SUMMARY')
print(f'-' * 70)

if all_trades:
    wins = [t for t in all_trades if t['profit'] > 0]
    losses = [t for t in all_trades if t['profit'] <= 0]
    profits = np.array([t['profit'] for t in all_trades])
    pct_returns = np.array([t['profit_pct'] for t in all_trades])

    print(f'  Total trades:    {len(all_trades)}')
    print(f'  Wins:            {len(wins)} ({len(wins)/len(all_trades)*100:.0f}%)')
    print(f'  Losses:          {len(losses)} ({len(losses)/len(all_trades)*100:.0f}%)')
    print(f'  Total P&L:       ${np.sum(profits):.2f} per spread')
    print(f'  Avg P&L/trade:   ${np.mean(profits):+.2f}')
    print(f'  Avg % return:    {np.mean(pct_returns):+.1f}%')
    print(f'  Avg debit:       ${np.mean([t["net_debit"] for t in all_trades]):.2f}')
    print(f'  Best trade:      ${np.max(profits):+.2f} ({np.max(pct_returns):+.0f}%)')
    print(f'  Worst trade:     ${np.min(profits):+.2f} ({np.min(pct_returns):+.0f}%)')

    avg_spy_move = np.mean([t['spy_move_pct'] for t in all_trades])
    print(f'  Avg SPY move at expiry: {avg_spy_move:.2f}%')

    # Breakeven analysis
    be_move = 1.5  # threshold where model shifts
    below = [t for t in all_trades if t['spy_move_pct'] < be_move]
    above = [t for t in all_trades if t['spy_move_pct'] >= be_move]
    print(f'\n  When SPY moved <1.5%: {len(below)} trades, avg P&L ${np.mean([t["profit"] for t in below]):+.2f}' if below else '')
    print(f'  When SPY moved >=1.5%: {len(above)} trades, avg P&L ${np.mean([t["profit"] for t in above]):+.2f}' if above else '')
else:
    print('  No trades simulated')

# ═══════════════════════════════════════════════════════════════════════════════
# ANALYSIS 2: Analyst Lag / Conviction Put Candidates
# ═══════════════════════════════════════════════════════════════════════════════

print(f'\n\n' + '=' * 70)
print('ANALYSIS 2: ANALYST LAG — CONVICTION PUT CANDIDATES')
print('=' * 70)
print('Stocks far from 52w high where analysts haven\'t caught up')
print('= real conviction put candidates')

# Load ticker intelligence
cur.execute("""
    SELECT ti.ticker,
           ti.earnings_date,
           ti.earnings_days_away,
           ti.earnings_avg_move_pct,
           ti.earnings_beat_rate,
           ti.analyst_price_target
    FROM lc_v3.ticker_intelligence ti
    WHERE ti.analyst_price_target IS NOT NULL
""")
intel_rows = cur.fetchall()

# Load latest prices from daily bars
cur.execute("""
    SELECT DISTINCT ON (ticker) ticker, close as last_close,
           DATE(ts AT TIME ZONE 'America/New_York') as last_date
    FROM lc_v3.bars
    WHERE session = 'REGULAR'
    ORDER BY ticker, ts DESC
""")
price_rows = cur.fetchall()
prices = {r['ticker']: {'close': float(r['last_close']), 'date': str(r['last_date'])} for r in price_rows}

# Load 52-week highs
cur.execute("""
    SELECT ticker, MAX(high) as high_52w
    FROM lc_v3.bars
    WHERE session = 'REGULAR'
      AND ts >= NOW() - INTERVAL '52 weeks'
    GROUP BY ticker
""")
high_rows = cur.fetchall()
highs_52w = {r['ticker']: float(r['high_52w']) for r in high_rows}

# Load fundamentals for revenue trend
cur.execute("""
    SELECT ticker, period, revenue, reported_at
    FROM lc_v3.fundamentals
    WHERE revenue IS NOT NULL
    ORDER BY ticker, reported_at DESC
""")
fund_rows = cur.fetchall()
fund_by_ticker = defaultdict(list)
for r in fund_rows:
    fund_by_ticker[r['ticker']].append({
        'period': r['period'],
        'revenue': float(r['revenue']),
        'reported_at': str(r['reported_at']) if r['reported_at'] else None,
    })

conn.close()

# Build candidate list
candidates = []
for row in intel_rows:
    ticker = row['ticker']
    if ticker not in prices or ticker not in highs_52w:
        continue

    current_price = prices[ticker]['close']
    high_52w = highs_52w[ticker]
    target = float(row['analyst_price_target'])
    pct_from_high = (current_price - high_52w) / high_52w * 100

    # Analyst lag: target is still high relative to current price
    target_upside = (target - current_price) / current_price * 100

    # Revenue trend
    quarters = fund_by_ticker.get(ticker, [])[:4]
    rev_declining = False
    declining_quarters = 0
    if len(quarters) >= 2:
        for i in range(len(quarters) - 1):
            if quarters[i]['revenue'] < quarters[i+1]['revenue']:
                declining_quarters += 1
            else:
                break
        rev_declining = declining_quarters >= 2

    candidates.append({
        'ticker': ticker,
        'price': current_price,
        'high_52w': high_52w,
        'pct_from_high': pct_from_high,
        'analyst_target': target,
        'target_upside': target_upside,
        'earnings_date': str(row['earnings_date']) if row['earnings_date'] else None,
        'earnings_days': row['earnings_days_away'],
        'beat_rate': float(row['earnings_beat_rate']) if row['earnings_beat_rate'] else None,
        'avg_move': float(row['earnings_avg_move_pct']) if row['earnings_avg_move_pct'] else None,
        'rev_declining': rev_declining,
        'declining_quarters': declining_quarters,
    })

# Sort by pct from high (most beaten down first)
candidates.sort(key=lambda x: x['pct_from_high'])

# Show all candidates with significant drawdown
print(f'\nTotal tickers with analyst data: {len(candidates)}')

# Analyst lag candidates: >15% below 52w high AND analyst target still implies >20% upside
lag_candidates = [c for c in candidates if c['pct_from_high'] < -15 and c['target_upside'] > 20]
print(f'Analyst lag candidates (>15% below high, analysts target >20% upside): {len(lag_candidates)}')

print(f'\n  {"Ticker":<8} {"Price":>8} {"52wHigh":>8} {"FromHigh":>9} {"Target":>8} {"Upside":>8} {"Earnings":>12} {"BeatRt":>7} {"RevDecl":>8}')
print(f'  {"─"*8} {"─"*8} {"─"*8} {"─"*9} {"─"*8} {"─"*8} {"─"*12} {"─"*7} {"─"*8}')

for c in lag_candidates:
    earn_str = c['earnings_date'][:10] if c['earnings_date'] and c['earnings_date'] != 'None' else '—'
    beat_str = f"{c['beat_rate']*100:.0f}%" if c['beat_rate'] is not None else '—'
    rev_str = f"YES({c['declining_quarters']}Q)" if c['rev_declining'] else 'no'
    print(f'  {c["ticker"]:<8} ${c["price"]:>7.2f} ${c["high_52w"]:>7.2f} {c["pct_from_high"]:>+8.1f}% ${c["analyst_target"]:>7.2f} {c["target_upside"]:>+7.1f}% {earn_str:>12} {beat_str:>7} {rev_str:>8}')

# Now show conviction put candidates: analyst lag + declining revenue
print(f'\n' + '-' * 70)
print(f'CONVICTION PUT CANDIDATES (analyst lag + declining revenue)')
print(f'-' * 70)

conviction_puts = [c for c in lag_candidates if c['rev_declining']]
print(f'  Candidates with declining revenue: {len(conviction_puts)}')

if conviction_puts:
    print(f'\n  {"Ticker":<8} {"Price":>8} {"FromHigh":>9} {"Target":>8} {"DeclQ":>6} {"Earnings":>12} {"BeatRt":>7}')
    print(f'  {"─"*8} {"─"*8} {"─"*9} {"─"*8} {"─"*6} {"─"*12} {"─"*7}')
    for c in conviction_puts:
        earn_str = c['earnings_date'][:10] if c['earnings_date'] and c['earnings_date'] != 'None' else '—'
        beat_str = f"{c['beat_rate']*100:.0f}%" if c['beat_rate'] is not None else '—'
        print(f'  {c["ticker"]:<8} ${c["price"]:>7.2f} {c["pct_from_high"]:>+8.1f}% ${c["analyst_target"]:>7.2f} {c["declining_quarters"]:>5}Q {earn_str:>12} {beat_str:>7}')

# Broader view: all stocks >20% below high
print(f'\n' + '-' * 70)
print(f'ALL STOCKS >20% BELOW 52-WEEK HIGH')
print(f'-' * 70)

deep_drawdown = [c for c in candidates if c['pct_from_high'] < -20]
print(f'  Count: {len(deep_drawdown)}')

if deep_drawdown:
    print(f'\n  {"Ticker":<8} {"Price":>8} {"52wHigh":>8} {"FromHigh":>9} {"Target":>8} {"Gap":>8} {"RevDecl":>8} {"Earnings":>12}')
    print(f'  {"─"*8} {"─"*8} {"─"*8} {"─"*9} {"─"*8} {"─"*8} {"─"*8} {"─"*12}')
    for c in deep_drawdown:
        # Gap = how far analyst target is from 52w high (negative = analysts already lowered)
        target_vs_high = (c['analyst_target'] - c['high_52w']) / c['high_52w'] * 100
        earn_str = c['earnings_date'][:10] if c['earnings_date'] and c['earnings_date'] != 'None' else '—'
        rev_str = f"YES({c['declining_quarters']}Q)" if c['rev_declining'] else 'no'
        print(f'  {c["ticker"]:<8} ${c["price"]:>7.2f} ${c["high_52w"]:>7.2f} {c["pct_from_high"]:>+8.1f}% ${c["analyst_target"]:>7.2f} {target_vs_high:>+7.1f}% {rev_str:>8} {earn_str:>12}')

# Summary stats
print(f'\n' + '=' * 70)
print(f'SUMMARY')
print(f'=' * 70)
print(f'  Tickers analyzed: {len(candidates)}')
print(f'  >15% below 52w high: {len([c for c in candidates if c["pct_from_high"] < -15])}')
print(f'  >20% below 52w high: {len(deep_drawdown)}')
print(f'  Analyst lag (>15% down, target >20% upside): {len(lag_candidates)}')
print(f'  Conviction puts (lag + declining rev): {len(conviction_puts)}')

rev_decl_all = [c for c in candidates if c['rev_declining']]
print(f'  Tickers with declining revenue (2+Q): {len(rev_decl_all)}')

print()

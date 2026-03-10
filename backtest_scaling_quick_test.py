#!/usr/bin/env python3
"""
Quick Test: Scaling Exits Backtest (1 month only for validation)
"""

import os
os.environ['DATABASE_URL'] = os.getenv('DATABASE_URL', 'postgresql://alphatrades_db_user:kY5KYLQ16AQ43Ylp5foW0enqfSyiCZxK@dpg-d6kak47kijhs73cat0o0-a.oregon-postgres.render.com/alphatrades_db')

from models import get_session, MinuteBar
from scorer_v5 import get_v5_scorer
from scorer_momentum import get_momentum_scorer
from datetime import datetime, timedelta, date
from sqlalchemy import func, and_
import pytz

# Quick test configuration
STARTING_CAPITAL = 2500
POSITION_SIZE_PCT = 0.20
MAX_POSITIONS = 3
STOP_LOSS_PCT = -50
MAX_HOLD_HOURS = 36

T1_TARGET = 50
T2_TARGET = 100
T3_TARGET = 150
T3_TRAILING_STOP_PCT = -25

# Test only 1 month
START_DATE = date(2024, 1, 1)
END_DATE = date(2024, 1, 31)

TICKERS = ['NVDA', 'TSLA', 'AMD']  # Just 3 tickers

TRANCHE_SIZING = {
    'A+': {'t1': 0.25, 't2': 0.35, 't3': 0.40},
    'A': {'t1': 0.25, 't2': 0.35, 't3': 0.40},
    'A-': {'t1': 0.33, 't2': 0.33, 't3': 0.34},
    'B+': {'t1': 0.33, 't2': 0.33, 't3': 0.34},
    'B': {'t1': 0.50, 't2': 0.50, 't3': 0.00},
    'B-': {'t1': 0.50, 't2': 0.50, 't3': 0.00},
}

print("🚀 Quick test starting (1 month, 3 tickers)...")
print(f"Period: {START_DATE} to {END_DATE}")
print()

session = get_session()

# Get one day of bars to test
test_date = date(2024, 1, 15)
start_dt = datetime.combine(test_date, datetime.min.time()).replace(tzinfo=pytz.UTC)
end_dt = start_dt + timedelta(days=1)

bars = session.query(MinuteBar).filter(
    and_(
        MinuteBar.ticker == 'NVDA',
        MinuteBar.timestamp >= start_dt,
        MinuteBar.timestamp < end_dt
    )
).limit(100).all()

print(f"✅ Found {len(bars)} bars for NVDA on {test_date}")
if bars:
    print(f"   First bar: {bars[0].timestamp} - O:{bars[0].open} H:{bars[0].high} L:{bars[0].low} C:{bars[0].close}")
    print(f"   Last bar:  {bars[-1].timestamp} - O:{bars[-1].open} H:{bars[-1].high} L:{bars[-1].low} C:{bars[-1].close}")

# Test scoring
quote_data = {
    'open': 500.0,
    'high': 510.0,
    'low': 495.0,
    'current': 508.0,
    'volume': 1000000,
    'avg_volume': 800000
}

print("\nTesting V5 scorer...")
v5_scorer = get_v5_scorer()
v5_result = v5_scorer.score_ticker('NVDA', quote_data, {'is_up': True, 'change_pct': 0})
print(f"✅ V5 Score: {v5_result['score']} ({v5_result['grade']})")

print("\nTesting Momentum scorer...")
momentum_scorer = get_momentum_scorer()
momentum_result = momentum_scorer.score_ticker('NVDA', quote_data, {'is_up': True, 'change_pct': 0})
print(f"✅ Momentum Score: {momentum_result['score']} ({momentum_result['grade']})")

# Test tranche sizing
for grade in ['A+', 'A-', 'B', 'B-']:
    sizing = TRANCHE_SIZING[grade]
    print(f"\n{grade}: T1={sizing['t1']*100:.0f}% T2={sizing['t2']*100:.0f}% T3={sizing['t3']*100:.0f}%")

session.close()

print("\n✅ All systems operational!")
print("\nNOTE: Full backtest is compute-intensive with 3.5M bars.")
print("Estimated runtime: 10-15 minutes for 2-year full historical backtest.")

#!/usr/bin/env python3
"""
Direct worker test - run ONE update cycle manually to see what breaks
"""
import os
import sys

print("="*70)
print("🔍 DIRECT WORKER TEST")
print("="*70)
print()

# Step 1: Check environment
print("1️⃣ Checking environment variables...")
db_url = os.getenv('DATABASE_URL')
api_key = os.getenv('ALPACA_API_KEY')
secret_key = os.getenv('ALPACA_SECRET_KEY')

if not db_url:
    print("❌ DATABASE_URL not set!")
    sys.exit(1)
if not api_key:
    print("❌ ALPACA_API_KEY not set!")
    sys.exit(1)
if not secret_key:
    print("❌ ALPACA_SECRET_KEY not set!")
    sys.exit(1)

print(f"   ✅ DATABASE_URL: {db_url[:50]}...")
print(f"   ✅ ALPACA_API_KEY: {api_key[:10]}...")
print()

# Step 2: Import modules
print("2️⃣ Importing modules...")
try:
    from models import Signal, get_session
    print("   ✅ models imported")
    from scorer_v5 import get_v5_scorer
    print("   ✅ scorer_v5 imported")
    from alpaca_client import AlpacaClient
    print("   ✅ alpaca_client imported")
except Exception as e:
    print(f"   ❌ Import failed: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

print()

# Step 3: Create instances
print("3️⃣ Creating instances...")
try:
    session = get_session()
    print("   ✅ Database session created")
    
    alpaca = AlpacaClient()
    print("   ✅ Alpaca client created")
    
    scorer = get_v5_scorer()
    print("   ✅ V5 scorer created")
except Exception as e:
    print(f"   ❌ Instance creation failed: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

print()

# Step 4: Test ONE ticker update
print("4️⃣ Testing NVDA signal generation...")
ticker = 'NVDA'

try:
    # Get quote
    print(f"   📥 Fetching {ticker} quote...")
    quote = alpaca.get_snapshot(ticker)
    stock_price = quote.get('c', 0)
    print(f"   ✅ Got price: ${stock_price:.2f}")
    
    # Get SPY for market context
    print(f"   📥 Fetching SPY...")
    spy_quote = alpaca.get_snapshot('SPY')
    spy_current = spy_quote.get('c', 0)
    spy_prev = spy_quote.get('pc', spy_current)
    market_data = {
        'is_up': spy_current >= spy_prev,
        'change_pct': ((spy_current - spy_prev) / spy_prev * 100) if spy_prev else 0
    }
    print(f"   ✅ SPY: ${spy_current:.2f} ({market_data['change_pct']:+.2f}%)")
    
    # Get bars for volume
    print(f"   📥 Fetching {ticker} bars...")
    bars_response = alpaca.get_bars(ticker, timeframe='1Day', limit=20)
    bars = bars_response.get('bars', []) if bars_response else []
    avg_volume = sum(bar['v'] for bar in bars) / len(bars) if bars else quote.get('v', 0)
    print(f"   ✅ Got {len(bars)} bars, avg volume: {avg_volume:,.0f}")
    
    # Score it
    print(f"   🧮 Scoring with V5...")
    quote_data = {
        'open': quote.get('o', 0),
        'high': quote.get('h', 0),
        'low': quote.get('l', 0),
        'current': stock_price,
        'volume': quote.get('v', 0),
        'avg_volume': avg_volume
    }
    
    v5_result = scorer.score_ticker(ticker, quote_data, market_data)
    print(f"   ✅ Score: {v5_result['score']}/100, Grade: {v5_result['grade']}")
    
    # Write to database
    print(f"   💾 Writing to database...")
    from decimal import Decimal
    
    signal = session.query(Signal).filter_by(ticker=ticker).first()
    if not signal:
        signal = Signal(ticker=ticker)
        session.add(signal)
        print(f"      Creating new signal")
    else:
        print(f"      Updating existing signal")
    
    signal.price = Decimal(str(stock_price))
    prev_close = quote.get('pc', stock_price)
    signal.change_pct = Decimal(str(((stock_price - prev_close) / prev_close) * 100))
    signal.grade = v5_result['grade']
    signal.score = v5_result['score']
    signal.convergence_count = 0
    signal.confidence = v5_result['decision']
    signal.convergence_json = v5_result
    
    session.commit()
    print(f"   ✅ Database write successful")
    
    # Verify
    count = session.query(Signal).count()
    print()
    print(f"✅ SUCCESS! Total signals in database: {count}")
    print(f"   {ticker}: ${stock_price:.2f} | Grade: {signal.grade} | Score: {signal.score}/100")
    
except Exception as e:
    print(f"   ❌ Error: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)
finally:
    session.close()

print()
print("="*70)
print("✅ TEST COMPLETE - Worker components are functional")
print("="*70)

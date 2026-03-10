"""
Quick test to see if worker can actually update signals
"""
import os
os.environ['DATABASE_URL'] = 'postgresql://alphatrades_db_user:kY5KYLQ16AQ43Ylp5foW0enqfSyiCZxK@dpg-d6kak47kijhs73cat0o0-a.oregon-postgres.render.com/alphatrades_db'
os.environ['ALPACA_API_KEY'] = 'PKCF3BAQSFQEWDQRLG45SZIMMQ'
os.environ['ALPACA_SECRET_KEY'] = 'DFJXX1qz33tPgYxQdVAhhYt4QXmp4zFGHbiaFrCaiQkk'

print("🔍 Testing worker signal generation...")
print()

try:
    print("1. Importing modules...")
    from models import Signal, get_session
    from scorer_v5 import get_v5_scorer
    from alpaca_client import AlpacaClient
    print("   ✅ Imports successful")
    
    print("\n2. Creating AlpacaClient...")
    alpaca = AlpacaClient()
    print("   ✅ AlpacaClient created")
    
    print("\n3. Testing SPY snapshot...")
    spy_quote = alpaca.get_snapshot('SPY')
    print(f"   ✅ SPY: ${spy_quote.get('c', 0):.2f}")
    
    print("\n4. Creating V5 scorer...")
    scorer = get_v5_scorer()
    print("   ✅ Scorer created")
    
    print("\n5. Testing NVDA signal generation...")
    quote = alpaca.get_snapshot('NVDA')
    print(f"   Got quote: ${quote.get('c', 0):.2f}")
    
    # Try to score it
    stock_data = {
        'ticker': 'NVDA',
        'current_price': quote.get('c', 0),
        'open': quote.get('o', 0),
        'high': quote.get('h', 0),
        'low': quote.get('l', 0),
        'volume': quote.get('v', 0),
        'prev_close': quote.get('pc', 0),
    }
    
    print("\n6. Scoring NVDA...")
    result = scorer.score(stock_data, market_data={'is_up': True, 'change_pct': 0.5})
    print(f"   ✅ Score: {result.get('score', 0)}, Grade: {result.get('grade', 'N/A')}")
    
    print("\n7. Writing to database...")
    session = get_session()
    
    # Check if signal exists
    existing = session.query(Signal).filter_by(ticker='NVDA').first()
    if existing:
        print(f"   Found existing signal for NVDA")
        existing.score = result.get('score', 0)
        existing.grade = result.get('grade', 'F')
        existing.price = stock_data['current_price']
        print(f"   Updating...")
    else:
        print(f"   Creating new signal for NVDA")
        signal = Signal(
            ticker='NVDA',
            price=stock_data['current_price'],
            score=result.get('score', 0),
            grade=result.get('grade', 'F'),
            convergence_count=0,
            confidence='medium'
        )
        session.add(signal)
    
    session.commit()
    print("   ✅ Database write successful")
    
    # Verify
    count = session.query(Signal).count()
    print(f"\n✅ SUCCESS! Signals in database: {count}")
    session.close()
    
except Exception as e:
    print(f"\n❌ ERROR: {e}")
    import traceback
    traceback.print_exc()

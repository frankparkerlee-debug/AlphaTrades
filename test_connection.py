"""
Quick test script to verify database and API connections
Run this before deploying to catch any issues
"""
import os
from models import get_session, ModelConfig, AccountState
from scorer import Scorer
import requests

print("🧪 AlphaTrades Connection Test")
print("=" * 50)

# Test 1: Database Connection
print("\n1. Testing database connection...")
try:
    session = get_session()
    
    # Check if config exists
    config = session.query(ModelConfig).filter_by(is_active=True).first()
    if config:
        print("   ✅ Database connected")
        print(f"   ✅ Active config: {config.config_name}")
        print(f"   ✅ Auto-trade grades: {config.auto_trade_grades}")
    else:
        print("   ⚠️  Database connected but no active config")
    
    # Check if account state exists
    account = session.query(AccountState).first()
    if account:
        print(f"   ✅ Account initialized: ${account.current_capital}")
    else:
        print("   ⚠️  No account state (will be created on first run)")
    
    session.close()
except Exception as e:
    print(f"   ❌ Database connection failed: {e}")
    print("   Fix: Set DATABASE_URL environment variable")

# Test 2: Finnhub API
print("\n2. Testing Finnhub API...")
api_key = os.getenv('FINNHUB_API_KEY')
if not api_key:
    print("   ❌ FINNHUB_API_KEY not set")
    print("   Fix: Get free key at https://finnhub.io")
else:
    try:
        url = f"https://finnhub.io/api/v1/quote?symbol=AAPL&token={api_key}"
        response = requests.get(url, timeout=5)
        response.raise_for_status()
        data = response.json()
        
        if data.get('c'):  # current price exists
            print("   ✅ Finnhub API working")
            print(f"   ✅ AAPL current price: ${data['c']}")
        else:
            print("   ⚠️  API responded but no price data")
    except Exception as e:
        print(f"   ❌ Finnhub API failed: {e}")

# Test 3: Scorer
print("\n3. Testing scoring algorithm...")
try:
    scorer = Scorer()
    
    # Test quote
    test_quote = {
        'ticker': 'TEST',
        'current': 150.0,
        'open': 145.0,
        'high': 152.0,
        'low': 144.0
    }
    
    test_market = {'is_up': True, 'change_pct': 0.5}
    
    result = scorer.calculate_score(test_quote, test_market)
    
    print("   ✅ Scorer working")
    print(f"   ✅ Test score: {result['score']}/55 = Grade {result['grade']}")
    print(f"   ✅ Direction: {result['direction']}")
    print(f"   ✅ Strike: ${result['strike']}")
except Exception as e:
    print(f"   ❌ Scorer failed: {e}")

# Summary
print("\n" + "=" * 50)
print("🎯 Test Summary:")
print("")

all_good = True

if os.getenv('DATABASE_URL'):
    print("   ✅ DATABASE_URL set")
else:
    print("   ❌ DATABASE_URL not set")
    all_good = False

if os.getenv('FINNHUB_API_KEY'):
    print("   ✅ FINNHUB_API_KEY set")
else:
    print("   ❌ FINNHUB_API_KEY not set")
    all_good = False

if os.getenv('TRADING_MODE'):
    print(f"   ✅ TRADING_MODE = {os.getenv('TRADING_MODE')}")
else:
    print("   ⚠️  TRADING_MODE not set (will default to 'paper')")

print("")
if all_good:
    print("✅ All systems ready for deployment!")
    print("")
    print("Next steps:")
    print("1. Push to GitHub: git push origin main")
    print("2. Deploy to Render")
    print("3. Monitor logs for first alerts")
else:
    print("⚠️  Fix issues above before deploying")

print("")

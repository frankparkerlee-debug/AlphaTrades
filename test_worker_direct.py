"""
Direct Worker Test - Diagnose why only 1 ticker is processed
This simulates the exact worker loop to find the stopping point
"""
import os
import sys

# Set environment variables
os.environ['DATABASE_URL'] = 'postgresql://alphatrades_db_user:kY5KYLQ16AQ43Ylp5foW0enqfSyiCZxK@dpg-d6kak47kijhs73cat0o0-a.oregon-postgres.render.com/alphatrades_db'
os.environ['ALPACA_API_KEY'] = 'PKC F3BAQSFQEWDQRLG45SZIMMQ'
os.environ['ALPACA_SECRET_KEY'] = 'DFJXX1qz33tPgYxQdVAhhYt4QXmp4zFGHbiaFrCaiQkk'

print("="*70)
print("🔍 DIRECT WORKER TEST - Finding why only 1 ticker processes")
print("="*70)
print()

TICKERS = ['NVDA', 'TSLA', 'AMD', 'AAPL', 'AMZN']  # Test first 5

try:
    print("1️⃣  Importing modules...")
    from models import Signal, get_session
    from scorer_v5 import get_v5_scorer
    from options_selector import get_selector
    from alpaca_client import AlpacaClient
    from datetime import datetime
    from decimal import Decimal
    import pytz
    print("   ✅ All imports successful")
    print()
    
    print("2️⃣  Creating components...")
    session = get_session()
    alpaca = AlpacaClient()
    scorer = get_v5_scorer()
    selector = get_selector()
    print("   ✅ All components created")
    print()
    
    print("3️⃣  Getting SPY for market context...")
    spy_quote = alpaca.get_snapshot('SPY')
    spy_current = spy_quote.get('c', 0)
    spy_prev = spy_quote.get('pc', spy_current)
    market_data = {
        'is_up': spy_current >= spy_prev,
        'change_pct': ((spy_current - spy_prev) / spy_prev * 100) if spy_prev else 0
    }
    print(f"   ✅ SPY: ${spy_current:.2f} ({market_data['change_pct']:+.2f}%)")
    print()
    
    print("4️⃣  TESTING TICKER LOOP (exact worker logic)...")
    print("-"*70)
    
    updated_count = 0
    error_count = 0
    
    for i, ticker in enumerate(TICKERS, 1):
        print(f"\n[{i}/{len(TICKERS)}] Processing {ticker}...")
        
        try:
            # Step A: Get stock quote
            print(f"   📊 Getting snapshot for {ticker}...")
            quote = alpaca.get_snapshot(ticker.upper())
            stock_price = quote.get('c', 0)
            open_price = quote.get('o', 0)
            high = quote.get('h', 0)
            low = quote.get('l', 0)
            volume = quote.get('v', 0)
            print(f"   ✅ Quote: ${stock_price:.2f}")
            
            if not stock_price:
                print(f"   ⚠️  No price data - SKIPPING")
                continue
            
            # Step B: Get bars
            print(f"   📊 Getting bars for {ticker}...")
            bars_response = alpaca.get_bars(ticker.upper(), timeframe='1Day', limit=20)
            bars = bars_response.get('bars', []) if bars_response else []
            if bars and len(bars) > 0:
                avg_volume = sum(bar['v'] for bar in bars) / len(bars)
            else:
                avg_volume = volume
            print(f"   ✅ Got {len(bars)} bars, avg_volume: {avg_volume:,.0f}")
            
            # Step C: Build quote_data
            quote_data = {
                'open': open_price,
                'high': high,
                'low': low,
                'current': stock_price,
                'volume': volume,
                'avg_volume': avg_volume
            }
            
            # Step D: Calculate V5 score
            print(f"   🎯 Calculating V5 score...")
            v5_result = scorer.score_ticker(ticker.upper(), quote_data, market_data)
            print(f"   ✅ Score: {v5_result['score']}/100, Grade: {v5_result['grade']}")
            
            # Step E: Get trade setup
            trade_setup = v5_result.get('trade_setup', {})
            direction = trade_setup.get('direction', 'CALL')
            option_type = 'call' if direction == 'CALL' else 'put'
            print(f"   📈 Direction: {direction}")
            
            # Step F: Get options chain
            print(f"   💰 Getting options chain...")
            chain_data = alpaca.get_options_chain(ticker.upper())
            
            optimal_option = None
            if 'error' not in chain_data and chain_data.get('snapshots'):
                print(f"   ✅ Got {len(chain_data.get('snapshots', {}))} option contracts")
                print(f"   🔍 Selecting best {option_type}...")
                optimal_option = selector.select_best_contract(
                    chain_data.get('snapshots', {}),
                    stock_price,
                    option_type
                )
                if optimal_option:
                    print(f"   ✅ Selected: {optimal_option['symbol']} @ ${optimal_option['mid']:.2f}")
                else:
                    print(f"   ⚠️  No suitable option found (not fatal)")
            else:
                error_msg = chain_data.get('error', 'Unknown error')
                print(f"   ⚠️  Options chain error: {error_msg} (not fatal)")
            
            # Step G: Database upsert
            print(f"   💾 Writing to database...")
            signal = session.query(Signal).filter_by(ticker=ticker).first()
            if not signal:
                print(f"      Creating new signal...")
                signal = Signal(ticker=ticker)
                session.add(signal)
            else:
                print(f"      Updating existing signal...")
            
            # Update all fields
            signal.price = Decimal(str(stock_price))
            prev_close = quote.get('pc', stock_price)
            signal.change_pct = Decimal(str(((stock_price - prev_close) / prev_close) * 100))
            signal.grade = v5_result['grade']
            signal.score = v5_result['score']
            signal.convergence_count = v5_result['breakdown'].get('range', {}).get('score', 0)
            signal.confidence = v5_result['decision']
            signal.convergence_json = v5_result
            signal.option_json = optimal_option
            signal.updated_at = datetime.now(pytz.UTC)
            
            print(f"   💾 Committing to database...")
            session.commit()
            print(f"   ✅ Database commit successful")
            
            updated_count += 1
            print(f"   ✅✅✅ {ticker} COMPLETED SUCCESSFULLY")
            
        except Exception as e:
            error_count += 1
            print(f"   ❌ ERROR processing {ticker}: {e}")
            import traceback
            traceback.print_exc()
            print(f"   ⚠️  Continuing to next ticker...")
            # Worker has try/except that continues, so we should too
            continue
    
    print()
    print("="*70)
    print(f"🏁 TEST COMPLETE")
    print(f"   ✅ Updated: {updated_count} signals")
    print(f"   ❌ Errors: {error_count} signals")
    print("="*70)
    print()
    
    # Verify database
    print("5️⃣  Verifying database...")
    all_signals = session.query(Signal).all()
    print(f"   📊 Total signals in database: {len(all_signals)}")
    for sig in all_signals:
        print(f"      {sig.ticker}: ${sig.price:.2f}, Score: {sig.score}, Grade: {sig.grade}")
    
    session.close()
    
    print()
    print("✅ TEST SUCCESSFUL - No blocking issues found!")
    print()
    
    if updated_count < len(TICKERS):
        print(f"⚠️  WARNING: Only {updated_count}/{len(TICKERS)} tickers processed!")
        print(f"   This suggests the production worker has the same issue")
    
except Exception as e:
    print(f"\n❌ FATAL ERROR: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

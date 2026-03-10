#!/usr/bin/env python3
"""
Test script for Overnight Gap Momentum Scanner
Verifies scanner logic and finds setups
"""
import os
import sys
from datetime import datetime
from overnight_gap_scanner import OvernightGapScanner
from tech_100 import get_tech_100

def test_scanner():
    """Test the overnight gap scanner"""
    print("=" * 60)
    print("OVERNIGHT GAP MOMENTUM SCANNER TEST")
    print("=" * 60)
    print()
    
    # Initialize scanner
    print("Initializing scanner...")
    scanner = OvernightGapScanner()
    
    # Test with a few sample symbols first
    test_symbols = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMD']
    
    print(f"\nTesting scanner with sample symbols: {', '.join(test_symbols)}")
    print("-" * 60)
    
    for symbol in test_symbols:
        print(f"\nScanning {symbol}...")
        try:
            result = scanner.scan_symbol(symbol)
            
            if result:
                print(f"✅ Setup found!")
                print(f"   Score: {result['score']}")
                print(f"   Direction: {result['direction']}")
                print(f"   Current Price: ${result['current_price']:.2f}")
                print(f"   Suggested Strike: ${result['suggested_strike']:.2f}")
                print(f"   Intraday Change: {result['intraday_change']:.2f}%")
                print(f"   RSI: {result['rsi']:.1f}")
                print(f"   Volume Increase: {result['volume_increase']:.1f}%")
                print(f"   Breakdown: Momentum={result['breakdown']['momentum']}, "
                      f"Volume={result['breakdown']['volume']}, "
                      f"Technical={result['breakdown']['technical']}, "
                      f"KeyLevel={result['breakdown']['key_level']}, "
                      f"Time={result['breakdown']['time_of_day']}")
            else:
                print(f"   No setup found (score too low or insufficient data)")
                
        except Exception as e:
            print(f"❌ Error scanning {symbol}: {e}")
    
    # Now run full scan
    print("\n" + "=" * 60)
    print("RUNNING FULL SCAN (Top 100 Tech Stocks)")
    print("=" * 60)
    print(f"Started at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print()
    
    try:
        results = scanner.scan_all(min_score=60)
        
        print(f"\n✅ Scan complete!")
        print(f"   Found {len(results)} setups with score >= 60")
        print()
        
        if results:
            print("-" * 60)
            print("TOP SETUPS:")
            print("-" * 60)
            
            for i, setup in enumerate(results[:10], 1):  # Show top 10
                print(f"\n{i}. {setup['ticker']} - Score: {setup['score']}")
                print(f"   Direction: {setup['direction']}")
                print(f"   Price: ${setup['current_price']:.2f}")
                print(f"   Strike: ${setup['suggested_strike']:.2f} ({setup['suggested_expiry']})")
                print(f"   Entry: {setup['entry_range']}")
                print(f"   Target: ${setup['target_level']:.2f}")
                print(f"   Intraday: {setup['intraday_change']:.2f}% | "
                      f"RSI: {setup['rsi']:.1f} | "
                      f"Vol +{setup['volume_increase']:.1f}%")
        else:
            print("No setups found matching criteria (score >= 60)")
            print("This may be normal if:")
            print("  - Market is closed or after hours")
            print("  - No strong midday momentum currently")
            print("  - Try running during market hours (11 AM - 2 PM ET best)")
        
    except Exception as e:
        print(f"\n❌ Error during full scan: {e}")
        import traceback
        traceback.print_exc()
        return False
    
    print("\n" + "=" * 60)
    print("TEST COMPLETE")
    print("=" * 60)
    return True

if __name__ == '__main__':
    # Load environment variables
    from dotenv import load_dotenv
    load_dotenv('.env.alpaca')
    
    test_scanner()

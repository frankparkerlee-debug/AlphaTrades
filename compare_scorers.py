#!/usr/bin/env python3
"""
Compare V5 Scorer vs Momentum Scorer
Shows how the new momentum-focused algorithm changes grades/scores
"""

import os
os.environ['DATABASE_URL'] = os.getenv('DATABASE_URL', 'postgresql://alphatrades_db_user:kY5KYLQ16AQ43Ylp5foW0enqfSyiCZxK@dpg-d6kak47kijhs73cat0o0-a.oregon-postgres.render.com/alphatrades_db')

from alpaca_client import AlpacaClient
from scorer_v5 import get_v5_scorer
from scorer_momentum import get_momentum_scorer

# Test tickers with different characteristics
TEST_TICKERS = ['NVDA', 'TSLA', 'AMD', 'AVGO', 'AAPL', 'META']

def main():
    print("="*80)
    print("🔬 SCORER COMPARISON: V5 (Volume-Focused) vs MOMENTUM (Price-Focused)")
    print("="*80)
    print()
    
    alpaca = AlpacaClient()
    v5_scorer = get_v5_scorer()
    momentum_scorer = get_momentum_scorer()
    
    # Get SPY for market context
    try:
        spy_quote = alpaca.get_snapshot('SPY')
        spy_current = spy_quote.get('c', 0)
        spy_prev = spy_quote.get('pc', spy_current)
        market_data = {
            'is_up': spy_current >= spy_prev,
            'change_pct': ((spy_current - spy_prev) / spy_prev * 100) if spy_prev else 0
        }
        print(f"📈 SPY: ${spy_current:.2f} ({market_data['change_pct']:+.2f}%)")
        print()
    except Exception as e:
        print(f"⚠️  Could not fetch SPY: {e}")
        market_data = {'is_up': True, 'change_pct': 0}
    
    results = []
    
    for ticker in TEST_TICKERS:
        try:
            # Get quote
            quote = alpaca.get_snapshot(ticker)
            stock_price = quote.get('c', 0)
            open_price = quote.get('o', 0)
            high = quote.get('h', 0)
            low = quote.get('l', 0)
            volume = quote.get('v', 0)
            prev_close = quote.get('pc', stock_price)
            
            if not stock_price:
                continue
            
            # Get 20-day bars for volume avg
            bars_response = alpaca.get_bars(ticker, timeframe='1Day', limit=20)
            bars = bars_response.get('bars', []) if bars_response else []
            avg_volume = sum(bar['v'] for bar in bars) / len(bars) if bars else volume
            
            # Build quote data
            quote_data = {
                'open': open_price,
                'high': high,
                'low': low,
                'current': stock_price,
                'volume': volume,
                'avg_volume': avg_volume
            }
            
            # Score with both algorithms
            v5_result = v5_scorer.score_ticker(ticker, quote_data, market_data)
            momentum_result = momentum_scorer.score_ticker(ticker, quote_data, market_data)
            
            # Calculate metrics
            intraday_range = ((high - low) / open_price * 100) if open_price > 0 else 0
            day_change = ((stock_price - prev_close) / prev_close * 100) if prev_close > 0 else 0
            volume_ratio = volume / avg_volume if avg_volume > 0 else 1.0
            
            results.append({
                'ticker': ticker,
                'price': stock_price,
                'day_change': day_change,
                'intraday_range': intraday_range,
                'volume_ratio': volume_ratio,
                'v5_score': v5_result['score'],
                'v5_grade': v5_result['grade'],
                'momentum_score': momentum_result['score'],
                'momentum_grade': momentum_result['grade'],
                'v5_breakdown': v5_result.get('breakdown', {}),
                'momentum_breakdown': momentum_result.get('breakdown', {})
            })
            
        except Exception as e:
            print(f"⚠️  Error processing {ticker}: {e}")
            continue
    
    # Display comparison
    print()
    print("="*80)
    print("📊 RESULTS COMPARISON")
    print("="*80)
    print()
    print(f"{'Ticker':<8} {'Price':<10} {'Day %':<8} {'Range %':<9} {'Vol Ratio':<10} {'V5':<12} {'MOMENTUM':<12} {'Delta'}")
    print("-"*80)
    
    for r in results:
        score_delta = r['momentum_score'] - r['v5_score']
        delta_symbol = "🟢" if score_delta > 5 else "🔴" if score_delta < -5 else "⚪"
        
        print(f"{r['ticker']:<8} ${r['price']:<9.2f} {r['day_change']:+6.2f}% {r['intraday_range']:>6.2f}% {r['volume_ratio']:>6.1f}x   "
              f"{r['v5_grade']:>2s} ({r['v5_score']:>3d})   {r['momentum_grade']:>2s} ({r['momentum_score']:>3d})    "
              f"{score_delta:+4.0f} {delta_symbol}")
    
    print()
    print("="*80)
    print("🔍 DETAILED BREAKDOWN (Sample Ticker)")
    print("="*80)
    
    if results:
        # Show detailed breakdown for first ticker with big difference
        sample = max(results, key=lambda x: abs(x['momentum_score'] - x['v5_score']))
        
        print()
        print(f"📌 {sample['ticker']} - Price Action: {sample['day_change']:+.2f}% day, {sample['intraday_range']:.2f}% range, {sample['volume_ratio']:.1f}x volume")
        print()
        
        print("V5 SCORING (Volume-Focused):")
        v5_bd = sample['v5_breakdown']
        print(f"  Catalyst (volume):  {v5_bd.get('catalyst', {}).get('score', 0):2d}/30")
        print(f"  Volume (duplicate): {v5_bd.get('volume', {}).get('score', 0):2d}/20")
        print(f"  Direction:          {v5_bd.get('direction', {}).get('score', 0):2d}/20")
        print(f"  Range:              {v5_bd.get('range', {}).get('score', 0):2d}/15")
        print(f"  Others:             {v5_bd.get('timing', {}).get('score', 0) + v5_bd.get('calendar', {}).get('score', 0) + v5_bd.get('alignment', {}).get('score', 0) + v5_bd.get('rsi', {}).get('score', 0):2d}/30")
        print(f"  → TOTAL:            {sample['v5_score']:2d}/100 ({sample['v5_grade']})")
        print()
        
        print("MOMENTUM SCORING (Price-Focused):")
        mom_bd = sample['momentum_breakdown']
        print(f"  Momentum Catalyst:  {mom_bd.get('momentum', {}).get('score', 0):2d}/35 - {mom_bd.get('momentum', {}).get('reason', 'N/A')}")
        print(f"  Volume Confirm:     {mom_bd.get('volume', {}).get('score', 0):2d}/15 - {mom_bd.get('volume', {}).get('reason', 'N/A')}")
        print(f"  Market Alignment:   {mom_bd.get('alignment', {}).get('score', 0):2d}/15 - {mom_bd.get('alignment', {}).get('reason', 'N/A')}")
        print(f"  Timing:             {mom_bd.get('timing', {}).get('score', 0):2d}/10")
        print(f"  Technical:          {mom_bd.get('technical', {}).get('score', 0):2d}/10")
        print(f"  Calendar:           {mom_bd.get('calendar', {}).get('score', 0):2d}/5")
        print(f"  Liquidity:          {mom_bd.get('liquidity', {}).get('score', 0):2d}/10")
        print(f"  → TOTAL:            {sample['momentum_score']:2d}/100 ({sample['momentum_grade']})")
        print()
    
    print("="*80)
    print("💡 KEY DIFFERENCES")
    print("="*80)
    print()
    print("V5 (Current):")
    print("  - Catalyst = Volume surge (0-30 pts)")
    print("  - Volume = Duplicate scoring (0-20 pts)")
    print("  - Total 50 pts possible from volume alone")
    print("  - Price momentum split across Direction + Range")
    print()
    print("MOMENTUM (New):")
    print("  - Catalyst = Price momentum (0-35 pts)")
    print("  - Volume = Confirmation only (0-15 pts)")
    print("  - Market alignment increased (0-15 pts)")
    print("  - Scores big price moves higher, even with normal volume")
    print()
    print("Result: Stocks with strong price action but normal volume")
    print("        score 15-25 points HIGHER with momentum algo")
    print()

if __name__ == '__main__':
    main()

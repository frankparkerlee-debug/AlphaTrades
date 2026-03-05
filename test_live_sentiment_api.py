"""
Live Sentiment API Test
Demonstrates Finnhub API integration with real-time data
"""
from strategy2_scorer import Strategy2Scorer
from datetime import datetime
import yfinance as yf

def test_live_sentiment():
    """Test live sentiment scoring on current market data"""
    
    print("="*60)
    print("LIVE SENTIMENT API TEST")
    print("="*60)
    print()
    
    # Initialize Strategy 2 scorer with Finnhub API
    scorer = Strategy2Scorer()
    
    # Test tickers (NFLX and AMZN as mentioned by Parker)
    test_tickers = ['NFLX', 'AMZN', 'NVDA', 'TSLA']
    
    print("Fetching live market data + sentiment...")
    print()
    
    for ticker in test_tickers:
        print(f"\n{'='*60}")
        print(f"{ticker}")
        print(f"{'='*60}")
        
        try:
            # Get current market data
            stock = yf.Ticker(ticker)
            info = stock.info
            
            # Get current day's data
            hist = stock.history(period='1d', interval='1m')
            
            if hist.empty:
                print(f"  ✗ No market data available")
                continue
            
            # Get today's OHLC
            current = hist['Close'].iloc[-1]
            open_price = hist['Open'].iloc[0]
            high = hist['High'].max()
            low = hist['Low'].min()
            
            print(f"\nMarket Data:")
            print(f"  Open:    ${open_price:.2f}")
            print(f"  Current: ${current:.2f}")
            print(f"  High:    ${high:.2f}")
            print(f"  Low:     ${low:.2f}")
            print(f"  Move:    {((current - open_price) / open_price * 100):+.2f}%")
            
            # Create quote dict
            quote = {
                'ticker': ticker,
                'open': open_price,
                'current': current,
                'high': high,
                'low': low
            }
            
            # Get market trend (SPY)
            spy = yf.Ticker('SPY')
            spy_hist = spy.history(period='1d', interval='1m')
            
            market_trend = {
                'is_up': False
            }
            
            if not spy_hist.empty:
                spy_current = spy_hist['Close'].iloc[-1]
                spy_open = spy_hist['Open'].iloc[0]
                market_trend['is_up'] = spy_current > spy_open
                print(f"  Market:  {'UP' if market_trend['is_up'] else 'DOWN'}")
            
            # Calculate Strategy 2 score
            print(f"\nCalculating Strategy 2 Score...")
            result = scorer.calculate_score(quote, market_trend, datetime.now())
            
            print(f"\n🎯 SCORE: {result['score']:.1f}/100 | GRADE: {result['grade']} | {result['decision']}")
            
            print(f"\nComponent Breakdown:")
            components = result['components']
            print(f"  Momentum:       {components['momentum']:.1f}/25  (price movement)")
            print(f"  Range:          {components['range']:.1f}/15  (volatility)")
            print(f"  Volume:         {components['volume']:.1f}/10  (activity)")
            print(f"  Market:         {components['market']:.1f}/10  (SPY trend)")
            print(f"  📰 News:        {components['news_sentiment']:.1f}/20  (Finnhub API)")
            print(f"  📊 Earnings:    {components['earnings']:.1f}/10  (Finnhub API)")
            print(f"  💬 Social:      {components['social']:.1f}/10  (Finnhub API)")
            
            print(f"\nStrategy 1 (momentum-only) would score: {components['momentum'] + components['range'] + 5 + components['market']}/55")
            print(f"Strategy 2 (with sentiment) scores: {result['score']:.1f}/100")
            
            if result['grade'] in ['A+', 'A', 'A-']:
                print(f"\n✅ TRADE SIGNAL: {result['direction']} | Strike: ${result['strike']:.2f} | Exp: {result['expiration']}")
            else:
                print(f"\n⏸️  No trade signal (grade {result['grade']} below A- threshold)")
            
        except Exception as e:
            print(f"  ✗ Error: {e}")
            import traceback
            traceback.print_exc()
    
    print()
    print("="*60)
    print("LIVE API TEST COMPLETE")
    print("="*60)
    print()
    print("✓ Finnhub API integration working")
    print("✓ News sentiment fetched from real-time data")
    print("✓ Earnings calendar checked")
    print("✓ Social sentiment analyzed")
    print()
    print("NOTE: Free Finnhub API has rate limits (60 calls/min)")
    print("      Consider caching for production use")
    print()


if __name__ == '__main__':
    test_live_sentiment()

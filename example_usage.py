#!/usr/bin/env python3
"""
Example Usage of Distress Scanner
Demonstrates how to use the scanner in your own code
"""

from distress_scanner import DistressScanner, RealTimeMonitor
from alerts import AlertManager, TradeRecommendationEngine, create_and_send_alert
from scorer_distress import quick_score

# =============================================================================
# EXAMPLE 1: Simple single ticker scan
# =============================================================================

def example_1_simple_scan():
    """Scan a single ticker and print results"""
    print("\n" + "="*70)
    print("EXAMPLE 1: Simple Single Ticker Scan")
    print("="*70)
    
    # Initialize scanner
    scanner = DistressScanner()
    
    # Scan a ticker
    result = scanner.scan_ticker('AAPL', days_back=30)
    
    # Print results
    print(f"\nTicker: {result['ticker']}")
    print(f"Score: {result['score']}/100")
    print(f"Alert: {'🚨 YES' if result['alert'] else '✅ NO'}")
    print(f"Signals triggered: {result.get('signals_triggered', 0)}")
    
    if result.get('signals'):
        print("\nTriggered signals:")
        for signal in result['signals']:
            print(f"  • {signal['type']}: +{signal['weight']} pts - {signal['details']}")
    
    return result


# =============================================================================
# EXAMPLE 2: Batch scan multiple tickers
# =============================================================================

def example_2_batch_scan():
    """Scan multiple tickers and get alerts"""
    print("\n" + "="*70)
    print("EXAMPLE 2: Batch Scan with Alert Filtering")
    print("="*70)
    
    scanner = DistressScanner()
    
    # Define watchlist
    watchlist = ['AAPL', 'TSLA', 'LULU', 'META', 'SNAP']
    
    # Scan all tickers
    results = scanner.scan_multiple(watchlist, days_back=30)
    
    # Filter to only alerts
    alerts = scanner.get_alerts(results)
    
    print(f"\nScanned {len(results)} tickers")
    print(f"Found {len(alerts)} alerts (score ≥60)")
    
    if alerts:
        print("\n🚨 ALERTS:")
        for alert in alerts:
            print(f"  {alert['ticker']}: {alert['score']}/100")
    else:
        print("\n✅ No alerts - all clear!")
    
    return results, alerts


# =============================================================================
# EXAMPLE 3: Generate trade recommendations
# =============================================================================

def example_3_trade_recommendations():
    """Generate PUT trade recommendations for distressed companies"""
    print("\n" + "="*70)
    print("EXAMPLE 3: Trade Recommendation Generation")
    print("="*70)
    
    # Simulate a high-distress scenario
    ticker = "LULU"
    current_price = 300.0
    distress_score = 75
    days_until_earnings = 3
    
    print(f"\nScenario:")
    print(f"  Ticker: {ticker}")
    print(f"  Current Price: ${current_price}")
    print(f"  Distress Score: {distress_score}/100")
    print(f"  Days Until Earnings: {days_until_earnings}")
    
    # Generate recommendation
    rec = TradeRecommendationEngine.calculate_strike_and_expiry(
        ticker=ticker,
        current_price=current_price,
        distress_score=distress_score,
        days_until_earnings=days_until_earnings
    )
    
    print(f"\n💰 TRADE RECOMMENDATION:")
    print(f"  Action: {rec.action}")
    print(f"  Strike: ${rec.strike}")
    print(f"  Expiry: {rec.expiry}")
    print(f"  Confidence: {rec.confidence}")
    print(f"  Reasoning: {rec.reasoning}")
    
    return rec


# =============================================================================
# EXAMPLE 4: Set up alerts with webhooks
# =============================================================================

def example_4_alert_system():
    """Configure and send alerts through webhooks"""
    print("\n" + "="*70)
    print("EXAMPLE 4: Alert System Setup")
    print("="*70)
    
    # Initialize alert manager with webhooks
    # (Replace with your actual webhook URLs)
    alert_manager = AlertManager(
        slack_webhook="https://hooks.slack.com/services/YOUR/WEBHOOK/HERE",
        discord_webhook="https://discord.com/api/webhooks/YOUR/WEBHOOK/HERE"
    )
    
    print("\n✅ Alert manager initialized with:")
    print("  • Slack webhook")
    print("  • Discord webhook")
    
    # Simulate an alert
    test_signals = [
        {'type': 'executive_departure', 'weight': 30, 'details': 'CFO resigned'},
        {'type': 'insider_selling_spike', 'weight': 25, 'details': '6 Form 4s in 30 days'},
        {'type': 'negative_news', 'weight': 20, 'details': 'Avg sentiment: -0.6'},
    ]
    
    print("\n📤 Sending test alert...")
    print("  (Will fail without valid webhook URLs)")
    
    # This will print to console if webhooks are not configured
    create_and_send_alert(
        ticker='TEST',
        score=75,
        signals=test_signals,
        current_price=100.0,
        days_until_earnings=3,
        alert_manager=None  # Set to alert_manager to actually send
    )


# =============================================================================
# EXAMPLE 5: Continuous monitoring
# =============================================================================

def example_5_continuous_monitoring():
    """Set up continuous monitoring (runs once for demo)"""
    print("\n" + "="*70)
    print("EXAMPLE 5: Continuous Monitoring Setup")
    print("="*70)
    
    scanner = DistressScanner()
    
    # Define watchlist
    watchlist = ['LULU', 'META', 'SNAP', 'NFLX', 'BYND']
    
    print(f"\nWatchlist: {', '.join(watchlist)}")
    print("Monitoring interval: 60 minutes")
    print("(In production, this runs continuously)")
    
    # Create monitor
    monitor = RealTimeMonitor(scanner, watchlist)
    
    # Run one scan
    print("\nRunning single scan...")
    results = monitor.scan_once()
    
    print(f"\n✅ Scan complete!")
    print(f"Tickers scanned: {len(results)}")
    print(f"Alerts in history: {len(monitor.alert_history)}")
    
    # In production, you would do:
    # monitor.run_continuous(interval_minutes=60)
    
    return monitor


# =============================================================================
# EXAMPLE 6: Custom scoring with direct API
# =============================================================================

def example_6_custom_scoring():
    """Use the scoring algorithm directly with custom data"""
    print("\n" + "="*70)
    print("EXAMPLE 6: Custom Scoring (Direct API)")
    print("="*70)
    
    # Prepare custom data
    filings_8k = [
        {'date': '2026-03-05', 'type': '8-K'}
    ]
    
    form4_filings = [
        {'date': f'2026-03-0{i}'} for i in range(1, 7)
    ]
    
    news_analysis = {
        'average_sentiment': -0.6,
        'negative_count': 8,
        'total_count': 10,
        'negative_ratio': 0.8
    }
    
    print("\nCustom data provided:")
    print(f"  8-K filings: {len(filings_8k)}")
    print(f"  Form 4 filings: {len(form4_filings)}")
    print(f"  News sentiment: {news_analysis['average_sentiment']:.2f}")
    
    # Calculate score
    report = quick_score(
        ticker='CUSTOM',
        filings_8k=filings_8k,
        form4_filings=form4_filings,
        news_analysis=news_analysis,
        put_volume=5000,
        call_volume=1000,
        analyst_downgrades=2,
        days_until_earnings=3
    )
    
    print(f"\n📊 SCORE REPORT:")
    print(f"  Score: {report['score']}/100")
    print(f"  Alert: {'🚨 YES' if report['alert'] else 'NO'}")
    print(f"  Signals: {report['signals_triggered']}")
    
    for signal in report['signals']:
        print(f"    • {signal['type']}: +{signal['weight']} pts")
    
    return report


# =============================================================================
# EXAMPLE 7: Database integration (requires SQLAlchemy)
# =============================================================================

def example_7_database_integration():
    """Store scan results in database"""
    print("\n" + "="*70)
    print("EXAMPLE 7: Database Integration (Requires PostgreSQL)")
    print("="*70)
    
    print("\nTo use database integration:")
    print("1. Set up PostgreSQL database")
    print("2. Run: python -c 'from models import create_all_tables, engine; create_all_tables(engine)'")
    print("3. Use SQLAlchemy to store results")
    
    print("\nExample code:")
    print("""
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from models import DistressSignal

# Create engine
engine = create_engine('postgresql://user:pass@localhost/alphatrades')
Session = sessionmaker(bind=engine)
session = Session()

# Store scan result
signal = DistressSignal(
    ticker='LULU',
    distress_score=75,
    alert_triggered=True,
    # ... other fields
)

session.add(signal)
session.commit()
    """)


# =============================================================================
# MAIN - Run all examples
# =============================================================================

def main():
    """Run all examples"""
    print("\n" + "="*70)
    print("🚨 DISTRESS SCANNER - EXAMPLE USAGE")
    print("="*70)
    print("\nThis script demonstrates various ways to use the scanner.")
    print("Some examples may fail if APIs are rate-limited or unavailable.")
    print("\nPress Ctrl+C to skip to next example.\n")
    
    try:
        # Example 1: Simple scan
        input("Press Enter to run Example 1 (Simple Scan)...")
        example_1_simple_scan()
        
        # Example 2: Batch scan
        input("\nPress Enter to run Example 2 (Batch Scan)...")
        example_2_batch_scan()
        
        # Example 3: Trade recommendations
        input("\nPress Enter to run Example 3 (Trade Recommendations)...")
        example_3_trade_recommendations()
        
        # Example 4: Alert system
        input("\nPress Enter to run Example 4 (Alert System)...")
        example_4_alert_system()
        
        # Example 5: Monitoring
        input("\nPress Enter to run Example 5 (Continuous Monitoring)...")
        example_5_continuous_monitoring()
        
        # Example 6: Custom scoring
        input("\nPress Enter to run Example 6 (Custom Scoring)...")
        example_6_custom_scoring()
        
        # Example 7: Database
        input("\nPress Enter to run Example 7 (Database Info)...")
        example_7_database_integration()
        
        print("\n" + "="*70)
        print("✅ ALL EXAMPLES COMPLETE!")
        print("="*70)
        print("\nNext steps:")
        print("1. Review the code in this file")
        print("2. Check README.md for full documentation")
        print("3. Run test_distress_scanner.py to validate")
        print("4. Configure your watchlist and start scanning!")
        
    except KeyboardInterrupt:
        print("\n\n⚠️  Interrupted by user")
    except Exception as e:
        print(f"\n\n❌ Error: {e}")
        print("(Some errors are expected without API keys configured)")


if __name__ == "__main__":
    # You can run individual examples:
    # example_1_simple_scan()
    # example_2_batch_scan()
    # example_3_trade_recommendations()
    
    # Or run all examples:
    main()

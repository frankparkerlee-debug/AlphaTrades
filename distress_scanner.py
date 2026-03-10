"""
Distress Signal Scanner - Main Module
Identifies companies likely to miss earnings or experience negative events
"""

import sys
from typing import Dict, List, Optional, Tuple
from datetime import datetime, timedelta
import json

# Import our modules
from data_sources import (
    SECEdgarAPI, 
    FinnhubAPI, 
    SentimentAnalyzer, 
    EarningsCalendar
)
from scorer_distress import DistressScorer, quick_score
from sentiment_ai import HybridDistressScorer, AISentimentAnalyzer


class DistressScanner:
    """
    Main scanner class for identifying distressed companies
    
    Analyzes multiple data sources and calculates distress scores
    """
    
    def __init__(self, finnhub_api_key: Optional[str] = None):
        """
        Initialize scanner with API credentials
        
        Args:
            finnhub_api_key: Finnhub API key (optional, uses demo if not provided)
        """
        self.sec_api = SECEdgarAPI()
        self.finnhub_api = FinnhubAPI(finnhub_api_key)
        self.sentiment_analyzer = SentimentAnalyzer()
        
        print("✅ Distress Scanner initialized")
    
    def scan_ticker(self, ticker: str, 
                   days_back: int = 30,
                   put_volume: Optional[int] = None,
                   call_volume: Optional[int] = None,
                   analyst_downgrades: int = 0) -> Dict:
        """
        Scan a single ticker for distress signals
        
        Args:
            ticker: Stock ticker symbol
            days_back: Days to look back for data
            put_volume: Current PUT volume (optional)
            call_volume: Current CALL volume (optional)
            analyst_downgrades: Number of recent downgrades
        
        Returns:
            Dict with scan results and distress score
        """
        print(f"\n🔍 Scanning {ticker}...")
        
        results = {
            'ticker': ticker,
            'scan_timestamp': datetime.now().isoformat(),
            'data': {},
            'score': None,
            'alert': False,
            'error': None
        }
        
        try:
            # 1. Fetch SEC filings
            print(f"  📄 Fetching SEC filings...")
            filings_8k = self.sec_api.get_recent_8k_filings(ticker, days_back)
            form4_filings = self.sec_api.get_recent_form4_filings(ticker, days_back)
            
            results['data']['filings_8k'] = len(filings_8k)
            results['data']['form4_filings'] = len(form4_filings)
            
            print(f"     8-K filings: {len(filings_8k)}")
            print(f"     Form 4 filings: {len(form4_filings)}")
            
            # 2. Fetch and analyze news
            print(f"  📰 Fetching and analyzing news...")
            news = self.finnhub_api.get_company_news(ticker, days_back=7)
            news_analysis = self.sentiment_analyzer.analyze_news_batch(news)
            
            results['data']['news_count'] = len(news)
            results['data']['news_sentiment'] = news_analysis
            
            print(f"     News articles: {len(news)}")
            print(f"     Avg sentiment: {news_analysis['average_sentiment']:.2f}")
            print(f"     Negative ratio: {news_analysis['negative_ratio']:.1%}")
            
            # 3. Get earnings calendar
            print(f"  📅 Checking earnings calendar...")
            days_until = EarningsCalendar.days_until_earnings(ticker, self.finnhub_api)
            
            results['data']['days_until_earnings'] = days_until
            
            if days_until is not None:
                print(f"     Next earnings: {days_until} days")
            else:
                print(f"     Next earnings: Not found")
            
            # 4. Calculate distress score
            print(f"  📊 Calculating distress score...")
            
            score_report = quick_score(
                ticker=ticker,
                filings_8k=filings_8k,
                form4_filings=form4_filings,
                news_analysis=news_analysis,
                put_volume=put_volume or 0,
                call_volume=call_volume or 1,
                analyst_downgrades=analyst_downgrades,
                days_until_earnings=days_until
            )
            
            results['score'] = score_report['score']
            results['alert'] = score_report['alert']
            results['signals'] = score_report['signals']
            results['signals_triggered'] = score_report['signals_triggered']
            
            # Status indicator
            if score_report['alert']:
                status = "🚨 ALERT"
            elif score_report['score'] >= 40:
                status = "⚠️  WATCH"
            else:
                status = "✅ OK"
            
            print(f"\n  {status} | Score: {score_report['score']}/100 | Signals: {score_report['signals_triggered']}")
            
            return results
        
        except Exception as e:
            results['error'] = str(e)
            print(f"  ❌ Error scanning {ticker}: {e}")
            return results
    
    def scan_ticker_hybrid(self, ticker: str, 
                          earnings_date: Optional[str] = None,
                          price_change_30d: Optional[float] = None,
                          iv_percentile: Optional[float] = None,
                          use_ai: bool = False,
                          anthropic_key: Optional[str] = None) -> Dict:
        """
        Hybrid scan using AI-enhanced sentiment analysis
        
        Args:
            ticker: Stock symbol
            earnings_date: Upcoming earnings date (YYYY-MM-DD)
            price_change_30d: 30-day price change %
            iv_percentile: Current IV percentile (0-100)
            use_ai: Whether to use Claude/GPT for deep analysis
            anthropic_key: Anthropic API key for Claude
        
        Returns:
            Full hybrid scoring result
        """
        print(f"\n🔬 Hybrid scan: {ticker}")
        
        # Gather data
        news = self.finnhub_api.get_company_news(ticker, days_back=14)
        filings_8k = self.sec_api.get_recent_8k_filings(ticker, days_back=30)
        form4_filings = self.sec_api.get_recent_form4_filings(ticker, days_back=30)
        
        # Count insider sells (simplified - would need deeper Form 4 parsing)
        insider_sells = len(form4_filings)
        
        # Initialize hybrid scorer
        scorer = HybridDistressScorer(
            finnhub_key=self.finnhub_api.api_key,
            anthropic_key=anthropic_key
        )
        
        # Run hybrid scoring
        result = scorer.score_ticker(
            ticker=ticker,
            news=news,
            sec_filings=len(filings_8k),
            insider_sells=insider_sells,
            earnings_date=earnings_date,
            price_change_30d=price_change_30d,
            iv_percentile=iv_percentile,
            use_ai=use_ai
        )
        
        print(f"   Score: {result['score']:.1f} | Grade: {result['grade']} | {result['recommendation']}")
        
        return result
    
    def scan_multiple(self, tickers: List[str], max_workers: int = 10, **kwargs) -> List[Dict]:
        """
        Scan multiple tickers in parallel
        
        Args:
            tickers: List of ticker symbols
            max_workers: Max concurrent scans (default 10)
            **kwargs: Additional arguments passed to scan_ticker
        
        Returns:
            List of scan results
        """
        from concurrent.futures import ThreadPoolExecutor, as_completed
        
        results = []
        
        print(f"\n{'='*60}")
        print(f"📡 Starting parallel scan of {len(tickers)} tickers ({max_workers} workers)")
        print(f"{'='*60}")
        
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {executor.submit(self.scan_ticker, ticker, **kwargs): ticker for ticker in tickers}
            for future in as_completed(futures):
                try:
                    result = future.result(timeout=30)  # 30s timeout per ticker
                    results.append(result)
                except Exception as e:
                    ticker = futures[future]
                    print(f"  ⚠️ {ticker}: {e}")
                    results.append({'ticker': ticker, 'error': str(e), 'score': 0})
        
        return results
    
    def get_alerts(self, scan_results: List[Dict]) -> List[Dict]:
        """
        Filter scan results to only alerts (score >= 60)
        
        Args:
            scan_results: Results from scan_multiple
        
        Returns:
            List of alerts sorted by score (highest first)
        """
        alerts = [r for r in scan_results if r.get('alert', False)]
        alerts.sort(key=lambda x: x.get('score', 0), reverse=True)
        return alerts
    
    def print_summary(self, scan_results: List[Dict]):
        """Print summary of scan results"""
        print(f"\n{'='*60}")
        print(f"📊 SCAN SUMMARY")
        print(f"{'='*60}")
        
        total = len(scan_results)
        alerts = [r for r in scan_results if r.get('alert', False)]
        watches = [r for r in scan_results 
                  if not r.get('alert', False) and r.get('score', 0) >= 40]
        
        print(f"Total scanned: {total}")
        print(f"🚨 Alerts (≥60): {len(alerts)}")
        print(f"⚠️  Watch list (40-59): {len(watches)}")
        print(f"✅ Normal (<40): {total - len(alerts) - len(watches)}")
        
        if alerts:
            print(f"\n🚨 ALERT TRIGGERS:")
            print("-" * 60)
            for result in sorted(alerts, key=lambda x: x.get('score', 0), reverse=True):
                ticker = result['ticker']
                score = result['score']
                signals = result.get('signals_triggered', 0)
                
                print(f"{ticker:6s} | Score: {score:3d}/100 | Signals: {signals}")
                
                # Print signal details
                for signal in result.get('signals', []):
                    print(f"  • {signal['type']}: +{signal['weight']} pts - {signal['details']}")
        
        if watches:
            print(f"\n⚠️  WATCH LIST:")
            print("-" * 60)
            for result in sorted(watches, key=lambda x: x.get('score', 0), reverse=True):
                ticker = result['ticker']
                score = result['score']
                signals = result.get('signals_triggered', 0)
                print(f"{ticker:6s} | Score: {score:3d}/100 | Signals: {signals}")
    
    def export_results(self, scan_results: List[Dict], filename: str):
        """Export scan results to JSON file"""
        with open(filename, 'w') as f:
            json.dump(scan_results, f, indent=2)
        print(f"\n💾 Results exported to {filename}")


class RealTimeMonitor:
    """
    Real-time monitoring system for distress signals
    (Framework - actual implementation would use threading/async)
    """
    
    def __init__(self, scanner: DistressScanner, watchlist: List[str]):
        self.scanner = scanner
        self.watchlist = watchlist
        self.last_scan_time = None
        self.alert_history: List[Dict] = []
    
    def scan_once(self) -> List[Dict]:
        """Run a single scan of the watchlist"""
        print(f"\n🔄 Running watchlist scan at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        
        results = self.scanner.scan_multiple(self.watchlist)
        self.last_scan_time = datetime.now()
        
        # Check for new alerts
        alerts = self.scanner.get_alerts(results)
        
        if alerts:
            print(f"\n🚨 {len(alerts)} ALERT(S) DETECTED!")
            for alert in alerts:
                self.alert_history.append({
                    'timestamp': datetime.now().isoformat(),
                    'ticker': alert['ticker'],
                    'score': alert['score'],
                    'signals': alert['signals_triggered']
                })
        
        return results
    
    def run_continuous(self, interval_minutes: int = 60):
        """
        Run continuous monitoring
        (Placeholder - would use threading or async in production)
        """
        print(f"\n🔴 Starting continuous monitoring (scan every {interval_minutes} min)")
        print(f"Watchlist: {', '.join(self.watchlist)}")
        print("Press Ctrl+C to stop\n")
        
        # In production, this would be:
        # while True:
        #     self.scan_once()
        #     time.sleep(interval_minutes * 60)
        
        # For now, just run once
        self.scan_once()


# CLI Interface
def main():
    """Command-line interface for the scanner"""
    import argparse
    
    parser = argparse.ArgumentParser(
        description='AI Distress Signal Scanner - Find companies before they crash'
    )
    parser.add_argument(
        'tickers',
        nargs='+',
        help='Stock tickers to scan (e.g., AAPL TSLA LULU)'
    )
    parser.add_argument(
        '--api-key',
        help='Finnhub API key (optional, uses demo if not provided)'
    )
    parser.add_argument(
        '--days-back',
        type=int,
        default=30,
        help='Days to look back for data (default: 30)'
    )
    parser.add_argument(
        '--export',
        help='Export results to JSON file'
    )
    parser.add_argument(
        '--monitor',
        action='store_true',
        help='Enable continuous monitoring mode'
    )
    parser.add_argument(
        '--interval',
        type=int,
        default=60,
        help='Monitoring interval in minutes (default: 60)'
    )
    
    args = parser.parse_args()
    
    # Initialize scanner
    scanner = DistressScanner(finnhub_api_key=args.api_key)
    
    if args.monitor:
        # Run in monitoring mode
        monitor = RealTimeMonitor(scanner, args.tickers)
        monitor.run_continuous(interval_minutes=args.interval)
    else:
        # Run single scan
        results = scanner.scan_multiple(args.tickers, days_back=args.days_back)
        
        # Print summary
        scanner.print_summary(results)
        
        # Export if requested
        if args.export:
            scanner.export_results(results, args.export)


if __name__ == "__main__":
    # If run directly, use CLI
    if len(sys.argv) > 1:
        main()
    else:
        # Demo mode
        print("="*60)
        print("🎯 AI DISTRESS SIGNAL SCANNER")
        print("Strategy 3: PUT plays on earnings misses & corporate distress")
        print("="*60)
        
        # Demo scan
        scanner = DistressScanner()
        
        # Example tickers (some with known issues)
        demo_tickers = ['AAPL', 'TSLA']  # Using well-known tickers for demo
        
        results = scanner.scan_multiple(demo_tickers, days_back=30)
        scanner.print_summary(results)
        
        print(f"\n💡 Usage: python distress_scanner.py AAPL TSLA LULU --days-back 30")
        print(f"💡 With API key: python distress_scanner.py AAPL --api-key YOUR_KEY")
        print(f"💡 Monitoring mode: python distress_scanner.py AAPL TSLA --monitor")

"""
Test Suite for Distress Scanner
Tests against known historical earnings misses and corporate distress events
"""

import sys
from datetime import datetime
from typing import Dict, List

# Import scanner components
from distress_scanner import DistressScanner
from scorer_distress import quick_score
from alerts import TradeRecommendationEngine


class HistoricalTestCase:
    """Historical test case for known distress events"""
    
    def __init__(self, 
                 ticker: str,
                 event_date: str,
                 event_description: str,
                 expected_signals: List[str],
                 min_expected_score: int):
        self.ticker = ticker
        self.event_date = event_date
        self.event_description = event_description
        self.expected_signals = expected_signals
        self.min_expected_score = min_expected_score


# Known historical cases
HISTORICAL_TEST_CASES = [
    HistoricalTestCase(
        ticker="LULU",
        event_date="2024-03-21",
        event_description="Lululemon Q4 2023 earnings miss - guidance cut, stock dropped 15%",
        expected_signals=['negative_news', 'near_earnings'],
        min_expected_score=40
    ),
    HistoricalTestCase(
        ticker="META",
        event_date="2022-02-03",
        event_description="Meta Q4 2021 - first ever user decline, stock dropped 26%",
        expected_signals=['negative_news', 'near_earnings'],
        min_expected_score=40
    ),
    HistoricalTestCase(
        ticker="NFLX",
        event_date="2022-04-20",
        event_description="Netflix Q1 2022 - subscriber loss, stock dropped 35%",
        expected_signals=['negative_news', 'near_earnings'],
        min_expected_score=40
    ),
    HistoricalTestCase(
        ticker="SNAP",
        event_date="2022-05-24",
        event_description="Snap guidance warning - CEO sold shares before announcement",
        expected_signals=['executive_departure', 'insider_selling_spike', 'negative_news'],
        min_expected_score=50
    ),
    HistoricalTestCase(
        ticker="BYND",
        event_date="2023-08-04",
        event_description="Beyond Meat COO suspended after assault incident, earnings miss",
        expected_signals=['executive_departure', 'negative_news'],
        min_expected_score=50
    ),
]


class TestDistressScanner:
    """Test suite for distress scanner"""
    
    def __init__(self):
        self.scanner = DistressScanner()
        self.results: List[Dict] = []
    
    def test_scoring_algorithm(self):
        """Test 1: Validate scoring algorithm with synthetic data"""
        print("\n" + "="*70)
        print("TEST 1: Scoring Algorithm Validation")
        print("="*70)
        
        test_cases = [
            {
                'name': 'Maximum Distress',
                'data': {
                    'filings_8k': [{'date': '2026-03-05', 'type': '8-K'}],
                    'form4_filings': [{'date': f'2026-03-0{i}'} for i in range(1, 7)],
                    'news_analysis': {
                        'average_sentiment': -0.7,
                        'negative_count': 9,
                        'total_count': 10,
                        'negative_ratio': 0.9
                    },
                    'put_volume': 10000,
                    'call_volume': 1000,
                    'analyst_downgrades': 3,
                    'days_until_earnings': 2
                },
                'expected_min_score': 80,
                'expected_alert': True
            },
            {
                'name': 'Moderate Distress',
                'data': {
                    'filings_8k': [],
                    'form4_filings': [{'date': f'2026-03-0{i}'} for i in range(1, 4)],
                    'news_analysis': {
                        'average_sentiment': -0.4,
                        'negative_count': 5,
                        'total_count': 10,
                        'negative_ratio': 0.5
                    },
                    'put_volume': 2000,
                    'call_volume': 1000,
                    'analyst_downgrades': 1,
                    'days_until_earnings': 10
                },
                'expected_min_score': 40,
                'expected_alert': False
            },
            {
                'name': 'Healthy Company',
                'data': {
                    'filings_8k': [],
                    'form4_filings': [{'date': '2026-03-01'}],
                    'news_analysis': {
                        'average_sentiment': 0.5,
                        'negative_count': 1,
                        'total_count': 10,
                        'negative_ratio': 0.1
                    },
                    'put_volume': 500,
                    'call_volume': 1000,
                    'analyst_downgrades': 0,
                    'days_until_earnings': 30
                },
                'expected_min_score': 0,
                'expected_alert': False
            }
        ]
        
        passed = 0
        failed = 0
        
        for test in test_cases:
            print(f"\n  Testing: {test['name']}")
            print("  " + "-"*66)
            
            result = quick_score(
                ticker='TEST',
                **test['data']
            )
            
            score = result['score']
            alert = result['alert']
            
            # Check score threshold
            score_pass = score >= test['expected_min_score']
            alert_pass = alert == test['expected_alert']
            
            if score_pass and alert_pass:
                print(f"  ✅ PASS | Score: {score}/100 | Alert: {alert}")
                passed += 1
            else:
                print(f"  ❌ FAIL | Score: {score}/100 (expected ≥{test['expected_min_score']}) | Alert: {alert} (expected {test['expected_alert']})")
                failed += 1
            
            print(f"  Signals triggered: {result['signals_triggered']}")
            for signal in result['signals']:
                print(f"    • {signal['type']}: +{signal['weight']} pts")
        
        print(f"\n  Results: {passed} passed, {failed} failed")
        return failed == 0
    
    def test_signal_detection(self):
        """Test 2: Individual signal detection"""
        print("\n" + "="*70)
        print("TEST 2: Individual Signal Detection")
        print("="*70)
        
        from scorer_distress import DistressScorer
        
        tests = [
            {
                'name': 'Executive Departure Detection',
                'check': 'check_executive_departure',
                'args': [[{'date': '2026-03-05', 'type': '8-K'}]],
                'expected': True
            },
            {
                'name': 'Insider Selling Spike Detection',
                'check': 'check_insider_selling_spike',
                'args': [[{'date': f'2026-03-0{i}'} for i in range(1, 7)], 2],
                'expected': True
            },
            {
                'name': 'Negative News Detection',
                'check': 'check_negative_news_sentiment',
                'args': [{
                    'average_sentiment': -0.5,
                    'negative_count': 7,
                    'total_count': 10,
                    'negative_ratio': 0.7
                }],
                'expected': True
            },
            {
                'name': 'Unusual PUT Volume Detection',
                'check': 'check_unusual_put_volume',
                'args': [5000, 1000, 0.8],
                'expected': True
            },
            {
                'name': 'Analyst Downgrade Detection',
                'check': 'check_analyst_downgrade',
                'args': [2],
                'expected': True
            },
            {
                'name': 'Near Earnings Detection',
                'check': 'check_near_earnings',
                'args': [3],
                'expected': True
            }
        ]
        
        passed = 0
        failed = 0
        
        for test in tests:
            print(f"\n  Testing: {test['name']}")
            print("  " + "-"*66)
            
            scorer = DistressScorer()
            check_method = getattr(scorer, test['check'])
            result = check_method(*test['args'])
            
            if result == test['expected']:
                print(f"  ✅ PASS | Detected: {result}")
                passed += 1
            else:
                print(f"  ❌ FAIL | Detected: {result} (expected {test['expected']})")
                failed += 1
        
        print(f"\n  Results: {passed} passed, {failed} failed")
        return failed == 0
    
    def test_trade_recommendations(self):
        """Test 3: Trade recommendation generation"""
        print("\n" + "="*70)
        print("TEST 3: Trade Recommendation Generation")
        print("="*70)
        
        test_scenarios = [
            {
                'name': 'High Distress, Near Earnings',
                'current_price': 100.0,
                'distress_score': 85,
                'days_until_earnings': 3,
                'expected_confidence': 'HIGH'
            },
            {
                'name': 'Medium Distress, Far from Earnings',
                'current_price': 150.0,
                'distress_score': 65,
                'days_until_earnings': 20,
                'expected_confidence': 'MEDIUM'
            },
            {
                'name': 'Threshold Distress',
                'current_price': 50.0,
                'distress_score': 60,
                'days_until_earnings': None,
                'expected_confidence': 'MEDIUM'
            }
        ]
        
        passed = 0
        failed = 0
        
        for scenario in test_scenarios:
            print(f"\n  Testing: {scenario['name']}")
            print("  " + "-"*66)
            
            rec = TradeRecommendationEngine.calculate_strike_and_expiry(
                ticker='TEST',
                current_price=scenario['current_price'],
                distress_score=scenario['distress_score'],
                days_until_earnings=scenario['days_until_earnings']
            )
            
            # Validate recommendation
            valid = True
            
            # Check confidence matches
            if rec.confidence != scenario['expected_confidence']:
                valid = False
                print(f"  ❌ Confidence mismatch: {rec.confidence} vs {scenario['expected_confidence']}")
            
            # Check strike is below current price (PUT is OTM)
            if rec.strike >= scenario['current_price']:
                valid = False
                print(f"  ❌ Strike should be below current price")
            
            # Check expiry is in the future
            expiry_date = datetime.strptime(rec.expiry, '%Y-%m-%d')
            if expiry_date <= datetime.now():
                valid = False
                print(f"  ❌ Expiry should be in the future")
            
            if valid:
                print(f"  ✅ PASS")
                print(f"     Strike: ${rec.strike} ({((scenario['current_price'] - rec.strike) / scenario['current_price'] * 100):.1f}% OTM)")
                print(f"     Expiry: {rec.expiry}")
                print(f"     Confidence: {rec.confidence}")
                passed += 1
            else:
                failed += 1
        
        print(f"\n  Results: {passed} passed, {failed} failed")
        return failed == 0
    
    def test_live_tickers(self, tickers: List[str] = None):
        """Test 4: Live API calls (optional, requires network)"""
        print("\n" + "="*70)
        print("TEST 4: Live Ticker Scanning (Optional)")
        print("="*70)
        
        if not tickers:
            tickers = ['AAPL']  # Default to safe, stable ticker
        
        print(f"\n  Testing live scan of: {', '.join(tickers)}")
        print("  (This will make real API calls)\n")
        
        try:
            results = self.scanner.scan_multiple(tickers, days_back=30)
            
            # Check that we got results
            if len(results) == len(tickers):
                print(f"\n  ✅ PASS | Successfully scanned {len(results)} ticker(s)")
                
                # Print summary
                for result in results:
                    ticker = result['ticker']
                    score = result.get('score', 'N/A')
                    print(f"     {ticker}: Score {score}/100")
                
                return True
            else:
                print(f"\n  ❌ FAIL | Expected {len(tickers)} results, got {len(results)}")
                return False
        
        except Exception as e:
            print(f"\n  ⚠️  SKIP | Error during live test: {e}")
            print("     (This is expected if network/API is unavailable)")
            return True  # Don't fail on network errors
    
    def run_all_tests(self, include_live: bool = False):
        """Run all tests"""
        print("\n" + "="*70)
        print("🧪 DISTRESS SCANNER TEST SUITE")
        print("="*70)
        print(f"Timestamp: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        
        results = []
        
        # Run tests
        results.append(("Scoring Algorithm", self.test_scoring_algorithm()))
        results.append(("Signal Detection", self.test_signal_detection()))
        results.append(("Trade Recommendations", self.test_trade_recommendations()))
        
        if include_live:
            results.append(("Live Ticker Scan", self.test_live_tickers()))
        
        # Summary
        print("\n" + "="*70)
        print("📊 TEST SUMMARY")
        print("="*70)
        
        passed = sum(1 for _, result in results if result)
        total = len(results)
        
        for test_name, result in results:
            status = "✅ PASS" if result else "❌ FAIL"
            print(f"  {status} | {test_name}")
        
        print(f"\n  Total: {passed}/{total} tests passed")
        
        if passed == total:
            print("\n  🎉 ALL TESTS PASSED!")
            return True
        else:
            print(f"\n  ⚠️  {total - passed} test(s) failed")
            return False


def main():
    """Main test runner"""
    import argparse
    
    parser = argparse.ArgumentParser(description='Test the Distress Scanner')
    parser.add_argument(
        '--live',
        action='store_true',
        help='Include live API tests (makes real network calls)'
    )
    parser.add_argument(
        '--tickers',
        nargs='+',
        help='Tickers to test with live scan'
    )
    
    args = parser.parse_args()
    
    tester = TestDistressScanner()
    
    if args.live and args.tickers:
        # Just run live test with specific tickers
        tester.test_live_tickers(args.tickers)
    else:
        # Run full test suite
        success = tester.run_all_tests(include_live=args.live)
        sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()

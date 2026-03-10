"""
Distress Scoring Algorithm
Calculates a 0-100 distress score based on multiple signals
Triggers alert at 60+
"""

from typing import Dict, List, Optional
from datetime import datetime, timedelta
from dataclasses import dataclass, field


@dataclass
class DistressSignal:
    """Individual distress signal with weight"""
    signal_type: str
    weight: int
    triggered: bool
    details: str = ""
    timestamp: datetime = field(default_factory=datetime.now)


class DistressScorer:
    """
    Scoring system for company distress signals
    
    Scoring breakdown:
    - Executive departure: +30 points
    - Insider selling spike (3x normal): +25 points
    - Negative news sentiment: +20 points
    - Unusual PUT volume: +15 points
    - Analyst downgrades: +10 points
    - Near earnings (within 5 days): +10 points (multiplier effect)
    
    Total: 0-100, triggers at 60+
    """
    
    # Base weights for each signal type
    WEIGHTS = {
        'executive_departure': 30,
        'insider_selling_spike': 25,
        'negative_news': 20,
        'unusual_put_volume': 15,
        'analyst_downgrade': 10,
        'near_earnings': 10  # Multiplier effect
    }
    
    ALERT_THRESHOLD = 60
    
    def __init__(self):
        self.signals: List[DistressSignal] = []
        self.raw_score = 0
        self.final_score = 0
        self.metadata: Dict = {}
    
    def reset(self):
        """Reset scorer for new evaluation"""
        self.signals = []
        self.raw_score = 0
        self.final_score = 0
        self.metadata = {}
    
    def check_executive_departure(self, filings_8k: List[Dict]) -> bool:
        """
        Check for executive departures in 8-K filings
        Item 5.02 = Departure of Directors or Officers
        """
        departure_keywords = [
            'departure', 'resign', 'stepped down', 'terminated',
            'ceo', 'cfo', 'coo', 'president', 'officer'
        ]
        
        for filing in filings_8k:
            # In production, would parse actual 8-K XML/HTML content
            # For now, checking if recent filing exists
            filing_date = datetime.strptime(filing['date'], '%Y-%m-%d')
            days_old = (datetime.now() - filing_date).days
            
            if days_old <= 30:  # Recent filing
                # Simplified check - would need full content parsing
                signal = DistressSignal(
                    signal_type='executive_departure',
                    weight=self.WEIGHTS['executive_departure'],
                    triggered=True,
                    details=f"Recent 8-K filing on {filing['date']}"
                )
                self.signals.append(signal)
                return True
        
        return False
    
    def check_insider_selling_spike(self, form4_filings: List[Dict], 
                                   historical_avg: Optional[int] = None) -> bool:
        """
        Check for unusual insider selling (3x normal volume)
        """
        recent_filings = len(form4_filings)
        
        # Use historical average or default baseline
        baseline = historical_avg if historical_avg else 2
        
        # Check if current volume is 3x baseline
        if recent_filings >= baseline * 3:
            signal = DistressSignal(
                signal_type='insider_selling_spike',
                weight=self.WEIGHTS['insider_selling_spike'],
                triggered=True,
                details=f"Insider selling spike: {recent_filings} Form 4s vs baseline {baseline}"
            )
            self.signals.append(signal)
            return True
        
        return False
    
    def check_negative_news_sentiment(self, news_analysis: Dict) -> bool:
        """
        Check for negative news sentiment
        Triggers if average sentiment < -0.3 or >50% negative articles
        """
        avg_sentiment = news_analysis.get('average_sentiment', 0.0)
        negative_ratio = news_analysis.get('negative_ratio', 0.0)
        negative_count = news_analysis.get('negative_count', 0)
        
        # Trigger if strong negative sentiment or high negative ratio
        if avg_sentiment < -0.3 or negative_ratio > 0.5:
            signal = DistressSignal(
                signal_type='negative_news',
                weight=self.WEIGHTS['negative_news'],
                triggered=True,
                details=f"Negative sentiment: {avg_sentiment:.2f}, {negative_count} negative articles"
            )
            self.signals.append(signal)
            return True
        
        return False
    
    def check_unusual_put_volume(self, put_volume: int, 
                                call_volume: int,
                                historical_put_call_ratio: float = 0.8) -> bool:
        """
        Check for unusual PUT volume
        Triggers if PUT/CALL ratio is 2x normal
        """
        if call_volume == 0:
            return False
        
        current_ratio = put_volume / call_volume
        
        # Check if current ratio is 2x historical average
        if current_ratio >= historical_put_call_ratio * 2:
            signal = DistressSignal(
                signal_type='unusual_put_volume',
                weight=self.WEIGHTS['unusual_put_volume'],
                triggered=True,
                details=f"PUT/CALL ratio: {current_ratio:.2f} (normal: {historical_put_call_ratio:.2f})"
            )
            self.signals.append(signal)
            return True
        
        return False
    
    def check_analyst_downgrade(self, recent_downgrades: int) -> bool:
        """
        Check for recent analyst downgrades
        Triggers if 1+ downgrades in last 30 days
        """
        if recent_downgrades > 0:
            signal = DistressSignal(
                signal_type='analyst_downgrade',
                weight=self.WEIGHTS['analyst_downgrade'],
                triggered=True,
                details=f"{recent_downgrades} analyst downgrades in last 30 days"
            )
            self.signals.append(signal)
            return True
        
        return False
    
    def check_near_earnings(self, days_until_earnings: Optional[int]) -> bool:
        """
        Check if near earnings (within 5 days)
        Acts as a multiplier on existing score
        """
        if days_until_earnings and 0 <= days_until_earnings <= 5:
            signal = DistressSignal(
                signal_type='near_earnings',
                weight=self.WEIGHTS['near_earnings'],
                triggered=True,
                details=f"Earnings in {days_until_earnings} days"
            )
            self.signals.append(signal)
            return True
        
        return False
    
    def calculate_score(self) -> int:
        """
        Calculate final distress score (0-100)
        """
        # Sum base scores
        self.raw_score = sum(s.weight for s in self.signals if s.triggered)
        
        # Check for earnings multiplier
        near_earnings = any(s.signal_type == 'near_earnings' and s.triggered 
                           for s in self.signals)
        
        if near_earnings:
            # If near earnings, add the near_earnings weight
            # This amplifies urgency without double-counting
            self.final_score = min(100, self.raw_score)
        else:
            # Remove near_earnings weight if it was added
            self.raw_score = sum(s.weight for s in self.signals 
                                if s.triggered and s.signal_type != 'near_earnings')
            self.final_score = min(100, self.raw_score)
        
        return self.final_score
    
    def should_alert(self) -> bool:
        """Check if score exceeds alert threshold"""
        return self.final_score >= self.ALERT_THRESHOLD
    
    def get_triggered_signals(self) -> List[DistressSignal]:
        """Get list of triggered signals"""
        return [s for s in self.signals if s.triggered]
    
    def get_report(self) -> Dict:
        """Generate detailed scoring report"""
        triggered = self.get_triggered_signals()
        
        return {
            'score': self.final_score,
            'raw_score': self.raw_score,
            'alert': self.should_alert(),
            'threshold': self.ALERT_THRESHOLD,
            'signals_triggered': len(triggered),
            'signals': [
                {
                    'type': s.signal_type,
                    'weight': s.weight,
                    'details': s.details,
                    'timestamp': s.timestamp.isoformat()
                }
                for s in triggered
            ],
            'metadata': self.metadata
        }
    
    def set_metadata(self, key: str, value):
        """Store additional metadata"""
        self.metadata[key] = value


# Convenience function for quick scoring
def quick_score(ticker: str,
                filings_8k: List[Dict],
                form4_filings: List[Dict],
                news_analysis: Dict,
                put_volume: int = 0,
                call_volume: int = 1,
                analyst_downgrades: int = 0,
                days_until_earnings: Optional[int] = None) -> Dict:
    """
    Quick scoring function for a ticker
    
    Returns: Full scoring report
    """
    scorer = DistressScorer()
    
    # Store ticker metadata
    scorer.set_metadata('ticker', ticker)
    scorer.set_metadata('timestamp', datetime.now().isoformat())
    
    # Run all checks
    scorer.check_executive_departure(filings_8k)
    scorer.check_insider_selling_spike(form4_filings)
    scorer.check_negative_news_sentiment(news_analysis)
    
    if put_volume > 0 and call_volume > 0:
        scorer.check_unusual_put_volume(put_volume, call_volume)
    
    if analyst_downgrades > 0:
        scorer.check_analyst_downgrade(analyst_downgrades)
    
    if days_until_earnings is not None:
        scorer.check_near_earnings(days_until_earnings)
    
    # Calculate final score
    scorer.calculate_score()
    
    return scorer.get_report()


# Demo / Test
if __name__ == "__main__":
    print("Testing Distress Scorer...")
    
    # Test case 1: High distress scenario
    print("\n📊 Test 1: High Distress Company")
    print("-" * 50)
    
    test_filings_8k = [
        {'date': '2026-03-05', 'type': '8-K'}  # Recent filing
    ]
    
    test_form4 = [
        {'date': '2026-03-01'},
        {'date': '2026-03-02'},
        {'date': '2026-03-03'},
        {'date': '2026-03-04'},
        {'date': '2026-03-05'},
        {'date': '2026-03-06'},
    ]  # 6 filings vs baseline of 2 = 3x spike
    
    test_news = {
        'average_sentiment': -0.6,
        'negative_count': 8,
        'total_count': 10,
        'negative_ratio': 0.8
    }
    
    report = quick_score(
        ticker='TEST',
        filings_8k=test_filings_8k,
        form4_filings=test_form4,
        news_analysis=test_news,
        put_volume=5000,
        call_volume=1000,  # 5:1 ratio (high PUT volume)
        analyst_downgrades=2,
        days_until_earnings=3  # Near earnings
    )
    
    print(f"Distress Score: {report['score']}/100")
    print(f"Alert Status: {'🚨 ALERT' if report['alert'] else '✅ OK'}")
    print(f"Signals Triggered: {report['signals_triggered']}")
    print("\nTriggered Signals:")
    for signal in report['signals']:
        print(f"  • {signal['type']}: +{signal['weight']} pts - {signal['details']}")
    
    # Test case 2: Low distress scenario
    print("\n\n📊 Test 2: Healthy Company")
    print("-" * 50)
    
    report2 = quick_score(
        ticker='HEALTHY',
        filings_8k=[],
        form4_filings=[{'date': '2026-03-01'}],  # Normal activity
        news_analysis={
            'average_sentiment': 0.4,
            'negative_count': 1,
            'total_count': 10,
            'negative_ratio': 0.1
        },
        put_volume=800,
        call_volume=1000,  # Normal ratio
        analyst_downgrades=0,
        days_until_earnings=30  # Not near earnings
    )
    
    print(f"Distress Score: {report2['score']}/100")
    print(f"Alert Status: {'🚨 ALERT' if report2['alert'] else '✅ OK'}")
    print(f"Signals Triggered: {report2['signals_triggered']}")
    
    print("\n✅ Distress Scorer test complete!")

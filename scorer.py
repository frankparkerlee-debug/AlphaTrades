"""
Strategy 1 Scoring Algorithm
Calculates grade (A+ through D) based on momentum, range, volume, and market trend
"""
from datetime import datetime, timedelta
from decimal import Decimal

class Scorer:
    def __init__(self, config=None):
        """
        Initialize scorer with model configuration
        If no config provided, uses default thresholds
        """
        if config:
            self.thresholds = {
                'A+': config.threshold_a_plus,
                'A': config.threshold_a,
                'A-': config.threshold_a_minus,
                'B+': config.threshold_b_plus,
                'B': config.threshold_b,
                'B-': config.threshold_b_minus
            }
            self.weights = {
                'momentum': config.weight_momentum,
                'range': config.weight_range,
                'volume': config.weight_volume,
                'market': config.weight_market
            }
        else:
            # Default configuration
            self.thresholds = {
                'A+': 50, 'A': 47, 'A-': 45,
                'B+': 41, 'B': 38, 'B-': 35
            }
            self.weights = {
                'momentum': 25,
                'range': 15,
                'volume': 5,
                'market': 10
            }
    
    def calculate_score(self, quote, market_trend):
        """
        Calculate score and grade for a stock quote
        
        Args:
            quote: Dict with keys: ticker, current, open, high, low
            market_trend: Dict with keys: is_up (bool), change_pct (float)
        
        Returns:
            Dict with keys: ticker, score, grade, decision, components, direction, strike
        """
        open_price = float(quote.get('open', 0))
        current = float(quote.get('current', 0))
        high = float(quote.get('high', 0))
        low = float(quote.get('low', 0))
        
        if open_price == 0 or current == 0:
            return self._skip_result(quote.get('ticker', 'UNKNOWN'))
        
        # Calculate metrics
        move_from_open = abs((current - open_price) / open_price * 100)
        range_pct = (high - low) / open_price * 100
        
        # Calculate component scores
        score_momentum = self._score_momentum(move_from_open)
        score_range = self._score_range(range_pct)
        score_volume = self.weights['volume']  # Fixed for now
        score_market = self.weights['market'] if market_trend.get('is_up') else 0
        
        total_score = score_momentum + score_range + score_volume + score_market
        
        # Determine grade
        grade = self._score_to_grade(total_score)
        decision = self._grade_to_decision(grade)
        
        # Determine direction (CALL or PUT based on move direction)
        direction = 'CALL' if current > open_price else 'PUT'
        
        # Calculate strike (ATM = at-the-money)
        strike = self._calculate_atm_strike(current)
        
        # Calculate expiration (next Friday)
        expiration = self._get_next_friday()
        
        return {
            'ticker': quote.get('ticker'),
            'score': total_score,
            'grade': grade,
            'decision': decision,
            'components': {
                'momentum': score_momentum,
                'range': score_range,
                'volume': score_volume,
                'market': score_market
            },
            'metrics': {
                'move_pct': round(move_from_open, 2),
                'range_pct': round(range_pct, 2),
                'current': current,
                'open': open_price,
                'high': high,
                'low': low
            },
            'direction': direction,
            'strike': strike,
            'expiration': expiration
        }
    
    def _score_momentum(self, move_pct):
        """Score based on absolute move from open"""
        if move_pct >= 3.0:
            return self.weights['momentum']
        elif move_pct >= 2.0:
            return int(self.weights['momentum'] * 0.8)  # 20
        elif move_pct >= 1.5:
            return int(self.weights['momentum'] * 0.6)  # 15
        elif move_pct >= 1.0:
            return int(self.weights['momentum'] * 0.4)  # 10
        else:
            return 0
    
    def _score_range(self, range_pct):
        """Score based on daily price range"""
        if range_pct >= 3.0:
            return self.weights['range']
        elif range_pct >= 2.0:
            return int(self.weights['range'] * 0.67)  # 10
        elif range_pct >= 1.5:
            return int(self.weights['range'] * 0.33)  # 5
        else:
            return 0
    
    def _score_to_grade(self, score):
        """Convert numerical score to letter grade"""
        if score >= self.thresholds['A+']:
            return 'A+'
        elif score >= self.thresholds['A']:
            return 'A'
        elif score >= self.thresholds['A-']:
            return 'A-'
        elif score >= self.thresholds['B+']:
            return 'B+'
        elif score >= self.thresholds['B']:
            return 'B'
        elif score >= self.thresholds['B-']:
            return 'B-'
        elif score >= 31:
            return 'C+'
        elif score >= 28:
            return 'C'
        elif score >= 25:
            return 'C-'
        else:
            return 'D'
    
    def _grade_to_decision(self, grade):
        """Convert grade to decision text"""
        if grade in ['A+', 'A', 'A-']:
            return 'STRONG BUY'
        elif grade in ['B+', 'B', 'B-']:
            return 'BUY'
        elif grade in ['C+', 'C', 'C-']:
            return 'WATCH'
        else:
            return 'SKIP'
    
    def _calculate_atm_strike(self, current_price):
        """Calculate at-the-money strike price"""
        # Round to nearest strike interval
        if current_price >= 500:
            interval = 10
        elif current_price >= 200:
            interval = 5
        elif current_price >= 100:
            interval = 2.5
        elif current_price >= 50:
            interval = 1
        else:
            interval = 0.5
        
        return round(current_price / interval) * interval
    
    def _get_next_friday(self):
        """Get next Friday's date (or following Friday if after 3pm Friday)"""
        now = datetime.now()
        days_ahead = 4 - now.weekday()  # Friday is 4
        
        # If today is Friday and after 3pm, get next Friday
        if now.weekday() == 4 and now.hour >= 15:
            days_ahead = 7
        # If past Friday, get next Friday
        elif days_ahead < 0:
            days_ahead += 7
        # If Saturday or Sunday, get next Friday
        elif now.weekday() in [5, 6]:
            days_ahead = (4 - now.weekday()) % 7
            if days_ahead == 0:
                days_ahead = 7
        
        next_friday = now + timedelta(days=days_ahead)
        return next_friday.date()
    
    def _skip_result(self, ticker):
        """Return a skip result for invalid data"""
        return {
            'ticker': ticker,
            'score': 0,
            'grade': 'D',
            'decision': 'SKIP',
            'components': {'momentum': 0, 'range': 0, 'volume': 0, 'market': 0},
            'metrics': {'move_pct': 0, 'range_pct': 0},
            'direction': 'CALL',
            'strike': 0,
            'expiration': self._get_next_friday()
        }

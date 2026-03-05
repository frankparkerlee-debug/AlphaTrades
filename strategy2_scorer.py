"""
Strategy 2 Scoring Algorithm
Adds sentiment, news, and earnings data to Strategy 1's momentum foundation
Total: 100 points (vs Strategy 1's 55 points)
"""
from datetime import datetime, timedelta
from decimal import Decimal
import requests
import time
from collections import Counter

class Strategy2Scorer:
    def __init__(self, config=None, finnhub_key='d6k4j79r01qko8c3c750d6k4j79r01qko8c3c75g'):
        """
        Initialize Strategy 2 scorer with Finnhub API integration
        """
        self.finnhub_key = finnhub_key
        self.finnhub_base = 'https://finnhub.io/api/v1'
        
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
                'market': config.weight_market,
                'news_sentiment': getattr(config, 'weight_news_sentiment', 20),
                'earnings': getattr(config, 'weight_earnings', 10),
                'social': getattr(config, 'weight_social', 10)
            }
        else:
            # Strategy 2 default configuration
            self.thresholds = {
                'A+': 85, 'A': 75, 'A-': 70,
                'B+': 65, 'B': 60, 'B-': 55
            }
            self.weights = {
                'momentum': 25,
                'range': 15,
                'volume': 10,
                'market': 10,
                'news_sentiment': 20,
                'earnings': 10,
                'social': 10
            }
        
        # Cache for API calls (to avoid rate limits during backtesting)
        self._news_cache = {}
        self._earnings_cache = {}
        self._social_cache = {}
    
    def calculate_score(self, quote, market_trend, date=None):
        """
        Calculate Strategy 2 score with sentiment/news/earnings
        
        Args:
            quote: Dict with keys: ticker, current, open, high, low
            market_trend: Dict with keys: is_up (bool), change_pct (float)
            date: Optional datetime for historical backtesting
        
        Returns:
            Dict with score, grade, decision, components breakdown
        """
        open_price = float(quote.get('open', 0))
        current = float(quote.get('current', 0))
        high = float(quote.get('high', 0))
        low = float(quote.get('low', 0))
        ticker = quote.get('ticker', 'UNKNOWN')
        
        if open_price == 0 or current == 0:
            return self._skip_result(ticker)
        
        # Calculate base metrics (Strategy 1 components)
        move_from_open = abs((current - open_price) / open_price * 100)
        range_pct = (high - low) / open_price * 100
        
        # Base component scores
        score_momentum = self._score_momentum(move_from_open)
        score_range = self._score_range(range_pct)
        score_volume = self.weights['volume']  # Enhanced from Strategy 1's 5 to 10
        score_market = self.weights['market'] if market_trend.get('is_up') else 0
        
        # NEW: Sentiment/News/Earnings components
        score_news = self._score_news_sentiment(ticker, date)
        score_earnings = self._score_earnings_impact(ticker, date)
        score_social = self._score_social_sentiment(ticker, date)
        
        total_score = (score_momentum + score_range + score_volume + score_market + 
                      score_news + score_earnings + score_social)
        
        # Determine grade with new thresholds
        grade = self._score_to_grade(total_score)
        decision = self._grade_to_decision(grade)
        
        # Determine direction
        direction = 'CALL' if current > open_price else 'PUT'
        
        # Calculate strike (ATM)
        strike = self._calculate_atm_strike(current)
        
        # Calculate expiration (next Friday)
        expiration = self._get_next_friday()
        
        return {
            'ticker': ticker,
            'score': total_score,
            'grade': grade,
            'decision': decision,
            'components': {
                'momentum': score_momentum,
                'range': score_range,
                'volume': score_volume,
                'market': score_market,
                'news_sentiment': score_news,
                'earnings': score_earnings,
                'social': score_social
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
    
    def _score_news_sentiment(self, ticker, date=None):
        """
        Score based on news sentiment from Finnhub (0-20 points)
        Analyzes headlines from last 24 hours
        """
        try:
            # Determine date range for news lookup
            if date:
                end_date = date
                start_date = date - timedelta(days=1)
            else:
                end_date = datetime.now()
                start_date = end_date - timedelta(days=1)
            
            # Check cache
            cache_key = f"{ticker}_{end_date.date()}"
            if cache_key in self._news_cache:
                return self._news_cache[cache_key]
            
            # Format dates for API
            from_date = start_date.strftime('%Y-%m-%d')
            to_date = end_date.strftime('%Y-%m-%d')
            
            # Call Finnhub News API
            url = f"{self.finnhub_base}/company-news"
            params = {
                'symbol': ticker,
                'from': from_date,
                'to': to_date,
                'token': self.finnhub_key
            }
            
            response = requests.get(url, params=params, timeout=5)
            
            if response.status_code != 200:
                self._news_cache[cache_key] = 0
                return 0
            
            news = response.json()
            
            if not news or len(news) == 0:
                self._news_cache[cache_key] = 5  # Neutral baseline
                return 5
            
            # Analyze sentiment from headlines
            positive_keywords = ['beat', 'surge', 'rally', 'jump', 'gain', 'high', 'upgrade', 
                               'bullish', 'strong', 'growth', 'record', 'win', 'up', 'rise']
            negative_keywords = ['miss', 'fall', 'drop', 'decline', 'down', 'downgrade', 
                               'bearish', 'weak', 'loss', 'cut', 'concern', 'warning']
            
            positive_count = 0
            negative_count = 0
            
            for article in news[:10]:  # Analyze top 10 articles
                headline = article.get('headline', '').lower()
                summary = article.get('summary', '').lower()
                text = headline + ' ' + summary
                
                for word in positive_keywords:
                    if word in text:
                        positive_count += 1
                
                for word in negative_keywords:
                    if word in text:
                        negative_count += 1
            
            # Calculate sentiment score (0-20 points)
            if positive_count == 0 and negative_count == 0:
                score = 10  # Neutral
            else:
                # Net sentiment ratio
                net_sentiment = (positive_count - negative_count) / max(positive_count + negative_count, 1)
                score = 10 + (net_sentiment * 10)  # Map from -1 to +1 -> 0 to 20
            
            score = max(0, min(20, score))  # Clamp to 0-20
            
            self._news_cache[cache_key] = score
            return score
            
        except Exception as e:
            # On error, return neutral score to avoid breaking backtests
            return 10
    
    def _score_earnings_impact(self, ticker, date=None):
        """
        Score based on earnings beats and upcoming earnings (0-10 points)
        - Recent beat (last 5 days): +10 points
        - Upcoming earnings (today/tomorrow): +5 points
        """
        try:
            # Determine date range
            if date:
                check_date = date
            else:
                check_date = datetime.now()
            
            # Check cache
            cache_key = f"{ticker}_{check_date.date()}"
            if cache_key in self._earnings_cache:
                return self._earnings_cache[cache_key]
            
            # Look back 5 days and forward 2 days
            from_date = (check_date - timedelta(days=5)).strftime('%Y-%m-%d')
            to_date = (check_date + timedelta(days=2)).strftime('%Y-%m-%d')
            
            # Call Finnhub Earnings Calendar
            url = f"{self.finnhub_base}/calendar/earnings"
            params = {
                'from': from_date,
                'to': to_date,
                'symbol': ticker,
                'token': self.finnhub_key
            }
            
            response = requests.get(url, params=params, timeout=5)
            
            if response.status_code != 200:
                self._earnings_cache[cache_key] = 0
                return 0
            
            data = response.json()
            earnings = data.get('earningsCalendar', [])
            
            score = 0
            
            for event in earnings:
                event_date = datetime.strptime(event.get('date', ''), '%Y-%m-%d')
                
                # Check if earnings beat (EPS actual > EPS estimate)
                eps_actual = event.get('epsActual')
                eps_estimate = event.get('epsEstimate')
                
                days_ago = (check_date - event_date).days
                
                # Recent beat (last 5 days)
                if 0 <= days_ago <= 5:
                    if eps_actual and eps_estimate and eps_actual > eps_estimate:
                        score = 10
                        break
                
                # Upcoming earnings (today or tomorrow)
                if -1 <= days_ago <= 0:
                    score = max(score, 5)
            
            self._earnings_cache[cache_key] = score
            return score
            
        except Exception as e:
            return 0
    
    def _score_social_sentiment(self, ticker, date=None):
        """
        Score based on social media sentiment from Finnhub (0-10 points)
        Reddit + Twitter mention volume and sentiment
        """
        try:
            # Check cache
            if date:
                cache_key = f"{ticker}_{date.date()}"
            else:
                cache_key = f"{ticker}_{datetime.now().date()}"
            
            if cache_key in self._social_cache:
                return self._social_cache[cache_key]
            
            # Call Finnhub Social Sentiment API
            url = f"{self.finnhub_base}/stock/social-sentiment"
            params = {
                'symbol': ticker,
                'token': self.finnhub_key
            }
            
            response = requests.get(url, params=params, timeout=5)
            
            if response.status_code != 200:
                self._social_cache[cache_key] = 0
                return 0
            
            data = response.json()
            
            # Get Reddit and Twitter data
            reddit = data.get('reddit', [])
            twitter = data.get('twitter', [])
            
            if not reddit and not twitter:
                self._social_cache[cache_key] = 5  # Neutral
                return 5
            
            # Analyze sentiment (use most recent data point)
            score = 5  # Start neutral
            
            if reddit and len(reddit) > 0:
                reddit_sentiment = reddit[0].get('sentiment', 0)
                reddit_mention = reddit[0].get('mention', 0)
                
                # Positive sentiment + high mentions = higher score
                if reddit_sentiment > 0.1 and reddit_mention > 10:
                    score += 3
                elif reddit_sentiment < -0.1:
                    score -= 2
            
            if twitter and len(twitter) > 0:
                twitter_sentiment = twitter[0].get('sentiment', 0)
                twitter_mention = twitter[0].get('mention', 0)
                
                # Positive sentiment + high mentions = higher score
                if twitter_sentiment > 0.1 and twitter_mention > 50:
                    score += 2
                elif twitter_sentiment < -0.1:
                    score -= 1
            
            score = max(0, min(10, score))  # Clamp to 0-10
            
            self._social_cache[cache_key] = score
            return score
            
        except Exception as e:
            return 5  # Neutral on error
    
    def _score_momentum(self, move_pct):
        """Score based on absolute move from open (0-25 points)"""
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
        """Score based on daily price range (0-15 points)"""
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
        elif score >= 50:
            return 'C+'
        elif score >= 45:
            return 'C'
        elif score >= 40:
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
        """Get next Friday's date"""
        now = datetime.now()
        days_ahead = 4 - now.weekday()
        
        if now.weekday() == 4 and now.hour >= 15:
            days_ahead = 7
        elif days_ahead < 0:
            days_ahead += 7
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
            'components': {
                'momentum': 0, 'range': 0, 'volume': 0, 'market': 0,
                'news_sentiment': 0, 'earnings': 0, 'social': 0
            },
            'metrics': {'move_pct': 0, 'range_pct': 0},
            'direction': 'CALL',
            'strike': 0,
            'expiration': self._get_next_friday()
        }

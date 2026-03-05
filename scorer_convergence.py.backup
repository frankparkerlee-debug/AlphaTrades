"""
Convergence-Based Scoring for Asymmetric Momentum Trades
Multiple independent signals that score separately - convergence = high probability
"""
import logging
import requests
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)

class ConvergenceScorer:
    """Multi-signal convergence scoring for asymmetric returns"""
    
    def __init__(self, alpaca_api_key=None, alpaca_secret_key=None):
        self.alpaca_api_key = alpaca_api_key
        self.alpaca_secret_key = alpaca_secret_key
        
        # Signal weights (total = 100)
        self.weights = {
            'momentum': 25,      # Price momentum strength
            'volume': 20,        # Volume surge/trend
            'news': 20,          # Breaking news/announcements
            'sentiment': 15,     # Social sentiment (StockTwits)
            'market': 10,        # Market relativity (vs SPY)
            'technical': 10      # Support/resistance, trend
        }
        
    def score_ticker(self, ticker, quote_data, market_data):
        """
        Score a ticker across all signals
        
        Returns:
            {
                'ticker': str,
                'total_score': 0-100,
                'grade': 'A+' to 'D',
                'signals': {
                    'momentum': {'score': 0-25, 'status': '✅/⚠️/❌', 'reason': str},
                    'volume': {...},
                    'news': {...},
                    'sentiment': {...},
                    'market': {...},
                    'technical': {...}
                },
                'convergence_count': 0-6,  # How many signals aligned
                'catalysts': [],  # List of identified catalysts
                'confidence': 'HIGH/MEDIUM/LOW'
            }
        """
        logger.info(f"🎯 Scoring {ticker} for convergence...")
        
        signals = {}
        catalysts = []
        
        # 1. Momentum Score (25 pts)
        momentum_result = self._score_momentum(ticker, quote_data)
        signals['momentum'] = momentum_result
        if momentum_result['score'] >= 20:
            catalysts.append(momentum_result['reason'])
        
        # 2. Volume Score (20 pts)
        volume_result = self._score_volume(ticker, quote_data)
        signals['volume'] = volume_result
        if volume_result['score'] >= 16:
            catalysts.append(volume_result['reason'])
        
        # 3. News Score (20 pts)
        news_result = self._score_news(ticker)
        signals['news'] = news_result
        if news_result['score'] >= 16:
            catalysts.extend(news_result.get('catalysts', []))
        
        # 4. Sentiment Score (15 pts)
        sentiment_result = self._score_sentiment(ticker)
        signals['sentiment'] = sentiment_result
        if sentiment_result['score'] >= 12:
            catalysts.append(sentiment_result['reason'])
        
        # 5. Market Score (10 pts)
        market_result = self._score_market(ticker, quote_data, market_data)
        signals['market'] = market_result
        
        # 6. Technical Score (10 pts)
        technical_result = self._score_technical(ticker, quote_data)
        signals['technical'] = technical_result
        
        # Calculate totals
        total_score = sum(s['score'] for s in signals.values())
        convergence_count = sum(1 for s in signals.values() if s['status'] == '✅')
        
        # Determine grade
        grade = self._score_to_grade(total_score)
        
        # Determine confidence
        if convergence_count >= 5:
            confidence = 'HIGH'
        elif convergence_count >= 3:
            confidence = 'MEDIUM'
        else:
            confidence = 'LOW'
        
        result = {
            'ticker': ticker,
            'total_score': total_score,
            'grade': grade,
            'signals': signals,
            'convergence_count': convergence_count,
            'catalysts': list(set(catalysts))[:5],  # Top 5 unique catalysts
            'confidence': confidence,
            'timestamp': datetime.now().isoformat()
        }
        
        logger.info(f"   ✅ {ticker} Score: {total_score}/100 ({grade})")
        logger.info(f"   Convergence: {convergence_count}/6 signals aligned")
        logger.info(f"   Confidence: {confidence}")
        
        return result
    
    def _score_momentum(self, ticker, quote_data):
        """Score price momentum (25 pts)"""
        current = quote_data.get('c', 0)
        open_price = quote_data.get('o', current)
        prev_close = quote_data.get('pc', current)
        high = quote_data.get('h', current)
        low = quote_data.get('l', current)
        
        if not current or not prev_close:
            return {'score': 0, 'status': '❌', 'reason': 'No price data'}
        
        # Calculate momentum metrics
        move_from_open = ((current - open_price) / open_price) * 100
        move_from_prev = ((current - prev_close) / prev_close) * 100
        range_pct = ((high - low) / open_price) * 100 if open_price else 0
        
        score = 0
        reason = ""
        
        # Strong momentum (absolute move)
        abs_move = abs(move_from_open)
        if abs_move >= 5.0:
            score = 25
            reason = f"Explosive {abs_move:.1f}% move"
        elif abs_move >= 3.0:
            score = 20
            reason = f"Strong {abs_move:.1f}% move"
        elif abs_move >= 2.0:
            score = 15
            reason = f"Moderate {abs_move:.1f}% move"
        elif abs_move >= 1.0:
            score = 10
            reason = f"Small {abs_move:.1f}% move"
        else:
            reason = f"Weak {abs_move:.1f}% move"
        
        # Determine status
        if score >= 20:
            status = '✅'
        elif score >= 10:
            status = '⚠️'
        else:
            status = '❌'
        
        return {
            'score': score,
            'status': status,
            'reason': reason,
            'metrics': {
                'move_from_open': round(move_from_open, 2),
                'move_from_prev': round(move_from_prev, 2),
                'range_pct': round(range_pct, 2)
            }
        }
    
    def _score_volume(self, ticker, quote_data):
        """Score volume surge (20 pts)"""
        # TODO: Get actual volume data from Alpaca
        # For now, placeholder scoring
        score = 10
        status = '⚠️'
        reason = "Volume data pending"
        
        return {
            'score': score,
            'status': status,
            'reason': reason
        }
    
    def _score_news(self, ticker):
        """Score news/announcements (20 pts)"""
        if not self.alpaca_api_key:
            return {'score': 0, 'status': '⚠️', 'reason': 'News API not configured', 'catalysts': []}
        
        try:
            # Alpaca News API
            url = "https://data.alpaca.markets/v1beta1/news"
            headers = {
                'APCA-API-KEY-ID': self.alpaca_api_key,
                'APCA-API-SECRET-KEY': self.alpaca_secret_key
            }
            
            # Get news from last 24 hours
            params = {
                'symbols': ticker,
                'limit': 10,
                'sort': 'desc'
            }
            
            response = requests.get(url, headers=headers, params=params, timeout=5)
            
            if response.status_code != 200:
                return {'score': 0, 'status': '⚠️', 'reason': 'News API error', 'catalysts': []}
            
            news_items = response.json().get('news', [])
            
            if not news_items:
                return {'score': 0, 'status': '❌', 'reason': 'No recent news', 'catalysts': []}
            
            # Analyze news recency and sentiment
            now = datetime.now()
            recent_news = []
            catalysts = []
            
            for item in news_items[:5]:  # Top 5 articles
                headline = item.get('headline', '')
                created_at = item.get('created_at', '')
                
                # Parse timestamp
                try:
                    news_time = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
                    hours_ago = (now - news_time.replace(tzinfo=None)).total_seconds() / 3600
                except:
                    hours_ago = 999
                
                if hours_ago < 24:
                    recent_news.append({'headline': headline, 'hours_ago': hours_ago})
                    
                    # Look for catalyst keywords
                    headline_lower = headline.lower()
                    if any(kw in headline_lower for kw in ['partner', 'deal', 'acquire', 'merger']):
                        catalysts.append(f"Partnership/Deal: {headline[:50]}...")
                    elif any(kw in headline_lower for kw in ['fda', 'approval', 'trial']):
                        catalysts.append(f"FDA/Trial: {headline[:50]}...")
                    elif any(kw in headline_lower for kw in ['earnings', 'beat', 'revenue']):
                        catalysts.append(f"Earnings: {headline[:50]}...")
                    elif any(kw in headline_lower for kw in ['contract', 'order', 'customer']):
                        catalysts.append(f"Contract: {headline[:50]}...")
            
            # Score based on recency and number of articles
            score = 0
            if recent_news:
                most_recent_hours = min(n['hours_ago'] for n in recent_news)
                
                if most_recent_hours < 2:  # Breaking news
                    score = 20
                    reason = f"Breaking news {int(most_recent_hours)}h ago"
                elif most_recent_hours < 6:
                    score = 15
                    reason = f"Recent news {int(most_recent_hours)}h ago"
                elif most_recent_hours < 24:
                    score = 10
                    reason = f"News {int(most_recent_hours)}h ago"
                else:
                    score = 5
                    reason = "Older news"
                
                # Bonus for multiple articles (trending)
                if len(recent_news) >= 3:
                    score += 5
                    reason += f" ({len(recent_news)} articles)"
            else:
                score = 0
                reason = "No recent news"
            
            status = '✅' if score >= 16 else '⚠️' if score >= 8 else '❌'
            
            return {
                'score': score,
                'status': status,
                'reason': reason,
                'catalysts': catalysts,
                'recent_news': recent_news[:3]  # Top 3 for display
            }
            
        except Exception as e:
            logger.error(f"Error fetching news for {ticker}: {e}")
            return {'score': 0, 'status': '⚠️', 'reason': 'News fetch error', 'catalysts': []}
    
    def _score_sentiment(self, ticker):
        """Score social sentiment from StockTwits (15 pts)"""
        try:
            # StockTwits API (free, no key needed for basic)
            url = f"https://api.stocktwits.com/api/2/streams/symbol/{ticker}.json"
            response = requests.get(url, timeout=5)
            
            if response.status_code != 200:
                return {'score': 0, 'status': '⚠️', 'reason': 'StockTwits API error'}
            
            data = response.json()
            messages = data.get('messages', [])
            
            if not messages:
                return {'score': 0, 'status': '❌', 'reason': 'No social mentions'}
            
            # Analyze sentiment from recent messages
            bullish = 0
            bearish = 0
            total = 0
            
            for msg in messages[:20]:  # Last 20 messages
                entities = msg.get('entities', {})
                sentiment = entities.get('sentiment', {})
                
                if sentiment:
                    basic = sentiment.get('basic', '')
                    if basic == 'Bullish':
                        bullish += 1
                    elif basic == 'Bearish':
                        bearish += 1
                    total += 1
            
            if total == 0:
                return {'score': 0, 'status': '⚠️', 'reason': 'No sentiment data'}
            
            # Calculate sentiment ratio
            bullish_pct = (bullish / total) * 100 if total > 0 else 0
            bearish_pct = (bearish / total) * 100 if total > 0 else 0
            
            # Score based on bullish sentiment
            score = 0
            if bullish_pct >= 70:
                score = 15
                reason = f"Very bullish ({int(bullish_pct)}%)"
            elif bullish_pct >= 60:
                score = 12
                reason = f"Bullish ({int(bullish_pct)}%)"
            elif bullish_pct >= 50:
                score = 8
                reason = f"Slightly bullish ({int(bullish_pct)}%)"
            elif bearish_pct >= 60:
                score = 3
                reason = f"Bearish ({int(bearish_pct)}%)"
            else:
                score = 5
                reason = "Mixed sentiment"
            
            status = '✅' if score >= 12 else '⚠️' if score >= 6 else '❌'
            
            return {
                'score': score,
                'status': status,
                'reason': reason,
                'metrics': {
                    'bullish_pct': round(bullish_pct, 1),
                    'bearish_pct': round(bearish_pct, 1),
                    'message_count': len(messages)
                }
            }
            
        except Exception as e:
            logger.error(f"Error fetching StockTwits for {ticker}: {e}")
            return {'score': 0, 'status': '⚠️', 'reason': 'Social sentiment unavailable'}
    
    def _score_market(self, ticker, quote_data, market_data):
        """Score market relativity vs SPY (10 pts)"""
        # Check if stock is outperforming market
        stock_move = ((quote_data.get('c', 0) - quote_data.get('pc', 0)) / quote_data.get('pc', 1)) * 100
        spy_move = market_data.get('change_pct', 0)
        
        outperformance = stock_move - spy_move
        
        score = 0
        if outperformance >= 3:
            score = 10
            reason = f"Strong outperformance (+{outperformance:.1f}% vs SPY)"
        elif outperformance >= 1:
            score = 7
            reason = f"Outperforming (+{outperformance:.1f}% vs SPY)"
        elif outperformance >= 0:
            score = 5
            reason = f"Slight outperformance (+{outperformance:.1f}% vs SPY)"
        else:
            score = 2
            reason = f"Underperforming ({outperformance:.1f}% vs SPY)"
        
        status = '✅' if score >= 7 else '⚠️' if score >= 5 else '❌'
        
        return {
            'score': score,
            'status': status,
            'reason': reason,
            'metrics': {
                'stock_move': round(stock_move, 2),
                'spy_move': round(spy_move, 2),
                'outperformance': round(outperformance, 2)
            }
        }
    
    def _score_technical(self, ticker, quote_data):
        """Score technical setup (10 pts)"""
        current = quote_data.get('c', 0)
        open_price = quote_data.get('o', current)
        high = quote_data.get('h', current)
        low = quote_data.get('l', current)
        
        # Simple technical scoring
        # TODO: Add more sophisticated technical analysis
        
        # Check if near high of day (momentum continuation)
        distance_from_high = ((high - current) / current) * 100 if current else 0
        
        score = 0
        if distance_from_high < 0.5:
            score = 10
            reason = "At HOD (strong)"
        elif distance_from_high < 1.0:
            score = 7
            reason = "Near HOD"
        elif distance_from_high < 2.0:
            score = 5
            reason = "Below HOD"
        else:
            score = 3
            reason = "Off highs"
        
        status = '✅' if score >= 7 else '⚠️' if score >= 4 else '❌'
        
        return {
            'score': score,
            'status': status,
            'reason': reason
        }
    
    def _score_to_grade(self, score):
        """Convert numeric score to letter grade"""
        if score >= 90:
            return 'A+'
        elif score >= 85:
            return 'A'
        elif score >= 80:
            return 'A-'
        elif score >= 75:
            return 'B+'
        elif score >= 70:
            return 'B'
        elif score >= 65:
            return 'B-'
        elif score >= 60:
            return 'C+'
        elif score >= 55:
            return 'C'
        elif score >= 50:
            return 'C-'
        else:
            return 'D'

# Global instance
_scorer = None

def get_convergence_scorer(alpaca_api_key=None, alpaca_secret_key=None):
    """Get or create convergence scorer instance"""
    global _scorer
    if _scorer is None:
        _scorer = ConvergenceScorer(alpaca_api_key, alpaca_secret_key)
    return _scorer

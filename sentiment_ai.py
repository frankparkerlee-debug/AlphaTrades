"""
AI-Powered Sentiment Analysis for Distress Scanner
Hybrid approach: Keyword filter → AI deep analysis on top candidates
"""

import os
import json
import logging
from typing import Dict, List, Optional
from datetime import datetime
import requests

logger = logging.getLogger(__name__)

# AI Provider configuration
ANTHROPIC_API_KEY = os.getenv('ANTHROPIC_API_KEY')
OPENAI_API_KEY = os.getenv('OPENAI_API_KEY')


class AISentimentAnalyzer:
    """
    Two-stage sentiment analysis:
    1. Quick keyword filter (free)
    2. AI deep dive on high-potential candidates
    """
    
    # Stage 1: Keyword weights (enhanced)
    NEGATIVE_SIGNALS = {
        # Severe (weight 3)
        'fraud': 3, 'investigation': 3, 'sec probe': 3, 'accounting irregularities': 3,
        'restatement': 3, 'ceo resign': 3, 'cfo resign': 3, 'ceo departure': 3,
        'securities fraud': 3, 'class action': 3, 'material weakness': 3,
        
        # High (weight 2)
        'layoff': 2, 'restructuring': 2, 'guidance cut': 2, 'downgrade': 2,
        'miss expectations': 2, 'disappointing': 2, 'warning': 2, 'lawsuit': 2,
        'data breach': 2, 'product recall': 2, 'fda rejection': 2,
        
        # Moderate (weight 1)
        'decline': 1, 'weak': 1, 'concern': 1, 'risk': 1, 'pressure': 1,
        'challenging': 1, 'headwind': 1, 'slowdown': 1, 'competitive': 1
    }
    
    POSITIVE_SIGNALS = {
        'beat': 2, 'exceed': 2, 'upgrade': 2, 'raise guidance': 2,
        'strong growth': 2, 'record revenue': 2, 'expansion': 1, 'partnership': 1
    }
    
    @classmethod
    def quick_score(cls, text: str) -> Dict:
        """
        Stage 1: Fast keyword-based scoring
        Returns score and matched signals
        """
        if not text:
            return {'score': 0, 'signals': [], 'stage': 'quick'}
        
        text_lower = text.lower()
        
        negative_score = 0
        positive_score = 0
        signals = []
        
        for keyword, weight in cls.NEGATIVE_SIGNALS.items():
            if keyword in text_lower:
                negative_score += weight
                signals.append({'type': 'negative', 'keyword': keyword, 'weight': weight})
        
        for keyword, weight in cls.POSITIVE_SIGNALS.items():
            if keyword in text_lower:
                positive_score += weight
                signals.append({'type': 'positive', 'keyword': keyword, 'weight': weight})
        
        # Net score: negative is bad (higher = more distress)
        net_score = negative_score - positive_score
        
        # Normalize to 0-100 scale (10 points = very distressed)
        normalized = min(100, max(0, net_score * 10))
        
        return {
            'score': normalized,
            'raw_negative': negative_score,
            'raw_positive': positive_score,
            'signals': signals,
            'stage': 'quick'
        }
    
    @classmethod
    def quick_score_batch(cls, articles: List[Dict]) -> Dict:
        """Score multiple articles and aggregate"""
        if not articles:
            return {'score': 0, 'article_count': 0, 'signals': [], 'stage': 'quick'}
        
        all_signals = []
        total_score = 0
        
        for article in articles:
            text = f"{article.get('headline', '')} {article.get('summary', '')}"
            result = cls.quick_score(text)
            total_score += result['score']
            all_signals.extend(result['signals'])
        
        avg_score = total_score / len(articles)
        
        return {
            'score': round(avg_score, 1),
            'article_count': len(articles),
            'signals': all_signals[:10],  # Top 10 signals
            'stage': 'quick'
        }
    
    @classmethod
    def ai_deep_analysis(cls, ticker: str, articles: List[Dict], 
                         earnings_date: Optional[str] = None,
                         price_change_30d: Optional[float] = None) -> Dict:
        """
        Stage 2: AI-powered deep analysis
        Uses Claude or GPT to analyze context and nuance
        """
        
        if not articles:
            return {'score': 0, 'analysis': 'No articles to analyze', 'stage': 'ai'}
        
        # Prepare article summaries for AI
        article_texts = []
        for i, article in enumerate(articles[:10]):  # Limit to 10 articles
            headline = article.get('headline', 'No headline')
            summary = article.get('summary', '')[:500]  # Truncate
            date = article.get('datetime', 'Unknown date')
            source = article.get('source', 'Unknown')
            article_texts.append(f"[{i+1}] {date} - {source}\n{headline}\n{summary}\n")
        
        articles_text = "\n---\n".join(article_texts)
        
        # Build prompt
        prompt = f"""Analyze these recent news articles about {ticker} for potential earnings miss signals.

CONTEXT:
- Ticker: {ticker}
- Earnings Date: {earnings_date or 'Unknown'}
- 30-day Price Change: {f'{price_change_30d:.1f}%' if price_change_30d else 'Unknown'}

ARTICLES:
{articles_text}

ANALYSIS REQUIRED:
1. Score the overall sentiment from -100 (extremely bearish/distressed) to +100 (bullish)
2. Identify specific distress signals (insider selling, guidance cuts, layoffs, etc.)
3. Assess if negative news is already priced into the stock
4. Estimate likelihood of earnings miss (low/medium/high)
5. Note any positive catalysts that might offset concerns

Return ONLY valid JSON (no markdown):
{{
  "sentiment_score": <-100 to +100>,
  "distress_level": "<none|low|medium|high|severe>",
  "earnings_miss_probability": "<low|medium|high>",
  "already_priced_in": <true|false>,
  "key_concerns": ["concern1", "concern2"],
  "positive_factors": ["factor1"],
  "summary": "2-3 sentence summary",
  "recommendation": "<no_trade|watch|consider_put|strong_put>"
}}"""

        # Try Claude first, fall back to OpenAI
        if ANTHROPIC_API_KEY:
            return cls._call_claude(prompt, ticker)
        elif OPENAI_API_KEY:
            return cls._call_openai(prompt, ticker)
        else:
            logger.warning("No AI API key configured, falling back to quick score")
            return {
                'score': 0,
                'analysis': 'No AI API key configured',
                'stage': 'fallback',
                'recommendation': 'Configure ANTHROPIC_API_KEY or OPENAI_API_KEY'
            }
    
    @classmethod
    def _call_claude(cls, prompt: str, ticker: str) -> Dict:
        """Call Claude API for analysis"""
        try:
            response = requests.post(
                'https://api.anthropic.com/v1/messages',
                headers={
                    'x-api-key': ANTHROPIC_API_KEY,
                    'content-type': 'application/json',
                    'anthropic-version': '2023-06-01'
                },
                json={
                    'model': 'claude-3-5-sonnet-20241022',
                    'max_tokens': 1024,
                    'messages': [{'role': 'user', 'content': prompt}]
                },
                timeout=30
            )
            
            if response.status_code == 200:
                content = response.json()['content'][0]['text']
                # Parse JSON from response
                try:
                    # Clean up response if needed
                    content = content.strip()
                    if content.startswith('```'):
                        content = content.split('```')[1]
                        if content.startswith('json'):
                            content = content[4:]
                    analysis = json.loads(content)
                    analysis['stage'] = 'ai_claude'
                    analysis['ticker'] = ticker
                    return analysis
                except json.JSONDecodeError as e:
                    logger.error(f"Failed to parse Claude response: {e}")
                    return {'score': 0, 'error': 'Parse error', 'raw': content[:500], 'stage': 'ai_error'}
            else:
                logger.error(f"Claude API error: {response.status_code} - {response.text[:200]}")
                return {'score': 0, 'error': f'API error {response.status_code}', 'stage': 'ai_error'}
                
        except Exception as e:
            logger.error(f"Claude API exception: {e}")
            return {'score': 0, 'error': str(e), 'stage': 'ai_error'}
    
    @classmethod
    def _call_openai(cls, prompt: str, ticker: str) -> Dict:
        """Call OpenAI API for analysis"""
        try:
            response = requests.post(
                'https://api.openai.com/v1/chat/completions',
                headers={
                    'Authorization': f'Bearer {OPENAI_API_KEY}',
                    'Content-Type': 'application/json'
                },
                json={
                    'model': 'gpt-4o-mini',
                    'messages': [{'role': 'user', 'content': prompt}],
                    'max_tokens': 1024,
                    'temperature': 0.3
                },
                timeout=30
            )
            
            if response.status_code == 200:
                content = response.json()['choices'][0]['message']['content']
                try:
                    content = content.strip()
                    if content.startswith('```'):
                        content = content.split('```')[1]
                        if content.startswith('json'):
                            content = content[4:]
                    analysis = json.loads(content)
                    analysis['stage'] = 'ai_openai'
                    analysis['ticker'] = ticker
                    return analysis
                except json.JSONDecodeError as e:
                    logger.error(f"Failed to parse OpenAI response: {e}")
                    return {'score': 0, 'error': 'Parse error', 'raw': content[:500], 'stage': 'ai_error'}
            else:
                logger.error(f"OpenAI API error: {response.status_code}")
                return {'score': 0, 'error': f'API error {response.status_code}', 'stage': 'ai_error'}
                
        except Exception as e:
            logger.error(f"OpenAI API exception: {e}")
            return {'score': 0, 'error': str(e), 'stage': 'ai_error'}


class HybridDistressScorer:
    """
    Full hybrid scoring pipeline:
    1. Gather data (SEC, news, insider)
    2. Quick filter all candidates
    3. AI deep dive on top 20
    4. Final ranking with "priced in" adjustments
    """
    
    def __init__(self, finnhub_key: Optional[str] = None, 
                 anthropic_key: Optional[str] = None,
                 openai_key: Optional[str] = None):
        self.finnhub_key = finnhub_key
        
        # Set API keys
        if anthropic_key:
            os.environ['ANTHROPIC_API_KEY'] = anthropic_key
        if openai_key:
            os.environ['OPENAI_API_KEY'] = openai_key
    
    def score_ticker(self, ticker: str, news: List[Dict],
                    sec_filings: int = 0, insider_sells: int = 0,
                    earnings_date: Optional[str] = None,
                    price_change_30d: Optional[float] = None,
                    iv_percentile: Optional[float] = None,
                    use_ai: bool = False) -> Dict:
        """
        Full hybrid scoring for a single ticker
        
        Args:
            ticker: Stock symbol
            news: List of news articles
            sec_filings: Number of recent 8-K filings
            insider_sells: Number of Form 4 sells
            earnings_date: Upcoming earnings date
            price_change_30d: 30-day price change %
            iv_percentile: Current IV percentile (0-100)
            use_ai: Whether to run AI deep analysis
        
        Returns:
            Complete scoring with recommendation
        """
        
        # Stage 1: Quick sentiment score
        quick_result = AISentimentAnalyzer.quick_score_batch(news)
        
        # Base score components
        sentiment_score = quick_result['score']
        
        # SEC/Insider scoring
        sec_score = min(30, sec_filings * 15)  # Max 30 pts for filings
        insider_score = min(35, insider_sells * 10)  # Max 35 pts for sells
        
        # Raw distress score
        raw_score = sentiment_score + sec_score + insider_score
        
        # "Priced In" deductions
        priced_in_deduction = 0
        priced_in_reasons = []
        
        if price_change_30d is not None:
            if price_change_30d <= -20:
                priced_in_deduction += 25
                priced_in_reasons.append(f"Stock down {price_change_30d:.1f}% (severely beaten)")
            elif price_change_30d <= -10:
                priced_in_deduction += 15
                priced_in_reasons.append(f"Stock down {price_change_30d:.1f}%")
        
        if iv_percentile is not None:
            if iv_percentile >= 95:
                priced_in_deduction += 20
                priced_in_reasons.append(f"IV at {iv_percentile:.0f}th percentile (extreme)")
            elif iv_percentile >= 80:
                priced_in_deduction += 10
                priced_in_reasons.append(f"IV at {iv_percentile:.0f}th percentile (elevated)")
        
        # Adjusted score
        adjusted_score = max(0, raw_score - priced_in_deduction)
        
        # Calculate days to earnings
        days_to_earnings = None
        if earnings_date:
            try:
                earn_dt = datetime.strptime(earnings_date, '%Y-%m-%d')
                days_to_earnings = (earn_dt - datetime.now()).days
            except:
                pass
        
        # Time-based threshold adjustment
        if days_to_earnings is not None and days_to_earnings <= 2:
            # Require higher score for late entries
            entry_threshold = 75
        elif days_to_earnings is not None and days_to_earnings <= 5:
            entry_threshold = 65
        else:
            entry_threshold = 55
        
        # Determine grade
        if adjusted_score >= 85:
            grade = 'A+'
        elif adjusted_score >= 80:
            grade = 'A'
        elif adjusted_score >= 70:
            grade = 'B+'
        elif adjusted_score >= 60:
            grade = 'B'
        elif adjusted_score >= 50:
            grade = 'C'
        else:
            grade = 'D'
        
        # Determine recommendation
        if adjusted_score >= entry_threshold:
            if adjusted_score >= 80:
                recommendation = 'STRONG_PUT'
            else:
                recommendation = 'CONSIDER_PUT'
        elif adjusted_score >= entry_threshold - 10:
            recommendation = 'WATCH'
        else:
            recommendation = 'NO_TRADE'
        
        result = {
            'ticker': ticker,
            'score': round(adjusted_score, 1),
            'raw_score': round(raw_score, 1),
            'grade': grade,
            'recommendation': recommendation,
            'components': {
                'sentiment': sentiment_score,
                'sec_filings': sec_score,
                'insider_activity': insider_score
            },
            'priced_in': {
                'deduction': priced_in_deduction,
                'reasons': priced_in_reasons
            },
            'signals': quick_result['signals'],
            'earnings_date': earnings_date,
            'days_to_earnings': days_to_earnings,
            'entry_threshold': entry_threshold,
            'stage': 'quick'
        }
        
        # Stage 2: AI deep analysis (if requested and score warrants it)
        if use_ai and raw_score >= 40:
            ai_result = AISentimentAnalyzer.ai_deep_analysis(
                ticker, news, earnings_date, price_change_30d
            )
            result['ai_analysis'] = ai_result
            result['stage'] = ai_result.get('stage', 'ai')
            
            # AI can adjust recommendation
            if ai_result.get('recommendation') == 'strong_put' and adjusted_score >= 60:
                result['recommendation'] = 'STRONG_PUT'
            elif ai_result.get('already_priced_in') and adjusted_score < 80:
                result['recommendation'] = 'NO_TRADE'
                result['priced_in']['reasons'].append('AI detected already priced in')
        
        return result


# Test
if __name__ == '__main__':
    # Test quick scoring
    test_articles = [
        {'headline': 'Company announces massive layoffs amid restructuring'},
        {'headline': 'CEO resigns amid accounting investigation'},
        {'headline': 'Strong Q4 results beat expectations'}
    ]
    
    result = AISentimentAnalyzer.quick_score_batch(test_articles)
    print(f"Quick Score: {result['score']}")
    print(f"Signals: {result['signals']}")
    
    # Test hybrid scorer
    scorer = HybridDistressScorer()
    full_result = scorer.score_ticker(
        'TEST',
        news=test_articles,
        sec_filings=2,
        insider_sells=3,
        price_change_30d=-15.0,
        iv_percentile=85,
        use_ai=False
    )
    print(f"\nFull Result:")
    print(json.dumps(full_result, indent=2))

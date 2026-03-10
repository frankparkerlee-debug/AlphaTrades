"""
Data Sources Module - API integrations for distress signal scanner
Free APIs: SEC EDGAR, Finnhub free tier
"""

import requests
import time
from datetime import datetime, timedelta
from typing import List, Dict, Optional
import json
import re


class SECEdgarAPI:
    """SEC EDGAR API - Free, no API key required"""
    BASE_URL = "https://www.sec.gov"
    HEADERS = {
        "User-Agent": "AlphaTrades DistressScanner parker@ideaworx.co"
    }
    
    # Class-level cache for company tickers (loaded once)
    _company_tickers_cache = None
    _cache_loaded_at = None
    
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update(self.HEADERS)
    
    def _load_company_tickers(self) -> dict:
        """Load company tickers JSON with caching (refreshes every 24h)"""
        import time as time_module
        
        # Check if cache is valid (less than 24 hours old)
        if (SECEdgarAPI._company_tickers_cache is not None and 
            SECEdgarAPI._cache_loaded_at is not None and
            time_module.time() - SECEdgarAPI._cache_loaded_at < 86400):
            return SECEdgarAPI._company_tickers_cache
        
        try:
            url = f"{self.BASE_URL}/files/company_tickers.json"
            time.sleep(0.5)  # Rate limit
            resp = self.session.get(url, timeout=30)
            resp.raise_for_status()
            
            SECEdgarAPI._company_tickers_cache = resp.json()
            SECEdgarAPI._cache_loaded_at = time_module.time()
            return SECEdgarAPI._company_tickers_cache
        except Exception as e:
            print(f"Error loading company tickers: {e}")
            return SECEdgarAPI._company_tickers_cache or {}
    
    def get_company_cik(self, ticker: str) -> Optional[str]:
        """Get CIK number for a ticker symbol (cached)"""
        try:
            tickers = self._load_company_tickers()
            ticker_upper = ticker.upper()
            
            for entry in tickers.values():
                if entry.get('ticker') == ticker_upper:
                    # Pad CIK to 10 digits
                    return str(entry['cik_str']).zfill(10)
            
            return None
        except Exception as e:
            print(f"Error getting CIK for {ticker}: {e}")
            return None
    
    def get_recent_8k_filings(self, ticker: str, days_back: int = 30) -> List[Dict]:
        """Get recent 8-K filings for a ticker"""
        cik = self.get_company_cik(ticker)
        if not cik:
            return []
        
        try:
            # Get filings from submissions endpoint
            url = f"{self.BASE_URL}/cgi-bin/browse-edgar"
            params = {
                'action': 'getcompany',
                'CIK': cik,
                'type': '8-K',
                'dateb': '',
                'owner': 'exclude',
                'count': '40',
                'output': 'atom'
            }
            
            time.sleep(0.5)  # Rate limiting - be nice to SEC
            resp = self.session.get(url, params=params, timeout=10)
            resp.raise_for_status()
            
            # Parse the atom feed for filing dates and links
            filings = []
            cutoff_date = datetime.now() - timedelta(days=days_back)
            
            # Simple regex parsing (could use xml parser but keeping dependencies light)
            entries = re.findall(r'<entry>(.*?)</entry>', resp.text, re.DOTALL)
            
            for entry in entries:
                date_match = re.search(r'<filing-date>(.*?)</filing-date>', entry)
                link_match = re.search(r'<filing-href>(.*?)</filing-href>', entry)
                
                if date_match and link_match:
                    filing_date = datetime.strptime(date_match.group(1), '%Y-%m-%d')
                    
                    if filing_date >= cutoff_date:
                        filings.append({
                            'date': filing_date.strftime('%Y-%m-%d'),
                            'url': link_match.group(1),
                            'type': '8-K'
                        })
            
            return filings
        
        except Exception as e:
            print(f"Error getting 8-K filings for {ticker}: {e}")
            return []
    
    def get_recent_form4_filings(self, ticker: str, days_back: int = 30) -> List[Dict]:
        """Get recent Form 4 insider trading filings"""
        cik = self.get_company_cik(ticker)
        if not cik:
            return []
        
        try:
            url = f"{self.BASE_URL}/cgi-bin/browse-edgar"
            params = {
                'action': 'getcompany',
                'CIK': cik,
                'type': '4',
                'dateb': '',
                'owner': 'include',
                'count': '40',
                'output': 'atom'
            }
            
            time.sleep(0.5)
            resp = self.session.get(url, params=params, timeout=10)
            resp.raise_for_status()
            
            filings = []
            cutoff_date = datetime.now() - timedelta(days=days_back)
            
            entries = re.findall(r'<entry>(.*?)</entry>', resp.text, re.DOTALL)
            
            for entry in entries:
                date_match = re.search(r'<filing-date>(.*?)</filing-date>', entry)
                
                if date_match:
                    filing_date = datetime.strptime(date_match.group(1), '%Y-%m-%d')
                    
                    if filing_date >= cutoff_date:
                        # Look for transaction code (S = Sell)
                        # This is simplified - full parsing would require XML
                        filings.append({
                            'date': filing_date.strftime('%Y-%m-%d'),
                            'type': 'Form 4',
                            'transaction': 'Unknown'  # Would need full parsing
                        })
            
            return filings
        
        except Exception as e:
            print(f"Error getting Form 4 filings for {ticker}: {e}")
            return []


class FinnhubAPI:
    """Finnhub API - Free tier available (60 API calls/minute)"""
    BASE_URL = "https://finnhub.io/api/v1"
    
    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or "demo"  # Use demo key if none provided
        self.session = requests.Session()
    
    def get_company_news(self, ticker: str, days_back: int = 7) -> List[Dict]:
        """Get recent company news"""
        try:
            from_date = (datetime.now() - timedelta(days=days_back)).strftime('%Y-%m-%d')
            to_date = datetime.now().strftime('%Y-%m-%d')
            
            url = f"{self.BASE_URL}/company-news"
            params = {
                'symbol': ticker.upper(),
                'from': from_date,
                'to': to_date,
                'token': self.api_key
            }
            
            resp = self.session.get(url, params=params, timeout=10)
            resp.raise_for_status()
            
            news = resp.json()
            return news if isinstance(news, list) else []
        
        except Exception as e:
            print(f"Error getting news for {ticker}: {e}")
            return []
    
    def get_earnings_calendar(self, ticker: str) -> Optional[Dict]:
        """Get upcoming earnings date"""
        try:
            url = f"{self.BASE_URL}/stock/earnings"
            params = {
                'symbol': ticker.upper(),
                'token': self.api_key
            }
            
            resp = self.session.get(url, params=params, timeout=10)
            resp.raise_for_status()
            
            return resp.json()
        
        except Exception as e:
            print(f"Error getting earnings calendar for {ticker}: {e}")
            return None


class SentimentAnalyzer:
    """Basic keyword-based sentiment analysis"""
    
    NEGATIVE_KEYWORDS = [
        'lawsuit', 'investigation', 'probe', 'fraud', 'scandal',
        'decline', 'plunge', 'crash', 'miss', 'disappointing',
        'warning', 'loss', 'layoff', 'departure', 'resign',
        'downgrade', 'cut', 'lower', 'reduce', 'concern',
        'risk', 'trouble', 'problem', 'issue', 'fail',
        'weak', 'poor', 'bad', 'negative', 'adverse'
    ]
    
    POSITIVE_KEYWORDS = [
        'growth', 'profit', 'gain', 'surge', 'beat',
        'upgrade', 'increase', 'strong', 'positive', 'success'
    ]
    
    @classmethod
    def analyze_text(cls, text: str) -> float:
        """
        Analyze sentiment of text
        Returns: -1.0 (very negative) to +1.0 (very positive)
        """
        if not text:
            return 0.0
        
        text_lower = text.lower()
        
        negative_count = sum(1 for kw in cls.NEGATIVE_KEYWORDS if kw in text_lower)
        positive_count = sum(1 for kw in cls.POSITIVE_KEYWORDS if kw in text_lower)
        
        total = negative_count + positive_count
        if total == 0:
            return 0.0
        
        # Normalize to -1.0 to +1.0
        sentiment = (positive_count - negative_count) / total
        return sentiment
    
    @classmethod
    def analyze_news_batch(cls, news_items: List[Dict]) -> Dict:
        """Analyze a batch of news items"""
        if not news_items:
            return {
                'average_sentiment': 0.0,
                'negative_count': 0,
                'total_count': 0,
                'negative_ratio': 0.0
            }
        
        sentiments = []
        negative_count = 0
        
        for item in news_items:
            text = f"{item.get('headline', '')} {item.get('summary', '')}"
            sentiment = cls.analyze_text(text)
            sentiments.append(sentiment)
            
            if sentiment < -0.3:  # Threshold for "negative"
                negative_count += 1
        
        avg_sentiment = sum(sentiments) / len(sentiments) if sentiments else 0.0
        
        return {
            'average_sentiment': avg_sentiment,
            'negative_count': negative_count,
            'total_count': len(news_items),
            'negative_ratio': negative_count / len(news_items) if news_items else 0.0
        }


class EarningsCalendar:
    """Earnings calendar data source"""
    
    @staticmethod
    def get_next_earnings_date(ticker: str, finnhub_api: FinnhubAPI) -> Optional[datetime]:
        """Get next earnings date for a ticker"""
        try:
            earnings_data = finnhub_api.get_earnings_calendar(ticker)
            
            if not earnings_data or not isinstance(earnings_data, list):
                return None
            
            # Find next earnings date
            now = datetime.now()
            
            for item in earnings_data:
                if 'date' in item:
                    earnings_date = datetime.strptime(item['date'], '%Y-%m-%d')
                    if earnings_date >= now:
                        return earnings_date
            
            return None
        
        except Exception as e:
            print(f"Error getting earnings date for {ticker}: {e}")
            return None
    
    @staticmethod
    def days_until_earnings(ticker: str, finnhub_api: FinnhubAPI) -> Optional[int]:
        """Get days until next earnings"""
        earnings_date = EarningsCalendar.get_next_earnings_date(ticker, finnhub_api)
        
        if earnings_date:
            delta = earnings_date - datetime.now()
            return delta.days
        
        return None


# Demo / Test functions
if __name__ == "__main__":
    print("Testing data sources...")
    
    # Test SEC EDGAR
    print("\n1. Testing SEC EDGAR API...")
    sec = SECEdgarAPI()
    cik = sec.get_company_cik("AAPL")
    print(f"Apple CIK: {cik}")
    
    filings_8k = sec.get_recent_8k_filings("AAPL", days_back=60)
    print(f"Recent 8-K filings: {len(filings_8k)}")
    
    # Test Finnhub (requires API key for full functionality)
    print("\n2. Testing Finnhub API...")
    finnhub = FinnhubAPI()  # Using demo key
    news = finnhub.get_company_news("AAPL", days_back=3)
    print(f"Recent news items: {len(news)}")
    
    # Test Sentiment
    print("\n3. Testing Sentiment Analyzer...")
    test_texts = [
        "Company announces major layoffs and disappointing earnings",
        "Strong growth and record profits expected",
        "Investigation launched into accounting practices"
    ]
    
    for text in test_texts:
        sentiment = SentimentAnalyzer.analyze_text(text)
        print(f"Text: {text[:50]}... | Sentiment: {sentiment:.2f}")
    
    print("\n✅ Data sources test complete!")

"""
Launch Control v2.0 - Nightly Equity Profile Update Job
Run at 18:00 ET Monday-Friday to update ticker profiles from 60 days of historical data

Calculates:
- ATR (20-day Average True Range)
- Volume baseline (20-day average)
- Beta vs QQQ
- Sector correlation
- Momentum persistence
- Price-volume correlation
- News sensitivity
"""

import os
import sys
from datetime import datetime, timedelta
from typing import Dict, List, Tuple
import psycopg2
from psycopg2.extras import RealDictCursor
import requests
import numpy as np
from scipy import stats


class EquityProfileUpdater:
    """Updates equity profiles from Alpaca historical data"""
    
    # 15 ticker universe + market indices
    UNIVERSE = [
        'NVDA', 'TSLA', 'AMD', 'META', 'NFLX', 'AAPL', 'MSFT', 'GOOGL', 
        'AMZN', 'INTC', 'CRM', 'ORCL', 'AVGO', 'QCOM'
    ]
    
    MARKET_INDICES = ['QQQ', 'SPY']
    
    SECTOR_ETFS = {
        'XLK': 'Technology',
        'SMH': 'Semiconductors', 
        'XLY': 'Consumer Discretionary',
        'XLC': 'Communication Services'
    }
    
    # Ticker to sector mapping
    TICKER_SECTORS = {
        'NVDA': 'SMH', 'AMD': 'SMH', 'AVGO': 'SMH', 'QCOM': 'SMH', 'INTC': 'SMH',
        'AAPL': 'XLK', 'MSFT': 'XLK', 'GOOGL': 'XLK', 'CRM': 'XLK', 'ORCL': 'XLK',
        'TSLA': 'XLY', 'AMZN': 'XLY',
        'META': 'XLK', 'NFLX': 'XLC'
    }
    
    def __init__(self, db_url: str = None, alpaca_key: str = None, alpaca_secret: str = None):
        self.db_url = db_url or os.getenv('DATABASE_URL')
        self.alpaca_key = alpaca_key or os.getenv('ALPACA_API_KEY')
        self.alpaca_secret = alpaca_secret or os.getenv('ALPACA_SECRET_KEY')
        
        if not all([self.db_url, self.alpaca_key, self.alpaca_secret]):
            raise ValueError("Missing required environment variables")
        
        self.data_url = 'https://data.alpaca.markets'
        self.headers = {
            'APCA-API-KEY-ID': self.alpaca_key,
            'APCA-API-SECRET-KEY': self.alpaca_secret
        }
    
    def run(self):
        """Main update process"""
        print(f"🚀 Starting equity profile update at {datetime.now()}")
        
        # Calculate date range (60 trading days ≈ 90 calendar days)
        end_date = datetime.now().date()
        start_date = end_date - timedelta(days=90)
        
        print(f"📅 Fetching data from {start_date} to {end_date}")
        
        # Fetch QQQ data for beta calculations
        print("📊 Fetching QQQ data...")
        qqq_data = self.fetch_bars('QQQ', start_date, end_date)
        if not qqq_data:
            print("❌ Failed to fetch QQQ data")
            return
        
        # Fetch sector ETF data
        print("📊 Fetching sector ETF data...")
        sector_data = {}
        for etf in self.SECTOR_ETFS.keys():
            sector_data[etf] = self.fetch_bars(etf, start_date, end_date)
        
        # Process each ticker
        conn = psycopg2.connect(self.db_url)
        successful = 0
        failed = 0
        
        for ticker in self.UNIVERSE:
            try:
                print(f"\n📈 Processing {ticker}...")
                
                # Fetch ticker bars
                bars = self.fetch_bars(ticker, start_date, end_date)
                if not bars or len(bars) < 20:
                    print(f"⚠️  Insufficient data for {ticker} ({len(bars) if bars else 0} bars)")
                    failed += 1
                    continue
                
                # Calculate profile
                profile = self.calculate_profile(ticker, bars, qqq_data, sector_data)
                
                # Update database
                self.update_profile(conn, ticker, profile, start_date, end_date, len(bars))
                
                print(f"✅ {ticker} updated: ATR={profile['atr']:.2f}, Vol={profile['vol_baseline']:,}, Beta={profile['beta']:.2f}")
                successful += 1
                
            except Exception as e:
                print(f"❌ Failed to process {ticker}: {e}")
                failed += 1
        
        conn.commit()
        conn.close()
        
        print(f"\n✅ Update complete: {successful} successful, {failed} failed")
    
    def fetch_bars(self, ticker: str, start_date, end_date) -> List[Dict]:
        """Fetch daily bars from Alpaca"""
        url = f"{self.data_url}/v2/stocks/{ticker}/bars"
        params = {
            'start': start_date.isoformat(),
            'end': end_date.isoformat(),
            'timeframe': '1Day',
            'adjustment': 'split',
            'feed': 'sip',
            'limit': 10000
        }
        
        try:
            response = requests.get(url, headers=self.headers, params=params)
            response.raise_for_status()
            data = response.json()
            return data.get('bars', [])
        except Exception as e:
            print(f"Error fetching {ticker}: {e}")
            return []
    
    def calculate_profile(self, ticker: str, bars: List[Dict], qqq_bars: List[Dict],
                         sector_data: Dict) -> Dict:
        """Calculate all profile metrics"""
        # Extract price and volume data
        closes = np.array([float(bar['c']) for bar in bars])
        opens = np.array([float(bar['o']) for bar in bars])
        highs = np.array([float(bar['h']) for bar in bars])
        lows = np.array([float(bar['l']) for bar in bars])
        volumes = np.array([int(bar['v']) for bar in bars])
        
        # 1. ATR (20-day Average True Range)
        atr = self.calculate_atr(opens, highs, lows, closes, period=20)
        atr_pct = (atr / closes[-1] * 100) if closes[-1] > 0 else 0
        
        # 2. Volume baseline (20-day average)
        vol_baseline = int(np.mean(volumes[-20:]))
        vol_std = int(np.std(volumes[-20:]))
        
        # 3. Beta vs QQQ
        beta = self.calculate_beta(closes, qqq_bars)
        
        # 4. Sector correlation
        sector_etf = self.TICKER_SECTORS.get(ticker, 'XLK')
        sector_corr = self.calculate_sector_correlation(closes, sector_data.get(sector_etf, []))
        
        # 5. Momentum persistence
        persistence = self.calculate_persistence(closes)
        
        # 6. Price-volume correlation
        vol_correlation = self.calculate_price_volume_correlation(closes, volumes)
        
        # 7. News sensitivity (placeholder - would need historical news data)
        news_sensitivity = 1.0  # Default, can be calibrated later
        
        return {
            'atr': atr,
            'atr_pct': atr_pct,
            'vol_baseline': vol_baseline,
            'vol_std': vol_std,
            'beta': beta,
            'sector_etf': sector_etf,
            'sector_correlation': sector_corr,
            'persistence': persistence,
            'vol_correlation': vol_correlation,
            'news_sensitivity': news_sensitivity
        }
    
    def calculate_atr(self, opens, highs, lows, closes, period=20) -> float:
        """Calculate Average True Range"""
        # True Range = max(high-low, abs(high-prev_close), abs(low-prev_close))
        tr = np.zeros(len(closes))
        for i in range(1, len(closes)):
            hl = highs[i] - lows[i]
            hc = abs(highs[i] - closes[i-1])
            lc = abs(lows[i] - closes[i-1])
            tr[i] = max(hl, hc, lc)
        
        # Average of last 'period' days
        atr = np.mean(tr[-period:])
        return float(atr)
    
    def calculate_beta(self, ticker_closes, qqq_bars) -> float:
        """Calculate beta vs QQQ"""
        if not qqq_bars or len(qqq_bars) != len(ticker_closes):
            return 1.0
        
        qqq_closes = np.array([float(bar['c']) for bar in qqq_bars])
        
        # Calculate returns
        ticker_returns = np.diff(ticker_closes) / ticker_closes[:-1]
        qqq_returns = np.diff(qqq_closes) / qqq_closes[:-1]
        
        # Beta = covariance(ticker, qqq) / variance(qqq)
        if len(ticker_returns) > 0 and len(qqq_returns) > 0:
            covariance = np.cov(ticker_returns, qqq_returns)[0][1]
            qqq_variance = np.var(qqq_returns)
            beta = covariance / qqq_variance if qqq_variance > 0 else 1.0
            return float(np.clip(beta, 0.5, 2.5))  # Reasonable range
        
        return 1.0
    
    def calculate_sector_correlation(self, ticker_closes, sector_bars) -> float:
        """Calculate correlation with sector ETF"""
        if not sector_bars or len(sector_bars) != len(ticker_closes):
            return 0.5
        
        sector_closes = np.array([float(bar['c']) for bar in sector_bars])
        
        # Calculate correlation coefficient
        if len(ticker_closes) > 1 and len(sector_closes) > 1:
            correlation = np.corrcoef(ticker_closes, sector_closes)[0][1]
            return float(np.clip(correlation, 0.0, 1.0))
        
        return 0.5
    
    def calculate_persistence(self, closes) -> float:
        """
        Calculate momentum persistence
        Measures how often price continues in same direction after a move
        """
        if len(closes) < 10:
            return 0.7
        
        # Calculate daily changes
        changes = np.diff(closes)
        
        # Count continuation vs reversal
        continuations = 0
        total = 0
        
        for i in range(1, len(changes)):
            if changes[i-1] != 0:  # Skip flat days
                if np.sign(changes[i]) == np.sign(changes[i-1]):
                    continuations += 1
                total += 1
        
        persistence = continuations / total if total > 0 else 0.7
        return float(np.clip(persistence, 0.5, 0.95))
    
    def calculate_price_volume_correlation(self, closes, volumes) -> float:
        """Calculate correlation between price changes and volume"""
        if len(closes) < 10 or len(volumes) < 10:
            return 0.6
        
        price_changes = np.abs(np.diff(closes))
        volume_changes = volumes[1:]
        
        if len(price_changes) > 0 and len(volume_changes) > 0:
            correlation = np.corrcoef(price_changes, volume_changes)[0][1]
            return float(np.clip(correlation, 0.0, 1.0))
        
        return 0.6
    
    def update_profile(self, conn, ticker: str, profile: Dict, start_date, end_date, bars_count: int):
        """Update equity profile in database"""
        sql = """
        INSERT INTO equity_profiles (
            ticker, atr, atr_pct, vol_baseline, vol_std, beta, 
            sector_etf, sector_correlation, persistence, vol_correlation,
            news_sensitivity, data_start_date, data_end_date, bars_analyzed,
            last_updated
        ) VALUES (
            %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW()
        )
        ON CONFLICT (ticker) DO UPDATE SET
            atr = EXCLUDED.atr,
            atr_pct = EXCLUDED.atr_pct,
            vol_baseline = EXCLUDED.vol_baseline,
            vol_std = EXCLUDED.vol_std,
            beta = EXCLUDED.beta,
            sector_etf = EXCLUDED.sector_etf,
            sector_correlation = EXCLUDED.sector_correlation,
            persistence = EXCLUDED.persistence,
            vol_correlation = EXCLUDED.vol_correlation,
            news_sensitivity = EXCLUDED.news_sensitivity,
            data_start_date = EXCLUDED.data_start_date,
            data_end_date = EXCLUDED.data_end_date,
            bars_analyzed = EXCLUDED.bars_analyzed,
            last_updated = NOW()
        """
        
        with conn.cursor() as cur:
            cur.execute(sql, (
                ticker,
                profile['atr'],
                profile['atr_pct'],
                profile['vol_baseline'],
                profile['vol_std'],
                profile['beta'],
                profile['sector_etf'],
                profile['sector_correlation'],
                profile['persistence'],
                profile['vol_correlation'],
                profile['news_sensitivity'],
                start_date,
                end_date,
                bars_count
            ))


def main():
    """Main entry point"""
    try:
        updater = EquityProfileUpdater()
        updater.run()
    except Exception as e:
        print(f"❌ Fatal error: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()

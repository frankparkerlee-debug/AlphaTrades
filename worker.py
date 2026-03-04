"""
Background Worker - Continuous Market Monitoring
Runs during market hours, generates alerts, executes trades
"""
import os
import time
import requests
import logging
from datetime import datetime, time as dt_time
from decimal import Decimal
from models import Alert, Trade, ModelConfig, DailyPerformance, get_session
from scorer import Scorer
from trader import Trader

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s'
)
logger = logging.getLogger(__name__)

# Configuration
FINNHUB_API_KEY = os.getenv('FINNHUB_API_KEY')
TICKERS = ['NVDA', 'TSLA', 'AMD', 'AAPL', 'AMZN', 'META', 'MSFT', 'GOOGL', 'NFLX', 'AVGO', 'ORCL', 'ADBE']
SCAN_INTERVAL = 5  # seconds
TRADING_MODE = os.getenv('TRADING_MODE', 'paper')

class MarketMonitor:
    def __init__(self):
        self.session = get_session()
        self.config = self._load_config()
        self.scorer = Scorer(self.config)
        self.trader = Trader(self.config, mode=TRADING_MODE)
        self.last_alert_cache = {}  # Prevent duplicate alerts
        
        logger.info(f"🚀 Market Monitor initialized")
        logger.info(f"   Mode: {TRADING_MODE}")
        logger.info(f"   Auto-trade grades: {self.config.auto_trade_grades if self.config else ['A+', 'A']}")
        logger.info(f"   Watching: {', '.join(TICKERS)}")
    
    def _load_config(self):
        """Load active model configuration"""
        config = self.session.query(ModelConfig).filter_by(is_active=True).first()
        if not config:
            logger.warning("No active config found, using defaults")
        return config
    
    def run(self):
        """Main monitoring loop"""
        logger.info("🎬 Starting market monitoring...")
        
        while True:
            try:
                if self._is_market_hours():
                    self._scan_market()
                    self._check_exits()
                else:
                    logger.info("💤 Outside market hours, sleeping...")
                    time.sleep(300)  # Sleep 5 minutes when market closed
                    continue
                
                time.sleep(SCAN_INTERVAL)
                
            except KeyboardInterrupt:
                logger.info("🛑 Shutting down...")
                break
            except Exception as e:
                logger.error(f"❌ Error in main loop: {e}", exc_info=True)
                time.sleep(60)  # Sleep 1 minute on error
    
    def _is_market_hours(self):
        """Check if market is currently open"""
        now = datetime.now()
        
        # Skip weekends
        if now.weekday() >= 5:
            return False
        
        # Market hours: 9:30 AM - 4:00 PM EST
        # TODO: Add timezone handling for proper EST conversion
        market_open = dt_time(9, 30)
        market_close = dt_time(16, 0)
        current_time = now.time()
        
        return market_open <= current_time <= market_close
    
    def _scan_market(self):
        """Scan all tickers and generate alerts"""
        logger.info("📊 Scanning market...")
        
        # Get SPY for market trend
        market_trend = self._get_market_trend()
        
        # Scan each ticker
        for ticker in TICKERS:
            try:
                quote = self._fetch_quote(ticker)
                if not quote:
                    continue
                
                # Calculate score
                result = self.scorer.calculate_score(quote, market_trend)
                
                # Log alert if grade is B- or better
                if result['grade'] != 'D':
                    alert = self._log_alert(result, market_trend)
                    
                    # Auto-trade if grade qualifies
                    if self.trader.should_enter_trade(result['grade']):
                        self._execute_trade(alert)
                
            except Exception as e:
                logger.error(f"Error scanning {ticker}: {e}")
    
    def _fetch_quote(self, ticker):
        """Fetch current quote from Finnhub"""
        if not FINNHUB_API_KEY:
            logger.error("FINNHUB_API_KEY not set!")
            return None
        
        try:
            url = f"https://finnhub.io/api/v1/quote?symbol={ticker}&token={FINNHUB_API_KEY}"
            response = requests.get(url, timeout=5)
            response.raise_for_status()
            data = response.json()
            
            return {
                'ticker': ticker,
                'current': data.get('c', 0),
                'open': data.get('o', 0),
                'high': data.get('h', 0),
                'low': data.get('l', 0),
                'previousClose': data.get('pc', 0)
            }
        except Exception as e:
            logger.error(f"Error fetching {ticker}: {e}")
            return None
    
    def _get_market_trend(self):
        """Get SPY trend (market direction)"""
        spy = self._fetch_quote('SPY')
        if not spy:
            return {'is_up': False, 'change_pct': 0}
        
        change_pct = ((spy['current'] - spy['previousClose']) / spy['previousClose']) * 100
        return {
            'is_up': spy['current'] > spy['previousClose'],
            'change_pct': change_pct
        }
    
    def _log_alert(self, result, market_trend):
        """Save alert to database"""
        # Check for duplicate (same ticker + grade within last 60 seconds)
        cache_key = f"{result['ticker']}-{result['grade']}"
        now = datetime.now()
        
        if cache_key in self.last_alert_cache:
            last_time = self.last_alert_cache[cache_key]
            if (now - last_time).total_seconds() < 60:
                return None  # Skip duplicate
        
        self.last_alert_cache[cache_key] = now
        
        alert = Alert(
            timestamp=now,
            ticker=result['ticker'],
            grade=result['grade'],
            score=result['score'],
            stock_price=Decimal(str(result['metrics']['current'])),
            open_price=Decimal(str(result['metrics']['open'])),
            high_price=Decimal(str(result['metrics']['high'])),
            low_price=Decimal(str(result['metrics']['low'])),
            move_pct=Decimal(str(result['metrics']['move_pct'])),
            range_pct=Decimal(str(result['metrics']['range_pct'])),
            direction=result['direction'],
            strike=Decimal(str(result['strike'])),
            expiration=result['expiration'],
            market_trend='UP' if market_trend['is_up'] else 'DOWN',
            spy_price=None  # TODO: Add SPY price
        )
        
        self.session.add(alert)
        self.session.commit()
        
        logger.info(f"🎯 ALERT: {alert.ticker} Grade {alert.grade} (Score: {alert.score}/55) | Move: {alert.move_pct}% | Range: {alert.range_pct}%")
        
        return alert
    
    def _execute_trade(self, alert):
        """Execute trade based on alert"""
        if not alert:
            return
        
        try:
            trade = self.trader.enter_trade(alert, self.session)
            if trade:
                logger.info(f"💰 Trade executed: {trade.ticker} {trade.direction} ${trade.strike}")
        except Exception as e:
            logger.error(f"Error executing trade for {alert.ticker}: {e}")
    
    def _check_exits(self):
        """Check open positions for exit conditions"""
        try:
            exited = self.trader.check_exits(self.session)
            if exited:
                logger.info(f"👋 Exited {len(exited)} position(s)")
        except Exception as e:
            logger.error(f"Error checking exits: {e}")

def main():
    """Entry point"""
    logger.info("=" * 50)
    logger.info("  AlphaTrades Market Monitor  ")
    logger.info("=" * 50)
    
    # Check environment
    if not FINNHUB_API_KEY:
        logger.error("❌ FINNHUB_API_KEY not set! Exiting...")
        return
    
    if not os.getenv('DATABASE_URL'):
        logger.error("❌ DATABASE_URL not set! Exiting...")
        return
    
    # Start monitoring
    monitor = MarketMonitor()
    monitor.run()

if __name__ == '__main__':
    main()

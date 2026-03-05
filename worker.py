"""
Background Worker - Continuous Market Monitoring
Real-time WebSocket-based monitoring with instant scoring
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
from alpaca_stream_gevent import get_stream

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
        self.stream = None  # WebSocket stream
        self.price_cache = {}  # Latest prices from stream
        
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
        """Main monitoring loop - WebSocket-based real-time scoring"""
        logger.info("🎬 Starting real-time market monitoring...")
        
        # Initialize WebSocket stream
        try:
            self.stream = get_stream()
            logger.info("✅ WebSocket stream initialized")
        except Exception as e:
            logger.error(f"Failed to initialize stream: {e}")
            return
        
        # Periodically check exits every 30 seconds
        last_exit_check = time.time()
        exit_check_interval = 30
        
        while True:
            try:
                if not self._is_market_hours():
                    logger.info("💤 Outside market hours, sleeping...")
                    time.sleep(300)  # Sleep 5 minutes when market closed
                    continue
                
                # Get next update from scoring queue (blocks for 1 second)
                update = self.stream.get_scoring_update(timeout=1)
                
                if update:
                    # Process price update for scoring
                    self._process_update(update)
                
                # Periodically check for exits
                if time.time() - last_exit_check >= exit_check_interval:
                    self._check_exits()
                    last_exit_check = time.time()
                
            except KeyboardInterrupt:
                logger.info("🛑 Shutting down...")
                break
            except Exception as e:
                logger.error(f"❌ Error in main loop: {e}", exc_info=True)
                time.sleep(10)  # Brief pause on error
    
    def _process_update(self, update):
        """Process price update from WebSocket stream"""
        symbol = update.get('symbol')
        
        # Skip if not in our watchlist
        if symbol not in TICKERS and symbol != 'SPY':
            return
        
        # Update price cache
        if symbol not in self.price_cache:
            self.price_cache[symbol] = {}
        
        # Handle different update types
        if update['type'] == 'trade':
            self.price_cache[symbol]['c'] = update['price']
            self.price_cache[symbol]['timestamp'] = update['timestamp']
        
        elif update['type'] == 'bar':
            self.price_cache[symbol].update({
                'o': update['open'],
                'h': update['high'],
                'l': update['low'],
                'c': update['close'],
                'pc': self.price_cache[symbol].get('c', update['open'])  # Previous close
            })
            
            # Only score on complete bar updates (has OHLC data)
            if symbol in TICKERS:
                self._score_symbol(symbol)
    
    def _score_symbol(self, symbol):
        """Score a symbol using cached price data"""
        quote = self.price_cache.get(symbol)
        if not quote or 'c' not in quote or 'o' not in quote:
            return
        
        # Get market trend from SPY
        market_trend = self._get_market_trend_from_cache()
        
        try:
            # Calculate score
            result = self.scorer.calculate_score(quote, market_trend)
            
            # Log alert if grade is B- or better
            if result['grade'] != 'D':
                alert = self._log_alert(result, market_trend)
                
                # Auto-trade if grade qualifies
                if alert and self.trader.should_enter_trade(result['grade']):
                    self._execute_trade(alert)
        
        except Exception as e:
            logger.error(f"Error scoring {symbol}: {e}")
    
    def _get_market_trend_from_cache(self):
        """Get SPY market trend from cached prices"""
        spy = self.price_cache.get('SPY', {})
        
        current = spy.get('c')
        prev_close = spy.get('pc')
        
        if current and prev_close:
            is_up = current >= prev_close
            change_pct = ((current - prev_close) / prev_close) * 100
        else:
            # Default to neutral
            is_up = True
            change_pct = 0.0
        
        return {
            'is_up': is_up,
            'change_pct': change_pct
        }
    
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
    
    # Removed: Old polling-based _scan_market() - now using WebSocket real-time updates
    
    # Removed: Old Finnhub polling methods (_fetch_quote, _get_market_trend)
    # Now using WebSocket stream cache via _get_market_trend_from_cache()
    
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

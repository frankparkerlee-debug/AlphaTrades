"""
Background Worker - Pre-compute Convergence Signals
Calculates expensive 7-signal convergence scores and caches in database
Runs every 60 seconds, making dashboard API calls instant (< 50ms)
"""
import os
import time
import logging
from datetime import datetime
from decimal import Decimal
from models import Signal, get_session
from scorer_convergence import get_convergence_scorer
from options_selector import get_selector
from alpaca_client import AlpacaClient

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s'
)
logger = logging.getLogger(__name__)

# Configuration
TICKERS = ['NVDA', 'TSLA', 'AMD', 'AAPL', 'AMZN', 'META', 'MSFT', 'GOOGL', 'NFLX', 'AVGO', 'ORCL', 'ADBE']
UPDATE_INTERVAL = 60  # seconds

# Alpaca credentials
ALPACA_API_KEY = os.getenv('ALPACA_API_KEY')
ALPACA_SECRET_KEY = os.getenv('ALPACA_SECRET_KEY')

class SignalWorker:
    """Background worker that pre-computes convergence signals"""
    
    def __init__(self):
        self.session = get_session()
        self.alpaca = AlpacaClient()
        self.scorer = get_convergence_scorer(ALPACA_API_KEY, ALPACA_SECRET_KEY)
        self.selector = get_selector()
        
        logger.info("🚀 Signal Worker initialized")
        logger.info(f"   Tickers: {', '.join(TICKERS)}")
        logger.info(f"   Update interval: {UPDATE_INTERVAL}s")
        logger.info(f"   Using: 7-signal ConvergenceScorer + OptionsSelector")
    
    def update_all_signals(self):
        """Pre-compute and cache all signals in database"""
        logger.info("=" * 60)
        logger.info(f"📊 Starting signal update cycle at {datetime.now()}")
        
        # Get SPY for market context (once per cycle)
        try:
            spy_quote = self.alpaca.get_snapshot('SPY')
            spy_current = spy_quote.get('c', 0)
            spy_prev = spy_quote.get('pc', spy_current)
            market_data = {
                'is_up': spy_current >= spy_prev,
                'change_pct': ((spy_current - spy_prev) / spy_prev * 100) if spy_prev else 0
            }
            logger.info(f"📈 SPY: ${spy_current:.2f} ({market_data['change_pct']:+.2f}%) - Market {'UP' if market_data['is_up'] else 'DOWN'}")
        except Exception as e:
            logger.error(f"❌ Failed to get SPY: {e}")
            market_data = {'is_up': True, 'change_pct': 0.0}
        
        updated_count = 0
        error_count = 0
        
        for ticker in TICKERS:
            try:
                # 1. Get stock quote
                quote = self.alpaca.get_snapshot(ticker.upper())
                stock_price = quote.get('c', 0)
                
                if not stock_price:
                    logger.warning(f"⚠️  {ticker}: No price data")
                    continue
                
                # 2. Calculate convergence (EXPENSIVE - but only once per minute)
                convergence_result = self.scorer.score_ticker(ticker.upper(), quote, market_data)
                
                # 3. Get optimal option based on momentum direction
                momentum_move = convergence_result['signals']['momentum']['metrics'].get('move_from_open', 0)
                option_type = 'call' if momentum_move >= 0 else 'put'
                
                # 4. Get options chain (EXPENSIVE - but cached)
                chain_data = self.alpaca.get_options_chain(ticker.upper())
                
                optimal_option = None
                if 'error' not in chain_data and chain_data.get('snapshots'):
                    optimal_option = self.selector.select_best_contract(
                        chain_data.get('snapshots', {}),
                        stock_price,
                        option_type
                    )
                
                # 5. STORE in database (upsert)
                signal = self.session.query(Signal).filter_by(ticker=ticker).first()
                if not signal:
                    signal = Signal(ticker=ticker)
                    self.session.add(signal)
                
                # Update all fields
                signal.price = Decimal(str(stock_price))
                prev_close = quote.get('pc', stock_price)
                signal.change_pct = Decimal(str(((stock_price - prev_close) / prev_close) * 100))
                signal.grade = convergence_result['grade']
                signal.score = convergence_result['total_score']
                signal.convergence_count = convergence_result['convergence_count']
                signal.confidence = convergence_result['confidence']
                signal.convergence_json = convergence_result
                signal.option_json = optimal_option
                signal.updated_at = datetime.utcnow()
                
                self.session.commit()
                
                # Log result
                option_str = ""
                if optimal_option:
                    option_str = f" | Option: {optimal_option['symbol']} ${optimal_option['mid']:.2f}"
                
                logger.info(
                    f"✅ {ticker:6s} | ${stock_price:7.2f} ({signal.change_pct:+6.2f}%) | "
                    f"Grade: {signal.grade:3s} | Score: {signal.score:3d}/100 | "
                    f"Signals: {signal.convergence_count}/7{option_str}"
                )
                
                updated_count += 1
                
            except Exception as e:
                logger.error(f"❌ {ticker}: {e}", exc_info=True)
                error_count += 1
        
        logger.info("-" * 60)
        logger.info(f"✅ Updated {updated_count} signals | ❌ {error_count} errors")
        logger.info(f"⏱️  Cycle completed at {datetime.now()}")
    
    def run(self):
        """Main worker loop"""
        logger.info("=" * 60)
        logger.info("  AlphaTrades Signal Worker  ")
        logger.info("  7-Signal Convergence Pre-Computation")
        logger.info("=" * 60)
        
        cycle_count = 0
        
        while True:
            try:
                cycle_count += 1
                start_time = time.time()
                
                logger.info(f"\n🔄 Cycle #{cycle_count}")
                self.update_all_signals()
                
                elapsed = time.time() - start_time
                sleep_time = max(0, UPDATE_INTERVAL - elapsed)
                
                logger.info(f"⏱️  Cycle took {elapsed:.1f}s | Sleeping {sleep_time:.1f}s until next update\n")
                time.sleep(sleep_time)
                
            except KeyboardInterrupt:
                logger.info("\n🛑 Shutting down Signal Worker...")
                break
            except Exception as e:
                logger.error(f"❌ Error in main loop: {e}", exc_info=True)
                logger.info("⏸️  Sleeping 60s before retry...")
                time.sleep(60)

def main():
    """Entry point"""
    # Validate environment
    if not ALPACA_API_KEY or not ALPACA_SECRET_KEY:
        logger.error("❌ ALPACA_API_KEY or ALPACA_SECRET_KEY not set! Exiting...")
        return
    
    if not os.getenv('DATABASE_URL'):
        logger.error("❌ DATABASE_URL not set! Exiting...")
        return
    
    # Start worker
    worker = SignalWorker()
    worker.run()

if __name__ == '__main__':
    main()

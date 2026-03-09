"""
Background Worker - Pre-compute V5 Signals
Calculates expensive V5 momentum scores and caches in database
Runs every 2 seconds, making dashboard API calls instant (< 50ms)
"""
# DIAGNOSTIC: Print before ANY imports to confirm script execution
print("="*70, flush=True)
print("📦 worker.py - SCRIPT STARTING", flush=True)
print("="*70, flush=True)

import os
import time
import logging
from datetime import datetime
from decimal import Decimal

print("✅ Standard library imports successful", flush=True)

from models import Signal, get_session
print("✅ models imported", flush=True)

from scorer_v5 import get_v5_scorer
print("✅ scorer_v5 imported", flush=True)

from options_selector import get_selector
print("✅ options_selector imported", flush=True)

from alpaca_client import AlpacaClient
print("✅ alpaca_client imported", flush=True)

print("✅ ALL IMPORTS SUCCESSFUL", flush=True)
print("", flush=True)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s'
)
logger = logging.getLogger(__name__)

# Configuration
TICKERS = ['NVDA', 'TSLA', 'AMD', 'AAPL', 'AMZN', 'META', 'MSFT', 'GOOGL', 'NFLX', 'AVGO', 'ORCL', 'ADBE', 'CRM', 'INTC', 'QCOM']
UPDATE_INTERVAL = 2  # seconds - FAST refresh for real-time dashboard

# Alpaca credentials
ALPACA_API_KEY = os.getenv('ALPACA_API_KEY')
ALPACA_SECRET_KEY = os.getenv('ALPACA_SECRET_KEY')

class SignalWorker:
    """Background worker that pre-computes V5 momentum signals"""
    
    def __init__(self):
        print("   📦 Creating database session...", flush=True)
        self.session = get_session()
        print("   ✅ Database connected", flush=True)
        
        print("   📦 Creating Alpaca client...", flush=True)
        self.alpaca = AlpacaClient()
        print("   ✅ Alpaca client ready", flush=True)
        
        print("   📦 Creating V5 scorer...", flush=True)
        self.scorer = get_v5_scorer()
        print("   ✅ V5 scorer ready", flush=True)
        
        print("   📦 Creating options selector...", flush=True)
        self.selector = get_selector()
        print("   ✅ Options selector ready", flush=True)
        
        logger.info("🚀 V5 Signal Worker initialized")
        logger.info(f"   Tickers: {', '.join(TICKERS)}")
        logger.info(f"   Update interval: {UPDATE_INTERVAL}s")
        logger.info(f"   Using: V5 100-Point Momentum Scorer + OptionsSelector")
        
        print(f"", flush=True)
        print(f"🎯 Configuration:", flush=True)
        print(f"   Tickers: {len(TICKERS)} ({', '.join(TICKERS[:5])}...)", flush=True)
        print(f"   Update interval: {UPDATE_INTERVAL} seconds", flush=True)
        print(f"", flush=True)
    
    def update_all_signals(self):
        """Pre-compute and cache all signals in database"""
        print(f"\n{'='*60}", flush=True)
        print(f"📊 UPDATE CYCLE STARTING at {datetime.now()}", flush=True)
        print(f"{'='*60}", flush=True)
        
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
                open_price = quote.get('o', 0)
                high = quote.get('h', 0)
                low = quote.get('l', 0)
                volume = quote.get('v', 0)
                
                if not stock_price:
                    logger.warning(f"⚠️  {ticker}: No price data")
                    continue
                
                # Get 20-day average volume (from bars)
                bars_response = self.alpaca.get_bars(ticker.upper(), timeframe='1Day', limit=20)
                bars = bars_response.get('bars', []) if bars_response else []
                if bars and len(bars) > 0:
                    avg_volume = sum(bar['v'] for bar in bars) / len(bars)
                else:
                    avg_volume = volume
                
                # 2. Build quote_data for V5 scorer
                quote_data = {
                    'open': open_price,
                    'high': high,
                    'low': low,
                    'current': stock_price,
                    'volume': volume,
                    'avg_volume': avg_volume
                }
                
                # 3. Calculate V5 score (EXPENSIVE - but only once per 2 seconds)
                v5_result = self.scorer.score_ticker(ticker.upper(), quote_data, market_data)
                
                # 4. Get optimal option based on V5 direction
                trade_setup = v5_result.get('trade_setup', {})
                direction = trade_setup.get('direction', 'CALL')
                option_type = 'call' if direction == 'CALL' else 'put'
                
                # 5. Get options chain (EXPENSIVE - but cached)
                chain_data = self.alpaca.get_options_chain(ticker.upper())
                
                optimal_option = None
                if 'error' not in chain_data and chain_data.get('snapshots'):
                    optimal_option = self.selector.select_best_contract(
                        chain_data.get('snapshots', {}),
                        stock_price,
                        option_type
                    )
                
                # 6. STORE in database (upsert)
                signal = self.session.query(Signal).filter_by(ticker=ticker).first()
                if not signal:
                    signal = Signal(ticker=ticker)
                    self.session.add(signal)
                
                # Update all fields
                signal.price = Decimal(str(stock_price))
                prev_close = quote.get('pc', stock_price)
                signal.change_pct = Decimal(str(((stock_price - prev_close) / prev_close) * 100))
                signal.grade = v5_result['grade']
                signal.score = v5_result['score']
                signal.convergence_count = v5_result['breakdown'].get('range', {}).get('score', 0)  # Use range score as proxy
                signal.confidence = v5_result['decision']
                signal.convergence_json = v5_result  # Store full V5 result
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
                    f"Decision: {signal.confidence}{option_str}"
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
        logger.info("  AlphaTrades V5 Signal Worker  ")
        logger.info("  100-Point Momentum Pre-Computation")
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
    # Force immediate log output
    print("=" * 70, flush=True)
    print("🚀 AlphaTrades V5 Worker Starting...", flush=True)
    print("=" * 70, flush=True)
    
    # Validate environment
    if not ALPACA_API_KEY or not ALPACA_SECRET_KEY:
        logger.error("❌ ALPACA_API_KEY or ALPACA_SECRET_KEY not set! Exiting...")
        print("❌ Missing Alpaca credentials!", flush=True)
        return
    
    if not os.getenv('DATABASE_URL'):
        logger.error("❌ DATABASE_URL not set! Exiting...")
        print("❌ Missing DATABASE_URL!", flush=True)
        return
    
    print(f"✅ Environment validated", flush=True)
    print(f"✅ Database URL: {os.getenv('DATABASE_URL')[:50]}...", flush=True)
    print(f"✅ Alpaca Key: {ALPACA_API_KEY[:10]}...", flush=True)
    print(f"", flush=True)
    
    # Start worker
    try:
        worker = SignalWorker()
        print("✅ Worker initialized successfully", flush=True)
        print("🔄 Starting main loop...", flush=True)
        worker.run()
    except Exception as e:
        print(f"❌ FATAL ERROR: {e}", flush=True)
        logger.error(f"❌ FATAL ERROR in main: {e}", exc_info=True)
        raise

if __name__ == '__main__':
    main()

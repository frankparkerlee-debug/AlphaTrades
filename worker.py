"""
Background Worker - Launch Control v2.0 Signals
Pre-computes momentum scores using 5-pillar system and caches in database
Runs every 2 seconds for real-time dashboard updates
"""
print("="*70, flush=True)
print("WORKER STARTING - Launch Control v2.0", flush=True)
print("="*70, flush=True)

import os
import time
import logging
from datetime import datetime, timedelta
from decimal import Decimal
import pytz

print("✅ Standard library imports", flush=True)

from models import Signal, get_session
print("✅ models imported", flush=True)

from scorer_launchcontrol import LaunchControlScorer
print("✅ scorer_launchcontrol imported", flush=True)

from options_selector import get_selector
print("✅ options_selector imported", flush=True)

from alpaca_client import AlpacaClient
print("✅ alpaca_client imported", flush=True)

print("✅ ALL IMPORTS SUCCESSFUL", flush=True)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s'
)
logger = logging.getLogger(__name__)

# Configuration - 15 tech tickers from Launch Control spec
TICKERS = ['NVDA', 'TSLA', 'AMD', 'AAPL', 'AMZN', 'META', 'MSFT', 'GOOGL', 'NFLX', 'AVGO', 'ORCL', 'ADBE', 'CRM', 'INTC', 'QCOM']
UPDATE_INTERVAL = 2  # seconds

ALPACA_API_KEY = os.getenv('ALPACA_API_KEY')
ALPACA_SECRET_KEY = os.getenv('ALPACA_SECRET_KEY')


class LaunchControlWorker:
    """Background worker using Launch Control v2.0 scoring"""
    
    def __init__(self):
        print("   Creating Alpaca client...", flush=True)
        self.alpaca = AlpacaClient()
        print("   ✅ Alpaca client ready", flush=True)
        
        print("   Creating Launch Control scorer...", flush=True)
        self.scorer = LaunchControlScorer()
        print("   ✅ Launch Control scorer ready", flush=True)
        
        print("   Creating options selector...", flush=True)
        self.selector = get_selector()
        print("   ✅ Options selector ready", flush=True)
        
        # Cache for equity profiles (ATR, vol baseline, etc.)
        self.equity_profiles = {}
        
        logger.info("Launch Control Worker initialized")
        logger.info(f"   Tickers: {', '.join(TICKERS)}")
        logger.info(f"   Update interval: {UPDATE_INTERVAL}s")
    
    def _get_fresh_session(self):
        return get_session()
    
    def _calculate_equity_profile(self, ticker: str, bars: list) -> dict:
        """Calculate equity profile from historical bars"""
        if not bars or len(bars) < 14:
            # Return defaults if not enough data
            return {
                'atr': 2.0,
                'vol_baseline': 10000000,
                'beta': 1.2,
                'sector_correlation': 0.7,
                'persistence': 0.75,
                'news_sensitivity': 1.0
            }
        
        # Calculate ATR (14-period)
        trs = []
        for i in range(1, min(15, len(bars))):
            h = bars[i].get('h', 0)
            l = bars[i].get('l', 0)
            pc = bars[i-1].get('c', 0)
            tr = max(h - l, abs(h - pc), abs(l - pc))
            trs.append(tr)
        atr = sum(trs) / len(trs) if trs else 2.0
        
        # Calculate average volume
        volumes = [b.get('v', 0) for b in bars[-20:]]
        vol_baseline = sum(volumes) / len(volumes) if volumes else 10000000
        
        # Calculate simple persistence (trend consistency)
        closes = [b.get('c', 0) for b in bars[-10:]]
        if len(closes) >= 2:
            up_moves = sum(1 for i in range(1, len(closes)) if closes[i] > closes[i-1])
            persistence = max(up_moves, len(closes) - 1 - up_moves) / (len(closes) - 1)
        else:
            persistence = 0.75
        
        return {
            'atr': atr,
            'vol_baseline': vol_baseline,
            'beta': 1.2,  # Would need SPY comparison for accurate beta
            'sector_correlation': 0.7,
            'persistence': persistence,
            'news_sensitivity': 1.0
        }
    
    def _get_market_data(self) -> dict:
        """Get market context (QQQ, VIX)"""
        try:
            qqq = self.alpaca.get_snapshot('QQQ')
            qqq_current = qqq.get('c', 0)
            qqq_prev = qqq.get('pc', qqq_current)
            qqq_change = ((qqq_current - qqq_prev) / qqq_prev * 100) if qqq_prev else 0
            
            return {
                'qqq_direction': 'up' if qqq_change >= 0 else 'down',
                'qqq_change': qqq_change,
                'sector_direction': 'up' if qqq_change >= 0 else 'down',
                'sector_change': qqq_change,
                'vix': 18.0  # Would need VIX quote for accurate value
            }
        except Exception as e:
            logger.warning(f"Market data error: {e}")
            return {
                'qqq_direction': 'up',
                'qqq_change': 0.0,
                'sector_direction': 'up',
                'sector_change': 0.0,
                'vix': 18.0
            }
    
    def update_all_signals(self):
        """Pre-compute and cache all Launch Control signals"""
        print(f"\n{'='*60}", flush=True)
        print(f"UPDATE CYCLE at {datetime.now()}", flush=True)
        print(f"{'='*60}", flush=True)
        
        session = self._get_fresh_session()
        market_data = self._get_market_data()
        
        logger.info(f"Market: QQQ {market_data['qqq_change']:+.2f}%")
        
        updated_count = 0
        error_count = 0
        
        for ticker in TICKERS:
            try:
                # 1. Get current quote
                quote = self.alpaca.get_snapshot(ticker)
                stock_price = quote.get('c', 0)
                if not stock_price:
                    continue
                
                open_price = quote.get('o', stock_price)
                high = quote.get('h', stock_price)
                low = quote.get('l', stock_price)
                volume = quote.get('v', 0)
                prev_close = quote.get('pc', stock_price)
                
                # 2. Get historical bars for profile calculation
                if ticker not in self.equity_profiles:
                    from datetime import timedelta
                    start_date = (datetime.now() - timedelta(days=60)).strftime('%Y-%m-%d')
                    bars_resp = self.alpaca.get_bars(ticker, timeframe='1Day', start=start_date, limit=30)
                    bars = bars_resp.get('bars', []) if bars_resp else []
                    self.equity_profiles[ticker] = self._calculate_equity_profile(ticker, bars)
                    logger.info(f"   {ticker} profile: ATR={self.equity_profiles[ticker]['atr']:.2f}, VolBase={self.equity_profiles[ticker]['vol_baseline']:.0f}")
                
                equity_profile = self.equity_profiles[ticker]
                
                # 3. Build bar data for scorer
                bar_data = {
                    'open': open_price,
                    'high': high,
                    'low': low,
                    'close': stock_price,
                    'volume': volume,
                    'timestamp': datetime.now(pytz.timezone('US/Eastern'))
                }
                
                # 4. Calculate Launch Control score
                lc_result = self.scorer.score_ticker(
                    ticker, 
                    bar_data, 
                    equity_profile,
                    market_data,
                    None  # news_data - could add later
                )
                
                # 5. Get optimal option contract
                direction = lc_result.get('direction', 'CALL')
                option_type = 'call' if direction == 'CALL' else 'put'
                
                optimal_option = None
                try:
                    optimal_option = self.alpaca.get_target_option_contract(
                        ticker,
                        stock_price,
                        option_type,
                        dte_preference=1
                    )
                except Exception as e:
                    logger.warning(f"{ticker} options: {e}")
                
                # 6. Calculate targets based on option
                if optimal_option:
                    entry_price = optimal_option.get('mid', 0)
                    # Target: +50% for T1, +100% for T2, +150% for T3
                    optimal_option['targets'] = {
                        't1': round(entry_price * 1.50, 2),
                        't2': round(entry_price * 2.00, 2),
                        't3': round(entry_price * 2.50, 2),
                        'stop': round(entry_price * 0.50, 2)
                    }
                    # Format contract string
                    optimal_option['contract'] = f"{ticker} {optimal_option.get('expiry', '')} ${optimal_option.get('strike', '')} {direction}"
                
                # 7. Store in database
                signal = session.query(Signal).filter_by(ticker=ticker).first()
                if not signal:
                    signal = Signal(ticker=ticker)
                    session.add(signal)
                
                change_pct = ((stock_price - prev_close) / prev_close * 100) if prev_close else 0
                
                signal.price = Decimal(str(stock_price))
                signal.change_pct = Decimal(str(change_pct))
                signal.grade = lc_result.get('grade', 'C')
                signal.score = lc_result.get('score', 0)
                signal.convergence_count = lc_result.get('signals_above_midpoint', 0)
                signal.confidence = lc_result.get('signal_type', 'REJECTED')
                
                # Store full breakdown for dashboard
                signal.convergence_json = {
                    'score': lc_result.get('score', 0),
                    'grade': lc_result.get('grade', 'C'),
                    'direction': direction,
                    'pillars': lc_result.get('breakdown', {}),
                    'filters': lc_result.get('filters', {}),
                    'position_size': lc_result.get('position_size', 0),
                    'exit_strategy': lc_result.get('exit_strategy', {}),
                    # Pillar scores for dashboard display
                    'pa_score': lc_result.get('breakdown', {}).get('price_action', {}).get('score', 0),
                    'vol_score': lc_result.get('breakdown', {}).get('volume', {}).get('score', 0),
                    'news_score': lc_result.get('breakdown', {}).get('news', {}).get('score', 0),
                    'market_score': lc_result.get('breakdown', {}).get('market', {}).get('score', 0),
                    'timing_score': lc_result.get('breakdown', {}).get('timing', {}).get('score', 0)
                }
                
                signal.option_json = optimal_option
                signal.updated_at = datetime.now(pytz.UTC)
                
                session.commit()
                
                # Log result
                opt_str = ""
                if optimal_option:
                    opt_str = f" | {optimal_option.get('contract', '')} @ ${optimal_option.get('mid', 0):.2f}"
                
                pa = lc_result.get('breakdown', {}).get('price_action', {}).get('score', 0)
                vol = lc_result.get('breakdown', {}).get('volume', {}).get('score', 0)
                gate = "PASS" if (pa > 17.5 and vol > 15) else "FAIL"
                
                logger.info(
                    f"{ticker:5s} ${stock_price:7.2f} ({change_pct:+5.2f}%) | "
                    f"{lc_result.get('grade', 'C'):3s} {int(lc_result.get('score', 0)):3d}/100 | "
                    f"PA:{pa:2.0f} Vol:{vol:2.0f} Gate:{gate}"
                    f"{opt_str}"
                )
                
                updated_count += 1
                
            except Exception as e:
                logger.error(f"{ticker}: {e}")
                session.rollback()
                error_count += 1
        
        session.close()
        logger.info(f"Updated {updated_count} | Errors {error_count}")
    
    def run(self):
        """Main worker loop"""
        logger.info("=" * 60)
        logger.info("  Launch Control v2.0 Worker  ")
        logger.info("  5-Pillar Momentum Scoring  ")
        logger.info("=" * 60)
        
        cycle = 0
        while True:
            try:
                cycle += 1
                start = time.time()
                
                self.update_all_signals()
                
                elapsed = time.time() - start
                sleep_time = max(0, UPDATE_INTERVAL - elapsed)
                logger.info(f"Cycle {cycle} took {elapsed:.1f}s | Next in {sleep_time:.1f}s")
                time.sleep(sleep_time)
                
            except KeyboardInterrupt:
                logger.info("Shutting down...")
                break
            except Exception as e:
                logger.error(f"Main loop error: {e}")
                time.sleep(60)


def main():
    print("=" * 70, flush=True)
    print("Launch Control v2.0 Worker Starting...", flush=True)
    print("=" * 70, flush=True)
    
    if not ALPACA_API_KEY or not ALPACA_SECRET_KEY:
        print("ERROR: Missing Alpaca credentials!", flush=True)
        return
    
    if not os.getenv('DATABASE_URL'):
        print("ERROR: Missing DATABASE_URL!", flush=True)
        return
    
    print(f"✅ Environment validated", flush=True)
    
    try:
        worker = LaunchControlWorker()
        print("✅ Worker initialized", flush=True)
        worker.run()
    except Exception as e:
        print(f"FATAL ERROR: {e}", flush=True)
        raise


if __name__ == '__main__':
    main()

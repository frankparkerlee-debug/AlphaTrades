"""
Enhanced Backtest with Journey Tracking
Uses real Alpaca intraday data to understand stock behavior during hold period

Example Output:
AAPL - Bought at $100 for $5/contract
- 10:00 AM: $100.00 → $5.00 (Entry)
- 10:30 AM: $102.00 → $6.50 (+30% on option) [HWM]
- 11:15 AM: $97.00 → $4.75 (-5% on option) [LWM]
- 12:00 PM: $99.00 → $5.25 (Exit, +5%)

Direction: BOTH (went up then down)
HWM: +30% (could have exited here)
LWM: -5% (worst drawdown)
Actual: +5%
Pattern: WHIPSAW
"""
import logging
from datetime import datetime, timedelta
from alpaca_client import AlpacaClient
from scorer_v5 import V5Scorer
from models import get_session
from models_trade_tracking import BacktestJourney, TradeJourney
import uuid

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class JourneyBacktester:
    """
    Backtest with detailed journey tracking
    Uses Alpaca 5-minute bars to track price movements during hold
    """
    
    def __init__(self, tickers, start_date, end_date, starting_capital=600):
        self.tickers = tickers
        self.start_date = start_date
        self.end_date = end_date
        self.starting_capital = starting_capital
        self.scorer = V5Scorer()
        self.alpaca = AlpacaClient()
        self.session = get_session()
        
        self.thresholds = {
            'B': 70,
            'B+': 75,
            'A-': 80,
            'A': 85,
            'A+': 90
        }
    
    def run_backtest(self, threshold_name='B+'):
        """Run backtest with journey tracking"""
        threshold = self.thresholds[threshold_name]
        backtest_run_id = str(uuid.uuid4())
        
        logger.info(f"\n{'='*80}")
        logger.info(f"JOURNEY BACKTEST: {threshold_name} ({threshold}+ score)")
        logger.info(f"Period: {self.start_date} to {self.end_date}")
        logger.info(f"Tickers: {', '.join(self.tickers)}")
        logger.info(f"{'='*80}\n")
        
        all_journeys = []
        
        for ticker in self.tickers:
            logger.info(f"Testing {ticker} with journey tracking...")
            journeys = self._backtest_ticker_with_journey(ticker, threshold, backtest_run_id)
            all_journeys.extend(journeys)
        
        # Calculate aggregate stats
        self._print_journey_summary(all_journeys, threshold_name)
        
        return all_journeys
    
    def _backtest_ticker_with_journey(self, ticker, threshold, backtest_run_id):
        """
        Backtest single ticker with detailed journey tracking
        
        Uses 5-minute bars to track intraday movements
        """
        try:
            # Get daily bars for signal detection
            daily_response = self.alpaca.get_bars(
                ticker,
                timeframe='1Day',
                start=self.start_date,
                end=self.end_date,
                limit=10000
            )
            
            if 'bars' not in daily_response or not daily_response['bars']:
                logger.warning(f"  No data for {ticker}")
                return []
            
            daily_bars = daily_response['bars']
            logger.info(f"  Retrieved {len(daily_bars)} daily bars")
            
            journeys = []
            
            for i in range(len(daily_bars)):
                bar = daily_bars[i]
                date = datetime.fromisoformat(bar['t'].replace('Z', '+00:00'))
                
                # Score the setup
                quote_data = {
                    'open': float(bar['o']),
                    'high': float(bar['h']),
                    'low': float(bar['l']),
                    'current': float(bar['c']),
                    'volume': float(bar['v']),
                    'avg_volume': float(bar['v'])  # Simplified
                }
                
                score_result = self.scorer.score_ticker(ticker, quote_data)
                score = score_result['score']
                
                # Only take trades at threshold or higher
                if score < threshold:
                    continue
                
                # Need next day for entry
                if i + 1 >= len(daily_bars):
                    continue
                
                # ENTRY: Next day at open
                entry_bar = daily_bars[i + 1]
                entry_date = datetime.fromisoformat(entry_bar['t'].replace('Z', '+00:00'))
                entry_price = float(entry_bar['o'])
                
                # Get intraday bars for journey tracking (5-minute intervals)
                journey_data = self._track_journey(
                    ticker,
                    entry_date,
                    entry_price,
                    score_result['direction']
                )
                
                if not journey_data:
                    continue
                
                # Create journey record
                journey = BacktestJourney(
                    backtest_run_id=backtest_run_id,
                    ticker=ticker,
                    entry_date=entry_date,
                    exit_date=journey_data['exit_date'],
                    grade=score_result['grade'],
                    score=score,
                    direction=score_result['direction'],
                    entry_stock_price=entry_price,
                    entry_option_price_est=journey_data['entry_option_price'],
                    journey_data=journey_data['snapshots'],
                    hwm_pct=journey_data['hwm_pct'],
                    lwm_pct=journey_data['lwm_pct'],
                    direction_after_entry=journey_data['direction_after_entry'],
                    num_reversals=journey_data['num_reversals'],
                    exit_stock_price=journey_data['exit_price'],
                    exit_option_price_est=journey_data['exit_option_price'],
                    exit_reason=journey_data['exit_reason'],
                    pnl_pct=journey_data['pnl_pct'],
                    pnl_dollars=journey_data['pnl_dollars'],
                    pattern=journey_data['pattern'],
                    optimal_exit_pct=journey_data['hwm_pct'],
                    exit_quality=journey_data['exit_quality']
                )
                
                self.session.add(journey)
                journeys.append(journey_data)
            
            self.session.commit()
            logger.info(f"  {ticker}: {len(journeys)} trades with journey tracking")
            return journeys
            
        except Exception as e:
            logger.error(f"  Error backtesting {ticker}: {e}")
            return []
    
    def _track_journey(self, ticker, entry_date, entry_price, direction):
        """
        Track intraday journey using 5-minute bars
        
        Returns detailed movement analysis
        """
        try:
            # Get 5-minute bars for the day
            end_date = entry_date + timedelta(days=1)
            
            bars_response = self.alpaca.get_bars(
                ticker,
                timeframe='5Min',
                start=entry_date.strftime('%Y-%m-%d'),
                end=end_date.strftime('%Y-%m-%d'),
                limit=1000
            )
            
            if 'bars' not in bars_response or not bars_response['bars']:
                return None
            
            bars = bars_response['bars']
            
            # Track journey
            snapshots = []
            hwm_price = entry_price
            lwm_price = entry_price
            hwm_pct = 0
            lwm_pct = 0
            
            option_entry_price = entry_price * 0.025  # 2.5% of stock
            option_hwm = option_entry_price
            option_lwm = option_entry_price
            
            reversals = 0
            last_direction = None
            
            exit_price = None
            exit_time = None
            exit_reason = None
            
            for bar in bars:
                timestamp = datetime.fromisoformat(bar['t'].replace('Z', '+00:00'))
                price = float(bar['c'])
                
                # Calculate option price (delta-adjusted)
                stock_move = price - entry_price
                option_move = stock_move * 0.5  # delta
                option_price = max(0, option_entry_price + option_move)
                
                # Track HWM/LWM
                if price > hwm_price:
                    hwm_price = price
                    option_hwm = option_price
                
                if price < lwm_price:
                    lwm_price = price
                    option_lwm = option_price
                
                # Track direction changes
                current_direction = 'UP' if price > entry_price else 'DOWN' if price < entry_price else 'FLAT'
                if last_direction and current_direction != last_direction and current_direction != 'FLAT':
                    reversals += 1
                last_direction = current_direction
                
                # Calculate percentages
                stock_pct = ((price - entry_price) / entry_price) * 100
                option_pct = ((option_price - option_entry_price) / option_entry_price) * 100
                
                # Store snapshot
                snapshots.append({
                    'timestamp': timestamp.isoformat(),
                    'stock_price': round(price, 2),
                    'option_price_est': round(option_price, 4),
                    'stock_pct': round(stock_pct, 2),
                    'option_pct': round(option_pct, 2)
                })
                
                # Check exit conditions
                # Target: +50% on option
                # Stop: -30% on option
                if option_pct >= 50.0:
                    exit_price = price
                    exit_time = timestamp
                    exit_reason = 'TARGET_HIT'
                    break
                elif option_pct <= -30.0:
                    exit_price = price
                    exit_time = timestamp
                    exit_reason = 'STOP_HIT'
                    break
            
            # If no exit, use last bar
            if not exit_price:
                last_bar = bars[-1]
                exit_price = float(last_bar['c'])
                exit_time = datetime.fromisoformat(last_bar['t'].replace('Z', '+00:00'))
                exit_reason = 'EOD'
            
            # Calculate final P&L
            final_stock_move = exit_price - entry_price
            final_option_move = final_stock_move * 0.5
            exit_option_price = max(0, option_entry_price + final_option_move)
            
            pnl_pct = ((exit_option_price - option_entry_price) / option_entry_price) * 100
            pnl_pct = max(-100, min(500, pnl_pct))  # Cap
            
            position_size = min(self.starting_capital * 0.2, 200)
            pnl_dollars = position_size * (pnl_pct / 100)
            
            # Calculate final HWM/LWM percentages
            hwm_pct = ((option_hwm - option_entry_price) / option_entry_price) * 100
            lwm_pct = ((option_lwm - option_entry_price) / option_entry_price) * 100
            
            # Determine direction after entry
            if hwm_pct > 5 and lwm_pct < -5:
                direction_after_entry = 'BOTH'
            elif hwm_pct > 5:
                direction_after_entry = 'UP'
            elif lwm_pct < -5:
                direction_after_entry = 'DOWN'
            else:
                direction_after_entry = 'FLAT'
            
            # Determine pattern
            if reversals == 0:
                pattern = 'STRAIGHT_UP' if pnl_pct > 0 else 'STRAIGHT_DOWN'
            elif reversals >= 3:
                pattern = 'WHIPSAW'
            else:
                pattern = 'REVERSAL'
            
            # Exit quality
            if pnl_pct >= hwm_pct * 0.9:
                exit_quality = 'EXCELLENT'
            elif pnl_pct >= hwm_pct * 0.7:
                exit_quality = 'GOOD'
            elif pnl_pct >= 0:
                exit_quality = 'ACCEPTABLE'
            else:
                exit_quality = 'POOR'
            
            return {
                'entry_date': entry_date,
                'exit_date': exit_time,
                'entry_option_price': option_entry_price,
                'exit_price': exit_price,
                'exit_option_price': exit_option_price,
                'exit_reason': exit_reason,
                'snapshots': snapshots,
                'hwm_pct': round(hwm_pct, 2),
                'lwm_pct': round(lwm_pct, 2),
                'direction_after_entry': direction_after_entry,
                'num_reversals': reversals,
                'pnl_pct': round(pnl_pct, 2),
                'pnl_dollars': round(pnl_dollars, 2),
                'pattern': pattern,
                'exit_quality': exit_quality
            }
            
        except Exception as e:
            logger.error(f"Error tracking journey: {e}")
            return None
    
    def _print_journey_summary(self, journeys, threshold_name):
        """Print summary with journey insights"""
        if not journeys:
            logger.info("No trades to analyze")
            return
        
        logger.info(f"\n{'='*80}")
        logger.info(f"JOURNEY ANALYSIS SUMMARY")
        logger.info(f"{'='*80}\n")
        
        logger.info(f"Total Trades: {len(journeys)}")
        
        # Direction analysis
        direction_counts = {}
        for j in journeys:
            direction_counts[j['direction_after_entry']] = direction_counts.get(j['direction_after_entry'], 0) + 1
        
        logger.info(f"\nDirection After Entry:")
        for direction, count in direction_counts.items():
            pct = (count / len(journeys)) * 100
            logger.info(f"  {direction}: {count} ({pct:.1f}%)")
        
        # Pattern analysis
        pattern_counts = {}
        for j in journeys:
            pattern_counts[j['pattern']] = pattern_counts.get(j['pattern'], 0) + 1
        
        logger.info(f"\nPatterns:")
        for pattern, count in pattern_counts.items():
            pct = (count / len(journeys)) * 100
            logger.info(f"  {pattern}: {count} ({pct:.1f}%)")
        
        # Exit quality
        quality_counts = {}
        for j in journeys:
            quality_counts[j['exit_quality']] = quality_counts.get(j['exit_quality'], 0) + 1
        
        logger.info(f"\nExit Quality:")
        for quality, count in quality_counts.items():
            pct = (count / len(journeys)) * 100
            logger.info(f"  {quality}: {count} ({pct:.1f}%)")
        
        # Opportunity analysis
        avg_hwm = sum(j['hwm_pct'] for j in journeys) / len(journeys)
        avg_lwm = sum(j['lwm_pct'] for j in journeys) / len(journeys)
        avg_actual = sum(j['pnl_pct'] for j in journeys) / len(journeys)
        avg_left_on_table = avg_hwm - avg_actual
        
        logger.info(f"\nOpportunity Analysis:")
        logger.info(f"  Avg HWM (best possible): +{avg_hwm:.1f}%")
        logger.info(f"  Avg Actual Exit: {avg_actual:+.1f}%")
        logger.info(f"  Avg LWM (worst drawdown): {avg_lwm:.1f}%")
        logger.info(f"  Avg Left on Table: {avg_left_on_table:.1f}%")
        
        logger.info(f"\n{'='*80}\n")


def main():
    """Test journey backtest"""
    backtester = JourneyBacktester(
        tickers=['AMD', 'NVDA'],
        start_date='2025-12-01',
        end_date='2025-12-31',
        starting_capital=600
    )
    
    journeys = backtester.run_backtest('B+')
    
    # Print sample journey
    if journeys:
        sample = journeys[0]
        logger.info("\nSample Journey Detail:")
        logger.info(f"Ticker: {sample.get('ticker', 'N/A')}")
        logger.info(f"Entry: ${sample['entry_date']}")
        logger.info(f"Snapshots: {len(sample['snapshots'])}")
        for snap in sample['snapshots'][:5]:
            logger.info(f"  {snap['timestamp']}: ${snap['stock_price']} ({snap['option_pct']:+.1f}%)")


if __name__ == '__main__':
    main()

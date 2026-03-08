"""
V5 Strategy Backtest Engine - ALPACA VERSION
Test 15 tech stocks with professional trading rules using Alpaca historical data

Why Alpaca instead of yfinance:
- Same data source for backtesting and live trading
- Consistent results (no data discrepancies)
- We're already paying for Premium subscription
- More accurate corporate actions and splits

Rules:
1. No trading first 15 minutes (9:30-9:45 AM ET)
2. No holding over earnings
3. No same-day trading until AFTER fed announcements
4. Minimum score thresholds (B, B+, A-, A, A+)
5. Same-day exit (EOD close)
"""

from alpaca_client import AlpacaClient
from datetime import datetime, timedelta
import pandas as pd
from scorer_v5 import V5Scorer
import json
from collections import defaultdict
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class V5BacktesterAlpaca:
    def __init__(self, tickers, start_date, end_date):
        self.tickers = tickers
        self.start_date = start_date
        self.end_date = end_date
        self.scorer = V5Scorer()
        self.alpaca = AlpacaClient()
        
        # Score thresholds
        self.thresholds = {
            'B': 70,
            'B+': 75,
            'A-': 80,
            'A': 85,
            'A+': 90
        }
        
        # Fed announcement dates (2025-2026)
        # TODO: Get from economic calendar API
        self.fed_dates = [
            '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18',
            '2025-07-30', '2025-09-17', '2025-11-05', '2025-12-17',
            '2026-01-28', '2026-03-18'
        ]
        
        # Earnings blackout (simplified - avoid known earnings weeks)
        # TODO: Get from earnings calendar API
        self.earnings_months = {
            1: [15, 30],  # Mid-Jan, End-Jan
            4: [15, 30],  # Mid-Apr, End-Apr
            7: [15, 31],  # Mid-Jul, End-Jul
            10: [15, 31]  # Mid-Oct, End-Oct
        }
    
    def run_backtest(self, threshold_name='B+'):
        """Run backtest for all tickers at given threshold"""
        threshold = self.thresholds[threshold_name]
        
        logger.info(f"\n{'='*80}")
        logger.info(f"V5 ALPACA BACKTEST: {threshold_name} ({threshold}+ score) threshold")
        logger.info(f"Period: {self.start_date} to {self.end_date}")
        logger.info(f"Tickers: {', '.join(self.tickers)}")
        logger.info(f"Data Source: Alpaca Premium")
        logger.info(f"{'='*80}\n")
        
        all_trades = []
        ticker_stats = {}
        
        for ticker in self.tickers:
            logger.info(f"Testing {ticker}...")
            trades = self._backtest_ticker(ticker, threshold)
            all_trades.extend(trades)
            
            # Calculate ticker stats
            if trades:
                wins = [t for t in trades if t['pnl'] > 0]
                losses = [t for t in trades if t['pnl'] <= 0]
                
                ticker_stats[ticker] = {
                    'trades': len(trades),
                    'wins': len(wins),
                    'losses': len(losses),
                    'win_rate': len(wins) / len(trades) * 100 if trades else 0,
                    'total_pnl': sum(t['pnl'] for t in trades),
                    'avg_win': sum(t['pnl'] for t in wins) / len(wins) if wins else 0,
                    'avg_loss': sum(t['pnl'] for t in losses) / len(losses) if losses else 0
                }
            else:
                ticker_stats[ticker] = {
                    'trades': 0,
                    'wins': 0,
                    'losses': 0,
                    'win_rate': 0,
                    'total_pnl': 0,
                    'avg_win': 0,
                    'avg_loss': 0
                }
        
        # Calculate aggregate stats
        wins = [t for t in all_trades if t['pnl'] > 0]
        losses = [t for t in all_trades if t['pnl'] <= 0]
        
        results = {
            'threshold': threshold_name,
            'threshold_score': threshold,
            'total_trades': len(all_trades),
            'wins': len(wins),
            'losses': len(losses),
            'win_rate': len(wins) / len(all_trades) * 100 if all_trades else 0,
            'total_pnl': sum(t['pnl'] for t in all_trades),
            'avg_win': sum(t['pnl'] for t in wins) / len(wins) if wins else 0,
            'avg_loss': sum(t['pnl'] for t in losses) / len(losses) if losses else 0,
            'profit_factor': abs(sum(t['pnl'] for t in wins) / sum(t['pnl'] for t in losses)) if losses and sum(t['pnl'] for t in losses) != 0 else 0,
            'trades_per_month': len(all_trades) / 12,
            'ticker_stats': ticker_stats,
            'trades': all_trades
        }
        
        return results
    
    def _backtest_ticker(self, ticker, threshold):
        """Backtest single ticker using Alpaca historical data"""
        try:
            # Get historical bars from Alpaca
            logger.info(f"  Fetching Alpaca bars for {ticker}...")
            bars_response = self.alpaca.get_bars(
                ticker,
                timeframe='1Day',
                start=self.start_date,
                end=self.end_date,
                limit=10000  # Max allowed
            )
            
            if 'bars' not in bars_response or not bars_response['bars']:
                logger.warning(f"  ⚠️  No data for {ticker}")
                return []
            
            bars = bars_response['bars']
            logger.info(f"  Retrieved {len(bars)} bars from Alpaca")
            
            trades = []
            
            # Calculate 20-day rolling volume average
            volumes = [bar['v'] for bar in bars]
            
            for i in range(len(bars)):
                bar = bars[i]
                
                # Parse date
                date = datetime.fromisoformat(bar['t'].replace('Z', '+00:00'))
                
                # RULE: Skip earnings blackout periods
                if self._is_earnings_blackout(date):
                    continue
                
                # RULE: Skip fed announcement days (no same-day trading)
                if self._is_fed_day(date):
                    continue
                
                # Calculate intraday metrics
                open_price = float(bar['o'])
                high = float(bar['h'])
                low = float(bar['l'])
                close = float(bar['c'])
                volume = float(bar['v'])
                
                # Get 20-day average volume
                if i >= 20:
                    avg_volume = sum(volumes[i-20:i]) / 20
                else:
                    avg_volume = volume
                
                # Build quote data
                quote_data = {
                    'open': open_price,
                    'high': high,
                    'low': low,
                    'current': close,  # Use close as proxy for intraday price
                    'volume': volume,
                    'avg_volume': avg_volume
                }
                
                # Score the setup
                score_result = self.scorer.score_ticker(ticker, quote_data)
                score = score_result['score']
                
                # RULE: Only take trades at threshold or higher
                if score < threshold:
                    continue
                
                # RULE: No trading first 15 minutes (simulated - we skip this in daily data)
                # In real-time, would check: if current_time < 9:45 AM ET, skip
                
                # Simulate trade (same-day exit)
                entry_price = close
                exit_price = close  # Same-day exit at close
                
                # Calculate P/L (using simplified 1:1 option pricing)
                # Assume ATM option moves ~0.7x underlying for small moves
                underlying_move_pct = ((exit_price - entry_price) / entry_price) * 100
                option_move_pct = underlying_move_pct * 0.7  # Delta approximation
                
                # Position size: $1000
                position_size = 1000
                pnl = position_size * (option_move_pct / 100)
                
                trades.append({
                    'ticker': ticker,
                    'date': date.strftime('%Y-%m-%d'),
                    'score': score,
                    'grade': score_result['grade'],
                    'direction': score_result['direction'],
                    'entry': entry_price,
                    'exit': exit_price,
                    'underlying_move_pct': underlying_move_pct,
                    'option_move_pct': option_move_pct,
                    'pnl': pnl,
                    'position_size': position_size
                })
            
            logger.info(f"  {ticker}: {len(trades)} trades")
            return trades
            
        except Exception as e:
            logger.error(f"  ❌ Error backtesting {ticker}: {e}")
            return []
    
    def _is_earnings_blackout(self, date):
        """Check if date falls in earnings blackout period"""
        month = date.month
        day = date.day
        
        if month in self.earnings_months:
            blackout_days = self.earnings_months[month]
            for blackout_day in blackout_days:
                # Blackout 3 days before and after earnings day
                if abs(day - blackout_day) <= 3:
                    return True
        
        return False
    
    def _is_fed_day(self, date):
        """Check if date is a Fed announcement day"""
        date_str = date.strftime('%Y-%m-%d')
        return date_str in self.fed_dates


def main():
    """Test the backtest engine"""
    tickers = ['AMD', 'NVDA', 'TSLA']
    start_date = '2025-03-01'
    end_date = '2026-03-01'
    
    backtester = V5BacktesterAlpaca(tickers, start_date, end_date)
    results = backtester.run_backtest('B+')
    
    print(f"\n{'='*80}")
    print("RESULTS SUMMARY")
    print(f"{'='*80}")
    print(f"Total Trades: {results['total_trades']}")
    print(f"Win Rate: {results['win_rate']:.1f}%")
    print(f"Total P&L: ${results['total_pnl']:.2f}")
    print(f"Avg Win: ${results['avg_win']:.2f}")
    print(f"Avg Loss: ${results['avg_loss']:.2f}")
    print(f"Profit Factor: {results['profit_factor']:.2f}")
    print(f"Trades/Month: {results['trades_per_month']:.1f}")
    print(f"\n{'='*80}")
    print("PER-TICKER BREAKDOWN")
    print(f"{'='*80}")
    
    for ticker, stats in results['ticker_stats'].items():
        print(f"\n{ticker}:")
        print(f"  Trades: {stats['trades']}")
        print(f"  Win Rate: {stats['win_rate']:.1f}%")
        print(f"  Total P&L: ${stats['total_pnl']:.2f}")
    
    # Save to file
    with open('v5_alpaca_backtest_results.json', 'w') as f:
        json.dump(results, f, indent=2)
    
    print(f"\n✅ Results saved to v5_alpaca_backtest_results.json")


if __name__ == '__main__':
    main()

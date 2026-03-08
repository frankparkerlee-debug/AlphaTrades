"""
V5 Strategy Backtest Engine
Test 15 tech stocks with professional trading rules

Rules:
1. No trading first 15 minutes (9:30-9:45 AM ET)
2. No holding over earnings
3. No same-day trading until AFTER fed announcements
4. Minimum score thresholds (B, B+, A-, A, A+)
5. Same-day exit (EOD close)
"""

import yfinance as yf
from datetime import datetime, timedelta, time as dt_time
import pandas as pd
from scorer_v5 import V5Scorer
import json
from collections import defaultdict

class V5Backtester:
    def __init__(self, tickers, start_date, end_date):
        self.tickers = tickers
        self.start_date = start_date
        self.end_date = end_date
        self.scorer = V5Scorer()
        
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
        
        print(f"\n{'='*80}")
        print(f"V5 BACKTEST: {threshold_name} ({threshold}+ score) threshold")
        print(f"Period: {self.start_date} to {self.end_date}")
        print(f"Tickers: {', '.join(self.tickers)}")
        print(f"{'='*80}\n")
        
        all_trades = []
        ticker_stats = {}
        
        for ticker in self.tickers:
            print(f"Testing {ticker}...")
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
        """Backtest single ticker"""
        try:
            # Download data
            data = yf.download(ticker, start=self.start_date, end=self.end_date, interval='1d', progress=False)
            
            if data.empty:
                print(f"  ⚠️  No data for {ticker}")
                return []
            
            trades = []
            
            for i in range(len(data)):
                date = data.index[i]
                row = data.iloc[i]
                
                # RULE: Skip earnings blackout periods
                if self._is_earnings_blackout(date):
                    continue
                
                # RULE: Skip fed announcement days (no same-day trading)
                if self._is_fed_day(date):
                    continue
                
                # Calculate intraday metrics (convert to scalar values)
                open_price = float(row['Open'])
                high = float(row['High'])
                low = float(row['Low'])
                close = float(row['Close'])
                volume = float(row['Volume'])
                
                # Get 20-day average volume
                if i >= 20:
                    avg_volume = data['Volume'].iloc[i-20:i].mean()
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
            
            print(f"  ✓ {ticker}: {len(trades)} trades")
            return trades
            
        except Exception as e:
            print(f"  ✗ {ticker}: Error - {str(e)}")
            return []
    
    def _is_earnings_blackout(self, date):
        """Check if date is in earnings blackout period"""
        month = date.month
        day = date.day
        
        if month in self.earnings_months:
            blackout_days = self.earnings_months[month]
            for blackout_day in blackout_days:
                if abs(day - blackout_day) <= 3:  # ±3 days around earnings
                    return True
        return False
    
    def _is_fed_day(self, date):
        """Check if date is a fed announcement day"""
        date_str = date.strftime('%Y-%m-%d')
        return date_str in self.fed_dates
    
    def compare_thresholds(self):
        """Compare all thresholds"""
        print("\n" + "="*80)
        print("V5 STRATEGY COMPARISON - ALL THRESHOLDS")
        print("="*80 + "\n")
        
        results = {}
        for threshold_name in ['B', 'B+', 'A-', 'A', 'A+']:
            results[threshold_name] = self.run_backtest(threshold_name)
        
        # Print comparison table
        print("\n" + "="*80)
        print("THRESHOLD COMPARISON SUMMARY")
        print("="*80)
        print(f"{'Threshold':<12} {'Trades':<10} {'Win Rate':<12} {'Total P/L':<15} {'Profit Factor':<15} {'Trades/Month':<15}")
        print("-" * 80)
        
        for threshold_name in ['B', 'B+', 'A-', 'A', 'A+']:
            r = results[threshold_name]
            print(f"{threshold_name:<12} {r['total_trades']:<10} {r['win_rate']:<12.1f}% ${r['total_pnl']:<14.2f} {r['profit_factor']:<15.2f} {r['trades_per_month']:<15.1f}")
        
        print("="*80 + "\n")
        
        return results
    
    def save_results(self, results, filename):
        """Save results to JSON file"""
        # Convert to JSON-serializable format
        output = {}
        for threshold, data in results.items():
            output[threshold] = {
                k: v for k, v in data.items() if k != 'trades'
            }
            # Save trades separately
            output[threshold]['sample_trades'] = data['trades'][:10]  # First 10 trades
        
        with open(filename, 'w') as f:
            json.dump(output, f, indent=2)
        
        print(f"✓ Results saved to {filename}")

def main():
    # Top 15 tech stocks
    tickers = [
        'AMD', 'NVDA', 'TSLA',  # Proven
        'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META',  # Mega caps
        'NFLX', 'AVGO', 'ORCL', 'ADBE',  # Mid caps
        'CRM', 'INTC', 'QCOM'  # Additional
    ]
    
    # 12 months backtest
    end_date = datetime.now()
    start_date = end_date - timedelta(days=365)
    
    backtester = V5Backtester(
        tickers=tickers,
        start_date=start_date.strftime('%Y-%m-%d'),
        end_date=end_date.strftime('%Y-%m-%d')
    )
    
    # Run comparison
    results = backtester.compare_thresholds()
    
    # Save results
    backtester.save_results(results, 'v5_backtest_results.json')
    
    # Generate detailed report
    print("\n" + "="*80)
    print("DETAILED ANALYSIS")
    print("="*80 + "\n")
    
    # Best threshold
    best_threshold = max(results.keys(), key=lambda k: results[k]['profit_factor'])
    best_result = results[best_threshold]
    
    print(f"🏆 BEST THRESHOLD: {best_threshold}")
    print(f"   Trades: {best_result['total_trades']}")
    print(f"   Win Rate: {best_result['win_rate']:.1f}%")
    print(f"   Total P/L: ${best_result['total_pnl']:.2f}")
    print(f"   Profit Factor: {best_result['profit_factor']:.2f}")
    print(f"   Trades/Month: {best_result['trades_per_month']:.1f}")
    print(f"   Avg Win: ${best_result['avg_win']:.2f}")
    print(f"   Avg Loss: ${best_result['avg_loss']:.2f}")
    
    print("\n" + "="*80)
    print("TOP PERFORMING TICKERS")
    print("="*80)
    
    ticker_stats = best_result['ticker_stats']
    sorted_tickers = sorted(ticker_stats.items(), key=lambda x: x[1]['total_pnl'], reverse=True)
    
    print(f"{'Ticker':<10} {'Trades':<10} {'Win Rate':<12} {'Total P/L':<15}")
    print("-" * 50)
    for ticker, stats in sorted_tickers[:10]:
        print(f"{ticker:<10} {stats['trades']:<10} {stats['win_rate']:<12.1f}% ${stats['total_pnl']:<14.2f}")
    
    print("\n✅ Backtest complete!")

if __name__ == '__main__':
    main()

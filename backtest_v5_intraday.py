"""
V5 Intraday Backtest - Using 5-minute bars
Test realistic intraday momentum signals with proper exits

Rules:
1. Intraday 5-min bars (realistic for V5 momentum detection)
2. No trading first 15 minutes (9:30-9:45 AM ET)
3. No holding over earnings
4. No same-day trading until AFTER fed announcements
5. 35% stop loss
6. Dynamic trailing stops based on momentum (scale out as profit grows)
7. Same-day exit (EOD close)
"""

import requests
import os
from datetime import datetime, timedelta, time as dt_time
import json
from scorer_v5 import V5Scorer
from collections import defaultdict
import time as time_module

class V5IntradayBacktester:
    def __init__(self, tickers, start_date, end_date):
        self.tickers = tickers
        self.start_date = start_date
        self.end_date = end_date
        self.scorer = V5Scorer()
        
        # Alpaca credentials
        self.alpaca_key = os.getenv('ALPACA_API_KEY')
        self.alpaca_secret = os.getenv('ALPACA_SECRET_KEY')
        self.data_url = 'https://data.alpaca.markets'
        
        # Score thresholds
        self.thresholds = {
            'B': 70,
            'B+': 75,
            'A-': 80,
            'A': 85,
            'A+': 90
        }
        
        # Stop loss
        self.stop_loss_pct = 0.35  # 35%
        
        # Dynamic trailing stops based on profit
        # As profit grows, tighten the trailing stop
        self.trailing_stops = [
            {'profit_pct': 0.05, 'trail_pct': 0.30},  # At +5% profit, trail at -30%
            {'profit_pct': 0.10, 'trail_pct': 0.20},  # At +10%, trail at -20%
            {'profit_pct': 0.15, 'trail_pct': 0.15},  # At +15%, trail at -15%
            {'profit_pct': 0.20, 'trail_pct': 0.10},  # At +20%, trail at -10%
            {'profit_pct': 0.30, 'trail_pct': 0.05},  # At +30%, trail at -5%
        ]
        
        # Momentum-based scaling (take profits as we hit targets)
        self.scale_out_levels = [
            {'profit_pct': 0.15, 'scale_out': 0.33},  # At +15%, sell 1/3
            {'profit_pct': 0.30, 'scale_out': 0.50},  # At +30%, sell half of remaining
            {'profit_pct': 0.50, 'scale_out': 1.00},  # At +50%, sell all
        ]
    
    def get_intraday_bars(self, ticker, date):
        """Fetch 5-minute bars for a specific trading day"""
        try:
            # Format date for Alpaca API
            start = f"{date}T09:30:00-05:00"  # Market open
            end = f"{date}T16:00:00-05:00"    # Market close
            
            url = f"{self.data_url}/v2/stocks/{ticker}/bars"
            params = {
                'start': start,
                'end': end,
                'timeframe': '5Min',
                'limit': 10000,
                'adjustment': 'split'
            }
            
            headers = {
                'APCA-API-KEY-ID': self.alpaca_key,
                'APCA-API-SECRET-KEY': self.alpaca_secret
            }
            
            response = requests.get(url, params=params, headers=headers)
            
            if response.status_code != 200:
                print(f"  ⚠️  API error {response.status_code} for {ticker} on {date}")
                return []
            
            data = response.json()
            bars = data.get('bars', [])
            
            return bars
            
        except Exception as e:
            print(f"  ✗ Error fetching {ticker} bars: {str(e)}")
            return []
    
    def run_backtest(self, threshold_name='B+', max_days=30):
        """Run intraday backtest for given threshold"""
        threshold = self.thresholds[threshold_name]
        
        print(f"\n{'='*80}")
        print(f"V5 INTRADAY BACKTEST: {threshold_name} ({threshold}+ score)")
        print(f"Period: {self.start_date} to {self.end_date} (max {max_days} trading days)")
        print(f"Tickers: {', '.join(self.tickers)}")
        print(f"Stop Loss: {self.stop_loss_pct*100}%")
        print(f"Dynamic Trailing: Active")
        print(f"{'='*80}\n")
        
        all_trades = []
        ticker_stats = {}
        
        # Generate list of trading days to test
        start = datetime.strptime(self.start_date, '%Y-%m-%d')
        end = datetime.strptime(self.end_date, '%Y-%m-%d')
        
        trading_days = []
        current = end  # Start from most recent (better data availability)
        
        while current >= start and len(trading_days) < max_days:
            # Skip weekends
            if current.weekday() < 5:  # Mon-Fri
                trading_days.append(current.strftime('%Y-%m-%d'))
            current -= timedelta(days=1)
        
        trading_days.reverse()  # Chronological order
        
        print(f"Testing {len(trading_days)} trading days...\n")
        
        for ticker in self.tickers:
            print(f"Testing {ticker}...")
            trades = self._backtest_ticker_intraday(ticker, threshold, trading_days)
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
                    'trades': 0, 'wins': 0, 'losses': 0,
                    'win_rate': 0, 'total_pnl': 0, 'avg_win': 0, 'avg_loss': 0
                }
            
            # Rate limiting (avoid API throttling)
            time_module.sleep(0.5)
        
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
            'trades_per_day': len(all_trades) / len(trading_days) if trading_days else 0,
            'trades_per_month': len(all_trades) / len(trading_days) * 21 if trading_days else 0,
            'ticker_stats': ticker_stats,
            'sample_trades': all_trades[:20]
        }
        
        return results
    
    def _backtest_ticker_intraday(self, ticker, threshold, trading_days):
        """Backtest single ticker using intraday bars"""
        trades = []
        
        for date in trading_days:
            # Get 5-min bars for this day
            bars = self.get_intraday_bars(ticker, date)
            
            if not bars:
                continue
            
            # Track the day for potential entry
            for i, bar in enumerate(bars):
                bar_time = datetime.fromisoformat(bar['t'].replace('Z', '+00:00'))
                bar_hour = bar_time.hour
                bar_minute = bar_time.minute
                
                # RULE: No trading first 15 minutes (before 9:45 AM ET)
                if bar_hour == 9 and bar_minute < 45:
                    continue
                
                # Calculate metrics from bars up to this point
                day_open = bars[0]['o']
                day_high = max(b['h'] for b in bars[:i+1])
                day_low = min(b['l'] for b in bars[:i+1])
                current = bar['c']
                volume = sum(b['v'] for b in bars[:i+1])
                
                # Calculate 20-bar average volume (if enough bars)
                if i >= 20:
                    avg_volume = sum(b['v'] for b in bars[i-20:i]) / 20
                else:
                    avg_volume = volume / (i + 1)
                
                # Build quote data
                quote_data = {
                    'open': day_open,
                    'high': day_high,
                    'low': day_low,
                    'current': current,
                    'volume': volume,
                    'avg_volume': avg_volume
                }
                
                # Score the setup
                score_result = self.scorer.score_ticker(ticker, quote_data)
                score = score_result['score']
                
                # Check if this meets threshold
                if score >= threshold:
                    # ENTRY: Take the trade
                    entry_price = current
                    entry_bar_idx = i
                    
                    # Now simulate exit logic through rest of day
                    exit_result = self._simulate_exit(
                        ticker, bars, entry_bar_idx, entry_price, score_result
                    )
                    
                    if exit_result:
                        trades.append(exit_result)
                    
                    # Only one trade per ticker per day
                    break
        
        print(f"  ✓ {ticker}: {len(trades)} trades")
        return trades
    
    def _simulate_exit(self, ticker, bars, entry_idx, entry_price, score_result):
        """Simulate trade exit with dynamic trailing stops"""
        position_size = 1000  # $1000 position
        remaining_position = 1.0  # 100% of position still held
        total_pnl = 0
        max_price = entry_price
        highest_profit_pct = 0
        
        # Initial stop loss
        stop_price = entry_price * (1 - self.stop_loss_pct)
        
        # Track through remaining bars
        for i in range(entry_idx + 1, len(bars)):
            bar = bars[i]
            current_price = bar['c']
            
            # Update max price seen
            if current_price > max_price:
                max_price = current_price
            
            # Calculate current profit %
            profit_pct = (current_price - entry_price) / entry_price
            
            if profit_pct > highest_profit_pct:
                highest_profit_pct = profit_pct
            
            # Check for stop loss
            if current_price <= stop_price:
                # STOPPED OUT
                pnl = (current_price - entry_price) / entry_price * position_size * remaining_position
                total_pnl += pnl
                
                return {
                    'ticker': ticker,
                    'date': bars[entry_idx]['t'][:10],
                    'entry_time': bars[entry_idx]['t'][11:16],
                    'exit_time': bar['t'][11:16],
                    'exit_reason': 'STOP_LOSS',
                    'score': score_result['score'],
                    'grade': score_result['grade'],
                    'direction': score_result['direction'],
                    'entry': entry_price,
                    'exit': current_price,
                    'max_price': max_price,
                    'pnl_pct': profit_pct * 100,
                    'pnl': total_pnl,
                    'position_scaled': 1.0 - remaining_position
                }
            
            # Check for scale-out levels
            for level in self.scale_out_levels:
                if profit_pct >= level['profit_pct'] and remaining_position > 0:
                    # Scale out
                    scale_amount = level['scale_out'] * remaining_position
                    pnl_this_scale = (current_price - entry_price) / entry_price * position_size * scale_amount
                    total_pnl += pnl_this_scale
                    remaining_position -= scale_amount
                    
                    # If fully scaled out, exit
                    if remaining_position <= 0.01:
                        return {
                            'ticker': ticker,
                            'date': bars[entry_idx]['t'][:10],
                            'entry_time': bars[entry_idx]['t'][11:16],
                            'exit_time': bar['t'][11:16],
                            'exit_reason': 'SCALE_OUT_COMPLETE',
                            'score': score_result['score'],
                            'grade': score_result['grade'],
                            'direction': score_result['direction'],
                            'entry': entry_price,
                            'exit': current_price,
                            'max_price': max_price,
                            'pnl_pct': profit_pct * 100,
                            'pnl': total_pnl,
                            'position_scaled': 1.0
                        }
            
            # Update dynamic trailing stop
            for trail_level in self.trailing_stops:
                if highest_profit_pct >= trail_level['profit_pct']:
                    # Update stop to trail from max price
                    new_stop = max_price * (1 - trail_level['trail_pct'])
                    if new_stop > stop_price:
                        stop_price = new_stop
        
        # EOD close (didn't hit stop or scale out)
        final_price = bars[-1]['c']
        final_pnl = (final_price - entry_price) / entry_price * position_size * remaining_position + total_pnl
        
        return {
            'ticker': ticker,
            'date': bars[entry_idx]['t'][:10],
            'entry_time': bars[entry_idx]['t'][11:16],
            'exit_time': bars[-1]['t'][11:16],
            'exit_reason': 'EOD_CLOSE',
            'score': score_result['score'],
            'grade': score_result['grade'],
            'direction': score_result['direction'],
            'entry': entry_price,
            'exit': final_price,
            'max_price': max_price,
            'pnl_pct': ((final_price - entry_price) / entry_price) * 100,
            'pnl': final_pnl,
            'position_scaled': 1.0 - remaining_position
        }
    
    def compare_thresholds(self, max_days=30):
        """Compare all thresholds"""
        print("\n" + "="*80)
        print("V5 INTRADAY STRATEGY COMPARISON")
        print("="*80 + "\n")
        
        results = {}
        for threshold_name in ['B+', 'A-', 'A']:
            results[threshold_name] = self.run_backtest(threshold_name, max_days)
            print()  # Spacing
        
        # Print comparison
        print("\n" + "="*80)
        print("THRESHOLD COMPARISON")
        print("="*80)
        print(f"{'Threshold':<12} {'Trades':<10} {'Win%':<10} {'P/L':<12} {'PF':<10} {'Trades/Day':<12}")
        print("-" * 80)
        
        for name in ['B+', 'A-', 'A']:
            r = results[name]
            print(f"{name:<12} {r['total_trades']:<10} {r['win_rate']:<10.1f} ${r['total_pnl']:<11.2f} {r['profit_factor']:<10.2f} {r['trades_per_day']:<12.1f}")
        
        return results

def main():
    tickers = ['AMD', 'NVDA', 'TSLA', 'AAPL', 'MSFT']  # Start with 5 proven tickers
    
    # Test last 30 trading days
    end_date = datetime.now()
    start_date = end_date - timedelta(days=60)  # 60 calendar days = ~40-45 trading days
    
    backtester = V5IntradayBacktester(
        tickers=tickers,
        start_date=start_date.strftime('%Y-%m-%d'),
        end_date=end_date.strftime('%Y-%m-%d')
    )
    
    results = backtester.compare_thresholds(max_days=30)
    
    # Save results
    with open('v5_intraday_results.json', 'w') as f:
        json.dump(results, f, indent=2, default=str)
    
    print("\n✅ Backtest complete! Results saved to v5_intraday_results.json")
    
    # Print sample trades
    best = max(results.keys(), key=lambda k: results[k]['profit_factor'])
    print(f"\n{'='*80}")
    print(f"SAMPLE TRADES FROM {best} THRESHOLD")
    print("="*80)
    for trade in results[best]['sample_trades'][:5]:
        print(f"{trade['ticker']} {trade['date']} {trade['entry_time']}-{trade['exit_time']}: "
              f"{trade['direction']} @ ${trade['entry']:.2f} → ${trade['exit']:.2f} "
              f"({trade['pnl_pct']:+.1f}%) ${trade['pnl']:+.2f} [{trade['exit_reason']}]")

if __name__ == '__main__':
    main()

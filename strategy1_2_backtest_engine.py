"""
Strategy 1.2 Backtesting Engine
Event-driven trading with catalyst detection
"""
import yfinance as yf
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import json
from pathlib import Path
from strategy1_2_scorer import Strategy12Scorer

class Strategy12Backtest:
    def __init__(self, start_date, end_date, initial_capital=600):
        self.start_date = pd.to_datetime(start_date)
        self.end_date = pd.to_datetime(end_date)
        self.initial_capital = initial_capital
        self.capital = initial_capital
        
        # Strategy parameters
        self.position_size_pct = 0.20  # 20% per trade
        self.max_positions = 3
        self.stop_loss = -0.30  # -30%
        self.profit_target = 0.50  # +50%
        self.max_hold_days = 5
        
        # Trading state
        self.positions = []
        self.closed_trades = []
        self.daily_equity = []
        
        # Scorer
        self.scorer = Strategy12Scorer()
        
        # Tickers to track
        self.tickers = ['NVDA', 'TSLA', 'AMD', 'AAPL', 'AMZN', 'META', 
                       'MSFT', 'GOOGL', 'NFLX', 'AVGO', 'ORCL', 'ADBE', 'SPY']
        
        print(f"Initializing Strategy 1.2 backtest: {start_date} to {end_date}")
        print(f"Initial capital: ${initial_capital}")
    
    def fetch_data(self):
        """Fetch historical OHLCV data"""
        print(f"\nFetching historical data for {len(self.tickers)} symbols...")
        
        buffer_start = self.start_date - timedelta(days=10)
        
        data = {}
        for ticker in self.tickers:
            try:
                print(f"  Downloading {ticker}...", end='')
                df = yf.download(ticker, start=buffer_start, end=self.end_date + timedelta(days=1), 
                               progress=False, auto_adjust=True)
                if not df.empty:
                    data[ticker] = df
                    print(f" ✓ ({len(df)} days)")
                else:
                    print(f" ✗ No data")
            except Exception as e:
                print(f" ✗ Error: {e}")
        
        self.data = data
        return data
    
    def run_backtest(self):
        """Execute backtest"""
        print("\n" + "="*60)
        print("RUNNING STRATEGY 1.2 BACKTEST (EVENT-DRIVEN)")
        print("="*60)
        
        if not hasattr(self, 'data'):
            self.fetch_data()
        
        # Get trading days from SPY
        if 'SPY' not in self.data:
            print("ERROR: No SPY data for market trend")
            return
        
        spy_data = self.data['SPY']
        trading_days = spy_data.loc[self.start_date:self.end_date].index
        
        print(f"\nBacktesting {len(trading_days)} trading days...")
        print(f"Strategy: Event-Driven (Catalysts → Momentum → Sentiment)")
        
        for current_date in trading_days:
            self._process_day(current_date)
        
        # Close any remaining positions
        self._close_all_positions(trading_days[-1])
        
        return self._generate_results()
    
    def _process_day(self, date):
        """Process a single trading day"""
        # Get market trend
        market_trend = self._get_market_trend(date)
        
        # Update existing positions
        self._update_positions(date)
        
        # Check for new trade opportunities
        self._find_opportunities(date, market_trend)
        
        # Track equity
        equity = self.capital + sum([p['current_value'] for p in self.positions])
        self.daily_equity.append({
            'date': date,
            'equity': equity,
            'capital': self.capital,
            'positions': len(self.positions)
        })
    
    def _get_market_trend(self, date):
        """Get SPY market trend"""
        spy = self.data['SPY']
        
        if date not in spy.index:
            return {'is_up': True, 'change_pct': 0}
        
        row = spy.loc[date]
        if isinstance(row, pd.DataFrame):
            row = row.iloc[0]
        
        open_price = float(row['Open'])
        close_price = float(row['Close'])
        
        if open_price == 0:
            return {'is_up': True, 'change_pct': 0}
        
        change_pct = (close_price - open_price) / open_price * 100
        
        return {
            'is_up': change_pct > 0,
            'change_pct': change_pct
        }
    
    def _update_positions(self, date):
        """Update existing positions and check exit conditions"""
        for position in self.positions[:]:  # Copy list to modify during iteration
            if position['ticker'] not in self.data:
                continue
            
            df = self.data[position['ticker']]
            if date not in df.index:
                continue
            
            row = df.loc[date]
            if isinstance(row, pd.DataFrame):
                row = row.iloc[0]
            
            current_price = float(row['Close'])
            position['current_value'] = position['shares'] * current_price
            position['return_pct'] = (current_price - position['entry_price']) / position['entry_price']
            position['days_held'] = (date - position['entry_date']).days
            
            # Check exit conditions
            should_exit = False
            exit_reason = ''
            
            # Friday 3pm close
            if date.weekday() == 4 and date.hour >= 15:
                should_exit = True
                exit_reason = 'Friday close'
            
            # Max hold days
            elif position['days_held'] >= self.max_hold_days:
                should_exit = True
                exit_reason = 'Max hold days'
            
            # Stop loss
            elif position['return_pct'] <= self.stop_loss:
                should_exit = True
                exit_reason = 'Stop loss'
            
            # Profit target
            elif position['return_pct'] >= self.profit_target:
                should_exit = True
                exit_reason = 'Profit target'
            
            if should_exit:
                self._close_position(position, date, current_price, exit_reason)
    
    def _close_position(self, position, exit_date, exit_price, reason):
        """Close a position"""
        exit_value = position['shares'] * exit_price
        pnl = exit_value - position['entry_value']
        pnl_pct = (exit_price - position['entry_price']) / position['entry_price'] * 100
        
        self.capital += exit_value
        
        trade = {
            'ticker': position['ticker'],
            'entry_date': position['entry_date'].strftime('%Y-%m-%d'),
            'exit_date': exit_date.strftime('%Y-%m-%d'),
            'entry_price': position['entry_price'],
            'exit_price': exit_price,
            'shares': position['shares'],
            'entry_value': position['entry_value'],
            'exit_value': exit_value,
            'pnl': pnl,
            'pnl_pct': pnl_pct,
            'days_held': position['days_held'],
            'exit_reason': reason,
            'entry_score': position['score'],
            'entry_grade': position['grade'],
            'catalyst_type': position.get('catalyst_type', 'unknown')
        }
        
        self.closed_trades.append(trade)
        self.positions.remove(position)
    
    def _find_opportunities(self, date, market_trend):
        """Find new trade opportunities"""
        # Don't enter if at max positions
        if len(self.positions) >= self.max_positions:
            return
        
        # Market hours check (9:30 AM - 3:30 PM EST)
        # For backtesting, we assume we're evaluating at market close
        
        candidates = []
        
        for ticker in self.tickers:
            if ticker == 'SPY':  # Don't trade SPY
                continue
            
            if ticker not in self.data:
                continue
            
            df = self.data[ticker]
            if date not in df.index:
                continue
            
            row = df.loc[date]
            if isinstance(row, pd.DataFrame):
                row = row.iloc[0]
            
            ohlc = {
                'open': float(row['Open']),
                'high': float(row['High']),
                'low': float(row['Low']),
                'close': float(row['Close']),
                'volume': float(row['Volume'])
            }
            
            # Calculate score
            result = self.scorer.calculate_score(ticker, date, ohlc, market_trend)
            
            # Consider A+, A, A-, and B+ grades (catalyst-driven with confirmation)
            if result['grade'] in ['A+', 'A', 'A-', 'B+']:
                result['current_price'] = ohlc['close']
                candidates.append(result)
        
        # Sort by score
        candidates.sort(key=lambda x: x['score'], reverse=True)
        
        # Enter positions
        slots_available = self.max_positions - len(self.positions)
        for candidate in candidates[:slots_available]:
            self._enter_position(candidate, date)
    
    def _enter_position(self, signal, date):
        """Enter a new position"""
        position_size = self.capital * self.position_size_pct
        shares = int(position_size / signal['current_price'])
        
        if shares == 0:
            return
        
        entry_value = shares * signal['current_price']
        
        if entry_value > self.capital:
            return
        
        self.capital -= entry_value
        
        position = {
            'ticker': signal['ticker'],
            'entry_date': date,
            'entry_price': signal['current_price'],
            'shares': shares,
            'entry_value': entry_value,
            'current_value': entry_value,
            'return_pct': 0,
            'days_held': 0,
            'score': signal['score'],
            'grade': signal['grade'],
            'catalyst_type': self._get_primary_catalyst(signal)
        }
        
        self.positions.append(position)
    
    def _get_primary_catalyst(self, signal):
        """Determine primary catalyst type"""
        comp = signal.get('components', {})
        if comp.get('news', 0) > 0:
            return 'news'
        elif comp.get('earnings', 0) > 0:
            return 'earnings'
        elif comp.get('federal', 0) > 0:
            return 'federal'
        else:
            return 'unknown'
    
    def _close_all_positions(self, final_date):
        """Close all remaining positions at end of backtest"""
        for position in self.positions[:]:
            if position['ticker'] not in self.data:
                continue
            
            df = self.data[position['ticker']]
            if final_date not in df.index:
                continue
            
            row = df.loc[final_date]
            if isinstance(row, pd.DataFrame):
                row = row.iloc[0]
            
            final_price = float(row['Close'])
            self._close_position(position, final_date, final_price, 'Backtest end')
    
    def _generate_results(self):
        """Generate backtest results"""
        if not self.closed_trades:
            return {
                'strategy': 'Strategy 1.2 (Event-Driven)',
                'period': f"{self.start_date.date()} to {self.end_date.date()}",
                'total_trades': 0,
                'win_rate': 0,
                'total_return_pct': 0,
                'final_capital': self.capital,
                'initial_capital': self.initial_capital,
                'catalyst_performance': {},
                'trades': [],
                'equity_curve': self.daily_equity
            }
        
        df = pd.DataFrame(self.closed_trades)
        
        total_trades = len(df)
        wins = len(df[df['pnl'] > 0])
        win_rate = wins / total_trades * 100 if total_trades > 0 else 0
        
        total_return_pct = (self.capital - self.initial_capital) / self.initial_capital * 100
        
        # Calculate by catalyst type
        catalyst_performance = {}
        for cat_type in ['news', 'earnings', 'federal', 'unknown']:
            cat_trades = df[df['catalyst_type'] == cat_type]
            if len(cat_trades) > 0:
                catalyst_performance[cat_type] = {
                    'trades': len(cat_trades),
                    'win_rate': len(cat_trades[cat_trades['pnl'] > 0]) / len(cat_trades) * 100,
                    'avg_return': cat_trades['pnl_pct'].mean()
                }
        
        results = {
            'strategy': 'Strategy 1.2 (Event-Driven)',
            'period': f"{self.start_date.date()} to {self.end_date.date()}",
            'total_trades': total_trades,
            'wins': wins,
            'losses': total_trades - wins,
            'win_rate': win_rate,
            'total_return_pct': total_return_pct,
            'initial_capital': self.initial_capital,
            'final_capital': self.capital,
            'avg_return_per_trade': df['pnl_pct'].mean(),
            'best_trade': df['pnl_pct'].max(),
            'worst_trade': df['pnl_pct'].min(),
            'avg_hold_days': df['days_held'].mean(),
            'catalyst_performance': catalyst_performance,
            'trades': self.closed_trades,
            'equity_curve': self.daily_equity
        }
        
        return results
    
    def save_results(self, output_dir='/tmp/AlphaTrades/backtest_data'):
        """Save results to files"""
        Path(output_dir).mkdir(exist_ok=True, parents=True)
        
        results = self._generate_results()
        
        # Save summary
        period_label = f"{self.start_date.date()}_{self.end_date.date()}"
        summary_file = Path(output_dir) / f"strategy1_2_summary_{period_label}.json"
        
        with open(summary_file, 'w') as f:
            json.dump({
                'strategy': results.get('strategy', 'Strategy 1.2'),
                'period': results.get('period', f"{self.start_date.date()} to {self.end_date.date()}"),
                'total_trades': results['total_trades'],
                'win_rate': results['win_rate'],
                'total_return_pct': results['total_return_pct'],
                'final_capital': results['final_capital'],
                'catalyst_performance': results.get('catalyst_performance', {})
            }, f, indent=2)
        
        # Save detailed trades
        if self.closed_trades:
            trades_df = pd.DataFrame(self.closed_trades)
            trades_file = Path(output_dir) / f"strategy1_2_trades_{period_label}.csv"
            trades_df.to_csv(trades_file, index=False)
        
        print(f"\n✓ Results saved to {output_dir}")
        
        return results


def run_multi_period_backtest():
    """Run backtests across multiple time periods"""
    periods = [30, 45, 60, 75, 90, 120, 365]
    end_date = datetime.now()
    
    all_results = {}
    
    for days in periods:
        start_date = end_date - timedelta(days=days)
        
        print(f"\n{'='*60}")
        print(f"PERIOD: {days} days")
        print(f"{'='*60}")
        
        bt = Strategy12Backtest(start_date, end_date)
        bt.fetch_data()
        results = bt.run_backtest()
        bt.save_results()
        
        all_results[f"{days}d"] = results
        
        # Print summary
        print(f"\n📊 SUMMARY ({days}d)")
        print(f"  Total Trades: {results['total_trades']}")
        print(f"  Win Rate: {results['win_rate']:.2f}%")
        print(f"  Total Return: {results['total_return_pct']:.2f}%")
        print(f"  Final Capital: ${results['final_capital']:.2f}")
    
    # Save combined results
    output_file = Path('/tmp/AlphaTrades/backtest_data/strategy1_2_all_periods.json')
    with open(output_file, 'w') as f:
        json.dump({
            period: {
                'total_trades': res['total_trades'],
                'win_rate': res['win_rate'],
                'total_return_pct': res['total_return_pct'],
                'catalyst_performance': res['catalyst_performance']
            }
            for period, res in all_results.items()
        }, f, indent=2)
    
    print(f"\n✓ All results saved to {output_file}")
    
    return all_results


if __name__ == '__main__':
    run_multi_period_backtest()

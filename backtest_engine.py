"""
Strategy 1 Backtesting Engine
Comprehensive backtesting framework for Strategy 1 algorithm
"""
import yfinance as yf
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import json
from pathlib import Path

class Strategy1Backtest:
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
        
        # Grade thresholds
        self.thresholds = {
            'A+': 50, 'A': 47, 'A-': 45,
            'B+': 41, 'B': 38, 'B-': 35
        }
        
        # Component weights
        self.weights = {
            'momentum': 25,
            'range': 15,
            'volume': 5,
            'market': 10
        }
        
        # Trading state
        self.positions = []
        self.closed_trades = []
        self.daily_equity = []
        
        # Tickers to track
        self.tickers = ['NVDA', 'TSLA', 'AMD', 'AAPL', 'AMZN', 'META', 
                       'MSFT', 'GOOGL', 'NFLX', 'AVGO', 'ORCL', 'ADBE', 'SPY']
        
        print(f"Initializing backtest: {start_date} to {end_date}")
        print(f"Initial capital: ${initial_capital}")
    
    def fetch_data(self):
        """Fetch historical OHLCV data for all tickers"""
        print(f"\nFetching historical data for {len(self.tickers)} symbols...")
        
        # Add buffer days for calculations
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
    
    def calculate_score(self, ticker, date, market_trend):
        """Calculate Strategy 1 score for a ticker on a specific date"""
        if ticker not in self.data:
            return None
        
        df = self.data[ticker]
        if date not in df.index:
            return None
        
        row = df.loc[date]
        
        # Handle both Series and DataFrame returns
        if isinstance(row, pd.DataFrame):
            if len(row) == 0:
                return None
            row = row.iloc[0]
        
        open_price = float(row['Open'])
        current = float(row['Close'])
        high = float(row['High'])
        low = float(row['Low'])
        
        if open_price == 0 or np.isnan(open_price):
            return None
        
        # Calculate metrics
        move_from_open = abs((current - open_price) / open_price * 100)
        range_pct = (high - low) / open_price * 100
        
        # Component scores
        score_momentum = self._score_momentum(move_from_open)
        score_range = self._score_range(range_pct)
        score_volume = self.weights['volume']
        score_market = self.weights['market'] if market_trend else 0
        
        total_score = score_momentum + score_range + score_volume + score_market
        grade = self._score_to_grade(total_score)
        
        return {
            'ticker': ticker,
            'date': date,
            'score': total_score,
            'grade': grade,
            'open': open_price,
            'close': current,
            'high': high,
            'low': low,
            'move_pct': move_from_open,
            'range_pct': range_pct,
            'direction': 'LONG' if current > open_price else 'SHORT'
        }
    
    def _score_momentum(self, move_pct):
        """Score based on absolute move from open"""
        if move_pct >= 3.0:
            return self.weights['momentum']
        elif move_pct >= 2.0:
            return int(self.weights['momentum'] * 0.8)
        elif move_pct >= 1.5:
            return int(self.weights['momentum'] * 0.6)
        elif move_pct >= 1.0:
            return int(self.weights['momentum'] * 0.4)
        return 0
    
    def _score_range(self, range_pct):
        """Score based on daily price range"""
        if range_pct >= 3.0:
            return self.weights['range']
        elif range_pct >= 2.0:
            return int(self.weights['range'] * 0.67)
        elif range_pct >= 1.5:
            return int(self.weights['range'] * 0.33)
        return 0
    
    def _score_to_grade(self, score):
        """Convert numerical score to letter grade"""
        if score >= self.thresholds['A+']:
            return 'A+'
        elif score >= self.thresholds['A']:
            return 'A'
        elif score >= self.thresholds['A-']:
            return 'A-'
        elif score >= self.thresholds['B+']:
            return 'B+'
        elif score >= self.thresholds['B']:
            return 'B'
        elif score >= self.thresholds['B-']:
            return 'B-'
        else:
            return 'C'
    
    def get_market_trend(self, date):
        """Check if SPY is up or down on this date"""
        if 'SPY' not in self.data or date not in self.data['SPY'].index:
            return False
        
        spy = self.data['SPY'].loc[date]
        
        # Handle both Series and DataFrame returns
        if isinstance(spy, pd.DataFrame):
            if len(spy) == 0:
                return False
            spy = spy.iloc[0]
        
        return float(spy['Close']) > float(spy['Open'])
    
    def check_exits(self, current_date):
        """Check exit conditions for all open positions"""
        to_close = []
        
        for pos in self.positions:
            ticker = pos['ticker']
            entry_date = pos['entry_date']
            entry_price = pos['entry_price']
            shares = pos['shares']
            
            # Get current price
            if ticker not in self.data or current_date not in self.data[ticker].index:
                continue
            
            price_data = self.data[ticker].loc[current_date]
            if isinstance(price_data, pd.DataFrame):
                if len(price_data) == 0:
                    continue
                price_data = price_data.iloc[0]
            
            current_price = float(price_data['Close'])
            current_return = (current_price - entry_price) / entry_price
            
            hold_days = (current_date - entry_date).days
            is_friday = current_date.weekday() == 4
            
            exit_reason = None
            
            # Check exit conditions
            if current_return <= self.stop_loss:
                exit_reason = 'STOP_LOSS'
            elif current_return >= self.profit_target:
                exit_reason = 'PROFIT_TARGET'
            elif hold_days >= self.max_hold_days:
                exit_reason = 'MAX_HOLD'
            elif is_friday:
                exit_reason = 'FRIDAY_CLOSE'
            
            if exit_reason:
                pnl = shares * (current_price - entry_price)
                pnl_pct = current_return * 100
                
                trade = {
                    'ticker': ticker,
                    'grade': pos['grade'],
                    'entry_date': entry_date,
                    'entry_price': entry_price,
                    'exit_date': current_date,
                    'exit_price': current_price,
                    'shares': shares,
                    'pnl': pnl,
                    'pnl_pct': pnl_pct,
                    'hold_days': hold_days,
                    'exit_reason': exit_reason
                }
                
                self.closed_trades.append(trade)
                self.capital += pos['position_value'] + pnl
                to_close.append(pos)
        
        # Remove closed positions
        for pos in to_close:
            self.positions.remove(pos)
    
    def enter_trade(self, signal, current_date):
        """Enter a new trade if conditions are met"""
        # Check if we can enter
        if len(self.positions) >= self.max_positions:
            return False
        
        # Only trade A+, A, A- grades
        if signal['grade'] not in ['A+', 'A', 'A-']:
            return False
        
        # Calculate position size
        position_value = self.capital * self.position_size_pct
        ticker = signal['ticker']
        
        # Get entry price (next day open)
        next_date = current_date + timedelta(days=1)
        
        # Find next trading day
        max_lookforward = 5
        for i in range(max_lookforward):
            check_date = current_date + timedelta(days=i+1)
            if ticker in self.data and check_date in self.data[ticker].index:
                next_date = check_date
                break
        else:
            return False  # No valid entry found
        
        if ticker not in self.data or next_date not in self.data[ticker].index:
            return False
        
        entry_data = self.data[ticker].loc[next_date]
        if isinstance(entry_data, pd.DataFrame):
            if len(entry_data) == 0:
                return False
            entry_data = entry_data.iloc[0]
        
        entry_price = float(entry_data['Open'])
        shares = position_value / entry_price
        
        position = {
            'ticker': ticker,
            'grade': signal['grade'],
            'entry_date': next_date,
            'entry_price': entry_price,
            'shares': shares,
            'position_value': position_value
        }
        
        self.positions.append(position)
        self.capital -= position_value
        
        return True
    
    def run_backtest(self):
        """Run the complete backtest simulation"""
        print(f"\n{'='*60}")
        print("RUNNING BACKTEST")
        print(f"{'='*60}\n")
        
        # Get trading days
        trading_days = pd.date_range(start=self.start_date, end=self.end_date, freq='D')
        
        signals_by_date = []
        
        for current_date in trading_days:
            # Skip weekends
            if current_date.weekday() >= 5:
                continue
            
            # Check exits first
            self.check_exits(current_date)
            
            # Calculate portfolio value
            portfolio_value = self.capital
            for pos in self.positions:
                if pos['ticker'] in self.data and current_date in self.data[pos['ticker']].index:
                    price_data = self.data[pos['ticker']].loc[current_date]
                    if isinstance(price_data, pd.DataFrame):
                        if len(price_data) == 0:
                            continue
                        price_data = price_data.iloc[0]
                    current_price = float(price_data['Close'])
                    portfolio_value += pos['shares'] * current_price
            
            self.daily_equity.append({
                'date': current_date,
                'equity': portfolio_value,
                'cash': self.capital,
                'positions': len(self.positions)
            })
            
            # Get market trend
            market_trend = self.get_market_trend(current_date)
            
            # Scan for signals
            day_signals = []
            for ticker in [t for t in self.tickers if t != 'SPY']:
                signal = self.calculate_score(ticker, current_date, market_trend)
                if signal:
                    day_signals.append(signal)
            
            # Sort by score (highest first)
            day_signals.sort(key=lambda x: x['score'], reverse=True)
            
            # Try to enter trades
            for signal in day_signals:
                if self.enter_trade(signal, current_date):
                    signals_by_date.append(signal)
        
        # Close any remaining positions at end
        if self.positions:
            for pos in self.positions:
                ticker = pos['ticker']
                if ticker in self.data and self.end_date in self.data[ticker].index:
                    price_data = self.data[ticker].loc[self.end_date]
                    if isinstance(price_data, pd.DataFrame):
                        if len(price_data) == 0:
                            continue
                        price_data = price_data.iloc[0]
                    exit_price = float(price_data['Close'])
                    pnl = pos['shares'] * (exit_price - pos['entry_price'])
                    pnl_pct = ((exit_price - pos['entry_price']) / pos['entry_price']) * 100
                    
                    trade = {
                        'ticker': ticker,
                        'grade': pos['grade'],
                        'entry_date': pos['entry_date'],
                        'entry_price': pos['entry_price'],
                        'exit_date': self.end_date,
                        'exit_price': exit_price,
                        'shares': pos['shares'],
                        'pnl': pnl,
                        'pnl_pct': pnl_pct,
                        'hold_days': (self.end_date - pos['entry_date']).days,
                        'exit_reason': 'END_OF_PERIOD'
                    }
                    
                    self.closed_trades.append(trade)
                    self.capital += pos['position_value'] + pnl
        
        final_equity = self.capital
        for pos in self.positions:
            if pos['ticker'] in self.data and self.end_date in self.data[pos['ticker']].index:
                price_data = self.data[pos['ticker']].loc[self.end_date]
                if isinstance(price_data, pd.DataFrame):
                    if len(price_data) == 0:
                        continue
                    price_data = price_data.iloc[0]
                current_price = float(price_data['Close'])
                final_equity += pos['shares'] * current_price
        
        self.final_equity = final_equity
        
        print(f"Backtest complete!")
        print(f"Trades executed: {len(self.closed_trades)}")
        print(f"Final equity: ${final_equity:.2f}")
        print(f"Total return: {((final_equity - self.initial_capital) / self.initial_capital * 100):.2f}%")
    
    def generate_report(self):
        """Generate comprehensive performance report"""
        if not self.closed_trades:
            return {
                'error': 'No trades executed',
                'total_return_pct': 0,
                'final_equity': self.capital
            }
        
        df_trades = pd.DataFrame(self.closed_trades)
        
        # Overall metrics
        total_return = ((self.final_equity - self.initial_capital) / self.initial_capital) * 100
        total_trades = len(df_trades)
        winning_trades = len(df_trades[df_trades['pnl'] > 0])
        win_rate = (winning_trades / total_trades * 100) if total_trades > 0 else 0
        
        avg_pnl = df_trades['pnl'].mean()
        avg_pnl_pct = df_trades['pnl_pct'].mean()
        
        # Drawdown calculation
        equity_series = pd.DataFrame(self.daily_equity)
        equity_series['cummax'] = equity_series['equity'].cummax()
        equity_series['drawdown'] = (equity_series['equity'] - equity_series['cummax']) / equity_series['cummax'] * 100
        max_drawdown = equity_series['drawdown'].min()
        
        # By grade
        grade_stats = df_trades.groupby('grade').agg({
            'pnl': ['count', 'mean', 'sum'],
            'pnl_pct': 'mean'
        }).round(2)
        
        # Calculate win rate by grade
        grade_wins = df_trades[df_trades['pnl'] > 0].groupby('grade').size()
        grade_total = df_trades.groupby('grade').size()
        grade_win_rate = (grade_wins / grade_total * 100).round(2)
        
        # Exit reasons
        exit_breakdown = df_trades['exit_reason'].value_counts()
        
        # Best and worst trades
        best_trade = df_trades.loc[df_trades['pnl'].idxmax()]
        worst_trade = df_trades.loc[df_trades['pnl'].idxmin()]
        
        report = {
            'period': f"{self.start_date.date()} to {self.end_date.date()}",
            'days': (self.end_date - self.start_date).days,
            'initial_capital': self.initial_capital,
            'final_equity': round(self.final_equity, 2),
            'total_return_pct': round(total_return, 2),
            'total_trades': total_trades,
            'winning_trades': winning_trades,
            'losing_trades': total_trades - winning_trades,
            'win_rate': round(win_rate, 2),
            'avg_pnl': round(avg_pnl, 2),
            'avg_pnl_pct': round(avg_pnl_pct, 2),
            'max_drawdown': round(max_drawdown, 2),
            'best_trade': {
                'ticker': best_trade['ticker'],
                'grade': best_trade['grade'],
                'pnl': round(best_trade['pnl'], 2),
                'pnl_pct': round(best_trade['pnl_pct'], 2),
                'entry': str(best_trade['entry_date'].date()),
                'exit': str(best_trade['exit_date'].date())
            },
            'worst_trade': {
                'ticker': worst_trade['ticker'],
                'grade': worst_trade['grade'],
                'pnl': round(worst_trade['pnl'], 2),
                'pnl_pct': round(worst_trade['pnl_pct'], 2),
                'entry': str(worst_trade['entry_date'].date()),
                'exit': str(worst_trade['exit_date'].date())
            },
            'by_grade': {},
            'exit_reasons': exit_breakdown.to_dict(),
            'trades': df_trades.to_dict('records')
        }
        
        # Add grade-specific stats
        for grade in ['A+', 'A', 'A-']:
            if grade in df_trades['grade'].values:
                grade_df = df_trades[df_trades['grade'] == grade]
                report['by_grade'][grade] = {
                    'count': len(grade_df),
                    'win_rate': round((len(grade_df[grade_df['pnl'] > 0]) / len(grade_df) * 100), 2),
                    'avg_pnl': round(grade_df['pnl'].mean(), 2),
                    'avg_pnl_pct': round(grade_df['pnl_pct'].mean(), 2),
                    'total_pnl': round(grade_df['pnl'].sum(), 2)
                }
        
        return report


def run_multi_period_backtest():
    """Run backtests across multiple time periods"""
    
    periods = [
        ('30d', '2026-02-03', '2026-03-04'),
        ('45d', '2026-01-19', '2026-03-04'),
        ('60d', '2026-01-04', '2026-03-04'),
        ('75d', '2025-12-20', '2026-03-04'),
        ('90d', '2025-12-05', '2026-03-04'),
        ('120d', '2025-11-05', '2026-03-04'),
        ('365d', '2025-03-05', '2026-03-04'),
    ]
    
    results = {}
    
    for period_name, start, end in periods:
        print(f"\n{'#'*60}")
        print(f"PERIOD: {period_name} ({start} to {end})")
        print(f"{'#'*60}")
        
        bt = Strategy1Backtest(start, end, initial_capital=600)
        bt.fetch_data()
        bt.run_backtest()
        report = bt.generate_report()
        
        results[period_name] = report
        
        # Save individual period data
        output_dir = Path('/tmp/AlphaTrades/backtest_data')
        output_dir.mkdir(parents=True, exist_ok=True)
        
        # Save trades CSV
        if report.get('trades'):
            trades_df = pd.DataFrame(report['trades'])
            trades_df.to_csv(output_dir / f'trades_{period_name}.csv', index=False)
        
        # Save equity curve
        if bt.daily_equity:
            equity_df = pd.DataFrame(bt.daily_equity)
            equity_df.to_csv(output_dir / f'equity_{period_name}.csv', index=False)
    
    return results


if __name__ == '__main__':
    results = run_multi_period_backtest()
    
    # Save summary JSON
    output_path = Path('/tmp/AlphaTrades/backtest_data/summary.json')
    with open(output_path, 'w') as f:
        json.dump(results, f, indent=2, default=str)
    
    print(f"\n{'='*60}")
    print("BACKTEST COMPLETE - Summary saved to backtest_data/summary.json")
    print(f"{'='*60}\n")

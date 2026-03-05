"""
Strategy 2 Fast Backtesting Engine
Uses simulated sentiment data for historical backtesting
(Historical sentiment data not available via free API)
"""
import yfinance as yf
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import json
from pathlib import Path
import random

class Strategy2FastBacktest:
    def __init__(self, start_date, end_date, initial_capital=600, sentiment_mode='realistic'):
        self.start_date = pd.to_datetime(start_date)
        self.end_date = pd.to_datetime(end_date)
        self.initial_capital = initial_capital
        self.capital = initial_capital
        self.sentiment_mode = sentiment_mode  # 'realistic', 'optimistic', 'neutral'
        
        # Strategy 2 thresholds and weights
        self.thresholds = {
            'A+': 85, 'A': 75, 'A-': 70,
            'B+': 65, 'B': 60, 'B-': 55
        }
        
        self.weights = {
            'momentum': 25,
            'range': 15,
            'volume': 10,
            'market': 10,
            'news_sentiment': 20,
            'earnings': 10,
            'social': 10
        }
        
        # Strategy parameters
        self.position_size_pct = 0.20
        self.max_positions = 3
        self.stop_loss = -0.30
        self.profit_target = 0.50
        self.max_hold_days = 5
        
        # Trading state
        self.positions = []
        self.closed_trades = []
        self.daily_equity = []
        
        # Tickers
        self.tickers = ['NVDA', 'TSLA', 'AMD', 'AAPL', 'AMZN', 'META', 
                       'MSFT', 'GOOGL', 'NFLX', 'AVGO', 'ORCL', 'ADBE', 'SPY']
        
        print(f"Strategy 2 Fast Backtest: {start_date} to {end_date}")
        print(f"Sentiment mode: {sentiment_mode}")
        print(f"Initial capital: ${initial_capital}")
    
    def fetch_data(self):
        """Fetch historical OHLCV data"""
        print(f"\nFetching data for {len(self.tickers)} symbols...")
        
        buffer_start = self.start_date - timedelta(days=10)
        data = {}
        
        for ticker in self.tickers:
            try:
                print(f"  {ticker}...", end='')
                df = yf.download(ticker, start=buffer_start, end=self.end_date + timedelta(days=1), 
                               progress=False, auto_adjust=True)
                if not df.empty:
                    data[ticker] = df
                    print(f" ✓")
                else:
                    print(f" ✗")
            except Exception as e:
                print(f" ✗")
        
        self.data = data
        return data
    
    def simulate_sentiment_components(self, ticker, date, future_return):
        """
        Simulate sentiment scores based on future price movement
        This represents what sentiment WOULD have shown if we had historical data
        
        Realistic mode: Sentiment is somewhat predictive but not perfect
        """
        # News sentiment (0-20 points)
        if self.sentiment_mode == 'realistic':
            # Sentiment has ~60% correlation with future moves
            if future_return > 2:  # Strong positive move coming
                news_score = random.uniform(12, 20)
            elif future_return > 0:
                news_score = random.uniform(8, 15)
            elif future_return > -2:
                news_score = random.uniform(5, 12)
            else:
                news_score = random.uniform(0, 8)
        elif self.sentiment_mode == 'optimistic':
            # Sentiment highly predictive (70-80%)
            if future_return > 2:
                news_score = random.uniform(15, 20)
            elif future_return > 0:
                news_score = random.uniform(10, 16)
            elif future_return > -2:
                news_score = random.uniform(5, 10)
            else:
                news_score = random.uniform(0, 5)
        else:  # neutral
            # Sentiment adds no value
            news_score = 10  # Always neutral
        
        # Earnings impact (0-10 points)
        # Simulate earnings beats randomly (10% chance per period)
        if random.random() < 0.10 and future_return > 1:
            earnings_score = 10  # Beat detected
        elif random.random() < 0.05:
            earnings_score = 5  # Upcoming earnings
        else:
            earnings_score = 0
        
        # Social sentiment (0-10 points)
        if self.sentiment_mode == 'realistic':
            # Social has moderate correlation
            if future_return > 3:
                social_score = random.uniform(7, 10)
            elif future_return > 0:
                social_score = random.uniform(5, 8)
            else:
                social_score = random.uniform(0, 6)
        elif self.sentiment_mode == 'optimistic':
            if future_return > 3:
                social_score = random.uniform(8, 10)
            elif future_return > 0:
                social_score = random.uniform(6, 9)
            else:
                social_score = random.uniform(0, 5)
        else:
            social_score = 5  # Neutral
        
        return {
            'news_sentiment': news_score,
            'earnings': earnings_score,
            'social': social_score
        }
    
    def calculate_score(self, ticker, date, market_trend):
        """Calculate Strategy 2 score with simulated sentiment"""
        if ticker not in self.data:
            return None
        
        df = self.data[ticker]
        if date not in df.index:
            return None
        
        row = df.loc[date]
        
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
        
        # Calculate future return (5 days ahead) for sentiment simulation
        future_date = date + timedelta(days=5)
        future_return = 0
        
        if future_date in df.index:
            future_row = df.loc[future_date]
            if isinstance(future_row, pd.DataFrame):
                if len(future_row) > 0:
                    future_row = future_row.iloc[0]
                    future_return = ((float(future_row['Close']) - current) / current * 100)
        
        # Base metrics
        move_from_open = abs((current - open_price) / open_price * 100)
        range_pct = (high - low) / open_price * 100
        
        # Base component scores (Strategy 1)
        score_momentum = self._score_momentum(move_from_open)
        score_range = self._score_range(range_pct)
        score_volume = self.weights['volume']
        score_market = self.weights['market'] if market_trend else 0
        
        # Simulated sentiment components
        sentiment = self.simulate_sentiment_components(ticker, date, future_return)
        
        score_news = sentiment['news_sentiment']
        score_earnings = sentiment['earnings']
        score_social = sentiment['social']
        
        total_score = (score_momentum + score_range + score_volume + score_market + 
                      score_news + score_earnings + score_social)
        
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
            'direction': 'LONG' if current > open_price else 'SHORT',
            'components': {
                'momentum': score_momentum,
                'range': score_range,
                'volume': score_volume,
                'market': score_market,
                'news_sentiment': score_news,
                'earnings': score_earnings,
                'social': score_social
            }
        }
    
    def _score_momentum(self, move_pct):
        """Score momentum (0-25)"""
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
        """Score range (0-15)"""
        if range_pct >= 3.0:
            return self.weights['range']
        elif range_pct >= 2.0:
            return int(self.weights['range'] * 0.67)
        elif range_pct >= 1.5:
            return int(self.weights['range'] * 0.33)
        return 0
    
    def _score_to_grade(self, score):
        """Convert score to grade"""
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
        """Check SPY trend"""
        if 'SPY' not in self.data or date not in self.data['SPY'].index:
            return False
        
        spy = self.data['SPY'].loc[date]
        if isinstance(spy, pd.DataFrame):
            if len(spy) == 0:
                return False
            spy = spy.iloc[0]
        
        return float(spy['Close']) > float(spy['Open'])
    
    def check_exits(self, current_date):
        """Check exit conditions"""
        to_close = []
        
        for pos in self.positions:
            ticker = pos['ticker']
            entry_date = pos['entry_date']
            entry_price = pos['entry_price']
            shares = pos['shares']
            
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
                    'exit_reason': exit_reason,
                    'components': pos.get('components', {})
                }
                
                self.closed_trades.append(trade)
                self.capital += pos['position_value'] + pnl
                to_close.append(pos)
        
        for pos in to_close:
            self.positions.remove(pos)
    
    def enter_trade(self, signal, current_date):
        """Enter trade"""
        if len(self.positions) >= self.max_positions:
            return False
        
        if signal['grade'] not in ['A+', 'A', 'A-']:
            return False
        
        position_value = self.capital * self.position_size_pct
        ticker = signal['ticker']
        
        # Find next trading day
        for i in range(1, 6):
            check_date = current_date + timedelta(days=i)
            if ticker in self.data and check_date in self.data[ticker].index:
                next_date = check_date
                break
        else:
            return False
        
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
            'position_value': position_value,
            'components': signal.get('components', {})
        }
        
        self.positions.append(position)
        self.capital -= position_value
        
        return True
    
    def run_backtest(self):
        """Run backtest"""
        print(f"\n{'='*60}")
        print("RUNNING STRATEGY 2 BACKTEST (FAST MODE)")
        print(f"{'='*60}\n")
        
        trading_days = pd.date_range(start=self.start_date, end=self.end_date, freq='D')
        
        for current_date in trading_days:
            if current_date.weekday() >= 5:
                continue
            
            self.check_exits(current_date)
            
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
            
            market_trend = self.get_market_trend(current_date)
            
            day_signals = []
            for ticker in [t for t in self.tickers if t != 'SPY']:
                signal = self.calculate_score(ticker, current_date, market_trend)
                if signal:
                    day_signals.append(signal)
            
            day_signals.sort(key=lambda x: x['score'], reverse=True)
            
            for signal in day_signals:
                if self.enter_trade(signal, current_date):
                    pass
        
        # Close remaining positions
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
                        'exit_reason': 'END_OF_PERIOD',
                        'components': pos.get('components', {})
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
        print(f"Trades: {len(self.closed_trades)}")
        print(f"Final equity: ${final_equity:.2f}")
        print(f"Total return: {((final_equity - self.initial_capital) / self.initial_capital * 100):.2f}%")
    
    def generate_report(self):
        """Generate performance report"""
        if not self.closed_trades:
            return {
                'error': 'No trades',
                'total_return_pct': 0,
                'final_equity': self.capital
            }
        
        df_trades = pd.DataFrame(self.closed_trades)
        
        total_return = ((self.final_equity - self.initial_capital) / self.initial_capital) * 100
        total_trades = len(df_trades)
        winning_trades = len(df_trades[df_trades['pnl'] > 0])
        win_rate = (winning_trades / total_trades * 100) if total_trades > 0 else 0
        
        avg_pnl = df_trades['pnl'].mean()
        avg_pnl_pct = df_trades['pnl_pct'].mean()
        
        equity_series = pd.DataFrame(self.daily_equity)
        equity_series['cummax'] = equity_series['equity'].cummax()
        equity_series['drawdown'] = (equity_series['equity'] - equity_series['cummax']) / equity_series['cummax'] * 100
        max_drawdown = equity_series['drawdown'].min()
        
        daily_returns = equity_series['equity'].pct_change().dropna()
        sharpe = (daily_returns.mean() / daily_returns.std() * np.sqrt(252)) if len(daily_returns) > 0 else 0
        
        exit_breakdown = df_trades['exit_reason'].value_counts()
        
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
            'sharpe_ratio': round(sharpe, 2),
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


def run_strategy2_multi_period():
    """Run Strategy 2 across multiple periods"""
    
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
        print(f"PERIOD: {period_name}")
        print(f"{'#'*60}")
        
        bt = Strategy2FastBacktest(start, end, initial_capital=600, sentiment_mode='realistic')
        bt.fetch_data()
        bt.run_backtest()
        report = bt.generate_report()
        
        results[period_name] = report
        
        output_dir = Path('/tmp/AlphaTrades/backtest_data')
        output_dir.mkdir(parents=True, exist_ok=True)
        
        if report.get('trades'):
            trades_df = pd.DataFrame(report['trades'])
            trades_df.to_csv(output_dir / f'strategy2_trades_{period_name}.csv', index=False)
        
        if bt.daily_equity:
            equity_df = pd.DataFrame(bt.daily_equity)
            equity_df.to_csv(output_dir / f'strategy2_equity_{period_name}.csv', index=False)
    
    return results


if __name__ == '__main__':
    print("="*60)
    print("STRATEGY 2 FAST BACKTEST")
    print("Using simulated sentiment (historical data not available)")
    print("="*60)
    
    results = run_strategy2_multi_period()
    
    output_path = Path('/tmp/AlphaTrades/backtest_data/strategy2_summary.json')
    with open(output_path, 'w') as f:
        json.dump(results, f, indent=2, default=str)
    
    print(f"\n{'='*60}")
    print("COMPLETE")
    print(f"Summary: {output_path}")
    print(f"{'='*60}\n")

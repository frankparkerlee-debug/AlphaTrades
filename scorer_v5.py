"""
V5 Scoring System - 100 Point Momentum Confirmation Strategy
Based on proven AMD backtest (706 trades, 86.8% win rate)

Scoring Components:
- Catalyst (0-30): News/earnings
- Volume (0-20): Surge vs average
- Direction (0-20): Directional dominance  
- Range (0-15): Intraday range %
- Timing (0-10): Entry window quality
- Calendar (0-5): FOMC/event penalties
- Alignment (0-5): Market trend alignment
- RSI (0-10): Momentum confirmation
"""

from datetime import datetime, time as dt_time
import requests
import os

class V5Scorer:
    def __init__(self, alpaca_api_key=None, alpaca_secret_key=None):
        self.alpaca_api_key = alpaca_api_key or os.getenv('ALPACA_API_KEY')
        self.alpaca_secret_key = alpaca_secret_key or os.getenv('ALPACA_SECRET_KEY')
        self.data_url = 'https://data.alpaca.markets'
        
    def score_ticker(self, ticker, quote_data, market_data=None):
        """
        Calculate V5 score for a ticker
        
        Args:
            ticker: Stock symbol
            quote_data: Dict with {open, high, low, current, volume}
            market_data: Dict with SPY trend info (optional)
            
        Returns:
            Dict with score, grade, breakdown, trade_setup
        """
        open_price = quote_data.get('open', 0)
        high = quote_data.get('high', 0)
        low = quote_data.get('low', 0)
        current = quote_data.get('current', 0)
        volume = quote_data.get('volume', 0)
        avg_volume = quote_data.get('avg_volume', volume)  # 20-day average
        
        if not all([open_price, high, low, current]):
            return self._empty_score()
        
        # Calculate metrics
        intraday_range = ((high - low) / open_price * 100) if open_price > 0 else 0
        volume_ratio = (volume / avg_volume) if avg_volume > 0 else 1.0
        move_from_open = abs((current - open_price) / open_price * 100) if open_price > 0 else 0
        range_remaining = intraday_range - move_from_open
        
        is_bullish = current > open_price
        direction = 'CALL' if is_bullish else 'PUT'
        
        # 1. CATALYST SCORE (0-30 points)
        catalyst_score, catalyst_type = self._score_catalyst(ticker, quote_data)
        
        # 2. VOLUME SCORE (0-20 points)
        volume_score = self._score_volume(volume_ratio)
        
        # 3. DIRECTION SCORE (0-20 points) 
        direction_score = self._score_direction(open_price, high, low, current, is_bullish)
        
        # 4. RANGE SCORE (0-15 points)
        range_score = self._score_range(intraday_range)
        
        # 5. TIMING SCORE (0-10 points)
        timing_score = self._score_timing()
        
        # 6. CALENDAR SCORE (0-5 points)
        calendar_score, calendar_status = self._score_calendar()
        
        # 7. ALIGNMENT SCORE (0-5 points)
        alignment_score = self._score_alignment(is_bullish, market_data)
        
        # 8. RSI SCORE (0-10 points)
        rsi_score, rsi_value = self._score_rsi(quote_data)
        
        # STALE MOVE PENALTY
        stale_penalty = self._calculate_stale_penalty(move_from_open, range_remaining)
        
        # TOTAL SCORE
        total_before_penalty = (catalyst_score + volume_score + direction_score + 
                                range_score + timing_score + calendar_score + 
                                alignment_score + rsi_score)
        total_score = max(0, total_before_penalty - stale_penalty)
        
        # GRADE
        grade, decision = self._calculate_grade(total_score)
        
        # TRADE SETUP
        trade_setup = self._calculate_trade_setup(ticker, current, is_bullish, direction, intraday_range)
        
        # BREAKDOWN
        breakdown = {
            'catalyst': {'score': catalyst_score, 'type': catalyst_type},
            'volume': {'score': volume_score, 'ratio': volume_ratio},
            'direction': {'score': direction_score},
            'range': {'score': range_score, 'value': intraday_range},
            'timing': {'score': timing_score},
            'calendar': {'score': calendar_score, 'status': calendar_status},
            'alignment': {'score': alignment_score},
            'rsi': {'score': rsi_score, 'value': rsi_value},
            'stale_penalty': stale_penalty,
            'move_from_open': move_from_open,
            'range_remaining': range_remaining,
            'total_before_penalty': total_before_penalty
        }
        
        return {
            'ticker': ticker,
            'score': round(total_score),
            'grade': grade,
            'decision': decision,
            'direction': direction,
            'trade_setup': trade_setup,
            'breakdown': breakdown,
            'current_price': current,
            'intraday_range': round(intraday_range, 2)
        }
    
    def _score_catalyst(self, ticker, quote_data):
        """Score based on news/earnings catalysts (0-30 points)"""
        # TODO: Integrate with Finnhub or Alpaca news API
        # For now, use volume surge as proxy
        volume_ratio = quote_data.get('volume', 1) / quote_data.get('avg_volume', 1)
        
        if volume_ratio >= 3.0:
            return 30, 'High Volume (Potential News)'
        elif volume_ratio >= 2.0:
            return 20, 'Elevated Volume'
        elif volume_ratio >= 1.5:
            return 10, 'Above Average Volume'
        return 0, 'Normal Volume'
    
    def _score_volume(self, volume_ratio):
        """Score based on volume surge (0-20 points)"""
        # Formula: min(20, (volume_ratio - 1) * 40)
        if volume_ratio >= 1.5:
            return 20  # Maxed out
        elif volume_ratio >= 1.25:
            return 15
        elif volume_ratio >= 1.1:
            return 10
        elif volume_ratio >= 1.0:
            return 5
        return 0
    
    def _score_direction(self, open_price, high, low, current, is_bullish):
        """Score based on directional dominance (0-20 points)"""
        total_range = high - low
        if total_range == 0:
            return 0
        
        if is_bullish:
            up_range = high - open_price
        else:
            up_range = open_price - low
        
        direction_pct = (up_range / total_range * 100) if total_range > 0 else 0
        
        if direction_pct >= 80:
            return 20
        elif direction_pct >= 70:
            return 15
        elif direction_pct >= 60:
            return 10
        elif direction_pct >= 50:
            return 5
        return 0
    
    def _score_range(self, intraday_range):
        """Score based on intraday range % (0-15 points)"""
        # Formula: min(15, (range% - 0.5) * 7.5)
        if intraday_range >= 2.5:
            return 15  # Maxed out
        elif intraday_range >= 2.0:
            return 12
        elif intraday_range >= 1.5:
            return 8
        elif intraday_range >= 1.0:
            return 4
        return 0
    
    def _score_timing(self):
        """Score based on time of day (0-10 points)"""
        now_et = datetime.now()  # Assuming ET timezone
        hour = now_et.hour + now_et.minute / 60
        
        # Best windows
        if 10.0 <= hour < 10.5:  # 10:00-10:30 AM
            return 10
        elif 10.5 <= hour < 14.0:  # 10:30 AM - 2:00 PM
            return 8
        elif 14.0 <= hour < 15.0:  # 2:00-3:00 PM
            return 4
        return 0  # Outside market hours or early morning
    
    def _score_calendar(self):
        """Score based on economic calendar (0-5 points)"""
        # TODO: Integrate with economic calendar API
        # For now, assume normal trading day
        return 5, 'Normal Day'
    
    def _score_alignment(self, is_bullish, market_data):
        """Score based on SPY alignment (0-5 points)"""
        if not market_data or 'spy_direction' not in market_data:
            return 0
        
        spy_up = market_data.get('spy_direction') == 'UP'
        aligned = (is_bullish and spy_up) or (not is_bullish and not spy_up)
        return 5 if aligned else 0
    
    def _score_rsi(self, quote_data):
        """Score based on RSI momentum (0-10 points)"""
        rsi = quote_data.get('rsi')
        if not rsi:
            return 0, 'N/A'
        
        if 60 <= rsi <= 75:
            return 10, round(rsi, 1)  # Strong momentum, not overbought
        elif 55 <= rsi < 60:
            return 8, round(rsi, 1)
        elif rsi > 75:
            return 5, round(rsi, 1)  # Overbought risk
        elif rsi >= 50:
            return 5, round(rsi, 1)
        elif rsi >= 40:
            return 3, round(rsi, 1)
        return 0, round(rsi, 1)
    
    def _calculate_stale_penalty(self, move_from_open, range_remaining):
        """Penalize late entries into moves"""
        if move_from_open < 1.0:
            return 0  # Move hasn't really started yet
        
        if range_remaining < 0.3:
            return 20  # Very late
        elif range_remaining < 0.5:
            return 10  # Late
        elif range_remaining < 0.75:
            return 5  # Slightly late
        return 0
    
    def _calculate_grade(self, total_score):
        """Convert score to grade and decision"""
        if total_score >= 90:
            return 'A+', 'TAKE - Full Size'
        elif total_score >= 85:
            return 'A', 'TAKE - Full Size'
        elif total_score >= 80:
            return 'A-', 'TAKE - Full Size'
        elif total_score >= 75:
            return 'B+', 'TAKE - Full Size'
        elif total_score >= 70:
            return 'B', 'CONSIDER - Half Size'
        elif total_score >= 65:
            return 'B-', 'CONSIDER - Half Size'
        elif total_score >= 60:
            return 'C+', 'SKIP - Too Weak'
        elif total_score >= 55:
            return 'C', 'SKIP - Too Weak'
        else:
            return 'D', 'SKIP - Too Weak'
    
    def _calculate_trade_setup(self, ticker, current, is_bullish, direction, intraday_range):
        """Calculate trade setup details"""
        # Target and stop prices
        if is_bullish:
            target_price = current * 1.015  # +1.5% target
            stop_price = current * 0.995  # -0.5% stop
        else:
            target_price = current * 0.985  # -1.5% target
            stop_price = current * 1.005  # +0.5% stop
        
        # ATM strike calculation
        if current >= 500:
            strike_interval = 10
        elif current >= 200:
            strike_interval = 5
        elif current >= 100:
            strike_interval = 2.5
        elif current >= 50:
            strike_interval = 1
        else:
            strike_interval = 0.5
        
        atm_strike = round(current / strike_interval) * strike_interval
        
        # OTM strike
        otm_strike = atm_strike + strike_interval if is_bullish else atm_strike - strike_interval
        
        # Estimated premiums (rough approximation)
        vol_factor = 0.025
        atm_intrinsic = max(0, current - atm_strike if is_bullish else atm_strike - current)
        atm_extrinsic = current * vol_factor
        atm_premium = atm_intrinsic + atm_extrinsic
        
        otm_intrinsic = max(0, current - otm_strike if is_bullish else otm_strike - current)
        otm_extrinsic = current * vol_factor * 0.7
        otm_premium = otm_intrinsic + otm_extrinsic
        
        return {
            'direction': direction,
            'entry_price': round(current, 2),
            'target_price': round(target_price, 2),
            'stop_price': round(stop_price, 2),
            'atm_strike': atm_strike,
            'otm_strike': otm_strike,
            'atm_premium_est': round(atm_premium, 2),
            'otm_premium_est': round(otm_premium, 2),
            'target_pct': 1.5 if is_bullish else -1.5,
            'stop_pct': -0.5 if is_bullish else 0.5
        }
    
    def _empty_score(self):
        """Return empty score structure"""
        return {
            'score': 0,
            'grade': 'F',
            'decision': 'NO DATA',
            'direction': 'N/A',
            'trade_setup': {},
            'breakdown': {},
            'current_price': 0,
            'intraday_range': 0
        }

# Singleton instance
_v5_scorer = None

def get_v5_scorer():
    """Get or create V5 scorer instance"""
    global _v5_scorer
    if _v5_scorer is None:
        _v5_scorer = V5Scorer()
    return _v5_scorer

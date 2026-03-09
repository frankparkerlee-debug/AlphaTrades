"""
Momentum-Focused Scoring System - Price Action as Primary Catalyst
Fixes V5 issues: Makes momentum the signal, volume the confirmation

Scoring Components (100 points):
- MOMENTUM CATALYST (0-35): Price movement is THE signal
- VOLUME CONFIRMATION (0-15): Validates the move (not the catalyst)
- MARKET ALIGNMENT (0-15): SPY correlation + relative strength
- TIMING (0-10): Entry window quality
- TECHNICAL (0-10): RSI momentum confirmation
- CALENDAR (0-5): FOMC/event penalties
- LIQUIDITY (0-10): Options quality check
"""

from datetime import datetime, time as dt_time
import os

class MomentumScorer:
    def __init__(self):
        pass
        
    def score_ticker(self, ticker, quote_data, market_data=None):
        """
        Calculate momentum-focused score
        
        Args:
            ticker: Stock symbol
            quote_data: Dict with {open, high, low, current, volume, avg_volume}
            market_data: Dict with SPY trend info
            
        Returns:
            Dict with score, grade, breakdown, trade_setup
        """
        open_price = quote_data.get('open', 0)
        high = quote_data.get('high', 0)
        low = quote_data.get('low', 0)
        current = quote_data.get('current', 0)
        volume = quote_data.get('volume', 0)
        avg_volume = quote_data.get('avg_volume', volume)
        
        if not all([open_price, high, low, current]):
            return self._empty_score()
        
        # Calculate metrics
        intraday_range = ((high - low) / open_price * 100) if open_price > 0 else 0
        volume_ratio = (volume / avg_volume) if avg_volume > 0 else 1.0
        move_from_open = abs((current - open_price) / open_price * 100) if open_price > 0 else 0
        
        is_bullish = current > open_price
        direction = 'CALL' if is_bullish else 'PUT'
        
        # 1. MOMENTUM CATALYST (0-35 points) - PRIMARY SIGNAL
        momentum_score, momentum_reason = self._score_momentum_catalyst(
            intraday_range, open_price, high, low, current, is_bullish
        )
        
        # 2. VOLUME CONFIRMATION (0-15 points) - VALIDATES MOMENTUM
        volume_score, volume_reason = self._score_volume_confirmation(volume_ratio)
        
        # 3. MARKET ALIGNMENT (0-15 points) - SPY CORRELATION
        alignment_score, alignment_reason = self._score_market_alignment(
            is_bullish, current, open_price, market_data
        )
        
        # 4. TIMING (0-10 points)
        timing_score = self._score_timing()
        
        # 5. TECHNICAL (0-10 points) - RSI/MACD
        technical_score = self._score_technical(quote_data)
        
        # 6. CALENDAR (0-5 points)
        calendar_score, calendar_status = self._score_calendar()
        
        # 7. LIQUIDITY (0-10 points) - OPTIONS QUALITY
        liquidity_score = self._score_liquidity(volume, intraday_range)
        
        # TOTAL SCORE
        total_score = (momentum_score + volume_score + alignment_score + 
                      timing_score + technical_score + calendar_score + liquidity_score)
        
        # GRADE
        grade, decision = self._calculate_grade(total_score)
        
        # TRADE SETUP
        trade_setup = {
            'direction': direction,
            'entry_price': current,
            'stop_loss': current * 0.97 if is_bullish else current * 1.03,
            'target': current * 1.03 if is_bullish else current * 0.97,
            'dte_preference': 1,
            'risk_reward': 1.5
        }
        
        # BREAKDOWN
        breakdown = {
            'momentum': {'score': momentum_score, 'reason': momentum_reason, 'range_pct': round(intraday_range, 2)},
            'volume': {'score': volume_score, 'reason': volume_reason, 'ratio': round(volume_ratio, 2)},
            'alignment': {'score': alignment_score, 'reason': alignment_reason},
            'timing': {'score': timing_score},
            'technical': {'score': technical_score},
            'calendar': {'score': calendar_score, 'status': calendar_status},
            'liquidity': {'score': liquidity_score}
        }
        
        return {
            'ticker': ticker,
            'score': total_score,
            'grade': grade,
            'decision': decision,
            'direction': direction,
            'breakdown': breakdown,
            'trade_setup': trade_setup,
            'intraday_range': round(intraday_range, 2),
            'current_price': current
        }
    
    def _score_momentum_catalyst(self, intraday_range, open_price, high, low, current, is_bullish):
        """
        MOMENTUM = PRIMARY CATALYST (0-35 points)
        Large price moves with strong direction = high score
        """
        # Range component (0-25 points) - bigger moves = better
        if intraday_range >= 4.0:
            range_score = 25
            range_reason = f"Explosive {intraday_range:.1f}% range"
        elif intraday_range >= 3.0:
            range_score = 20
            range_reason = f"Strong {intraday_range:.1f}% range"
        elif intraday_range >= 2.0:
            range_score = 15
            range_reason = f"Good {intraday_range:.1f}% range"
        elif intraday_range >= 1.5:
            range_score = 10
            range_reason = f"Moderate {intraday_range:.1f}% range"
        elif intraday_range >= 1.0:
            range_score = 5
            range_reason = f"Minimal {intraday_range:.1f}% range"
        else:
            range_score = 0
            range_reason = f"Too small {intraday_range:.1f}% range"
        
        # Direction component (0-10 points) - one-sided moves = better
        total_range = high - low
        if total_range > 0:
            if is_bullish:
                up_range = high - open_price
            else:
                up_range = open_price - low
            direction_pct = (up_range / total_range * 100)
            
            if direction_pct >= 85:
                direction_score = 10
            elif direction_pct >= 75:
                direction_score = 8
            elif direction_pct >= 65:
                direction_score = 6
            elif direction_pct >= 55:
                direction_score = 4
            else:
                direction_score = 2
        else:
            direction_score = 0
        
        total = range_score + direction_score
        return total, range_reason
    
    def _score_volume_confirmation(self, volume_ratio):
        """
        VOLUME = CONFIRMATION (0-15 points)
        Above average volume validates momentum, but isn't the signal itself
        """
        if volume_ratio >= 2.5:
            return 15, f"Strong confirmation ({volume_ratio:.1f}x avg)"
        elif volume_ratio >= 2.0:
            return 12, f"Good confirmation ({volume_ratio:.1f}x avg)"
        elif volume_ratio >= 1.5:
            return 9, f"Moderate confirmation ({volume_ratio:.1f}x avg)"
        elif volume_ratio >= 1.2:
            return 6, f"Slight confirmation ({volume_ratio:.1f}x avg)"
        elif volume_ratio >= 1.0:
            return 3, f"Normal volume ({volume_ratio:.1f}x avg)"
        else:
            return 0, f"Low volume ({volume_ratio:.1f}x avg)"
    
    def _score_market_alignment(self, is_bullish, current, open_price, market_data):
        """
        MARKET ALIGNMENT (0-15 points)
        SPY correlation + relative strength
        """
        if not market_data:
            return 0, "No market data"
        
        # SPY direction match (0-10 points)
        spy_up = market_data.get('is_up', True)
        aligned = (is_bullish and spy_up) or (not is_bullish and not spy_up)
        
        if aligned:
            direction_score = 10
            direction_reason = "With market trend"
        else:
            direction_score = 0
            direction_reason = "Against market trend"
        
        # Relative strength (0-5 points)
        stock_change = abs((current - open_price) / open_price * 100) if open_price > 0 else 0
        spy_change = abs(market_data.get('change_pct', 0))
        
        if stock_change > spy_change * 2:
            strength_score = 5
            strength_reason = "Strong outperformance"
        elif stock_change > spy_change * 1.5:
            strength_score = 3
            strength_reason = "Outperforming"
        else:
            strength_score = 0
            strength_reason = "In-line with market"
        
        total = direction_score + strength_score
        reason = f"{direction_reason}, {strength_reason}"
        return total, reason
    
    def _score_timing(self):
        """Score based on time of day (0-10 points)"""
        now_et = datetime.now()
        hour = now_et.hour + now_et.minute / 60
        
        if 10.0 <= hour < 10.5:
            return 10
        elif 10.5 <= hour < 14.0:
            return 8
        elif 14.0 <= hour < 15.0:
            return 5
        return 0
    
    def _score_technical(self, quote_data):
        """Score based on RSI/technical momentum (0-10 points)"""
        # Simplified - in real implementation would calculate RSI
        return 5  # Neutral for now
    
    def _score_calendar(self):
        """Score based on economic calendar (0-5 points)"""
        return 5, 'Normal Day'
    
    def _score_liquidity(self, volume, intraday_range):
        """
        Score based on options liquidity potential (0-10 points)
        High volume + volatility = good options liquidity
        """
        if volume > 1000000 and intraday_range > 2.0:
            return 10
        elif volume > 500000 and intraday_range > 1.5:
            return 7
        elif volume > 100000:
            return 4
        else:
            return 2
    
    def _calculate_grade(self, score):
        """Calculate letter grade and decision"""
        if score >= 80:
            return 'A+', 'STRONG BUY'
        elif score >= 75:
            return 'A', 'BUY'
        elif score >= 70:
            return 'A-', 'BUY'
        elif score >= 65:
            return 'B+', 'CONSIDER'
        elif score >= 60:
            return 'B', 'CONSIDER'
        elif score >= 55:
            return 'B-', 'WEAK'
        elif score >= 50:
            return 'C+', 'SKIP - Weak'
        elif score >= 45:
            return 'C', 'SKIP - Too Weak'
        else:
            return 'D', 'SKIP - Too Weak'
    
    def _empty_score(self):
        """Return empty score for invalid data"""
        return {
            'score': 0,
            'grade': 'F',
            'decision': 'SKIP - No Data',
            'breakdown': {}
        }

def get_momentum_scorer():
    """Factory function"""
    return MomentumScorer()

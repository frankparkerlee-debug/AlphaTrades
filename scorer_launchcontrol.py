"""
Launch Control Momentum Scoring Engine v2.0
Complete strategy specification validated through 6 synthetic backtest iterations

Scoring Components (100 pts total):
- Price Action: 35 pts (ATR-normalized, tiers: 0.7x/1.1x/1.7x)
- Volume: 30 pts (relative volume tiers: 1.2x/1.5x/2.0x/3.0x)
- News/Sentiment: 15 pts (-8 to +15 range)
- Market Alignment: 15 pts (-5 to +15 range)
- Timing: 5 pts (gate function only)
- Post-announcement bonus: +10 pts

CRITICAL: Asymmetry Gate - PA > 17.5 AND Vol > 15 required for primary signals
"""

from datetime import datetime, time as dt_time, timedelta
from typing import Dict, Optional, List, Tuple
import os


class LaunchControlScorer:
    """
    Launch Control v2.0 scoring engine implementing exact formulas from spec
    """
    
    # Updated grade thresholds (v2.0)
    GRADE_THRESHOLDS = {
        'A+': 83,
        'A': 73,
        'A-': 63,
        'B+': 53,
        'B': 43,
        'B-': 33,
        'C': 0
    }
    
    # Position sizing by grade (% of account)
    POSITION_SIZES = {
        'A+': 0.20,
        'A': 0.15,
        'A-': 0.10,
        'B+': 0.075,
        'B': 0.05,
        'B-': 0.0,  # Never traded
        'C': 0.0    # Rejected
    }
    
    # Circuit breaker limits
    DAILY_LOSS_LIMIT = -0.04  # -4%
    CONSECUTIVE_LOSS_THRESHOLD = 3
    VIX_SPIKE_THRESHOLD = 35
    
    def __init__(self, alpaca_api_key=None, alpaca_secret_key=None):
        self.alpaca_api_key = alpaca_api_key or os.getenv('ALPACA_API_KEY')
        self.alpaca_secret_key = alpaca_secret_key or os.getenv('ALPACA_SECRET_KEY')
        self.data_url = 'https://data.alpaca.markets'
        
    def score_ticker(self, ticker: str, bar_data: Dict, equity_profile: Dict, 
                    market_data: Optional[Dict] = None, news_data: Optional[Dict] = None) -> Dict:
        """
        Calculate Launch Control v2.0 score for a ticker
        
        Args:
            ticker: Stock symbol
            bar_data: Current bar data {open, high, low, close, volume, timestamp}
            equity_profile: Ticker profile {atr, vol_baseline, beta, sector_correlation, persistence}
            market_data: Market data {qqq_direction, qqq_change, sector_direction, sector_change, vix}
            news_data: News data {polarity, recency_minutes, news_sensitivity, social_amplification}
            
        Returns:
            Dict with score, grade, breakdown, filters, trade_setup, position_size
        """
        # Extract bar data
        open_price = bar_data.get('open', 0)
        high = bar_data.get('high', 0)
        low = bar_data.get('low', 0)
        close = bar_data.get('close', 0)
        volume = bar_data.get('volume', 0)
        timestamp = bar_data.get('timestamp', datetime.now())
        
        if not all([open_price, high, low, close, volume]):
            return self._empty_score(ticker)
        
        # Extract equity profile
        atr = equity_profile.get('atr', 0)
        vol_baseline = equity_profile.get('vol_baseline', volume)
        beta = equity_profile.get('beta', 1.0)
        sector_corr = equity_profile.get('sector_correlation', 0.5)
        persistence = equity_profile.get('persistence', 0.7)
        
        if atr == 0:
            return self._empty_score(ticker)
        
        # Determine direction
        is_bullish = close > open_price
        direction = 'CALL' if is_bullish else 'PUT'
        
        # Calculate metrics
        price_change = abs(close - open_price)
        atr_multiple = price_change / atr if atr > 0 else 0
        rel_volume = volume / vol_baseline if vol_baseline > 0 else 1.0
        intraday_range = high - low
        body_ratio = price_change / intraday_range if intraday_range > 0 else 0
        
        # 1. TIMING SCORE (0-5 pts) + Gate Caps
        timing_score, timing_cap, timing_window = self._score_timing(timestamp, market_data)
        
        # 2. PRICE ACTION SCORE (0-35 pts)
        pa_score, pa_breakdown = self._score_price_action(
            atr_multiple, close, open_price, high, low, 
            body_ratio, is_bullish, persistence
        )
        
        # 3. VOLUME SCORE (0-30 pts)
        vol_score, vol_breakdown = self._score_volume(
            rel_volume, volume, is_bullish, open_price, high, low, 
            sector_corr, timestamp
        )
        
        # 4. NEWS/SENTIMENT SCORE (-8 to +15 pts)
        news_score, news_breakdown = self._score_news_sentiment(
            news_data, is_bullish, equity_profile.get('news_sensitivity', 1.0)
        )
        
        # 5. MARKET ALIGNMENT SCORE (-5 to +15 pts)
        market_score, market_breakdown = self._score_market_alignment(
            market_data, is_bullish, beta, sector_corr
        )
        
        # POST-ANNOUNCEMENT BONUS (+10 pts)
        announcement_bonus = self._check_announcement_bonus(timestamp)
        
        # COMPOSITE SCORE (before caps) - floor at 0
        raw_score = max(0, timing_score + pa_score + vol_score + news_score + market_score + announcement_bonus)
        
        # APPLY ASYMMETRY GATE (CRITICAL!)
        asymmetry_gate_passed = pa_score > 17.5 and vol_score > 15.0
        
        # PRIMARY FILTER (4/5 pillars above midpoints)
        primary_filter_passed = self._check_primary_filter(
            timing_score, pa_score, vol_score, news_score, market_score
        )
        
        # BASE LAYER FILTER (relaxed thresholds)
        base_layer_eligible = self._check_base_layer_filter(
            timing_score, pa_score, vol_score, news_score, market_score
        )
        
        # CONFLICT FLAGS
        conflict_flags = self._detect_conflicts(
            news_breakdown, market_breakdown, timing_window, market_data
        )
        
        # GRADE CALCULATION
        grade, grade_reason = self._calculate_grade(
            raw_score, asymmetry_gate_passed, primary_filter_passed,
            base_layer_eligible, timing_cap, conflict_flags
        )
        
        # POSITION SIZING
        position_size_pct = self.POSITION_SIZES.get(grade, 0.0)
        
        # TRADE SETUP
        trade_setup = self._calculate_trade_setup(
            ticker, close, is_bullish, direction, grade, intraday_range, atr
        )
        
        # EXIT STRATEGY
        exit_strategy = self._get_exit_strategy(grade)
        
        # BREAKDOWN
        breakdown = {
            'timing': {'score': timing_score, 'window': timing_window, 'cap': timing_cap},
            'price_action': {'score': pa_score, 'details': pa_breakdown},
            'volume': {'score': vol_score, 'details': vol_breakdown},
            'news_sentiment': {'score': news_score, 'details': news_breakdown},
            'market_alignment': {'score': market_score, 'details': market_breakdown},
            'announcement_bonus': announcement_bonus,
            'raw_score': round(raw_score, 2)
        }
        
        # FILTERS
        filters = {
            'asymmetry_gate': asymmetry_gate_passed,
            'primary_filter': primary_filter_passed,
            'base_layer_eligible': base_layer_eligible,
            'conflict_flags': conflict_flags
        }
        
        return {
            'ticker': ticker,
            'timestamp': timestamp.isoformat() if isinstance(timestamp, datetime) else str(timestamp),
            'score': round(raw_score, 2),
            'grade': grade,
            'grade_reason': grade_reason,
            'direction': direction,
            'position_size_pct': position_size_pct,
            'trade_setup': trade_setup,
            'exit_strategy': exit_strategy,
            'breakdown': breakdown,
            'filters': filters,
            'current_price': close,
            'atr_multiple': round(atr_multiple, 2),
            'rel_volume': round(rel_volume, 2)
        }
    
    def _score_timing(self, timestamp: datetime, market_data: Optional[Dict]) -> Tuple[int, str, str]:
        """
        Score timing (0-5 pts) + determine grade caps
        
        Returns: (score, cap, window_name)
        """
        hour = timestamp.hour
        minute = timestamp.minute
        bar_minute = (hour - 9) * 60 + (minute - 30)  # Minutes since 9:30 AM
        
        # Check VIX spike
        vix = market_data.get('vix', 0) if market_data else 0
        if vix > self.VIX_SPIKE_THRESHOLD:
            return 0, 'B-', 'VIX_SPIKE'
        
        # Opening chop (first 14-28 minutes, ticker-specific)
        # For simplicity, using 20 minutes as default
        chop_window_end = 20
        if bar_minute < chop_window_end:
            return 0, 'B-', 'OPENING_CHOP'
        
        # Lunch window (11:30 AM - 1:00 PM = 120-210 minutes)
        if 120 <= bar_minute < 210:
            return 2, 'B-', 'LUNCH_WINDOW'
        
        # Late session (after 3:00 PM = 390+ minutes)
        if bar_minute >= 390:
            return 0, 'B-', 'LATE_SESSION'
        
        # Post-announcement prime window (checked separately for bonus)
        # Standard prime window (10:00 AM - 3:00 PM)
        return 5, None, 'PRIME'
    
    def _score_price_action(self, atr_multiple: float, close: float, open_price: float,
                           high: float, low: float, body_ratio: float, 
                           is_bullish: bool, persistence: float) -> Tuple[float, Dict]:
        """
        Score price action (0-35 pts)
        ATR-normalized with tightened tiers: 0.7x/1.1x/1.7x
        """
        # ATR TIERS (v2 - tightened)
        if atr_multiple >= 1.7:
            base = 35
        elif atr_multiple >= 1.1:
            base = 24
        elif atr_multiple >= 0.7:
            base = 12
        else:
            base = 0
        
        # LEVEL MULTIPLIER
        # TODO: Implement level detection (VWAP, prev day high/low, OR)
        # For now, use simplified logic
        level_mult = 1.0  # clean=1.0, extend=0.85, chase=0.60, none=0.70
        
        # CANDLE MULTIPLIER
        if body_ratio >= 0.75:
            candle_mult = 1.1
        elif body_ratio >= 0.50:
            candle_mult = 1.0
        elif body_ratio >= 0.30:
            candle_mult = 0.85
        else:
            candle_mult = 0.65
        
        # VWAP BONUS
        # TODO: Get actual VWAP from market data
        vwap_bonus = 0  # aligned=+2, opposing=-2
        
        # PERSISTENCE ADJUSTMENT
        persist_adj = (persistence - 0.70) * 10
        
        # FINAL SCORE
        pa_score = (base * level_mult * candle_mult) + vwap_bonus + persist_adj
        pa_score = max(0, min(35, pa_score))
        
        breakdown = {
            'atr_multiple': round(atr_multiple, 2),
            'base': base,
            'level_mult': level_mult,
            'candle_mult': round(candle_mult, 2),
            'body_ratio': round(body_ratio, 2),
            'vwap_bonus': vwap_bonus,
            'persistence_adj': round(persist_adj, 2),
            'final': round(pa_score, 2)
        }
        
        return pa_score, breakdown
    
    def _score_volume(self, rel_volume: float, volume: int, is_bullish: bool,
                     open_price: float, high: float, low: float,
                     vol_corr: float, timestamp: datetime) -> Tuple[float, Dict]:
        """
        Score volume (0-30 pts)
        Relative volume tiers: 1.2x/1.5x/2.0x/3.0x
        """
        # RELATIVE VOLUME TIERS (updated for 30pt max)
        if rel_volume >= 3.0:
            base = 30
        elif rel_volume >= 2.0:
            base = 22
        elif rel_volume >= 1.5:
            base = 14
        elif rel_volume >= 1.2:
            base = 7
        else:
            base = 0
        
        # DIRECTIONAL ALIGNMENT MULTIPLIER
        # Determine if volume is confirming the move
        total_range = high - low
        if total_range > 0:
            if is_bullish:
                up_range = high - open_price
                direction_pct = (up_range / total_range)
            else:
                down_range = open_price - low
                direction_pct = (down_range / total_range)
            
            if direction_pct >= 0.8:
                dir_mult = 1.30  # strongly confirming
            elif direction_pct >= 0.7:
                dir_mult = 1.10  # confirming
            elif direction_pct >= 0.5:
                dir_mult = 0.90  # neutral
            elif direction_pct >= 0.3:
                dir_mult = 0.50  # opposing
            else:
                dir_mult = 0.20  # strongly opposing
        else:
            dir_mult = 0.90  # neutral
        
        # VOLUME CORRELATION MULTIPLIER
        if vol_corr > 0.75:
            corr_mult = 1.20
        elif vol_corr > 0.50:
            corr_mult = 1.00
        else:
            corr_mult = 0.75
        
        # TIME ADJUSTMENT
        hour = timestamp.hour
        minute = timestamp.minute
        bar_minute = (hour - 9) * 60 + (minute - 30)
        
        if bar_minute < 30:  # Before 10:00 AM
            time_adj = 0.60
        elif 30 <= bar_minute < 120:  # 10:00-11:30 AM
            time_adj = 1.10
        elif 120 <= bar_minute < 210:  # Lunch
            time_adj = 1.20
        elif 210 <= bar_minute < 360:  # Afternoon
            time_adj = 1.00
        else:  # Close
            time_adj = 0.70
        
        # FINAL SCORE
        vol_score = base * dir_mult * corr_mult * time_adj
        vol_score = max(0, min(30, vol_score))
        
        breakdown = {
            'rel_volume': round(rel_volume, 2),
            'base': base,
            'dir_mult': round(dir_mult, 2),
            'corr_mult': corr_mult,
            'time_adj': time_adj,
            'final': round(vol_score, 2)
        }
        
        return vol_score, breakdown
    
    def _score_news_sentiment(self, news_data: Optional[Dict], is_bullish: bool,
                             news_sensitivity: float) -> Tuple[float, Dict]:
        """
        Score news/sentiment (-8 to +15 pts)
        Reduced from v1 (was 20 pts max)
        """
        if not news_data:
            # No news = slight positive (no headwind)
            return 4, {'polarity': 0, 'base': 4, 'reason': 'No news'}
        
        polarity = news_data.get('polarity', 0)  # -2 to +2
        recency_minutes = news_data.get('recency_minutes', 1440)  # Minutes since news
        
        # Determine directional polarity
        if is_bullish:
            dir_polarity = polarity  # Bullish wants positive news
        else:
            dir_polarity = -polarity  # Bearish wants negative news
        
        # POLARITY → BASE SCORE (updated for 15pt max)
        if dir_polarity >= 2:
            base = 15  # strongly confirms
        elif dir_polarity >= 1:
            base = 9
        elif dir_polarity >= 0:
            base = 4  # neutral or no news
        elif dir_polarity >= -1:
            base = 0  # NEWS_HEADWIND flag
            flag = 'NEWS_HEADWIND'
        else:  # dir_polarity <= -2
            base = -8  # NEWS_CONFLICT_CRITICAL
            flag = 'NEWS_CONFLICT_CRITICAL'
        
        # RECENCY DECAY
        if recency_minutes <= 60:
            decay = 1.0
        elif recency_minutes <= 240:
            decay = 0.85
        elif recency_minutes <= 1440:
            decay = 0.60
        else:
            decay = 0.30
        
        # NEWS SENSITIVITY MULTIPLIER
        news_sens_mult = news_sensitivity
        
        # SOCIAL AMPLIFICATION (if available)
        social_amp = news_data.get('social_amplification', 1.0)
        
        # FADE ADJUSTMENT (if available)
        fade_adj = news_data.get('fade_adjustment', 1.0)
        
        # FINAL SCORE
        news_score = base * decay * news_sens_mult * social_amp * fade_adj
        news_score = max(-8, min(15, news_score))
        
        breakdown = {
            'polarity': polarity,
            'dir_polarity': dir_polarity,
            'base': base,
            'decay': decay,
            'news_sens_mult': round(news_sens_mult, 2),
            'social_amp': social_amp,
            'fade_adj': fade_adj,
            'final': round(news_score, 2),
            'flag': flag if dir_polarity < 0 else None
        }
        
        return news_score, breakdown
    
    def _score_market_alignment(self, market_data: Optional[Dict], is_bullish: bool,
                               beta: float, sector_corr: float) -> Tuple[float, Dict]:
        """
        Score market alignment (-5 to +15 pts)
        QQQ + sector ETF direction, beta-weighted
        """
        if not market_data:
            return 0, {'reason': 'No market data'}
        
        qqq_direction = market_data.get('qqq_direction', 'NEUTRAL')
        qqq_change = market_data.get('qqq_change', 0.0)
        sector_direction = market_data.get('sector_direction', 'NEUTRAL')
        sector_change = market_data.get('sector_change', 0.0)
        
        # QQQ alignment
        qqq_aligned = (is_bullish and qqq_direction == 'UP') or (not is_bullish and qqq_direction == 'DOWN')
        qqq_score = 8 if qqq_aligned else -3
        
        # Sector alignment
        sector_aligned = (is_bullish and sector_direction == 'UP') or (not is_bullish and sector_direction == 'DOWN')
        sector_score = 7 if sector_aligned else -2
        
        # Check for double conflict (both opposing)
        if not qqq_aligned and not sector_aligned:
            # MARKET_CONFLICT flag
            return -5, {
                'qqq_aligned': False,
                'sector_aligned': False,
                'final': -5,
                'flag': 'MARKET_CONFLICT'
            }
        
        # BETA WEIGHTING
        # Higher beta = more sensitive to market moves
        beta_adj = 0.8 + (beta - 1.0) * 0.2  # Range: 0.6 to 1.2 for beta 0.5 to 2.0
        beta_adj = max(0.6, min(1.2, beta_adj))
        
        # SECTOR CORRELATION WEIGHTING
        sector_weight = sector_corr
        qqq_weight = 1.0 - sector_corr
        
        # FINAL SCORE
        market_score = (qqq_score * qqq_weight + sector_score * sector_weight) * beta_adj
        market_score = max(-5, min(15, market_score))
        
        breakdown = {
            'qqq_direction': qqq_direction,
            'qqq_aligned': qqq_aligned,
            'qqq_score': qqq_score,
            'sector_direction': sector_direction,
            'sector_aligned': sector_aligned,
            'sector_score': sector_score,
            'beta_adj': round(beta_adj, 2),
            'sector_weight': round(sector_weight, 2),
            'qqq_weight': round(qqq_weight, 2),
            'final': round(market_score, 2)
        }
        
        return market_score, breakdown
    
    def _check_announcement_bonus(self, timestamp: datetime) -> int:
        """
        Check if within post-announcement window (15-90 min after FOMC/CPI/NFP)
        Returns +10 bonus if in window
        """
        # TODO: Implement announcement tracking
        # For now, return 0
        return 0
    
    def _check_primary_filter(self, timing: float, pa: float, vol: float, 
                             news: float, market: float) -> bool:
        """
        Primary filter: PA > 17.5 AND Vol > 15 AND 4/5 pillars above midpoints
        """
        # Hard gate: PA and Vol must pass midpoints
        if pa <= 17.5 or vol <= 15.0:
            return False
        
        # Midpoints
        midpoints = {
            'timing': 2.5,
            'pa': 17.5,
            'vol': 15.0,
            'news': 7.5,
            'market': 7.5
        }
        
        # Count pillars above midpoint
        above = sum([
            timing > midpoints['timing'],
            pa > midpoints['pa'],
            vol > midpoints['vol'],
            news > midpoints['news'],
            market > midpoints['market']
        ])
        
        return above >= 4
    
    def _check_base_layer_filter(self, timing: float, pa: float, vol: float,
                                news: float, market: float) -> bool:
        """
        Base layer filter: PA > 12 AND 3/5 pillars above relaxed midpoints
        Only fires when no primary signal exists
        """
        # PA must be present (relaxed threshold)
        if pa <= 12:
            return False
        
        # Relaxed midpoints
        relaxed_mids = {
            'timing': 2.5,
            'pa': 12,
            'vol': 10,
            'news': 5,
            'market': 5
        }
        
        # Count pillars above relaxed midpoints
        above = sum([
            timing > relaxed_mids['timing'],
            pa > relaxed_mids['pa'],
            vol > relaxed_mids['vol'],
            news > relaxed_mids['news'],
            market > relaxed_mids['market']
        ])
        
        return above >= 3
    
    def _detect_conflicts(self, news_breakdown: Dict, market_breakdown: Dict,
                         timing_window: str, market_data: Optional[Dict]) -> List[str]:
        """
        Detect conflict flags that cap grade at B-
        """
        flags = []
        
        # News conflicts
        if news_breakdown.get('flag') == 'NEWS_CONFLICT_CRITICAL':
            flags.append('NEWS_CONFLICT_CRITICAL')
        elif news_breakdown.get('flag') == 'NEWS_HEADWIND':
            flags.append('NEWS_HEADWIND')
        
        # Market conflicts
        if market_breakdown.get('flag') == 'MARKET_CONFLICT':
            flags.append('MARKET_CONFLICT')
        
        # Timing conflicts
        if timing_window in ['OPENING_CHOP', 'LUNCH_WINDOW', 'LATE_SESSION']:
            flags.append(timing_window)
        
        # VIX spike
        if market_data and market_data.get('vix', 0) > self.VIX_SPIKE_THRESHOLD:
            flags.append('VIX_SPIKE')
        
        return flags
    
    def _calculate_grade(self, raw_score: float, asymmetry_gate: bool, 
                        primary_filter: bool, base_layer: bool,
                        timing_cap: Optional[str], conflict_flags: List[str]) -> Tuple[str, str]:
        """
        Calculate final grade with all caps and filters applied
        """
        # Check asymmetry gate (CRITICAL!)
        if not asymmetry_gate:
            return 'C', 'Failed asymmetry gate (PA ≤ 17.5 OR Vol ≤ 15)'
        
        # Check primary filter
        if not primary_filter and not base_layer:
            return 'C', 'Failed primary filter and not base layer eligible'
        
        # Apply conflict caps (hard cap at B-)
        critical_conflicts = [f for f in conflict_flags if f in [
            'NEWS_CONFLICT_CRITICAL', 'MARKET_CONFLICT', 'OPENING_CHOP', 
            'LUNCH_WINDOW', 'LATE_SESSION', 'VIX_SPIKE'
        ]]
        if critical_conflicts:
            if raw_score >= self.GRADE_THRESHOLDS['B-']:
                return 'B-', f'Capped by conflicts: {", ".join(critical_conflicts)}'
            else:
                return 'C', f'Below B- with conflicts: {", ".join(critical_conflicts)}'
        
        # Apply timing cap
        if timing_cap:
            if raw_score >= self.GRADE_THRESHOLDS[timing_cap]:
                return timing_cap, f'Capped by timing: {timing_cap}'
        
        # Normal grade calculation
        if raw_score >= self.GRADE_THRESHOLDS['A+']:
            grade = 'A+'
        elif raw_score >= self.GRADE_THRESHOLDS['A']:
            grade = 'A'
        elif raw_score >= self.GRADE_THRESHOLDS['A-']:
            grade = 'A-'
        elif raw_score >= self.GRADE_THRESHOLDS['B+']:
            grade = 'B+'
        elif raw_score >= self.GRADE_THRESHOLDS['B']:
            grade = 'B'
        elif raw_score >= self.GRADE_THRESHOLDS['B-']:
            grade = 'B-'
        else:
            grade = 'C'
        
        # B- and C are never traded
        if grade in ['B-', 'C']:
            return grade, 'Below trading threshold'
        
        # B only eligible as base layer
        if grade == 'B' and not base_layer:
            return 'C', 'B grade only eligible as base layer'
        
        reason = 'Primary signal' if primary_filter else 'Base layer signal'
        return grade, reason
    
    def _calculate_trade_setup(self, ticker: str, close: float, is_bullish: bool,
                              direction: str, grade: str, intraday_range: float,
                              atr: float) -> Dict:
        """
        Calculate trade setup details
        """
        if close <= 0 or grade in ['B-', 'C']:
            return {}
        
        # ATM strike calculation
        if close >= 500:
            strike_interval = 10
        elif close >= 200:
            strike_interval = 5
        elif close >= 100:
            strike_interval = 2.5
        elif close >= 50:
            strike_interval = 1
        else:
            strike_interval = 0.5
        
        atm_strike = round(close / strike_interval) * strike_interval
        
        # Suggested expiry (1-3 DTE based on grade)
        if grade in ['A+', 'A']:
            suggested_dte = 2
        else:
            suggested_dte = 1
        
        return {
            'direction': direction,
            'entry_price': round(close, 2),
            'atm_strike': atm_strike,
            'suggested_dte': suggested_dte,
            'atr': round(atr, 2),
            'intraday_range_pct': round((intraday_range / close * 100), 2) if close > 0 else 0
        }
    
    def _get_exit_strategy(self, grade: str) -> Dict:
        """
        Get exit strategy by grade
        """
        strategies = {
            'A+': {
                'type': '3-tranche + runner',
                'T1': {'size': 0.25, 'trigger': '~+45% or momentum fade'},
                'T2': {'size': 0.35, 'trigger': '~+85% or volume drops 2 bars'},
                'T3': {'size': 0.40, 'trigger': 'Runner to level break'},
                'stop': '-50% full position'
            },
            'A': {
                'type': '3-tranche + runner',
                'T1': {'size': 0.25, 'trigger': '~+45% or momentum fade'},
                'T2': {'size': 0.35, 'trigger': '~+85% or volume drops 2 bars'},
                'T3': {'size': 0.40, 'trigger': 'Runner to level break'},
                'stop': '-50% full position'
            },
            'A-': {
                'type': '3-tranche + runner',
                'T1': {'size': 0.25, 'trigger': '~+50% or momentum fade'},
                'T2': {'size': 0.35, 'trigger': '~+90% or volume drops 2 bars'},
                'T3': {'size': 0.34, 'trigger': 'Runner to level break'},
                'stop': '-50% full position'
            },
            'B+': {
                'type': '2-tranche, no runner',
                'T1': {'size': 0.40, 'trigger': '~+50% momentum fade'},
                'T2': {'size': 0.60, 'trigger': '~+80-100%'},
                'stop': '-50% full position'
            },
            'B': {
                'type': 'Single target',
                'T1': {'size': 1.0, 'trigger': '+60% fixed target'},
                'stop': '-50% full position'
            }
        }
        
        return strategies.get(grade, {})
    
    def _empty_score(self, ticker: str) -> Dict:
        """
        Return empty score structure
        """
        return {
            'ticker': ticker,
            'score': 0,
            'grade': 'F',
            'grade_reason': 'Insufficient data',
            'direction': 'N/A',
            'position_size_pct': 0.0,
            'trade_setup': {},
            'exit_strategy': {},
            'breakdown': {},
            'filters': {},
            'current_price': 0,
            'atr_multiple': 0,
            'rel_volume': 0
        }


# Singleton instance
_launchcontrol_scorer = None

def get_launchcontrol_scorer():
    """Get or create LaunchControl scorer instance"""
    global _launchcontrol_scorer
    if _launchcontrol_scorer is None:
        _launchcontrol_scorer = LaunchControlScorer()
    return _launchcontrol_scorer

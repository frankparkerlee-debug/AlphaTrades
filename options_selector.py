"""
Smart Options Contract Selection for Asymmetric Returns
Picks the OPTIMAL contract for 1-2 day momentum trades
"""
import logging
from datetime import date, timedelta

logger = logging.getLogger(__name__)

class OptionsSelector:
    """Select optimal options contracts for asymmetric 1-2 day returns"""
    
    def __init__(self):
        # Strategy parameters for asymmetric returns
        self.target_dte_min = 1
        self.target_dte_max = 3
        self.delta_min = 0.30
        self.delta_max = 0.60
        self.min_open_interest = 100
        self.min_volume = 10
        self.max_bid_ask_spread_pct = 0.15  # 15%
        self.iv_min = 0.25  # 25%
        self.iv_max = 0.80  # 80%
        
    def select_best_contract(self, options_data, stock_price, direction='call'):
        """
        Select the best options contract for asymmetric returns
        
        Args:
            options_data: Dict of all available options from Alpaca
            stock_price: Current stock price
            direction: 'call' or 'put'
        
        Returns:
            Best contract data or None
        """
        today = date.today()
        candidates = []
        
        logger.info(f"🎯 Selecting optimal {direction.upper()} contract for ${stock_price:.2f} stock")
        logger.info(f"   Strategy: 1-2 day asymmetric returns (50-100% target)")
        
        # Parse all available options
        for opt_symbol, opt_data in options_data.items():
            # Parse option symbol: SYMBOL_YYYYMMDD_SSSSSSSS[C/P]
            parts = opt_symbol.split('_')
            if len(parts) != 3:
                continue
            
            exp_str = parts[1]  # YYYYMMDD
            strike_and_type = parts[2]  # SSSSSSSS[C/P]
            
            opt_type = 'call' if strike_and_type[-1] == 'C' else 'put'
            strike = int(strike_and_type[:-1]) / 1000.0
            
            # Filter by type
            if opt_type != direction.lower():
                continue
            
            # Parse expiration
            from datetime import datetime
            try:
                exp_date = datetime.strptime(exp_str, '%Y%m%d').date()
            except:
                continue
            
            # Calculate DTE
            dte = (exp_date - today).days
            
            # Filter: DTE must be 1-3 days
            if dte < self.target_dte_min or dte > self.target_dte_max:
                continue
            
            # Get market data
            latest_quote = opt_data.get('latestQuote', {})
            latest_trade = opt_data.get('latestTrade', {})
            greeks = opt_data.get('greeks', {})
            
            bid = latest_quote.get('bp', 0)
            ask = latest_quote.get('ap', 0)
            last = latest_trade.get('p', 0)
            volume = latest_trade.get('s', 0)
            open_interest = opt_data.get('openInterest', 0)
            
            delta = greeks.get('delta', 0)
            iv = greeks.get('impliedVolatility', 0)
            
            # Skip if no pricing data
            if not bid or not ask:
                continue
            
            mid = (bid + ask) / 2
            
            # Calculate % distance from stock price
            if direction.lower() == 'call':
                pct_otm = ((strike - stock_price) / stock_price) * 100
            else:
                pct_otm = ((stock_price - strike) / stock_price) * 100
            
            # Calculate bid/ask spread
            spread_pct = ((ask - bid) / mid) if mid > 0 else 1.0
            
            # Quality filters
            if open_interest < self.min_open_interest:
                continue
            if volume < self.min_volume:
                continue
            if spread_pct > self.max_bid_ask_spread_pct:
                continue
            if abs(delta) < self.delta_min or abs(delta) > self.delta_max:
                continue
            if iv < self.iv_min or iv > self.iv_max:
                continue
            
            # Score this contract for asymmetric potential
            score = self._score_contract(
                dte, abs(delta), pct_otm, mid, iv, 
                open_interest, volume, spread_pct
            )
            
            candidates.append({
                'symbol': opt_symbol,
                'strike': strike,
                'expiration': exp_date,
                'dte': dte,
                'bid': bid,
                'ask': ask,
                'mid': mid,
                'last': last,
                'volume': volume,
                'open_interest': open_interest,
                'delta': delta,
                'iv': iv,
                'gamma': greeks.get('gamma', 0),
                'theta': greeks.get('theta', 0),
                'vega': greeks.get('vega', 0),
                'pct_otm': pct_otm,
                'spread_pct': spread_pct,
                'score': score,
                'data': opt_data
            })
        
        if not candidates:
            logger.warning(f"   ❌ No suitable contracts found for {direction.upper()}")
            logger.warning(f"   Filters: DTE {self.target_dte_min}-{self.target_dte_max}, Delta {self.delta_min}-{self.delta_max}")
            return None
        
        # Sort by score (highest first)
        candidates.sort(key=lambda x: x['score'], reverse=True)
        
        best = candidates[0]
        logger.info(f"   ✅ Selected: Strike ${best['strike']:.2f} ({best['pct_otm']:.1f}% OTM), {best['dte']}DTE")
        logger.info(f"   Entry: ${best['mid']:.2f}, Delta: {best['delta']:.3f}, IV: {best['iv']*100:.1f}%")
        logger.info(f"   Liquidity: OI={best['open_interest']}, Vol={best['volume']}, Spread={best['spread_pct']*100:.1f}%")
        logger.info(f"   Score: {best['score']:.2f}/100 (top of {len(candidates)} candidates)")
        
        return best
    
    def _score_contract(self, dte, delta, pct_otm, mid, iv, oi, volume, spread_pct):
        """
        Score a contract for asymmetric return potential (0-100)
        
        Higher score = better asymmetric setup
        """
        score = 0.0
        
        # DTE scoring (prefer 1-2 days)
        if dte == 1:
            score += 30  # Best for asymmetric 1-day moves
        elif dte == 2:
            score += 25
        elif dte == 3:
            score += 15
        
        # Delta scoring (prefer 0.40-0.50 sweet spot)
        if 0.40 <= delta <= 0.50:
            score += 25  # Perfect for asymmetric
        elif 0.35 <= delta <= 0.55:
            score += 20
        elif 0.30 <= delta <= 0.60:
            score += 15
        
        # OTM % scoring (prefer 2-5% OTM)
        if 2 <= pct_otm <= 5:
            score += 20  # Sweet spot
        elif 0 <= pct_otm <= 7:
            score += 15
        elif pct_otm < 0:  # ITM
            score += 5  # Less attractive
        
        # Liquidity scoring
        if oi >= 500:
            score += 10
        elif oi >= 200:
            score += 7
        elif oi >= 100:
            score += 5
        
        # Volume scoring
        if volume >= 50:
            score += 5
        elif volume >= 20:
            score += 3
        elif volume >= 10:
            score += 2
        
        # Spread scoring (tighter is better)
        if spread_pct <= 0.05:
            score += 5
        elif spread_pct <= 0.10:
            score += 3
        elif spread_pct <= 0.15:
            score += 1
        
        # IV scoring (prefer moderate)
        if 0.35 <= iv <= 0.50:
            score += 5  # Goldilocks zone
        elif 0.25 <= iv <= 0.60:
            score += 3
        
        return score

# Global instance
_selector = None

def get_selector():
    """Get or create selector instance"""
    global _selector
    if _selector is None:
        _selector = OptionsSelector()
    return _selector

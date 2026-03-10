"""
Test script for Launch Control v2.0 scorer
Validates the scoring engine with sample data
"""

from scorer_launchcontrol import get_launchcontrol_scorer
from datetime import datetime
import json


def test_basic_scoring():
    """Test basic scoring functionality"""
    print("🧪 Testing Launch Control v2.0 Scorer")
    print("=" * 60)
    
    scorer = get_launchcontrol_scorer()
    
    # Sample bar data (NVDA bullish momentum)
    # Need big move: ATR is 8.50, so need 8.50*1.7 = 14.45 points for top tier
    bar_data = {
        'open': 220.50,
        'high': 236.80,  # Big range
        'low': 220.20,
        'close': 235.00,  # +6.6% move = +14.5 pts = 1.71x ATR
        'volume': 75000000,  # 2.5x normal volume
        'timestamp': datetime(2026, 3, 10, 10, 30, 0)  # 10:30 AM ET
    }
    
    # Sample equity profile (NVDA characteristics)
    equity_profile = {
        'atr': 8.50,  # Average True Range
        'vol_baseline': 30000000,  # 20-day average volume
        'beta': 1.82,
        'sector_correlation': 0.84,  # High correlation with SMH
        'persistence': 0.82,
        'news_sensitivity': 1.15
    }
    
    # Sample market data (bullish alignment)
    market_data = {
        'qqq_direction': 'UP',
        'qqq_change': 0.8,
        'sector_direction': 'UP',  # SMH
        'sector_change': 1.2,
        'vix': 18.5
    }
    
    # Sample news data (positive catalyst)
    news_data = {
        'polarity': 2,  # Strongly positive
        'recency_minutes': 45,  # 45 minutes ago
        'news_sensitivity': 1.15,
        'social_amplification': 1.0
    }
    
    # Score the ticker
    result = scorer.score_ticker(
        ticker='NVDA',
        bar_data=bar_data,
        equity_profile=equity_profile,
        market_data=market_data,
        news_data=news_data
    )
    
    # Display results
    print(f"\n📊 SCORING RESULTS FOR NVDA")
    print(f"{'─' * 60}")
    print(f"Grade: {result['grade']} ({result['score']:.2f} points)")
    print(f"Reason: {result['grade_reason']}")
    print(f"Direction: {result['direction']}")
    print(f"Position Size: {result['position_size_pct']*100:.1f}% of account")
    
    print(f"\n🔢 PILLAR BREAKDOWN:")
    breakdown = result['breakdown']
    print(f"  Timing:     {breakdown['timing']['score']:.1f} / 5 pts")
    print(f"  Price Action: {breakdown['price_action']['score']:.1f} / 35 pts")
    print(f"  Volume:       {breakdown['volume']['score']:.1f} / 30 pts")
    print(f"  News:         {breakdown['news_sentiment']['score']:.1f} / 15 pts")
    print(f"  Market:       {breakdown['market_alignment']['score']:.1f} / 15 pts")
    print(f"  Bonus:        {breakdown['announcement_bonus']} pts")
    print(f"  ────────────")
    print(f"  Total:        {result['score']:.1f} / 110 pts")
    
    print(f"\n🚦 FILTERS:")
    filters = result['filters']
    print(f"  Asymmetry Gate: {'✅ PASS' if filters['asymmetry_gate'] else '❌ FAIL'}")
    print(f"  Primary Filter: {'✅ PASS' if filters['primary_filter'] else '❌ FAIL'}")
    print(f"  Base Layer:     {'✅ ELIGIBLE' if filters['base_layer_eligible'] else '❌ NOT ELIGIBLE'}")
    if filters['conflict_flags']:
        print(f"  Conflicts: {', '.join(filters['conflict_flags'])}")
    
    print(f"\n📈 TRADE SETUP:")
    setup = result['trade_setup']
    if setup:
        print(f"  Entry: ${setup['entry_price']:.2f}")
        print(f"  Strike: ${setup['atm_strike']:.2f} ATM")
        print(f"  Expiry: {setup['suggested_dte']} DTE")
        print(f"  ATR Multiple: {result['atr_multiple']:.2f}x")
        print(f"  Rel Volume: {result['rel_volume']:.2f}x")
    
    print(f"\n🎯 EXIT STRATEGY:")
    exit_strat = result['exit_strategy']
    if exit_strat:
        print(f"  Type: {exit_strat['type']}")
        if 'T1' in exit_strat:
            print(f"  T1: {exit_strat['T1']['size']*100:.0f}% @ {exit_strat['T1']['trigger']}")
        if 'T2' in exit_strat:
            print(f"  T2: {exit_strat['T2']['size']*100:.0f}% @ {exit_strat['T2']['trigger']}")
        if 'T3' in exit_strat:
            print(f"  T3: {exit_strat['T3']['size']*100:.0f}% @ {exit_strat['T3']['trigger']}")
        print(f"  Stop: {exit_strat['stop']}")
    
    print("\n" + "=" * 60)
    
    # Validate asymmetry gate
    pa_score = breakdown['price_action']['score']
    vol_score = breakdown['volume']['score']
    print(f"\n✅ ASYMMETRY GATE CHECK:")
    print(f"  PA Score: {pa_score:.1f} (need > 17.5) {'✅' if pa_score > 17.5 else '❌'}")
    print(f"  Vol Score: {vol_score:.1f} (need > 15.0) {'✅' if vol_score > 15.0 else '❌'}")
    
    return result


def test_failed_asymmetry_gate():
    """Test signal that fails asymmetry gate"""
    print("\n\n🧪 Testing Failed Asymmetry Gate")
    print("=" * 60)
    
    scorer = get_launchcontrol_scorer()
    
    # Weak price action, low volume
    bar_data = {
        'open': 220.50,
        'high': 221.00,  # Small move
        'low': 220.00,
        'close': 220.80,  # Only +0.14%
        'volume': 28000000,  # Only 0.93x normal
        'timestamp': datetime(2026, 3, 10, 10, 30, 0)
    }
    
    equity_profile = {
        'atr': 8.50,
        'vol_baseline': 30000000,
        'beta': 1.82,
        'sector_correlation': 0.84,
        'persistence': 0.82,
        'news_sensitivity': 1.15
    }
    
    result = scorer.score_ticker(
        ticker='NVDA',
        bar_data=bar_data,
        equity_profile=equity_profile,
        market_data={'qqq_direction': 'UP', 'sector_direction': 'UP', 'vix': 18},
        news_data={'polarity': 1, 'recency_minutes': 60}
    )
    
    print(f"\nGrade: {result['grade']}")
    print(f"Reason: {result['grade_reason']}")
    print(f"PA Score: {result['breakdown']['price_action']['score']:.1f}")
    print(f"Vol Score: {result['breakdown']['volume']['score']:.1f}")
    print(f"Asymmetry Gate: {'PASS' if result['filters']['asymmetry_gate'] else 'FAIL ❌'}")
    
    return result


def test_base_layer_signal():
    """Test base layer signal (B+ grade)"""
    print("\n\n🧪 Testing Base Layer Signal")
    print("=" * 60)
    
    scorer = get_launchcontrol_scorer()
    
    # Moderate setup, not strong enough for primary
    bar_data = {
        'open': 220.50,
        'high': 223.50,
        'low': 220.00,
        'close': 223.00,  # +1.13% move
        'volume': 40000000,  # 1.33x volume
        'timestamp': datetime(2026, 3, 10, 11, 0, 0)
    }
    
    equity_profile = {
        'atr': 8.50,
        'vol_baseline': 30000000,
        'beta': 1.82,
        'sector_correlation': 0.84,
        'persistence': 0.82,
        'news_sensitivity': 1.15
    }
    
    result = scorer.score_ticker(
        ticker='NVDA',
        bar_data=bar_data,
        equity_profile=equity_profile,
        market_data={'qqq_direction': 'UP', 'sector_direction': 'UP', 'vix': 18},
        news_data={'polarity': 0, 'recency_minutes': 120}
    )
    
    print(f"\nGrade: {result['grade']}")
    print(f"Score: {result['score']:.1f}")
    print(f"Primary Filter: {'PASS' if result['filters']['primary_filter'] else 'FAIL'}")
    print(f"Base Layer Eligible: {'YES ✅' if result['filters']['base_layer_eligible'] else 'NO'}")
    print(f"Position Size: {result['position_size_pct']*100:.1f}%")
    
    return result


def test_conflict_flags():
    """Test conflict detection and grade caps"""
    print("\n\n🧪 Testing Conflict Flags")
    print("=" * 60)
    
    scorer = get_launchcontrol_scorer()
    
    # Strong setup but negative news
    bar_data = {
        'open': 220.50,
        'high': 225.80,
        'low': 220.20,
        'close': 225.00,
        'volume': 75000000,
        'timestamp': datetime(2026, 3, 10, 10, 30, 0)
    }
    
    equity_profile = {
        'atr': 8.50,
        'vol_baseline': 30000000,
        'beta': 1.82,
        'sector_correlation': 0.84,
        'persistence': 0.82,
        'news_sensitivity': 1.15
    }
    
    # Conflicting news (bearish news on bullish move)
    result = scorer.score_ticker(
        ticker='NVDA',
        bar_data=bar_data,
        equity_profile=equity_profile,
        market_data={'qqq_direction': 'UP', 'sector_direction': 'UP', 'vix': 18},
        news_data={'polarity': -2, 'recency_minutes': 30}  # Strongly negative
    )
    
    print(f"\nGrade: {result['grade']}")
    print(f"Raw Score: {result['score']:.1f}")
    print(f"Conflicts: {result['filters']['conflict_flags']}")
    print(f"Grade Reason: {result['grade_reason']}")
    
    return result


if __name__ == '__main__':
    # Run all tests
    test_basic_scoring()
    test_failed_asymmetry_gate()
    test_base_layer_signal()
    test_conflict_flags()
    
    print("\n" + "=" * 60)
    print("✅ All tests complete!")
    print("=" * 60)

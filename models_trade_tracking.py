"""
Trade Journey Tracking - Understand stock behavior during hold period
Stores detailed price movements for ML improvement
"""
from sqlalchemy import Column, Integer, String, Numeric, DateTime, ForeignKey, JSON, Text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import relationship
from datetime import datetime

Base = declarative_base()

class TradeJourney(Base):
    """
    Detailed tracking of stock movement during trade hold period
    
    Example: Buy AAPL at $100 for $5/contract
    - Moves to $102 (+2%) at $6.50/contract
    - Drops to $97 (-3%) at $4.75/contract
    - Exit at $99 (-1%) at $5.25/contract
    
    This table captures ALL movements for ML analysis
    """
    __tablename__ = 'trade_journeys'
    
    id = Column(Integer, primary_key=True)
    trade_id = Column(String(50), nullable=False, index=True)  # Links to paper_trades or trades
    ticker = Column(String(10), nullable=False, index=True)
    
    # Trade context
    entry_time = Column(DateTime(timezone=True), nullable=False)
    entry_stock_price = Column(Numeric(10, 2), nullable=False)
    entry_option_price = Column(Numeric(10, 4), nullable=False)
    direction = Column(String(4), nullable=False)  # CALL/PUT
    grade = Column(String(3), nullable=False)
    
    # Exit context
    exit_time = Column(DateTime(timezone=True))
    exit_stock_price = Column(Numeric(10, 2))
    exit_option_price = Column(Numeric(10, 4))
    exit_reason = Column(String(50))
    
    # Journey analysis
    hwm_stock_price = Column(Numeric(10, 2))  # Highest stock price during hold
    hwm_option_price = Column(Numeric(10, 4))  # Highest option price
    hwm_reached_at = Column(DateTime(timezone=True))  # When HWM was reached
    hwm_pct_from_entry = Column(Numeric(8, 2))  # % gain at HWM
    
    lwm_stock_price = Column(Numeric(10, 2))  # Lowest stock price during hold
    lwm_option_price = Column(Numeric(10, 4))  # Lowest option price
    lwm_reached_at = Column(DateTime(timezone=True))  # When LWM was reached
    lwm_pct_from_entry = Column(Numeric(8, 2))  # % loss at LWM
    
    # Movement patterns
    direction_after_entry = Column(String(10))  # UP / DOWN / BOTH
    time_to_first_reversal = Column(Integer)  # Minutes until direction changed
    num_reversals = Column(Integer)  # Number of direction changes
    volatility_score = Column(Numeric(6, 2))  # Measure of price swings
    
    # Time in profit/loss
    minutes_profitable = Column(Integer)  # Time spent above entry
    minutes_underwater = Column(Integer)  # Time spent below entry
    max_drawdown_pct = Column(Numeric(8, 2))  # Worst drawdown during hold
    max_runup_pct = Column(Numeric(8, 2))  # Best gain during hold
    
    # Detailed movement log (JSON array)
    price_snapshots = Column(JSON)  # [{timestamp, stock_price, option_price, pct_from_entry}, ...]
    
    # ML features
    ml_features = Column(JSON)  # Extracted features for model training
    
    created_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class PriceSnapshot(Base):
    """
    Individual price observations during trade hold
    High-frequency tracking for detailed analysis
    """
    __tablename__ = 'price_snapshots'
    
    id = Column(Integer, primary_key=True)
    trade_id = Column(String(50), nullable=False, index=True)
    ticker = Column(String(10), nullable=False, index=True)
    
    timestamp = Column(DateTime(timezone=True), nullable=False, index=True)
    
    # Stock data
    stock_price = Column(Numeric(10, 2), nullable=False)
    stock_change_pct = Column(Numeric(8, 2))  # % from entry
    
    # Option data (if available)
    option_price = Column(Numeric(10, 4))
    option_change_pct = Column(Numeric(8, 2))  # % from entry
    
    # Context
    minutes_held = Column(Integer, nullable=False)  # Minutes since entry
    is_hwm = Column(Boolean, default=False)  # Is this the high water mark?
    is_lwm = Column(Boolean, default=False)  # Is this the low water mark?
    
    # Market context
    volume = Column(Numeric(20, 0))
    bid = Column(Numeric(10, 2))
    ask = Column(Numeric(10, 2))
    spread_pct = Column(Numeric(6, 2))
    
    created_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class MLTrainingData(Base):
    """
    Aggregated data for machine learning model training
    Features extracted from trade journeys for better entry/exit decisions
    """
    __tablename__ = 'ml_training_data'
    
    id = Column(Integer, primary_key=True)
    ticker = Column(String(10), nullable=False, index=True)
    
    # Signal features (at entry)
    grade = Column(String(3), nullable=False)
    score = Column(Integer, nullable=False)
    entry_time_of_day = Column(String(10))  # "09:45", "14:30", etc
    day_of_week = Column(Integer)  # 0-6
    
    # V5 scoring components
    catalyst_score = Column(Integer)
    volume_score = Column(Integer)
    direction_score = Column(Integer)
    range_score = Column(Integer)
    timing_score = Column(Integer)
    
    # Journey outcome
    direction_after_entry = Column(String(10))  # UP / DOWN / BOTH
    time_to_hwm_minutes = Column(Integer)  # How long to reach HWM
    time_to_lwm_minutes = Column(Integer)  # How long to reach LWM
    hwm_pct = Column(Numeric(8, 2))  # Max gain available
    lwm_pct = Column(Numeric(8, 2))  # Max loss risked
    
    # Exit analysis
    actual_exit_pct = Column(Numeric(8, 2))  # What we actually got
    left_on_table_pct = Column(Numeric(8, 2))  # HWM - actual exit (opportunity cost)
    avoided_drawdown_pct = Column(Numeric(8, 2))  # Actual exit - LWM (risk avoided)
    
    # Optimal exit (in hindsight)
    optimal_exit_pct = Column(Numeric(8, 2))  # Best possible exit (HWM)
    optimal_exit_time = Column(Integer)  # Minutes to optimal exit
    
    # Pattern classification
    pattern = Column(String(30))  # STRAIGHT_UP, STRAIGHT_DOWN, WHIPSAW, GRIND_UP, etc
    volatility_class = Column(String(20))  # LOW / MEDIUM / HIGH / EXTREME
    
    # Labels for ML
    was_profitable = Column(Boolean)
    beat_target = Column(Boolean)
    hit_stop = Column(Boolean)
    
    # Full features (JSON)
    features_json = Column(JSON)  # All numeric features for model
    
    created_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow, index=True)


class BacktestJourney(Base):
    """
    Backtest results with journey tracking
    Uses real Alpaca historical data
    """
    __tablename__ = 'backtest_journeys'
    
    id = Column(Integer, primary_key=True)
    backtest_run_id = Column(String(50), nullable=False, index=True)
    
    # Trade details
    ticker = Column(String(10), nullable=False)
    entry_date = Column(DateTime(timezone=True), nullable=False)
    exit_date = Column(DateTime(timezone=True))
    grade = Column(String(3), nullable=False)
    score = Column(Integer, nullable=False)
    direction = Column(String(4), nullable=False)
    
    # Entry
    entry_stock_price = Column(Numeric(10, 2), nullable=False)
    entry_option_price_est = Column(Numeric(10, 4), nullable=False)
    
    # Journey (what happened during hold)
    journey_data = Column(JSON)  # Array of {timestamp, stock_price, option_price_est, pct_change}
    
    # Summary stats
    hwm_pct = Column(Numeric(8, 2))  # Best opportunity
    lwm_pct = Column(Numeric(8, 2))  # Worst drawdown
    direction_after_entry = Column(String(10))  # UP / DOWN / BOTH
    num_reversals = Column(Integer)
    
    # Exit
    exit_stock_price = Column(Numeric(10, 2))
    exit_option_price_est = Column(Numeric(10, 4))
    exit_reason = Column(String(50))
    pnl_pct = Column(Numeric(8, 2))
    pnl_dollars = Column(Numeric(10, 2))
    
    # Analysis
    pattern = Column(String(30))
    optimal_exit_pct = Column(Numeric(8, 2))  # What we could have gotten
    exit_quality = Column(String(20))  # EXCELLENT / GOOD / POOR / TERRIBLE
    
    created_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)

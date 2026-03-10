"""
SQLAlchemy models for AlphaTrades database
Combined: Core trading models + Distress Scanner models
"""
from sqlalchemy import create_engine, Column, Integer, String, Numeric, DateTime, Date, Boolean, Text, ARRAY, ForeignKey, JSON, Index, Float
from sqlalchemy.orm import declarative_base, relationship, sessionmaker
from datetime import datetime
from typing import Optional, Dict
import os

Base = declarative_base()

# =============================================================================
# CORE TRADING MODELS
# =============================================================================

class MinuteBar(Base):
    """Minute-level OHLCV price data for backtesting and strategy development"""
    __tablename__ = 'minute_bars'
    
    id = Column(Integer, primary_key=True)
    ticker = Column(String(10), nullable=False, index=True)
    timestamp = Column(DateTime(timezone=True), nullable=False, index=True)
    
    # OHLCV
    open = Column(Numeric(12, 4), nullable=False)
    high = Column(Numeric(12, 4), nullable=False)
    low = Column(Numeric(12, 4), nullable=False)
    close = Column(Numeric(12, 4), nullable=False)
    volume = Column(Integer, nullable=False)
    
    # Additional Alpaca fields
    vwap = Column(Numeric(12, 4))
    trade_count = Column(Integer)
    
    created_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    
    __table_args__ = (
        Index('idx_minute_bars_ticker_timestamp', 'ticker', 'timestamp'),
    )


class Signal(Base):
    """Cached convergence signals - pre-computed by background worker"""
    __tablename__ = 'signals'
    
    id = Column(Integer, primary_key=True)
    ticker = Column(String(10), unique=True, nullable=False, index=True)
    
    # Stock data
    price = Column(Numeric(10, 2))
    change_pct = Column(Numeric(6, 3))
    
    # Convergence score
    grade = Column(String(3))
    score = Column(Integer)
    convergence_count = Column(Integer)
    confidence = Column(String(20))
    
    # Full data (JSON)
    convergence_json = Column(JSON)
    option_json = Column(JSON)
    
    # Metadata
    updated_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
    created_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    
    def to_dict(self):
        return {
            'ticker': self.ticker,
            'price': float(self.price) if self.price else None,
            'change_pct': float(self.change_pct) if self.change_pct else None,
            'grade': self.grade,
            'score': self.score,
            'convergence_count': self.convergence_count,
            'confidence': self.confidence,
            'convergence': self.convergence_json,
            'option': self.option_json,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            'age_seconds': (datetime.utcnow() - self.updated_at).total_seconds() if self.updated_at else None
        }


class Alert(Base):
    __tablename__ = 'alerts'
    
    id = Column(Integer, primary_key=True)
    timestamp = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    ticker = Column(String(10), nullable=False)
    grade = Column(String(3), nullable=False)
    score = Column(Integer, nullable=False)
    stock_price = Column(Numeric(10, 2), nullable=False)
    open_price = Column(Numeric(10, 2), nullable=False)
    high_price = Column(Numeric(10, 2), nullable=False)
    low_price = Column(Numeric(10, 2), nullable=False)
    move_pct = Column(Numeric(6, 3), nullable=False)
    range_pct = Column(Numeric(6, 3), nullable=False)
    direction = Column(String(4), nullable=False)
    strike = Column(Numeric(10, 2), nullable=False)
    expiration = Column(Date, nullable=False)
    market_trend = Column(String(10), nullable=False)
    spy_price = Column(Numeric(10, 2))
    created_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    
    trades = relationship("Trade", back_populates="alert")
    
    def to_dict(self):
        return {
            'id': self.id,
            'timestamp': self.timestamp.isoformat() if self.timestamp else None,
            'ticker': self.ticker,
            'grade': self.grade,
            'score': self.score,
            'stock_price': float(self.stock_price),
            'move_pct': float(self.move_pct),
            'range_pct': float(self.range_pct),
            'direction': self.direction,
            'strike': float(self.strike)
        }


class Trade(Base):
    __tablename__ = 'trades'
    
    id = Column(Integer, primary_key=True)
    alert_id = Column(Integer, ForeignKey('alerts.id'))
    
    ticker = Column(String(10), nullable=False)
    direction = Column(String(4), nullable=False)
    strike = Column(Numeric(10, 2), nullable=False)
    expiration = Column(Date, nullable=False)
    entry_time = Column(DateTime(timezone=True), nullable=False)
    entry_option_price = Column(Numeric(10, 2), nullable=False)
    entry_stock_price = Column(Numeric(10, 2), nullable=False)
    position_size = Column(Numeric(10, 2), nullable=False)
    quantity = Column(Integer, nullable=False, default=1)
    grade = Column(String(3), nullable=False)
    
    exit_time = Column(DateTime(timezone=True))
    exit_option_price = Column(Numeric(10, 2))
    exit_stock_price = Column(Numeric(10, 2))
    exit_reason = Column(String(50))
    
    profit_loss = Column(Numeric(10, 2))
    profit_loss_pct = Column(Numeric(6, 2))
    hold_hours = Column(Integer)
    hold_days = Column(Integer)
    
    status = Column(String(20), nullable=False, default='OPEN')
    trading_mode = Column(String(10), nullable=False, default='paper')
    notes = Column(Text)
    created_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    alert = relationship("Alert", back_populates="trades")
    
    def to_dict(self):
        return {
            'id': self.id,
            'ticker': self.ticker,
            'direction': self.direction,
            'strike': float(self.strike),
            'grade': self.grade,
            'entry_time': self.entry_time.isoformat() if self.entry_time else None,
            'entry_price': float(self.entry_option_price),
            'exit_time': self.exit_time.isoformat() if self.exit_time else None,
            'exit_price': float(self.exit_option_price) if self.exit_option_price else None,
            'profit_loss': float(self.profit_loss) if self.profit_loss else None,
            'profit_loss_pct': float(self.profit_loss_pct) if self.profit_loss_pct else None,
            'status': self.status,
            'hold_days': self.hold_days
        }


class DailyPerformance(Base):
    __tablename__ = 'daily_performance'
    
    id = Column(Integer, primary_key=True)
    date = Column(Date, nullable=False, unique=True)
    
    total_alerts = Column(Integer, nullable=False, default=0)
    alerts_a_plus = Column(Integer, nullable=False, default=0)
    alerts_a = Column(Integer, nullable=False, default=0)
    alerts_a_minus = Column(Integer, nullable=False, default=0)
    alerts_b_plus = Column(Integer, nullable=False, default=0)
    alerts_b = Column(Integer, nullable=False, default=0)
    alerts_b_minus = Column(Integer, nullable=False, default=0)
    
    trades_opened = Column(Integer, nullable=False, default=0)
    trades_closed = Column(Integer, nullable=False, default=0)
    trades_won = Column(Integer, nullable=False, default=0)
    trades_lost = Column(Integer, nullable=False, default=0)
    
    win_rate = Column(Numeric(5, 2))
    total_profit_loss = Column(Numeric(10, 2))
    avg_profit_loss = Column(Numeric(10, 2))
    best_trade_pl = Column(Numeric(10, 2))
    worst_trade_pl = Column(Numeric(10, 2))
    
    cumulative_pl = Column(Numeric(10, 2))
    account_balance = Column(Numeric(10, 2))
    
    created_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class ModelConfig(Base):
    __tablename__ = 'model_config'
    
    id = Column(Integer, primary_key=True)
    config_name = Column(String(50), nullable=False, unique=True)
    is_active = Column(Boolean, nullable=False, default=False)
    
    threshold_a_plus = Column(Integer, nullable=False, default=50)
    threshold_a = Column(Integer, nullable=False, default=47)
    threshold_a_minus = Column(Integer, nullable=False, default=45)
    threshold_b_plus = Column(Integer, nullable=False, default=41)
    threshold_b = Column(Integer, nullable=False, default=38)
    threshold_b_minus = Column(Integer, nullable=False, default=35)
    
    weight_momentum = Column(Integer, nullable=False, default=25)
    weight_range = Column(Integer, nullable=False, default=15)
    weight_volume = Column(Integer, nullable=False, default=5)
    weight_market = Column(Integer, nullable=False, default=10)
    
    auto_trade_grades = Column(ARRAY(String), nullable=False, default=['A+', 'A'])
    position_size_pct = Column(Numeric(5, 3), nullable=False, default=0.20)
    max_positions = Column(Integer, nullable=False, default=3)
    
    stop_loss_pct = Column(Numeric(5, 2), nullable=False, default=-30.00)
    target_profit_pct = Column(Numeric(5, 2), nullable=False, default=50.00)
    max_hold_days = Column(Integer, nullable=False, default=5)
    
    notes = Column(Text)
    created_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)


class AccountState(Base):
    __tablename__ = 'account_state'
    
    id = Column(Integer, primary_key=True)
    timestamp = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    starting_capital = Column(Numeric(10, 2), nullable=False, default=600.00)
    current_capital = Column(Numeric(10, 2), nullable=False, default=600.00)
    open_positions_value = Column(Numeric(10, 2), nullable=False, default=0.00)
    total_value = Column(Numeric(10, 2), nullable=False, default=600.00)
    cumulative_pl = Column(Numeric(10, 2), nullable=False, default=0.00)
    total_trades = Column(Integer, nullable=False, default=0)
    winning_trades = Column(Integer, nullable=False, default=0)
    losing_trades = Column(Integer, nullable=False, default=0)


# =============================================================================
# DISTRESS SCANNER MODELS
# =============================================================================

class DistressSignal(Base):
    """Distress signal scan results"""
    __tablename__ = 'distress_signals'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    ticker = Column(String(10), nullable=False, index=True)
    scan_timestamp = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)
    
    distress_score = Column(Integer, nullable=False, index=True)
    raw_score = Column(Integer, nullable=False)
    alert_triggered = Column(Boolean, nullable=False, default=False, index=True)
    
    signals_triggered = Column(Integer, nullable=False, default=0)
    signal_details = Column(JSON, nullable=True)
    
    filings_8k_count = Column(Integer, nullable=True)
    form4_filings_count = Column(Integer, nullable=True)
    news_count = Column(Integer, nullable=True)
    
    news_sentiment_avg = Column(Float, nullable=True)
    news_sentiment_negative_ratio = Column(Float, nullable=True)
    
    put_volume = Column(Integer, nullable=True)
    call_volume = Column(Integer, nullable=True)
    put_call_ratio = Column(Float, nullable=True)
    
    days_until_earnings = Column(Integer, nullable=True)
    earnings_date = Column(DateTime, nullable=True)
    
    analyst_downgrades = Column(Integer, nullable=True, default=0)
    
    has_recommendation = Column(Boolean, default=False)
    recommendation_data = Column(JSON, nullable=True)
    
    extra_data = Column(JSON, nullable=True)
    error_message = Column(Text, nullable=True)
    
    distress_alerts = relationship("DistressAlert", back_populates="signal", cascade="all, delete-orphan")
    
    __table_args__ = (
        Index('idx_distress_ticker_timestamp', 'ticker', 'scan_timestamp'),
        Index('idx_distress_alert_score', 'alert_triggered', 'distress_score'),
    )
    
    def to_dict(self) -> Dict:
        return {
            'id': self.id,
            'ticker': self.ticker,
            'scan_timestamp': self.scan_timestamp.isoformat() if self.scan_timestamp else None,
            'distress_score': self.distress_score,
            'alert_triggered': self.alert_triggered,
            'signals_triggered': self.signals_triggered,
            'signal_details': self.signal_details,
            'recommendation': self.recommendation_data if self.has_recommendation else None,
        }


class DistressAlert(Base):
    """Distress alert history"""
    __tablename__ = 'distress_alerts'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    signal_id = Column(Integer, ForeignKey('distress_signals.id'), nullable=False, index=True)
    
    ticker = Column(String(10), nullable=False, index=True)
    alert_timestamp = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)
    distress_score = Column(Integer, nullable=False)
    
    sent = Column(Boolean, default=False, index=True)
    delivery_channels = Column(JSON, nullable=True)
    delivery_status = Column(JSON, nullable=True)
    
    recommendation_data = Column(JSON, nullable=True)
    
    acknowledged = Column(Boolean, default=False)
    acknowledged_at = Column(DateTime, nullable=True)
    user_notes = Column(Text, nullable=True)
    
    trade_taken = Column(Boolean, default=False)
    trade_data = Column(JSON, nullable=True)
    
    signal = relationship("DistressSignal", back_populates="distress_alerts")


class Watchlist(Base):
    """User watchlist for continuous monitoring"""
    __tablename__ = 'watchlists'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    ticker = Column(String(10), nullable=False, unique=True, index=True)
    active = Column(Boolean, default=True, index=True)
    alert_threshold = Column(Integer, default=60)
    last_scanned = Column(DateTime, nullable=True, index=True)
    last_score = Column(Integer, nullable=True)
    last_alert = Column(DateTime, nullable=True)
    added_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    added_reason = Column(Text, nullable=True)
    notes = Column(Text, nullable=True)


class ScanJob(Base):
    """Scan job history"""
    __tablename__ = 'scan_jobs'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    job_type = Column(String(50), nullable=False)
    started_at = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)
    completed_at = Column(DateTime, nullable=True)
    status = Column(String(20), nullable=False, default='running')
    tickers_scanned = Column(Integer, default=0)
    alerts_generated = Column(Integer, default=0)
    errors_count = Column(Integer, default=0)
    ticker_list = Column(JSON, nullable=True)
    error_details = Column(JSON, nullable=True)


# =============================================================================
# DATABASE UTILITIES
# =============================================================================

def get_db_engine():
    database_url = os.getenv('DATABASE_URL')
    if not database_url:
        raise ValueError("DATABASE_URL environment variable not set")
    
    if database_url.startswith('postgres://'):
        database_url = database_url.replace('postgres://', 'postgresql://', 1)
    
    return create_engine(database_url)


def get_session():
    engine = get_db_engine()
    Session = sessionmaker(bind=engine)
    return Session()

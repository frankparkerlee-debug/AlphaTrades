"""
SQLAlchemy models for AlphaTrades database
"""
from sqlalchemy import create_engine, Column, Integer, String, Numeric, DateTime, Date, Boolean, Text, ARRAY, ForeignKey, JSON
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import relationship, sessionmaker
from datetime import datetime
import os

Base = declarative_base()

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
    convergence_json = Column(JSON)  # Complete convergence breakdown
    option_json = Column(JSON)       # Optimal option contract
    
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
    
    # Relationship
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
    
    # Entry
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
    
    # Exit
    exit_time = Column(DateTime(timezone=True))
    exit_option_price = Column(Numeric(10, 2))
    exit_stock_price = Column(Numeric(10, 2))
    exit_reason = Column(String(50))
    
    # Performance
    profit_loss = Column(Numeric(10, 2))
    profit_loss_pct = Column(Numeric(6, 2))
    hold_hours = Column(Integer)
    hold_days = Column(Integer)
    
    # Metadata
    status = Column(String(20), nullable=False, default='OPEN')
    trading_mode = Column(String(10), nullable=False, default='paper')
    notes = Column(Text)
    created_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # Relationship
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
    
    # Alerts
    total_alerts = Column(Integer, nullable=False, default=0)
    alerts_a_plus = Column(Integer, nullable=False, default=0)
    alerts_a = Column(Integer, nullable=False, default=0)
    alerts_a_minus = Column(Integer, nullable=False, default=0)
    alerts_b_plus = Column(Integer, nullable=False, default=0)
    alerts_b = Column(Integer, nullable=False, default=0)
    alerts_b_minus = Column(Integer, nullable=False, default=0)
    
    # Trades
    trades_opened = Column(Integer, nullable=False, default=0)
    trades_closed = Column(Integer, nullable=False, default=0)
    trades_won = Column(Integer, nullable=False, default=0)
    trades_lost = Column(Integer, nullable=False, default=0)
    
    # Performance
    win_rate = Column(Numeric(5, 2))
    total_profit_loss = Column(Numeric(10, 2))
    avg_profit_loss = Column(Numeric(10, 2))
    best_trade_pl = Column(Numeric(10, 2))
    worst_trade_pl = Column(Numeric(10, 2))
    
    # Cumulative
    cumulative_pl = Column(Numeric(10, 2))
    account_balance = Column(Numeric(10, 2))
    
    created_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)

class ModelConfig(Base):
    __tablename__ = 'model_config'
    
    id = Column(Integer, primary_key=True)
    config_name = Column(String(50), nullable=False, unique=True)
    is_active = Column(Boolean, nullable=False, default=False)
    
    # Thresholds
    threshold_a_plus = Column(Integer, nullable=False, default=50)
    threshold_a = Column(Integer, nullable=False, default=47)
    threshold_a_minus = Column(Integer, nullable=False, default=45)
    threshold_b_plus = Column(Integer, nullable=False, default=41)
    threshold_b = Column(Integer, nullable=False, default=38)
    threshold_b_minus = Column(Integer, nullable=False, default=35)
    
    # Weights
    weight_momentum = Column(Integer, nullable=False, default=25)
    weight_range = Column(Integer, nullable=False, default=15)
    weight_volume = Column(Integer, nullable=False, default=5)
    weight_market = Column(Integer, nullable=False, default=10)
    
    # Trading
    auto_trade_grades = Column(ARRAY(String), nullable=False, default=['A+', 'A'])
    position_size_pct = Column(Numeric(5, 3), nullable=False, default=0.20)
    max_positions = Column(Integer, nullable=False, default=3)
    
    # Risk
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

# Database engine and session
def get_db_engine():
    database_url = os.getenv('DATABASE_URL')
    if not database_url:
        raise ValueError("DATABASE_URL environment variable not set")
    
    # Fix Render's postgres:// URL to postgresql://
    if database_url.startswith('postgres://'):
        database_url = database_url.replace('postgres://', 'postgresql://', 1)
    
    return create_engine(database_url)

def get_session():
    engine = get_db_engine()
    Session = sessionmaker(bind=engine)
    return Session()

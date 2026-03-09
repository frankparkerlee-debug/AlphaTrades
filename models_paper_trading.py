"""
Paper Trading Bot Models (2.0 Agent)
Extends existing models with paper trading specific tables
"""
from sqlalchemy import Column, Integer, String, Numeric, DateTime, Boolean, Text, JSON, ForeignKey
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import relationship
from datetime import datetime
import os

Base = declarative_base()

class PaperTrade(Base):
    """Paper trading bot trades - separate from manual trades"""
    __tablename__ = 'paper_trades'
    
    id = Column(Integer, primary_key=True)
    trade_id = Column(String(50), unique=True, nullable=False)  # UUID
    
    # Source tracking
    source = Column(String(20), nullable=False, default='MACHINE_PAPER')  # vs HUMAN_REAL
    signal_id = Column(Integer, ForeignKey('signals.id'))
    
    # Entry details
    timestamp_entry = Column(DateTime(timezone=True), nullable=False)
    ticker = Column(String(10), nullable=False)
    direction = Column(String(4), nullable=False)  # CALL/PUT
    strategy = Column(String(20), nullable=False, default='V5_MOMENTUM')
    grade = Column(String(3), nullable=False)
    composite_score = Column(Integer, nullable=False)
    
    # Option details
    strike = Column(Numeric(10, 2), nullable=False)
    expiry = Column(DateTime(timezone=True), nullable=False)
    dte = Column(Integer, nullable=False)  # Days to expiry at entry
    premium_entry = Column(Numeric(10, 4), nullable=False)
    
    # Targets
    target = Column(Numeric(10, 4), nullable=False)  # Target premium
    stop = Column(Numeric(10, 4), nullable=False)  # Stop premium
    trailing_stop_activation_level = Column(Numeric(10, 4))  # When to start trailing
    trailing_stop_pct = Column(Numeric(5, 2))  # 80 = trail at 80% of HWM
    
    # Position sizing
    position_size = Column(Numeric(10, 2), nullable=False)  # Dollar amount
    quantity = Column(Integer, nullable=False, default=1)
    
    # Bot state at entry
    machine_mode = Column(String(20), nullable=False)  # CONSERVATIVE / EXPERIMENTAL
    buffer_at_entry = Column(Numeric(10, 2))  # Cumulative P&L% buffer
    
    # Snapshot
    scoring_snapshot = Column(JSON)  # Full V5 scoring breakdown
    
    # Exit details
    timestamp_exit = Column(DateTime(timezone=True))
    premium_exit = Column(Numeric(10, 4))
    exit_reason = Column(String(50))  # TARGET / STOP / TRAILING_STOP / TIME / STAGNATION / CIRCUIT_BREAKER
    
    # Performance
    pnl_pct = Column(Numeric(8, 2))  # Percentage gain/loss
    pnl_dollars = Column(Numeric(10, 2))  # Dollar gain/loss
    hwm_reached = Column(Numeric(10, 4))  # Highest premium during hold
    trail_log = Column(JSON)  # Trailing stop movements
    slippage_actual = Column(Numeric(10, 4))  # Fill vs mid price
    fill_quality = Column(String(20))  # EXCELLENT / GOOD / ACCEPTABLE / POOR
    
    # Metadata
    status = Column(String(20), nullable=False, default='OPEN')  # OPEN / CLOSED
    alpaca_order_id = Column(String(50))
    alpaca_fill_id = Column(String(50))
    
    created_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), onupdate=datetime.utcnow)
    
    # Relationship
    human_comparison = relationship("HumanComparison", back_populates="paper_trade", uselist=False)


class HumanComparison(Base):
    """Human operator comparison for each bot trade"""
    __tablename__ = 'human_comparisons'
    
    id = Column(Integer, primary_key=True)
    trade_id = Column(Integer, ForeignKey('paper_trades.id'), unique=True)
    
    # Machine decision
    machine_grade = Column(String(3), nullable=False)
    machine_decision = Column(String(20), nullable=False, default='ENTERED')
    
    # Human input (nullable, filled by operator)
    human_grade = Column(String(3))  # What grade would human have given?
    human_decision = Column(String(20))  # AGREED / HIGHER / LOWER / PASSED
    human_notes = Column(Text)  # Qualitative reasoning
    human_outcome = Column(String(20))  # BETTER / WORSE / SAME (filled after close)
    
    # Timestamps
    machine_entry_time = Column(DateTime(timezone=True), nullable=False)
    human_reviewed_at = Column(DateTime(timezone=True))
    
    # Relationship
    paper_trade = relationship("PaperTrade", back_populates="human_comparison")


class BotState(Base):
    """Paper trading bot state and config"""
    __tablename__ = 'bot_state'
    
    id = Column(Integer, primary_key=True)
    
    # Activation
    is_active = Column(Boolean, nullable=False, default=False)
    activation_time = Column(DateTime(timezone=True))
    last_heartbeat = Column(DateTime(timezone=True))
    
    # Mode
    machine_mode = Column(String(20), nullable=False, default='CONSERVATIVE')
    mode_changed_at = Column(DateTime(timezone=True))
    
    # Buffer (cumulative P&L%)
    buffer = Column(Numeric(10, 2), nullable=False, default=0.00)
    buffer_hwm = Column(Numeric(10, 2), nullable=False, default=0.00)  # High water mark
    
    # Counters
    consecutive_losses = Column(Integer, nullable=False, default=0)
    trades_today = Column(Integer, nullable=False, default=0)
    daily_pnl = Column(Numeric(10, 2), nullable=False, default=0.00)
    
    # Limits (from Step 4 Correlation Risk Agent)
    max_simultaneous_positions = Column(Integer, nullable=False, default=3)
    current_open_positions = Column(Integer, nullable=False, default=0)
    
    # Unit sizing
    unit_dollar_size = Column(Numeric(10, 2), nullable=False, default=120.00)  # $ per 1.0 unit
    
    # Circuit breaker
    is_halted = Column(Boolean, nullable=False, default=False)
    halt_reason = Column(String(100))
    halted_at = Column(DateTime(timezone=True))
    
    # Config
    config = Column(JSON)  # Full bot configuration
    
    # Last signal processed
    last_signal_timestamp = Column(DateTime(timezone=True))
    last_signal_ticker = Column(String(10))
    
    updated_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)


class BotLog(Base):
    """Detailed bot activity log"""
    __tablename__ = 'bot_logs'
    
    id = Column(Integer, primary_key=True)
    timestamp = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow, index=True)
    
    level = Column(String(10), nullable=False)  # INFO / WARNING / ERROR / CRITICAL
    category = Column(String(30), nullable=False)  # SIGNAL / ENTRY / EXIT / CIRCUIT_BREAKER / etc
    message = Column(Text, nullable=False)
    
    # Context
    ticker = Column(String(10))
    trade_id = Column(String(50))
    data = Column(JSON)  # Additional structured data
    
    created_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class ActivationChecklist(Base):
    """Graduation checklist before bot can trade"""
    __tablename__ = 'activation_checklist'
    
    id = Column(Integer, primary_key=True)
    
    # Checklist items
    graduation_status = Column(String(50))  # AUTHORIZED_FOR_PAPER_TRADING / PENDING / FAILED
    alpaca_paper_connected = Column(Boolean, default=False)
    paper_account_verified = Column(Boolean, default=False)
    buying_power_sufficient = Column(Boolean, default=False)
    signals_table_active = Column(Boolean, default=False)
    database_tables_ready = Column(Boolean, default=False)
    circuit_breaker_config_loaded = Column(Boolean, default=False)
    unit_size_confirmed = Column(Boolean, default=False)
    websocket_connected = Column(Boolean, default=False)
    dashboard_logging_active = Column(Boolean, default=False)
    reconciliation_scheduled = Column(Boolean, default=False)
    
    # Results
    all_pass = Column(Boolean, default=False)
    activated_at = Column(DateTime(timezone=True))
    
    # Details
    notes = Column(JSON)  # Detailed results for each check
    checked_by = Column(String(50))
    checked_at = Column(DateTime(timezone=True))
    
    created_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), onupdate=datetime.utcnow)

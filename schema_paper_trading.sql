-- Paper Trading Bot 2.0 Database Schema
-- Run this migration to create all new tables

-- Paper trades (bot trades separate from human)
CREATE TABLE IF NOT EXISTS paper_trades (
    id SERIAL PRIMARY KEY,
    trade_id VARCHAR(50) UNIQUE NOT NULL,
    source VARCHAR(20) NOT NULL DEFAULT 'MACHINE_PAPER',
    signal_id INTEGER REFERENCES signals(id),
    
    -- Entry
    timestamp_entry TIMESTAMPTZ NOT NULL,
    ticker VARCHAR(10) NOT NULL,
    direction VARCHAR(4) NOT NULL,
    strategy VARCHAR(20) NOT NULL DEFAULT 'V5_MOMENTUM',
    grade VARCHAR(3) NOT NULL,
    composite_score INTEGER NOT NULL,
    
    -- Option details
    strike NUMERIC(10,2) NOT NULL,
    expiry TIMESTAMPTZ NOT NULL,
    dte INTEGER NOT NULL,
    premium_entry NUMERIC(10,4) NOT NULL,
    
    -- Targets
    target NUMERIC(10,4) NOT NULL,
    stop NUMERIC(10,4) NOT NULL,
    trailing_stop_activation_level NUMERIC(10,4),
    trailing_stop_pct NUMERIC(5,2),
    
    -- Position
    position_size NUMERIC(10,2) NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    
    -- Bot state
    machine_mode VARCHAR(20) NOT NULL,
    buffer_at_entry NUMERIC(10,2),
    scoring_snapshot JSONB,
    
    -- Exit
    timestamp_exit TIMESTAMPTZ,
    premium_exit NUMERIC(10,4),
    exit_reason VARCHAR(50),
    
    -- Performance
    pnl_pct NUMERIC(8,2),
    pnl_dollars NUMERIC(10,2),
    hwm_reached NUMERIC(10,4),
    trail_log JSONB,
    slippage_actual NUMERIC(10,4),
    fill_quality VARCHAR(20),
    
    -- Metadata
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    alpaca_order_id VARCHAR(50),
    alpaca_fill_id VARCHAR(50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ
);

CREATE INDEX idx_paper_trades_ticker ON paper_trades(ticker);
CREATE INDEX idx_paper_trades_status ON paper_trades(status);
CREATE INDEX idx_paper_trades_timestamp_entry ON paper_trades(timestamp_entry);

-- Human comparison
CREATE TABLE IF NOT EXISTS human_comparisons (
    id SERIAL PRIMARY KEY,
    trade_id INTEGER REFERENCES paper_trades(id) UNIQUE,
    
    machine_grade VARCHAR(3) NOT NULL,
    machine_decision VARCHAR(20) NOT NULL DEFAULT 'ENTERED',
    
    human_grade VARCHAR(3),
    human_decision VARCHAR(20),
    human_notes TEXT,
    human_outcome VARCHAR(20),
    
    machine_entry_time TIMESTAMPTZ NOT NULL,
    human_reviewed_at TIMESTAMPTZ
);

-- Bot state
CREATE TABLE IF NOT EXISTS bot_state (
    id SERIAL PRIMARY KEY,
    
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    activation_time TIMESTAMPTZ,
    last_heartbeat TIMESTAMPTZ,
    
    machine_mode VARCHAR(20) NOT NULL DEFAULT 'CONSERVATIVE',
    mode_changed_at TIMESTAMPTZ,
    
    buffer NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    buffer_hwm NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    
    consecutive_losses INTEGER NOT NULL DEFAULT 0,
    trades_today INTEGER NOT NULL DEFAULT 0,
    daily_pnl NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    
    max_simultaneous_positions INTEGER NOT NULL DEFAULT 3,
    current_open_positions INTEGER NOT NULL DEFAULT 0,
    
    unit_dollar_size NUMERIC(10,2) NOT NULL DEFAULT 120.00,
    
    is_halted BOOLEAN NOT NULL DEFAULT FALSE,
    halt_reason VARCHAR(100),
    halted_at TIMESTAMPTZ,
    
    config JSONB,
    
    last_signal_timestamp TIMESTAMPTZ,
    last_signal_ticker VARCHAR(10),
    
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Bot logs
CREATE TABLE IF NOT EXISTS bot_logs (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    level VARCHAR(10) NOT NULL,
    category VARCHAR(30) NOT NULL,
    message TEXT NOT NULL,
    
    ticker VARCHAR(10),
    trade_id VARCHAR(50),
    data JSONB,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bot_logs_timestamp ON bot_logs(timestamp DESC);
CREATE INDEX idx_bot_logs_level ON bot_logs(level);
CREATE INDEX idx_bot_logs_ticker ON bot_logs(ticker);

-- Activation checklist
CREATE TABLE IF NOT EXISTS activation_checklist (
    id SERIAL PRIMARY KEY,
    
    graduation_status VARCHAR(50),
    alpaca_paper_connected BOOLEAN DEFAULT FALSE,
    paper_account_verified BOOLEAN DEFAULT FALSE,
    buying_power_sufficient BOOLEAN DEFAULT FALSE,
    signals_table_active BOOLEAN DEFAULT FALSE,
    database_tables_ready BOOLEAN DEFAULT FALSE,
    circuit_breaker_config_loaded BOOLEAN DEFAULT FALSE,
    unit_size_confirmed BOOLEAN DEFAULT FALSE,
    websocket_connected BOOLEAN DEFAULT FALSE,
    dashboard_logging_active BOOLEAN DEFAULT FALSE,
    reconciliation_scheduled BOOLEAN DEFAULT FALSE,
    
    all_pass BOOLEAN DEFAULT FALSE,
    activated_at TIMESTAMPTZ,
    
    notes JSONB,
    checked_by VARCHAR(50),
    checked_at TIMESTAMPTZ,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ
);

-- Trade journey tracking
CREATE TABLE IF NOT EXISTS trade_journeys (
    id SERIAL PRIMARY KEY,
    trade_id VARCHAR(50) NOT NULL,
    ticker VARCHAR(10) NOT NULL,
    
    entry_time TIMESTAMPTZ NOT NULL,
    entry_stock_price NUMERIC(10,2) NOT NULL,
    entry_option_price NUMERIC(10,4) NOT NULL,
    direction VARCHAR(4) NOT NULL,
    grade VARCHAR(3) NOT NULL,
    
    exit_time TIMESTAMPTZ,
    exit_stock_price NUMERIC(10,2),
    exit_option_price NUMERIC(10,4),
    exit_reason VARCHAR(50),
    
    hwm_stock_price NUMERIC(10,2),
    hwm_option_price NUMERIC(10,4),
    hwm_reached_at TIMESTAMPTZ,
    hwm_pct_from_entry NUMERIC(8,2),
    
    lwm_stock_price NUMERIC(10,2),
    lwm_option_price NUMERIC(10,4),
    lwm_reached_at TIMESTAMPTZ,
    lwm_pct_from_entry NUMERIC(8,2),
    
    direction_after_entry VARCHAR(10),
    time_to_first_reversal INTEGER,
    num_reversals INTEGER,
    volatility_score NUMERIC(6,2),
    
    minutes_profitable INTEGER,
    minutes_underwater INTEGER,
    max_drawdown_pct NUMERIC(8,2),
    max_runup_pct NUMERIC(8,2),
    
    price_snapshots JSONB,
    ml_features JSONB,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_trade_journeys_trade_id ON trade_journeys(trade_id);
CREATE INDEX idx_trade_journeys_ticker ON trade_journeys(ticker);

-- Backtest journeys
CREATE TABLE IF NOT EXISTS backtest_journeys (
    id SERIAL PRIMARY KEY,
    backtest_run_id VARCHAR(50) NOT NULL,
    
    ticker VARCHAR(10) NOT NULL,
    entry_date TIMESTAMPTZ NOT NULL,
    exit_date TIMESTAMPTZ,
    grade VARCHAR(3) NOT NULL,
    score INTEGER NOT NULL,
    direction VARCHAR(4) NOT NULL,
    
    entry_stock_price NUMERIC(10,2) NOT NULL,
    entry_option_price_est NUMERIC(10,4) NOT NULL,
    
    journey_data JSONB,
    
    hwm_pct NUMERIC(8,2),
    lwm_pct NUMERIC(8,2),
    direction_after_entry VARCHAR(10),
    num_reversals INTEGER,
    
    exit_stock_price NUMERIC(10,2),
    exit_option_price_est NUMERIC(10,4),
    exit_reason VARCHAR(50),
    pnl_pct NUMERIC(8,2),
    pnl_dollars NUMERIC(10,2),
    
    pattern VARCHAR(30),
    optimal_exit_pct NUMERIC(8,2),
    exit_quality VARCHAR(20),
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_backtest_journeys_run_id ON backtest_journeys(backtest_run_id);
CREATE INDEX idx_backtest_journeys_ticker ON backtest_journeys(ticker);

-- ML training data
CREATE TABLE IF NOT EXISTS ml_training_data (
    id SERIAL PRIMARY KEY,
    ticker VARCHAR(10) NOT NULL,
    
    grade VARCHAR(3) NOT NULL,
    score INTEGER NOT NULL,
    entry_time_of_day VARCHAR(10),
    day_of_week INTEGER,
    
    catalyst_score INTEGER,
    volume_score INTEGER,
    direction_score INTEGER,
    range_score INTEGER,
    timing_score INTEGER,
    
    direction_after_entry VARCHAR(10),
    time_to_hwm_minutes INTEGER,
    time_to_lwm_minutes INTEGER,
    hwm_pct NUMERIC(8,2),
    lwm_pct NUMERIC(8,2),
    
    actual_exit_pct NUMERIC(8,2),
    left_on_table_pct NUMERIC(8,2),
    avoided_drawdown_pct NUMERIC(8,2),
    
    optimal_exit_pct NUMERIC(8,2),
    optimal_exit_time INTEGER,
    
    pattern VARCHAR(30),
    volatility_class VARCHAR(20),
    
    was_profitable BOOLEAN,
    beat_target BOOLEAN,
    hit_stop BOOLEAN,
    
    features_json JSONB,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ml_training_data_ticker ON ml_training_data(ticker);
CREATE INDEX idx_ml_training_data_created ON ml_training_data(created_at DESC);

-- AlphaTrades Database Schema

-- Signals table: Cached convergence signals (pre-computed by worker)
CREATE TABLE IF NOT EXISTS signals (
    id SERIAL PRIMARY KEY,
    ticker VARCHAR(10) UNIQUE NOT NULL,
    
    -- Stock data
    price DECIMAL(10,2),
    change_pct DECIMAL(6,3),
    
    -- Convergence score
    grade VARCHAR(3),
    score INTEGER,
    convergence_count INTEGER,
    confidence VARCHAR(20),
    
    -- Full data (JSON)
    convergence_json JSONB,  -- Complete convergence breakdown
    option_json JSONB,       -- Optimal option contract
    
    -- Metadata
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_signals_ticker ON signals(ticker);
CREATE INDEX idx_signals_grade ON signals(grade);
CREATE INDEX idx_signals_updated ON signals(updated_at DESC);

-- Alerts table: Every grade calculation (continuous log)
CREATE TABLE IF NOT EXISTS alerts (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ticker VARCHAR(10) NOT NULL,
    grade VARCHAR(3) NOT NULL,
    score INTEGER NOT NULL,
    stock_price DECIMAL(10,2) NOT NULL,
    open_price DECIMAL(10,2) NOT NULL,
    high_price DECIMAL(10,2) NOT NULL,
    low_price DECIMAL(10,2) NOT NULL,
    move_pct DECIMAL(6,3) NOT NULL,
    range_pct DECIMAL(6,3) NOT NULL,
    direction VARCHAR(4) NOT NULL,  -- CALL or PUT
    strike DECIMAL(10,2) NOT NULL,
    expiration DATE NOT NULL,
    market_trend VARCHAR(10) NOT NULL,  -- UP or DOWN
    spy_price DECIMAL(10,2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_alerts_timestamp ON alerts(timestamp DESC);
CREATE INDEX idx_alerts_ticker_grade ON alerts(ticker, grade);
CREATE INDEX idx_alerts_grade ON alerts(grade);

-- Trades table: Executed positions (paper or real)
CREATE TABLE IF NOT EXISTS trades (
    id SERIAL PRIMARY KEY,
    alert_id INTEGER REFERENCES alerts(id),
    
    -- Entry
    ticker VARCHAR(10) NOT NULL,
    direction VARCHAR(4) NOT NULL,
    strike DECIMAL(10,2) NOT NULL,
    expiration DATE NOT NULL,
    entry_time TIMESTAMPTZ NOT NULL,
    entry_option_price DECIMAL(10,2) NOT NULL,
    entry_stock_price DECIMAL(10,2) NOT NULL,
    position_size DECIMAL(10,2) NOT NULL,  -- Dollar amount
    quantity INTEGER NOT NULL DEFAULT 1,
    grade VARCHAR(3) NOT NULL,
    
    -- Exit
    exit_time TIMESTAMPTZ,
    exit_option_price DECIMAL(10,2),
    exit_stock_price DECIMAL(10,2),
    exit_reason VARCHAR(50),  -- friday_close, max_hold, stop_loss, target_hit, manual
    
    -- Performance
    profit_loss DECIMAL(10,2),
    profit_loss_pct DECIMAL(6,2),
    hold_hours INTEGER,
    hold_days INTEGER,
    
    -- Metadata
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN',  -- OPEN, CLOSED, EXPIRED
    trading_mode VARCHAR(10) NOT NULL DEFAULT 'paper',  -- paper, live
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_trades_status ON trades(status);
CREATE INDEX idx_trades_ticker ON trades(ticker);
CREATE INDEX idx_trades_grade ON trades(grade);
CREATE INDEX idx_trades_entry_time ON trades(entry_time DESC);

-- Daily performance: Aggregated metrics
CREATE TABLE IF NOT EXISTS daily_performance (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL UNIQUE,
    
    -- Alerts
    total_alerts INTEGER NOT NULL DEFAULT 0,
    alerts_a_plus INTEGER NOT NULL DEFAULT 0,
    alerts_a INTEGER NOT NULL DEFAULT 0,
    alerts_a_minus INTEGER NOT NULL DEFAULT 0,
    alerts_b_plus INTEGER NOT NULL DEFAULT 0,
    alerts_b INTEGER NOT NULL DEFAULT 0,
    alerts_b_minus INTEGER NOT NULL DEFAULT 0,
    
    -- Trades
    trades_opened INTEGER NOT NULL DEFAULT 0,
    trades_closed INTEGER NOT NULL DEFAULT 0,
    trades_won INTEGER NOT NULL DEFAULT 0,
    trades_lost INTEGER NOT NULL DEFAULT 0,
    
    -- Performance
    win_rate DECIMAL(5,2),
    total_profit_loss DECIMAL(10,2),
    avg_profit_loss DECIMAL(10,2),
    best_trade_pl DECIMAL(10,2),
    worst_trade_pl DECIMAL(10,2),
    
    -- Cumulative
    cumulative_pl DECIMAL(10,2),
    account_balance DECIMAL(10,2),
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_daily_performance_date ON daily_performance(date DESC);

-- Model configuration: Optimizable thresholds and parameters
CREATE TABLE IF NOT EXISTS model_config (
    id SERIAL PRIMARY KEY,
    config_name VARCHAR(50) NOT NULL UNIQUE,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    
    -- Grade thresholds
    threshold_a_plus INTEGER NOT NULL DEFAULT 50,
    threshold_a INTEGER NOT NULL DEFAULT 47,
    threshold_a_minus INTEGER NOT NULL DEFAULT 45,
    threshold_b_plus INTEGER NOT NULL DEFAULT 41,
    threshold_b INTEGER NOT NULL DEFAULT 38,
    threshold_b_minus INTEGER NOT NULL DEFAULT 35,
    
    -- Scoring weights
    weight_momentum INTEGER NOT NULL DEFAULT 25,
    weight_range INTEGER NOT NULL DEFAULT 15,
    weight_volume INTEGER NOT NULL DEFAULT 5,
    weight_market INTEGER NOT NULL DEFAULT 10,
    
    -- Trading parameters
    auto_trade_grades TEXT[] NOT NULL DEFAULT ARRAY['A+', 'A'],
    position_size_pct DECIMAL(5,3) NOT NULL DEFAULT 0.20,
    max_positions INTEGER NOT NULL DEFAULT 3,
    
    -- Risk management
    stop_loss_pct DECIMAL(5,2) NOT NULL DEFAULT -30.00,
    target_profit_pct DECIMAL(5,2) NOT NULL DEFAULT 50.00,
    max_hold_days INTEGER NOT NULL DEFAULT 5,
    
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert default configuration
INSERT INTO model_config (
    config_name, is_active, notes
) VALUES (
    'default_strategy_1',
    TRUE,
    'Initial Strategy 1 configuration - Momentum plays on tech stocks'
) ON CONFLICT (config_name) DO NOTHING;

-- Account state: Track capital and positions
CREATE TABLE IF NOT EXISTS account_state (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    starting_capital DECIMAL(10,2) NOT NULL DEFAULT 600.00,
    current_capital DECIMAL(10,2) NOT NULL DEFAULT 600.00,
    open_positions_value DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    total_value DECIMAL(10,2) NOT NULL DEFAULT 600.00,
    cumulative_pl DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    total_trades INTEGER NOT NULL DEFAULT 0,
    winning_trades INTEGER NOT NULL DEFAULT 0,
    losing_trades INTEGER NOT NULL DEFAULT 0
);

-- Insert initial account state
INSERT INTO account_state (starting_capital, current_capital, total_value)
VALUES (600.00, 600.00, 600.00);

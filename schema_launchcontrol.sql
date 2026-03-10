-- Launch Control v2.0 Database Schema
-- Equity profiles and signals tables for momentum scoring engine

-- Equity profiles: Ticker-specific normalization data
-- Updated nightly from 60 days of historical data
CREATE TABLE IF NOT EXISTS equity_profiles (
    id SERIAL PRIMARY KEY,
    ticker VARCHAR(10) UNIQUE NOT NULL,
    
    -- Price volatility
    atr DECIMAL(10,4) NOT NULL,  -- 20-day ATR
    atr_pct DECIMAL(6,3),  -- ATR as % of price
    
    -- Volume baseline
    vol_baseline BIGINT NOT NULL,  -- 20-day average volume
    vol_std BIGINT,  -- Volume standard deviation
    
    -- Market relationships
    beta DECIMAL(6,3) NOT NULL DEFAULT 1.0,  -- Beta vs QQQ
    sector_etf VARCHAR(10),  -- XLK, SMH, XLY, XLC
    sector_correlation DECIMAL(6,3) NOT NULL DEFAULT 0.5,  -- Correlation with sector ETF
    
    -- Momentum characteristics
    persistence DECIMAL(6,3) NOT NULL DEFAULT 0.7,  -- Momentum persistence score
    vol_correlation DECIMAL(6,3) NOT NULL DEFAULT 0.6,  -- Price-volume correlation
    
    -- News sensitivity
    news_sensitivity DECIMAL(6,3) NOT NULL DEFAULT 1.0,  -- News impact multiplier
    
    -- Metadata
    last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    data_start_date DATE,  -- Start of 60-day window
    data_end_date DATE,  -- End of 60-day window
    bars_analyzed INTEGER,  -- Number of bars in calculation
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_equity_profiles_ticker ON equity_profiles(ticker);
CREATE INDEX idx_equity_profiles_updated ON equity_profiles(last_updated DESC);
CREATE INDEX idx_equity_profiles_sector ON equity_profiles(sector_etf);

-- Insert default profiles for 15 ticker universe
INSERT INTO equity_profiles (ticker, atr, vol_baseline, beta, sector_etf, sector_correlation, persistence, news_sensitivity, atr_pct) VALUES
('NVDA', 8.50, 300000000, 1.82, 'SMH', 0.84, 0.82, 1.15, 3.8),
('TSLA', 9.20, 120000000, 1.95, 'XLY', 0.44, 0.65, 1.25, 4.5),
('AMD', 5.40, 85000000, 1.68, 'SMH', 0.84, 0.74, 1.10, 3.5),
('META', 13.80, 18000000, 1.42, 'XLK', 0.72, 0.78, 1.28, 2.8),
('NFLX', 22.50, 5500000, 1.35, 'XLC', 0.68, 0.70, 1.53, 3.2),
('AAPL', 3.40, 55000000, 1.18, 'XLK', 0.81, 0.83, 0.95, 1.8),
('MSFT', 8.20, 22000000, 1.12, 'XLK', 0.79, 0.87, 0.92, 1.9),
('GOOGL', 3.70, 25000000, 1.25, 'XLK', 0.76, 0.81, 1.05, 2.2),
('AMZN', 5.10, 42000000, 1.38, 'XLY', 0.58, 0.75, 1.08, 2.6),
('INTC', 1.20, 48000000, 0.98, 'SMH', 0.71, 0.68, 1.15, 2.9),
('CRM', 8.70, 6500000, 1.28, 'XLK', 0.74, 0.76, 1.12, 2.8),
('ORCL', 3.20, 7800000, 1.05, 'XLK', 0.70, 0.79, 0.98, 2.3),
('AVGO', 25.40, 2200000, 1.45, 'SMH', 0.77, 0.80, 1.08, 2.5),
('QCOM', 4.90, 8500000, 1.32, 'SMH', 0.75, 0.77, 1.05, 2.6)
ON CONFLICT (ticker) DO NOTHING;

-- LaunchControl signals table (v2.0 structure)
CREATE TABLE IF NOT EXISTS launchcontrol_signals (
    id SERIAL PRIMARY KEY,
    ticker VARCHAR(10) NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Score components
    raw_score DECIMAL(6,2) NOT NULL,
    timing_score DECIMAL(5,2) NOT NULL,
    pa_score DECIMAL(5,2) NOT NULL,
    vol_score DECIMAL(5,2) NOT NULL,
    news_score DECIMAL(5,2) NOT NULL,
    market_score DECIMAL(5,2) NOT NULL,
    announcement_bonus INTEGER DEFAULT 0,
    
    -- Grade and filters
    grade VARCHAR(3) NOT NULL,
    grade_reason TEXT,
    asymmetry_gate_passed BOOLEAN NOT NULL,
    primary_filter_passed BOOLEAN NOT NULL,
    base_layer_eligible BOOLEAN NOT NULL,
    
    -- Trade setup
    direction VARCHAR(4) NOT NULL,  -- CALL or PUT
    position_size_pct DECIMAL(5,3),
    current_price DECIMAL(10,2),
    atr_multiple DECIMAL(6,3),
    rel_volume DECIMAL(6,3),
    
    -- Conflict flags
    conflict_flags TEXT[],  -- Array of conflict flag names
    
    -- Full data (JSON)
    breakdown JSONB,  -- Complete pillar breakdown
    trade_setup JSONB,  -- Entry details
    exit_strategy JSONB,  -- Exit plan by grade
    
    -- Signal lifecycle
    status VARCHAR(20) DEFAULT 'ACTIVE',  -- ACTIVE, EXPIRED, TAKEN, SKIPPED
    expired_at TIMESTAMPTZ,
    
    -- Human override tracking
    human_action VARCHAR(20),  -- TOOK, SKIPPED, IGNORED
    human_action_at TIMESTAMPTZ,
    human_notes TEXT,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_lc_signals_ticker ON launchcontrol_signals(ticker);
CREATE INDEX idx_lc_signals_timestamp ON launchcontrol_signals(timestamp DESC);
CREATE INDEX idx_lc_signals_grade ON launchcontrol_signals(grade);
CREATE INDEX idx_lc_signals_status ON launchcontrol_signals(status);
CREATE INDEX idx_lc_signals_asymmetry ON launchcontrol_signals(asymmetry_gate_passed);
CREATE INDEX idx_lc_signals_active ON launchcontrol_signals(status, timestamp DESC) WHERE status = 'ACTIVE';

-- LaunchControl trades table
CREATE TABLE IF NOT EXISTS launchcontrol_trades (
    id SERIAL PRIMARY KEY,
    signal_id INTEGER REFERENCES launchcontrol_signals(id),
    
    -- Entry
    ticker VARCHAR(10) NOT NULL,
    direction VARCHAR(4) NOT NULL,
    strike DECIMAL(10,2) NOT NULL,
    expiration DATE NOT NULL,
    entry_time TIMESTAMPTZ NOT NULL,
    entry_option_price DECIMAL(10,2) NOT NULL,
    entry_stock_price DECIMAL(10,2) NOT NULL,
    position_size_dollars DECIMAL(10,2) NOT NULL,
    position_size_pct DECIMAL(5,3) NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    grade VARCHAR(3) NOT NULL,
    
    -- Exit tranches
    exit_t1_time TIMESTAMPTZ,
    exit_t1_price DECIMAL(10,2),
    exit_t1_pct DECIMAL(5,2),  -- % of position
    exit_t1_reason VARCHAR(100),
    
    exit_t2_time TIMESTAMPTZ,
    exit_t2_price DECIMAL(10,2),
    exit_t2_pct DECIMAL(5,2),
    exit_t2_reason VARCHAR(100),
    
    exit_t3_time TIMESTAMPTZ,
    exit_t3_price DECIMAL(10,2),
    exit_t3_pct DECIMAL(5,2),
    exit_t3_reason VARCHAR(100),
    
    -- Stop loss
    stop_time TIMESTAMPTZ,
    stop_price DECIMAL(10,2),
    stop_reason VARCHAR(100),
    
    -- Performance
    total_profit_loss DECIMAL(10,2),
    total_profit_loss_pct DECIMAL(6,2),
    realized_pl DECIMAL(10,2),  -- From closed tranches
    unrealized_pl DECIMAL(10,2),  -- From open tranches
    hold_minutes INTEGER,
    max_gain_pct DECIMAL(6,2),  -- Peak gain during trade
    max_loss_pct DECIMAL(6,2),  -- Worst drawdown
    
    -- Status
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN',  -- OPEN, CLOSED, STOPPED
    remaining_pct DECIMAL(5,2) DEFAULT 1.0,  -- % of position still open
    
    -- Metadata
    trading_mode VARCHAR(10) NOT NULL DEFAULT 'paper',  -- paper, live
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_lc_trades_ticker ON launchcontrol_trades(ticker);
CREATE INDEX idx_lc_trades_status ON launchcontrol_trades(status);
CREATE INDEX idx_lc_trades_grade ON launchcontrol_trades(grade);
CREATE INDEX idx_lc_trades_entry_time ON launchcontrol_trades(entry_time DESC);
CREATE INDEX idx_lc_trades_signal ON launchcontrol_trades(signal_id);

-- Daily performance tracking
CREATE TABLE IF NOT EXISTS launchcontrol_daily (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL UNIQUE,
    
    -- Signal counts
    total_signals INTEGER DEFAULT 0,
    primary_signals INTEGER DEFAULT 0,
    base_layer_signals INTEGER DEFAULT 0,
    signals_a_plus INTEGER DEFAULT 0,
    signals_a INTEGER DEFAULT 0,
    signals_a_minus INTEGER DEFAULT 0,
    signals_b_plus INTEGER DEFAULT 0,
    signals_b INTEGER DEFAULT 0,
    
    -- Trades
    trades_taken INTEGER DEFAULT 0,
    trades_closed INTEGER DEFAULT 0,
    trades_won INTEGER DEFAULT 0,
    trades_lost INTEGER DEFAULT 0,
    
    -- Performance
    daily_pl DECIMAL(10,2) DEFAULT 0,
    daily_pl_pct DECIMAL(6,3) DEFAULT 0,
    win_rate DECIMAL(5,2),
    
    -- Capital
    starting_capital DECIMAL(10,2),
    ending_capital DECIMAL(10,2),
    peak_capital DECIMAL(10,2),
    max_drawdown_pct DECIMAL(6,3),
    
    -- Circuit breakers
    circuit_breaker_triggered VARCHAR(50),  -- DAILY_LOSS, CONSECUTIVE_LOSS, VIX_SPIKE, LOCK_IN
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_lc_daily_date ON launchcontrol_daily(date DESC);

-- Account state for circuit breakers
CREATE TABLE IF NOT EXISTS launchcontrol_account (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Capital
    starting_capital DECIMAL(10,2) NOT NULL DEFAULT 600.00,
    current_capital DECIMAL(10,2) NOT NULL,
    deployed_capital DECIMAL(10,2) NOT NULL DEFAULT 0,
    
    -- Position limits
    open_positions INTEGER DEFAULT 0,
    max_positions INTEGER DEFAULT 2,
    max_deployment_pct DECIMAL(5,3) DEFAULT 0.30,  -- 30%
    
    -- Circuit breakers
    consecutive_losses INTEGER DEFAULT 0,
    daily_pl_today DECIMAL(10,2) DEFAULT 0,
    daily_pl_pct DECIMAL(6,3) DEFAULT 0,
    circuit_breaker_active BOOLEAN DEFAULT FALSE,
    circuit_breaker_type VARCHAR(50),
    size_reduction_active BOOLEAN DEFAULT FALSE,  -- 50% size after 3 losses
    
    -- Trading state
    trading_halted BOOLEAN DEFAULT FALSE,
    halt_reason VARCHAR(100),
    
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert initial account state
INSERT INTO launchcontrol_account (starting_capital, current_capital) 
VALUES (600.00, 600.00)
ON CONFLICT DO NOTHING;

-- Human override comparison (for graduation gates)
CREATE TABLE IF NOT EXISTS launchcontrol_human_comparison (
    id SERIAL PRIMARY KEY,
    signal_id INTEGER REFERENCES launchcontrol_signals(id),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Machine decision
    machine_grade VARCHAR(3) NOT NULL,
    machine_score DECIMAL(6,2) NOT NULL,
    machine_decision VARCHAR(20),  -- TRADE, SKIP
    
    -- Human decision
    human_decision VARCHAR(20) NOT NULL,  -- TOOK, SKIPPED, AGREED, DISAGREED
    human_grade_override VARCHAR(3),  -- If human overrode the grade
    human_reason TEXT,
    
    -- Outcome (filled later)
    outcome VARCHAR(20),  -- WIN, LOSS, SCRATCH
    outcome_pl DECIMAL(10,2),
    outcome_pl_pct DECIMAL(6,2),
    
    -- Who was right?
    correct_decision VARCHAR(20),  -- MACHINE, HUMAN, BOTH, TBD
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_lc_human_timestamp ON launchcontrol_human_comparison(timestamp DESC);
CREATE INDEX idx_lc_human_signal ON launchcontrol_human_comparison(signal_id);

-- Add signals table for cached convergence data
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
    convergence_json JSONB,
    option_json JSONB,
    
    -- Metadata
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signals_ticker ON signals(ticker);
CREATE INDEX IF NOT EXISTS idx_signals_grade ON signals(grade);
CREATE INDEX IF NOT EXISTS idx_signals_updated ON signals(updated_at DESC);

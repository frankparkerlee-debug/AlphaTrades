/**
 * Migration: Create feedback loop tables
 * Run: node scripts/migrate-feedback.js
 */
import { query } from '../src/data/db.js';

console.log('Creating feedback loop tables...');

// Daily performance summary
await query(`
  CREATE TABLE IF NOT EXISTS lc_v3.daily_performance (
    date DATE PRIMARY KEY,
    total_signals INT DEFAULT 0,
    signals_taken INT DEFAULT 0,
    wins INT DEFAULT 0,
    losses INT DEFAULT 0,
    win_rate NUMERIC,
    total_pnl_pct NUMERIC,
    total_pnl_dollars NUMERIC,
    best_trade JSONB,
    worst_trade JSONB,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`);
console.log('✓ lc_v3.daily_performance');

// Signal outcome feedback — links signals to actual results
await query(`
  CREATE TABLE IF NOT EXISTS lc_v3.signal_feedback (
    id SERIAL PRIMARY KEY,
    signal_id UUID REFERENCES lc_v3.signals(signal_id),
    outcome TEXT CHECK (outcome IN ('WIN','LOSS','SCRATCH','SKIPPED')),
    entry_price NUMERIC,
    exit_price NUMERIC,
    pnl_pct NUMERIC,
    pnl_dollars NUMERIC,
    hold_minutes INT,
    exit_reason TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`);
console.log('✓ lc_v3.signal_feedback');

// Grade accuracy tracking — how well does each grade predict outcomes
await query(`
  CREATE TABLE IF NOT EXISTS lc_v3.grade_accuracy (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL,
    grade TEXT NOT NULL,
    total INT DEFAULT 0,
    wins INT DEFAULT 0,
    win_rate NUMERIC,
    avg_pnl_pct NUMERIC,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`);

await query(`
  CREATE INDEX IF NOT EXISTS idx_grade_accuracy_date
  ON lc_v3.grade_accuracy(date DESC)
`);
console.log('✓ lc_v3.grade_accuracy');

console.log('Migration complete.');
process.exit(0);

/**
 * Migration: Add momentum tracking columns to lc_v3.signals
 * Run: node scripts/migrate-momentum.js
 */
import { query } from '../src/data/db.js';

console.log('Adding momentum columns to lc_v3.signals...');

await query(`
  ALTER TABLE lc_v3.signals
    ADD COLUMN IF NOT EXISTS first_seen_at       TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_confirmed_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS confirmation_count  INTEGER DEFAULT 1,
    ADD COLUMN IF NOT EXISTS peak_composite      INTEGER,
    ADD COLUMN IF NOT EXISTS peak_grade          VARCHAR(3),
    ADD COLUMN IF NOT EXISTS composite_history   JSONB DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS momentum_trend      VARCHAR(16)
`);

console.log('Done. Backfilling existing signals...');

// Backfill: set first_seen_at and peak values for existing rows
await query(`
  UPDATE lc_v3.signals
  SET first_seen_at    = COALESCE(first_seen_at, created_at),
      last_confirmed_at = COALESCE(last_confirmed_at, created_at),
      peak_composite   = COALESCE(peak_composite, composite_raw),
      peak_grade       = COALESCE(peak_grade, grade)
  WHERE first_seen_at IS NULL
`);

console.log('Migration complete.');
process.exit(0);

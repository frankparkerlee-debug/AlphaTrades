/**
 * Migration: Add contract columns to lc_v3.signals
 * Run: node scripts/migrate-contracts.js
 */
import { query } from '../src/data/db.js';

console.log('Adding contract columns to lc_v3.signals...');

await query(`
  ALTER TABLE lc_v3.signals
    ADD COLUMN IF NOT EXISTS contract_symbol      TEXT,
    ADD COLUMN IF NOT EXISTS contract_strike      NUMERIC,
    ADD COLUMN IF NOT EXISTS contract_expiry      DATE,
    ADD COLUMN IF NOT EXISTS contract_expiry_label TEXT,
    ADD COLUMN IF NOT EXISTS contract_bid         NUMERIC,
    ADD COLUMN IF NOT EXISTS contract_ask         NUMERIC,
    ADD COLUMN IF NOT EXISTS contract_mid         NUMERIC,
    ADD COLUMN IF NOT EXISTS contract_entry_lo    NUMERIC,
    ADD COLUMN IF NOT EXISTS contract_entry_hi    NUMERIC,
    ADD COLUMN IF NOT EXISTS contract_delta       NUMERIC,
    ADD COLUMN IF NOT EXISTS contract_iv          NUMERIC,
    ADD COLUMN IF NOT EXISTS contract_t1          NUMERIC,
    ADD COLUMN IF NOT EXISTS contract_t2          NUMERIC,
    ADD COLUMN IF NOT EXISTS contract_t3          NUMERIC,
    ADD COLUMN IF NOT EXISTS contract_stop        NUMERIC,
    ADD COLUMN IF NOT EXISTS contract_estimated   BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS human_entry_price    NUMERIC,
    ADD COLUMN IF NOT EXISTS human_exit_price     NUMERIC,
    ADD COLUMN IF NOT EXISTS human_notes          TEXT
`);

console.log('✓ Contract columns added');
process.exit(0);

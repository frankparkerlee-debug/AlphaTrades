/**
 * Migration: Add auto_traded column to lc_v3.signals table
 * Run: node scripts/migrate-auto-trader.js
 */

import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function migrate() {
  console.log('Adding auto_traded column to lc_v3.signals...');

  await db.query(`
    ALTER TABLE lc_v3.signals
    ADD COLUMN IF NOT EXISTS auto_traded BOOLEAN DEFAULT false
  `);
  console.log('  -> auto_traded column added');

  // Also add auto_traded to paper_trades if it doesn't exist
  await db.query(`
    ALTER TABLE lc_v3.paper_trades
    ADD COLUMN IF NOT EXISTS auto_traded BOOLEAN DEFAULT false
  `);
  console.log('  -> auto_traded column added to paper_trades');

  console.log('Migration complete.');
  await db.end();
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});

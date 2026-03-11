import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function verify() {
  const client = await pool.connect();
  try {
    // 1. Basic connection
    const res = await client.query('SELECT NOW() as time');
    console.log('✓ DB connected:', res.rows[0].time);

    // 2. Schema exists
    const schema = await client.query(`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name = 'lc_v3'
    `);
    if (schema.rows.length === 0) {
      console.log('⚠ Schema lc_v3 does not exist yet — run npm run migrate first');
      return;
    }
    console.log('✓ Schema lc_v3 exists');

    // 3. Table count
    const tables = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'lc_v3'
      ORDER BY table_name
    `);
    console.log(`✓ Tables found (${tables.rows.length}):`);
    tables.rows.forEach(r => console.log(`   - ${r.table_name}`));

    // 4. Equity profiles count
    const profiles = await client.query(`SELECT COUNT(*) FROM lc_v3.equity_profiles`);
    console.log(`✓ Equity profiles: ${profiles.rows[0].count}`);

    // 5. Check window baselines for NVDA
    const nvda = await client.query(`
      SELECT ticker, avg_vol_by_window, last_updated
      FROM lc_v3.equity_profiles WHERE ticker = 'NVDA'
    `);
    if (nvda.rows.length > 0) {
      const windows = Object.keys(nvda.rows[0].avg_vol_by_window || {});
      console.log(`✓ NVDA window baselines: ${windows.length} windows seeded`);
      if (windows.length < 26) {
        console.log('⚠ NVDA has fewer than 26 windows — run npm run update-profiles');
      }
    } else {
      console.log('⚠ NVDA profile not seeded yet — run npm run seed then npm run update-profiles');
    }

    // 6. Recent signals
    const signals = await client.query(`
      SELECT COUNT(*), MIN(composite_raw) as min_score
      FROM lc_v3.signals
      WHERE composite_raw < 0
    `);
    const negatives = parseInt(signals.rows[0].count);
    if (negatives > 0) {
      console.log(`❌ CRITICAL: ${negatives} signals with negative composite_raw found!`);
    } else {
      console.log('✓ No negative composite scores');
    }

    console.log('\n✅ Verification complete');

  } catch (err) {
    console.error('❌ Verification failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

verify().catch(err => {
  console.error(err);
  process.exit(1);
});

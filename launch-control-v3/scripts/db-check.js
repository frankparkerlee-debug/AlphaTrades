import 'dotenv/config';
import { query } from '../src/data/db.js';

try {
  const r1 = await query('SELECT COUNT(*)::int as count FROM lc_v3.paper_trades WHERE auto_traded = true');
  console.log('auto_traded paper trades:', r1.rows[0].count);

  const r2 = await query("SELECT ticker FROM lc_v3.conviction_universe WHERE ticker = 'TTD'");
  console.log('TTD in conviction_universe:', r2.rows.length > 0 ? 'YES' : 'NO');

  const r3 = await query("SELECT COUNT(*)::int as count FROM lc_v3.volume_baselines WHERE ticker = 'TTD'");
  console.log('TTD volume baselines:', r3.rows[0].count);

  const r4 = await query("SELECT COUNT(*)::int as count FROM lc_v3.bars WHERE ticker = 'TTD' AND ts >= NOW() - INTERVAL '3 days'");
  console.log('TTD bars (last 3 days):', r4.rows[0].count);

  const r5 = await query("SELECT column_name FROM information_schema.columns WHERE table_schema='lc_v3' AND table_name='paper_trades' AND column_name='auto_traded'");
  console.log('auto_traded column exists:', r5.rows.length > 0 ? 'YES' : 'NO');
} catch (err) {
  console.error('Error:', err.message);
}

process.exit(0);

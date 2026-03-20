const pg = require('pg');
const pool = new pg.Pool({
  connectionString: 'postgresql://alphatrades_db_user:kY5KYLQ16AQ43Ylp5foW0enqfSyiCZxK@dpg-d6kak47kijhs73cat0o0-a.oregon-postgres.render.com/alphatrades_db',
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const sigRes = await pool.query(`
    SELECT signal_id, ticker, direction, status, price_at_signal, news_headline, created_at,
           spy_change_pct, qqq_change_pct, relative_volume
    FROM lc_v3.signals
    WHERE DATE(created_at AT TIME ZONE 'America/New_York') = CURRENT_DATE
    ORDER BY created_at
  `);

  for (const s of sigRes.rows) {
    const hl = s.news_headline || '';
    const strategy = (hl.match(/strategy=(\w+)/) || [])[1] || 'UNKNOWN';
    const gapPct = (hl.match(/gap=([0-9.\-]+)%/) || [])[1] || '--';
    const t1 = (hl.match(/T1=\$([0-9.]+)/) || [])[1] || '--';
    const t2 = (hl.match(/T2=\$([0-9.]+)/) || [])[1] || '--';
    const stop = (hl.match(/stop=\$([0-9.]+)/) || [])[1] || '--';
    const volRatio = (hl.match(/volRatio=([0-9.]+)x/) || [])[1] || '--';
    const sigTime = new Date(s.created_at);

    console.log('\n' + '='.repeat(90));
    console.log(`  ${s.ticker} ${s.direction} — ${strategy} — ${s.status}`);
    console.log('='.repeat(90));
    console.log(`  Created:        ${sigTime.toISOString()}`);
    console.log(`  Entry price:    $${s.price_at_signal}`);
    console.log(`  Gap %:          ${gapPct}%`);
    console.log(`  Vol ratio:      ${volRatio}x`);
    console.log(`  SPY change:     ${s.spy_change_pct ? (parseFloat(s.spy_change_pct)*100).toFixed(2) + '%' : '--'}`);
    console.log(`  QQQ change:     ${s.qqq_change_pct ? (parseFloat(s.qqq_change_pct)*100).toFixed(2) + '%' : '--'}`);
    console.log(`  Targets:        T1=$${t1}  T2=$${t2}  stop=$${stop}`);
    console.log(`  Headline:       ${hl.slice(0, 120)}`);

    // Get prev close (last bar before today's open)
    const prevCloseRes = await pool.query(`
      SELECT close, ts FROM lc_v3.bars
      WHERE ticker = $1
        AND ts < DATE_TRUNC('day', $2::timestamptz AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York'
      ORDER BY ts DESC LIMIT 1
    `, [s.ticker, s.created_at]);

    if (prevCloseRes.rows.length > 0) {
      const pc = prevCloseRes.rows[0];
      console.log(`\n  Prev close:     $${parseFloat(pc.close).toFixed(2)} (${new Date(pc.ts).toISOString().slice(0,16)})`);
    } else {
      console.log('\n  Prev close:     NOT FOUND');
    }

    // Get today's first bar (open bar) for this ticker
    const firstBarRes = await pool.query(`
      SELECT open, high, low, close, volume, ts FROM lc_v3.bars
      WHERE ticker = $1
        AND ts >= DATE_TRUNC('day', $2::timestamptz AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York'
      ORDER BY ts ASC LIMIT 1
    `, [s.ticker, s.created_at]);

    if (firstBarRes.rows.length > 0) {
      const fb = firstBarRes.rows[0];
      console.log(`  First candle:   open=$${parseFloat(fb.open).toFixed(2)} close=$${parseFloat(fb.close).toFixed(2)} high=$${parseFloat(fb.high).toFixed(2)} low=$${parseFloat(fb.low).toFixed(2)} vol=${parseInt(fb.volume).toLocaleString()} (${new Date(fb.ts).toISOString().slice(11,16)} UTC)`);
      const isRed = parseFloat(fb.close) < parseFloat(fb.open);
      console.log(`  First candle:   ${isRed ? 'RED (close < open)' : 'GREEN (close >= open)'}`);

      // Compute gap from prev close
      if (prevCloseRes.rows.length > 0) {
        const prevClose = parseFloat(prevCloseRes.rows[0].close);
        const todayOpen = parseFloat(fb.open);
        const computedGap = ((todayOpen - prevClose) / prevClose * 100).toFixed(2);
        console.log(`  Computed gap:   ${computedGap}% (open $${todayOpen.toFixed(2)} vs prevClose $${prevClose.toFixed(2)})`);
      }
    } else {
      console.log('  First candle:   NOT FOUND');
    }

    // Get bars from 30min before to 60min after signal
    const t0 = new Date(sigTime.getTime() - 30 * 60000);
    const t1end = new Date(sigTime.getTime() + 60 * 60000);

    const barsRes = await pool.query(`
      SELECT open, high, low, close, volume, ts FROM lc_v3.bars
      WHERE ticker = $1 AND ts >= $2 AND ts <= $3
      ORDER BY ts ASC
    `, [s.ticker, t0.toISOString(), t1end.toISOString()]);

    console.log(`\n  ── BARS (${barsRes.rows.length}) from ${t0.toISOString().slice(11,16)} to ${t1end.toISOString().slice(11,16)} UTC ──`);
    console.log('  ' + 'TIME'.padEnd(8) + 'OPEN'.padStart(10) + 'HIGH'.padStart(10) + 'LOW'.padStart(10) + 'CLOSE'.padStart(10) + 'VOLUME'.padStart(12) + '  NOTE');
    console.log('  ' + '-'.repeat(72));

    for (const b of barsRes.rows) {
      const bTime = new Date(b.ts);
      const timeStr = bTime.toISOString().slice(11, 16);
      const isSignalBar = Math.abs(bTime.getTime() - sigTime.getTime()) < 5 * 60000;
      const note = isSignalBar ? ' ← SIGNAL' : '';
      console.log('  ' +
        timeStr.padEnd(8) +
        ('$' + parseFloat(b.open).toFixed(2)).padStart(10) +
        ('$' + parseFloat(b.high).toFixed(2)).padStart(10) +
        ('$' + parseFloat(b.low).toFixed(2)).padStart(10) +
        ('$' + parseFloat(b.close).toFixed(2)).padStart(10) +
        parseInt(b.volume).toLocaleString().padStart(12) +
        note
      );
    }

    // Also get SPY bars around signal time
    const spyBarsRes = await pool.query(`
      SELECT open, close, ts FROM lc_v3.bars
      WHERE ticker = 'SPY' AND ts >= $1 AND ts <= $2
      ORDER BY ts ASC LIMIT 5
    `, [t0.toISOString(), t1end.toISOString()]);

    if (spyBarsRes.rows.length > 0) {
      console.log('\n  ── SPY CONTEXT ──');
      for (const b of spyBarsRes.rows) {
        const timeStr = new Date(b.ts).toISOString().slice(11, 16);
        const chg = ((parseFloat(b.close) - parseFloat(b.open)) / parseFloat(b.open) * 100).toFixed(2);
        console.log('  ' + timeStr + '  open=$' + parseFloat(b.open).toFixed(2) + '  close=$' + parseFloat(b.close).toFixed(2) + '  chg=' + chg + '%');
      }
    }
  }

  await pool.end();
}
run().catch(e => { console.error(e); process.exit(1); });

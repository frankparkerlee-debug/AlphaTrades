export default function DailyPnL({ signals }) {
  const taken = signals.filter(s => s.human_taken === true);
  const wins  = taken.filter(s => (s.human_pnl_pct || 0) > 0);
  const losses = taken.filter(s => (s.human_pnl_pct || 0) < 0);

  const totalPnlPct = taken.reduce((sum, s) => sum + (s.human_pnl_pct || 0), 0);
  const winRate = taken.length > 0 ? wins.length / taken.length : 0;

  const accountSize = 7500; // default
  const pnlDollars = accountSize * totalPnlPct;

  const pnlColor = totalPnlPct > 0 ? 'var(--green)' : totalPnlPct < 0 ? 'var(--red)' : 'var(--text-muted)';

  const todaySignals = signals.length;
  const activeSignals = signals.filter(s => s.status === 'ACTIVE').length;

  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border)',
      borderRadius: 6, padding: 12,
    }}>
      <div style={{
        fontSize: 9, fontWeight: 700, letterSpacing: 1.5,
        color: 'var(--text-muted)', fontFamily: 'var(--font-mono)',
        marginBottom: 10,
      }}>
        TODAY'S PERFORMANCE
      </div>

      {/* P&L */}
      <div style={{ marginBottom: 10 }}>
        <div style={{
          fontSize: 28, fontWeight: 700, fontFamily: 'var(--font-mono)',
          color: pnlColor, lineHeight: 1,
        }}>
          {totalPnlPct >= 0 ? '+' : ''}{(totalPnlPct * 100).toFixed(2)}%
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
          {pnlDollars >= 0 ? '+' : ''}${pnlDollars.toFixed(0)} on day
        </div>
      </div>

      {/* Stats grid */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 8,
      }}>
        {[
          { label: 'Signals',  val: todaySignals },
          { label: 'Active',   val: activeSignals, color: activeSignals > 0 ? 'var(--amber)' : null },
          { label: 'Taken',    val: taken.length },
          { label: 'Win Rate', val: taken.length > 0 ? `${(winRate*100).toFixed(0)}%` : '—',
            color: winRate >= 0.55 ? 'var(--green)' : winRate > 0 ? 'var(--red)' : null },
        ].map(({ label, val, color }) => (
          <div key={label} style={{
            background: 'var(--bg-secondary)', borderRadius: 4, padding: '6px 8px',
          }}>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 1 }}>{label}</div>
            <div style={{
              fontSize: 14, fontWeight: 700, fontFamily: 'var(--font-mono)',
              color: color || 'var(--text-primary)',
            }}>
              {val}
            </div>
          </div>
        ))}
      </div>

      {/* Win/Loss bar */}
      {taken.length > 0 && (
        <div>
          <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{
              width: `${winRate * 100}%`, height: '100%',
              background: 'var(--green)', borderRadius: 2,
              transition: 'width 0.5s ease',
            }} />
          </div>
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            fontSize: 9, color: 'var(--text-muted)', marginTop: 3,
            fontFamily: 'var(--font-mono)',
          }}>
            <span style={{ color: 'var(--green)' }}>{wins.length}W</span>
            <span style={{ color: 'var(--red)' }}>{losses.length}L</span>
          </div>
        </div>
      )}
    </div>
  );
}

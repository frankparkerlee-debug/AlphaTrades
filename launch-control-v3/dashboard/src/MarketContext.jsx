export default function MarketContext({ status, signals }) {
  const streams = status?.streams || {};
  const marketOpen = status?.marketOpen;

  // Derive market data from most recent signal
  const latest = signals?.find(s => s.spy_change_pct != null);

  const etfs = [
    { label: 'SPY', val: latest?.spy_change_pct },
    { label: 'QQQ', val: latest?.qqq_change_pct },
    { label: 'SEC', val: latest?.sector_change_pct },
  ];

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
        MARKET CONTEXT
      </div>

      {/* Market open/closed */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        marginBottom: 10,
      }}>
        <div style={{
          width: 7, height: 7, borderRadius: '50%',
          background: marketOpen ? 'var(--green)' : 'var(--red)',
          animation: marketOpen ? 'pulse-amber 2s ease-in-out infinite' : 'none',
        }} />
        <span style={{
          fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)',
          color: marketOpen ? 'var(--green)' : 'var(--red)',
        }}>
          MARKET {marketOpen ? 'OPEN' : 'CLOSED'}
        </span>
        <span style={{ fontSize: 9, color: 'var(--text-muted)', marginLeft: 'auto' }}>
          {status?.time ? new Date(status.time).toLocaleTimeString('en-US', {
            hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York',
          }) + ' ET' : '—'}
        </span>
      </div>

      {/* ETF grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 10 }}>
        {etfs.map(({ label, val }) => (
          <div key={label} style={{
            background: 'var(--bg-secondary)', borderRadius: 4,
            padding: '6px 8px', textAlign: 'center',
          }}>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 2 }}>{label}</div>
            <div style={{
              fontSize: 12, fontWeight: 700, fontFamily: 'var(--font-mono)',
              color: val > 0 ? 'var(--green)' : val < 0 ? 'var(--red)' : 'var(--text-muted)',
            }}>
              {val != null ? `${val > 0 ? '+' : ''}${(val * 100).toFixed(2)}%` : '—'}
            </div>
          </div>
        ))}
      </div>

      {/* Stream status */}
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
        <div style={{
          fontSize: 9, fontWeight: 700, letterSpacing: 1,
          color: 'var(--text-muted)', marginBottom: 6,
        }}>
          STREAMS
        </div>
        {[
          { label: 'Bars',  key: 'bars' },
          { label: 'News',  key: 'news' },
        ].map(({ label, key }) => (
          <div key={key} style={{
            display: 'flex', justifyContent: 'space-between',
            alignItems: 'center', marginBottom: 3,
          }}>
            <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{label}</span>
            <span style={{
              fontSize: 9, fontFamily: 'var(--font-mono)', fontWeight: 700,
              color: streams[key] === 'connected' ? 'var(--green)' : 'var(--red)',
            }}>
              {(streams[key] || 'disconnected').toUpperCase()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function PremarketBriefing({ premarket }) {
  if (!premarket) return null;

  const flagged = premarket.flagged_tickers || [];
  const macro   = premarket.macro_events   || [];
  const bias    = premarket.market_bias    || 'NEUTRAL';

  const biasColor = {
    BULLISH: 'var(--green)', BEARISH: 'var(--red)', NEUTRAL: 'var(--text-muted)',
  }[bias] || 'var(--text-muted)';

  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border)',
      borderRadius: 6, padding: 12, marginBottom: 12,
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 10,
      }}>
        <span style={{
          fontSize: 9, fontWeight: 700, letterSpacing: 1.5,
          color: 'var(--text-muted)', fontFamily: 'var(--font-mono)',
        }}>
          PRE-MARKET BRIEFING
        </span>
        <span style={{
          fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)',
          color: biasColor,
        }}>
          {bias}
        </span>
      </div>

      {/* Macro events */}
      {macro.length > 0 && (
        <div style={{
          background: '#92400e20', border: '1px solid var(--amber)',
          borderRadius: 4, padding: '5px 8px', marginBottom: 8,
          fontSize: 10, color: 'var(--amber)',
        }}>
          ⚠ {macro.map(e => e.type).join(' · ')} scheduled today
        </div>
      )}

      {/* Flagged tickers */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {flagged.slice(0, 10).map(t => (
          <div key={t.ticker} style={{
            background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            borderRadius: 4, padding: '3px 8px',
            display: 'flex', alignItems: 'center', gap: 5,
          }}>
            <span style={{
              fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)',
              color: 'var(--text-primary)',
            }}>
              {t.ticker}
            </span>
            <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
              {t.topCatalyst?.replace(/_/g, ' ')}
            </span>
          </div>
        ))}
        {flagged.length === 0 && (
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            No strong catalysts detected overnight
          </span>
        )}
      </div>
    </div>
  );
}

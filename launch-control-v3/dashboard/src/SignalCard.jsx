import { useState, useEffect } from 'react';

const GRADE_COLORS = {
  'A+': '#fbbf24', 'A': '#f59e0b', 'A-': '#10b981',
  'B+': '#3b82f6', 'B': '#8b5cf6',
};

const TIER_LABELS = {
  primary:     { label: 'PRIMARY',     color: '#10b981' },
  propagation: { label: '🔗 PROP',     color: '#3b82f6' },
  base_layer:  { label: 'BASE',        color: '#8b5cf6' },
  confluence:  { label: '⚡ CONFLUENCE', color: '#fbbf24' },
};

function PillarBar({ label, score, max, color }) {
  const pct = Math.max(0, Math.min(100, (score / max) * 100));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
      <span style={{ width: 14, fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
        {label}
      </span>
      <div style={{ flex: 1, height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{
          width: `${pct}%`, height: '100%',
          background: color, borderRadius: 2,
          transition: 'width 0.3s ease',
        }} />
      </div>
      <span style={{ width: 20, textAlign: 'right', fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
        {score}
      </span>
    </div>
  );
}

function Countdown({ expiresAt }) {
  const [secsLeft, setSecsLeft] = useState(0);

  useEffect(() => {
    const update = () => {
      const ms = new Date(expiresAt) - Date.now();
      setSecsLeft(Math.max(0, Math.round(ms / 1000)));
    };
    update();
    const i = setInterval(update, 1000);
    return () => clearInterval(i);
  }, [expiresAt]);

  const pct = Math.min(100, (secsLeft / 60) * 100);
  const urgent = secsLeft < 15;

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{
        height: 2, background: 'var(--border)', borderRadius: 1, overflow: 'hidden',
      }}>
        <div style={{
          width: `${pct}%`, height: '100%',
          background: urgent ? 'var(--red)' : 'var(--amber)',
          transition: 'width 1s linear, background 0.3s',
          animation: urgent ? 'pulse-amber 0.5s ease-in-out infinite' : 'none',
        }} />
      </div>
      <div style={{
        marginTop: 3, fontSize: 10, fontFamily: 'var(--font-mono)',
        color: urgent ? 'var(--red)' : 'var(--text-muted)',
        textAlign: 'right',
      }}>
        {secsLeft > 0 ? `${secsLeft}s` : 'EXPIRED'}
      </div>
    </div>
  );
}

export default function SignalCard({ signal, onRecord }) {
  const [showRecord, setShowRecord] = useState(false);
  const [entryPrice, setEntryPrice] = useState('');
  const [exitPrice,  setExitPrice]  = useState('');

  const gradeColor = GRADE_COLORS[signal.grade] || '#94a3b8';
  const tier = TIER_LABELS[signal.signal_tier] || TIER_LABELS.primary;
  const isActive = signal.status === 'ACTIVE';
  const confluenceLevel = signal.confluence_score || 0;

  return (
    <div style={{
      background: 'var(--bg-card)',
      border: `1px solid ${isActive ? gradeColor + '40' : 'var(--border)'}`,
      borderLeft: `3px solid ${isActive ? gradeColor : 'var(--border)'}`,
      borderRadius: 6,
      padding: '12px 14px',
      animation: 'slide-in 0.2s ease',
      opacity: isActive ? 1 : 0.6,
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Confluence glow */}
      {confluenceLevel >= 3 && isActive && (
        <div style={{
          position: 'absolute', inset: 0,
          background: `radial-gradient(ellipse at top left, ${gradeColor}08 0%, transparent 60%)`,
          pointerEvents: 'none',
        }} />
      )}

      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Grade badge */}
          <div style={{
            background: gradeColor + '20',
            border: `1px solid ${gradeColor}60`,
            borderRadius: 4, padding: '2px 8px',
            fontSize: 16, fontWeight: 700,
            fontFamily: 'var(--font-mono)',
            color: gradeColor,
            minWidth: 42, textAlign: 'center',
          }}>
            {signal.grade}
          </div>
          {/* Ticker + direction */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 15, fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                {signal.ticker}
              </span>
              <span style={{
                fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)',
                color: signal.direction === 'CALL' ? 'var(--green)' : 'var(--red)',
                background: signal.direction === 'CALL' ? 'var(--green-dim)' : 'var(--red-dim)',
                padding: '1px 6px', borderRadius: 3,
              }}>
                {signal.direction}
              </span>
              {/* Tier label */}
              <span style={{
                fontSize: 9, fontWeight: 700, letterSpacing: 1,
                color: tier.color, fontFamily: 'var(--font-mono)',
              }}>
                {tier.label}
              </span>
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>
              {new Date(signal.created_at).toLocaleTimeString('en-US', {
                hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/New_York',
              })} ET
            </div>
          </div>
        </div>

        {/* Composite score */}
        <div style={{ textAlign: 'right' }}>
          <div style={{
            fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-mono)',
            color: gradeColor, lineHeight: 1,
          }}>
            {signal.composite_raw}
          </div>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 1 }}>COMPOSITE</div>
        </div>
      </div>

      {/* Pillar bars */}
      <div style={{ marginBottom: 8 }}>
        <PillarBar label="PA"  score={signal.score_price_action || 0} max={35} color="#f59e0b" />
        <PillarBar label="Vol" score={signal.score_volume       || 0} max={30} color="#10b981" />
        <PillarBar label="Nws" score={Math.max(0, signal.score_news || 0)} max={20} color="#3b82f6" />
        <PillarBar label="Mkt" score={Math.max(0, signal.score_market || 0)} max={15} color="#8b5cf6" />
        <PillarBar label="Tmg" score={signal.score_timing       || 0} max={5}  color="#64748b" />
      </div>

      {/* Trigger reason */}
      {signal.news_headline && (
        <div style={{
          fontSize: 10, color: 'var(--text-secondary)',
          background: 'var(--bg-secondary)', borderRadius: 3,
          padding: '4px 8px', marginBottom: 6,
          borderLeft: '2px solid var(--blue)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          📰 {signal.news_headline}
        </div>
      )}

      {/* Propagation context */}
      {signal.signal_tier === 'propagation' && signal.leader_ticker && (
        <div style={{
          fontSize: 10, color: 'var(--blue)',
          background: 'var(--blue-dim)', borderRadius: 3,
          padding: '3px 8px', marginBottom: 6,
        }}>
          🔗 Propagation from {signal.leader_ticker} · lag {signal.propagation_lag_min}min
        </div>
      )}

      {/* Confluence alert */}
      {confluenceLevel >= 3 && (
        <div style={{
          fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
          color: 'var(--gold)', background: '#92400e40',
          border: '1px solid var(--gold)',
          borderRadius: 3, padding: '3px 8px', marginBottom: 6,
          textAlign: 'center',
        }}>
          ⚡ CONFLUENCE {confluenceLevel} — Multiple catalysts aligned
        </div>
      )}

      {/* Market context */}
      <div style={{
        display: 'flex', gap: 8, marginBottom: 6,
        fontSize: 10, fontFamily: 'var(--font-mono)',
      }}>
        {[
          ['SPY', signal.spy_change_pct],
          ['QQQ', signal.qqq_change_pct],
          ['SEC', signal.sector_change_pct],
        ].map(([label, val]) => (
          <div key={label} style={{
            color: val > 0 ? 'var(--green)' : val < 0 ? 'var(--red)' : 'var(--text-muted)',
          }}>
            {label} {val > 0 ? '+' : ''}{((val||0)*100).toFixed(2)}%
          </div>
        ))}
        {signal.atr_multiple && (
          <div style={{ color: 'var(--text-muted)' }}>
            {signal.atr_multiple.toFixed(1)}x ATR
          </div>
        )}
        {signal.relative_volume && (
          <div style={{ color: signal.relative_volume >= 2 ? 'var(--amber)' : 'var(--text-muted)' }}>
            {signal.relative_volume.toFixed(1)}x vol
          </div>
        )}
      </div>

      {/* Position size */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '6px 8px', background: 'var(--bg-secondary)', borderRadius: 4,
        marginBottom: isActive ? 6 : 0,
      }}>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Position</span>
        <span style={{
          fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-mono)',
          color: gradeColor,
        }}>
          ${signal.position_size_dollars?.toLocaleString() || '—'}
          <span style={{ fontSize: 9, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 4 }}>
            ({((signal.position_size_pct||0)*100).toFixed(1)}%)
          </span>
        </span>
      </div>

      {/* Countdown for active signals */}
      {isActive && signal.expires_at && <Countdown expiresAt={signal.expires_at} />}

      {/* Action buttons */}
      {isActive && !signal.human_taken && (
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button
            onClick={() => setShowRecord(!showRecord)}
            style={{
              flex: 1, padding: '6px 0', borderRadius: 4,
              border: `1px solid ${gradeColor}60`,
              background: gradeColor + '15', color: gradeColor,
              fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)',
              cursor: 'pointer', letterSpacing: 0.5,
            }}
          >
            TAKE
          </button>
          <button
            onClick={() => onRecord(signal.signal_id, { taken: false })}
            style={{
              flex: 1, padding: '6px 0', borderRadius: 4,
              border: '1px solid var(--border)',
              background: 'transparent', color: 'var(--text-muted)',
              fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)',
              cursor: 'pointer', letterSpacing: 0.5,
            }}
          >
            SKIP
          </button>
        </div>
      )}

      {/* Record outcome form */}
      {showRecord && (
        <div style={{
          marginTop: 8, padding: 8,
          background: 'var(--bg-secondary)', borderRadius: 4,
          border: '1px solid var(--border)',
        }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <input
              placeholder="Entry $"
              value={entryPrice}
              onChange={e => setEntryPrice(e.target.value)}
              style={{
                flex: 1, padding: '4px 8px', borderRadius: 3,
                border: '1px solid var(--border)', background: 'var(--bg-card)',
                color: 'var(--text-primary)', fontSize: 11, fontFamily: 'var(--font-mono)',
              }}
            />
            <input
              placeholder="Exit $"
              value={exitPrice}
              onChange={e => setExitPrice(e.target.value)}
              style={{
                flex: 1, padding: '4px 8px', borderRadius: 3,
                border: '1px solid var(--border)', background: 'var(--bg-card)',
                color: 'var(--text-primary)', fontSize: 11, fontFamily: 'var(--font-mono)',
              }}
            />
          </div>
          <button
            onClick={() => {
              onRecord(signal.signal_id, {
                taken: true,
                entryPrice: parseFloat(entryPrice) || null,
                exitPrice:  parseFloat(exitPrice)  || null,
              });
              setShowRecord(false);
            }}
            style={{
              width: '100%', padding: '5px 0', borderRadius: 3,
              border: 'none', background: gradeColor,
              color: '#000', fontSize: 11, fontWeight: 700,
              fontFamily: 'var(--font-mono)', cursor: 'pointer',
            }}
          >
            CONFIRM
          </button>
        </div>
      )}
    </div>
  );
}

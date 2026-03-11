import { useState } from 'react';
import { useApi } from './useApi.js';
import SignalCard from './SignalCard.jsx';
import ClusterMap from './ClusterMap.jsx';
import MarketContext from './MarketContext.jsx';
import PremarketBriefing from './PremarketBriefing.jsx';
import DailyPnL from './DailyPnL.jsx';

const GRADE_ORDER = ['A+', 'A', 'A-', 'B+', 'B', 'base_layer', 'all'];
const TIER_FILTERS = ['all', 'primary', 'propagation', 'base_layer'];

export default function App() {
  const { signals, status, premarket, loading, lastUpdate, error, recordOutcome } = useApi();
  const [gradeFilter, setGradeFilter] = useState('all');
  const [tierFilter,  setTierFilter]  = useState('all');
  const [showHistory, setShowHistory] = useState(false);

  const activeSignals = signals.filter(s => s.status === 'ACTIVE');
  const historySignals = signals.filter(s => s.status !== 'ACTIVE');

  const displayed = (showHistory ? signals : activeSignals).filter(s => {
    if (gradeFilter !== 'all' && s.grade !== gradeFilter) return false;
    if (tierFilter  !== 'all' && s.signal_tier !== tierFilter) return false;
    return true;
  });

  const confluenceCount = activeSignals.filter(s => (s.confluence_score || 0) >= 3).length;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>

      {/* ── HEADER ─────────────────────────────────── */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '10px 16px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        position: 'sticky', top: 0, zIndex: 100,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 8, height: 8, borderRadius: '50%',
            background: 'var(--amber)',
            animation: 'glow 2s ease-in-out infinite',
          }} />
          <span style={{
            fontSize: 14, fontWeight: 700, fontFamily: 'var(--font-mono)',
            color: 'var(--amber)', letterSpacing: 2,
          }}>
            LAUNCH CONTROL
          </span>
          <span style={{
            fontSize: 9, color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)',
          }}>
            v3.0
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {confluenceCount > 0 && (
            <div style={{
              background: '#92400e40', border: '1px solid var(--gold)',
              borderRadius: 4, padding: '2px 8px',
              fontSize: 10, fontWeight: 700, color: 'var(--gold)',
              fontFamily: 'var(--font-mono)',
              animation: 'pulse-amber 1.5s ease-in-out infinite',
            }}>
              ⚡ {confluenceCount} CONFLUENCE
            </div>
          )}
          {activeSignals.length > 0 && (
            <div style={{
              background: 'var(--amber)',
              borderRadius: 4, padding: '2px 8px',
              fontSize: 10, fontWeight: 700, color: '#000',
              fontFamily: 'var(--font-mono)',
            }}>
              {activeSignals.length} ACTIVE
            </div>
          )}
          <div style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {lastUpdate
              ? lastUpdate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
              : '—'}
          </div>
          {error && (
            <div style={{ fontSize: 9, color: 'var(--red)', fontFamily: 'var(--font-mono)' }}>
              ⚠ {error}
            </div>
          )}
        </div>
      </div>

      {/* ── MAIN LAYOUT ─────────────────────────────── */}
      <div style={{
        flex: 1, display: 'grid',
        gridTemplateColumns: '1fr 280px',
        gap: 0,
        maxWidth: 1400, width: '100%', margin: '0 auto',
        padding: 12, boxSizing: 'border-box',
        gap: 12,
      }}>

        {/* Left column — signals */}
        <div>
          {/* Pre-market briefing */}
          <PremarketBriefing premarket={premarket} />

          {/* Filter bar */}
          <div style={{
            display: 'flex', gap: 6, marginBottom: 10, alignItems: 'center',
            flexWrap: 'wrap',
          }}>
            {/* Grade filters */}
            <div style={{ display: 'flex', gap: 4 }}>
              {['all', 'A+', 'A', 'A-', 'B+', 'B'].map(g => (
                <button key={g}
                  onClick={() => setGradeFilter(g)}
                  style={{
                    padding: '3px 8px', borderRadius: 4, fontSize: 10,
                    fontFamily: 'var(--font-mono)', fontWeight: 700,
                    cursor: 'pointer', border: 'none',
                    background: gradeFilter === g ? 'var(--amber)' : 'var(--bg-card)',
                    color: gradeFilter === g ? '#000' : 'var(--text-muted)',
                  }}
                >
                  {g}
                </button>
              ))}
            </div>

            <div style={{ width: 1, height: 16, background: 'var(--border)' }} />

            {/* Tier filters */}
            {TIER_FILTERS.map(t => (
              <button key={t}
                onClick={() => setTierFilter(t)}
                style={{
                  padding: '3px 8px', borderRadius: 4, fontSize: 10,
                  fontFamily: 'var(--font-mono)', fontWeight: 700,
                  cursor: 'pointer', border: 'none',
                  background: tierFilter === t ? 'var(--blue)' : 'var(--bg-card)',
                  color: tierFilter === t ? '#fff' : 'var(--text-muted)',
                }}
              >
                {t}
              </button>
            ))}

            <div style={{ marginLeft: 'auto' }}>
              <button
                onClick={() => setShowHistory(!showHistory)}
                style={{
                  padding: '3px 10px', borderRadius: 4, fontSize: 10,
                  fontFamily: 'var(--font-mono)', fontWeight: 700,
                  cursor: 'pointer',
                  border: '1px solid var(--border)',
                  background: showHistory ? 'var(--bg-elevated)' : 'transparent',
                  color: 'var(--text-muted)',
                }}
              >
                {showHistory ? 'HIDE HISTORY' : 'SHOW HISTORY'}
              </button>
            </div>
          </div>

          {/* Signal cards */}
          {loading ? (
            <div style={{
              textAlign: 'center', padding: '40px 0',
              color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 11,
            }}>
              Loading signals...
            </div>
          ) : displayed.length === 0 ? (
            <div style={{
              textAlign: 'center', padding: '40px 20px',
              color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 11,
              border: '1px dashed var(--border)', borderRadius: 6,
            }}>
              <div style={{ fontSize: 24, marginBottom: 8 }}>◎</div>
              {activeSignals.length === 0
                ? 'No active signals — system is scanning'
                : 'No signals match current filter'}
              <div style={{ marginTop: 6, fontSize: 10, color: 'var(--text-dim)' }}>
                {signals.length} total signals today
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 8 }}>
              {displayed.map(signal => (
                <SignalCard
                  key={signal.signal_id}
                  signal={signal}
                  onRecord={recordOutcome}
                />
              ))}
            </div>
          )}
        </div>

        {/* Right column — context panels */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <DailyPnL signals={signals} />
          <ClusterMap status={status} />
          <MarketContext status={status} signals={signals} />
        </div>
      </div>
    </div>
  );
}

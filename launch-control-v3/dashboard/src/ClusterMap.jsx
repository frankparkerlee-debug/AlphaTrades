export default function ClusterMap({ status }) {
  const windows = status?.propagation || [];

  const clusters = [
    { id: 1, name: 'AI Infrastructure',  leader: 'NVDA', followers: ['AMD','MRVL','ARM','AVGO'] },
    { id: 2, name: 'Memory Cycle',       leader: 'MU',   followers: ['WDC','STX','MRVL'] },
    { id: 3, name: 'Hyperscaler Capex',  leader: 'MSFT', followers: ['NVDA','AVGO','AMZN','GOOGL'] },
    { id: 4, name: 'Consumer Platform',  leader: 'AAPL', followers: ['MSFT','GOOGL','META'] },
    { id: 5, name: 'High Beta',          leader: 'TSLA', followers: ['PLTR','APP'] },
    { id: 6, name: 'Semi Equipment',     leader: 'AMAT', followers: ['LRCX','KLAC'] },
    { id: 7, name: 'Software Cloud',     leader: 'NOW',  followers: ['CRM','ADBE','WDAY'] },
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
        CLUSTER MAP
      </div>

      {clusters.map(cluster => {
        const activeWindow = windows.find(w => w.leaderTicker === cluster.leader);
        const isActive = !!activeWindow;

        return (
          <div key={cluster.id} style={{
            marginBottom: 8, padding: '6px 8px',
            background: isActive ? 'var(--blue-dim)' : 'var(--bg-secondary)',
            border: `1px solid ${isActive ? 'var(--blue)' : 'var(--border)'}`,
            borderRadius: 4,
            transition: 'all 0.3s',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{
                  fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)',
                  color: isActive ? 'var(--blue)' : 'var(--text-secondary)',
                }}>
                  {cluster.leader}
                </span>
                {isActive && (
                  <span style={{
                    fontSize: 9, color: 'var(--blue)',
                    fontFamily: 'var(--font-mono)', fontWeight: 700,
                  }}>
                    ▲ {activeWindow.leaderDirection} · {activeWindow.minutesRemaining}min left
                  </span>
                )}
              </div>
              <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
                {cluster.name}
              </span>
            </div>

            {isActive && (
              <div style={{
                display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5,
              }}>
                {cluster.followers.map(f => {
                  const alerted = activeWindow.followersAlerted?.includes(f);
                  return (
                    <span key={f} style={{
                      fontSize: 9, fontFamily: 'var(--font-mono)', fontWeight: 700,
                      padding: '1px 5px', borderRadius: 3,
                      background: alerted ? 'var(--green-dim)' : '#1e2d3d',
                      color: alerted ? 'var(--green)' : 'var(--text-muted)',
                      border: `1px solid ${alerted ? 'var(--green)' : 'transparent'}`,
                    }}>
                      {f} {alerted ? '✓' : '·'}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

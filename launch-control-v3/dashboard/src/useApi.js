import { useState, useEffect, useCallback } from 'react';

const API = '/api';
const POLL_MS = 5000; // 5 second refresh

export function useApi() {
  const [signals,    setSignals]    = useState([]);
  const [status,     setStatus]     = useState(null);
  const [premarket,  setPremarket]  = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [error,      setError]      = useState(null);

  const fetchAll = useCallback(async () => {
    try {
      const [sigRes, statusRes, preRes] = await Promise.all([
        fetch(`${API}/signals/today`).then(r => r.json()),
        fetch(`${API}/status`).then(r => r.json()),
        fetch(`${API}/premarket`).then(r => r.json()),
      ]);

      setSignals(sigRes.signals || []);
      setStatus(statusRes);
      setPremarket(preRes.briefing);
      setLastUpdate(new Date());
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, POLL_MS);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const recordOutcome = useCallback(async (signalId, data) => {
    await fetch(`${API}/signals/outcome`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signalId, ...data }),
    });
    fetchAll();
  }, [fetchAll]);

  return { signals, status, premarket, loading, lastUpdate, error, recordOutcome };
}

import React, { useState } from 'react';
import { Pane } from '../components/Pane';
import { useRuntimeActions } from '../lib/hooks';

export function PaneKiokuLessons() {
  const { run, toast } = useRuntimeActions();
  const [items, setItems] = useState<any[]>([]);
  const [stats, setStats] = useState({ total_active: 0, applied_total: 0, prevented_total: 0 });
  const [statsLoaded, setStatsLoaded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<any>(null);

  const fetchStats = React.useCallback(async () => {
    const r = await run('lessons.stats', {}, { silentError: true });
    if (r.ok && r.data && typeof r.data === 'object') {
      setStats({
        total_active: Number(r.data.total_active || 0),
        applied_total: Number(r.data.applied_total || 0),
        prevented_total: Number(r.data.prevented_total || 0),
      });
    }
    setStatsLoaded(true);
  }, [run]);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      await fetchStats();
      if (cancelled) return;
      const r = await run('lessons.list', {}, { silentError: true });
      if (cancelled) return;
      if (r.ok && Array.isArray(r.data?.items)) setItems(r.data.items);
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [run, fetchStats]);

  const archive = async (id: any) => {
    setBusyId(id);
    const prev = items;
    const prevStats = stats;
    setItems(items.filter((l) => l.id !== id));
    setStats({
      total_active: Math.max(0, stats.total_active - 1),
      applied_total: stats.applied_total,
      prevented_total: stats.prevented_total,
    });
    const r = await run('lessons.archive', { id }, { silentError: true });
    setBusyId(null);
    if (!r.ok) {
      setItems(prev);
      setStats(prevStats);
      toast('Could not remove — try again.', 'error');
    } else {
      void fetchStats();
    }
  };

  return (
    <Pane title="KIOKU Lessons">
      <div className="t-sm" style={{ color: 'var(--text-mute)', marginBottom: 'var(--space-4)' }}>
        Things SHOGUN learned from your feedback.
      </div>
      <div className="card" style={{ padding: 'var(--space-4) var(--space-5)', marginBottom: 'var(--space-4)' }}>
        <div className="t-sm" style={{ color: 'var(--text)' }}>
          {statsLoaded ? `${stats.total_active} lessons learned` : '— lessons learned'}
        </div>
        <div className="t-sm" style={{ color: 'var(--text-mute)', marginTop: 'var(--space-1)' }}>
          {statsLoaded ? `Applied ${stats.applied_total} times total` : 'Applied — times total'}
        </div>
        {statsLoaded && stats.prevented_total > 0 && (
          <div className="t-sm" style={{ color: 'var(--text-mute)', marginTop: 'var(--space-1)' }}>
            Prevented {stats.prevented_total} failures
          </div>
        )}
      </div>
      <div className="card" style={{ padding: 'var(--space-4) var(--space-5)' }}>
        {!loaded ? (
          <div className="t-sm" style={{ color: 'var(--text-mute)' }}>Loading…</div>
        ) : items.length === 0 ? (
          <div className="t-sm" style={{ color: 'var(--text-mute)' }}>
            No lessons yet — they grow as you give feedback.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {items.map((l) => (
              <div key={l.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
                <div className="t-sm" style={{ color: 'var(--text)' }}>• {l.rule}</div>
                <button
                  className="btn btn-sm btn-secondary"
                  disabled={busyId === l.id}
                  onClick={() => archive(l.id)}
                >忘れて</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Pane>
  );
}

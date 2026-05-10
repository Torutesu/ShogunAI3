import React, { useState } from 'react';
import { Pane } from '../components/Pane';
import { useRuntimeActions } from '../lib/hooks';

export function PaneKiokuPatterns() {
  const { run, toast } = useRuntimeActions();
  const [items, setItems] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<any>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await run('patterns.list', {}, { silentError: true });
      if (cancelled) return;
      if (r.ok && Array.isArray(r.data?.items)) setItems(r.data.items);
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [run]);

  const invalidate = async (id: any) => {
    setBusyId(id);
    const prev = items;
    setItems(items.filter((p) => p.id !== id));
    const r = await run('patterns.invalidate', { id }, { silentError: true });
    setBusyId(null);
    if (!r.ok) {
      setItems(prev);
      toast('Could not remove — try again.', 'error');
    }
  };

  return (
    <Pane title="KIOKU Patterns">
      <div className="t-sm" style={{ color: 'var(--text-mute)', marginBottom: 'var(--space-4)' }}>
        Things SHOGUN noticed about your routine.
      </div>
      <div className="card" style={{ padding: 'var(--space-4) var(--space-5)' }}>
        {!loaded ? (
          <div className="t-sm" style={{ color: 'var(--text-mute)' }}>Loading…</div>
        ) : items.length === 0 ? (
          <div className="t-sm" style={{ color: 'var(--text-mute)' }}>
            Nothing yet — patterns appear after a few days of usage.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {items.map((p) => (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
                <div className="t-sm" style={{ color: 'var(--text)' }}>• {p.label}</div>
                <button
                  className="btn btn-sm btn-secondary"
                  disabled={busyId === p.id}
                  onClick={() => invalidate(p.id)}
                >これ違う</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Pane>
  );
}

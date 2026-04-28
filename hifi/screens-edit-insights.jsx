/* global React */
function ScreenEditInsights() {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [showRaw, setShowRaw] = React.useState(false);

  const settledRef = React.useRef({ resolved: false, resolvers: [] });

  // Test hook: when window.__SHOGUN_TEST__ is exposed (?test=1), register
  // a waitForScreen helper that returns a Promise resolving after the
  // first IPC settles. Used by edit-insights Playwright tests.
  // Spec: docs/superpowers/specs/2026-04-28-test-hooks-design.md
  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.__SHOGUN_TEST__) return;
    window.__SHOGUN_TEST__.waitForScreen = (id) => {
      if (id !== 'edit-insights') return Promise.resolve();
      if (settledRef.current.resolved) return Promise.resolve();
      return new Promise((resolve) => settledRef.current.resolvers.push(resolve));
    };
    return () => {
      if (typeof window !== 'undefined' && window.__SHOGUN_TEST__) {
        delete window.__SHOGUN_TEST__.waitForScreen;
      }
      settledRef.current = { resolved: false, resolvers: [] };
    };
  }, []);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await runRuntimeActionA('memory.summary.edit_insights', {}, { silentError: true });
      if (res?.ok) {
        setData(res.data);
        // Wake up any test waiters now that the screen has rendered with data.
        const refState = settledRef.current;
        refState.resolved = true;
        const pending = refState.resolvers;
        refState.resolvers = [];
        pending.forEach((r) => r());
      } else {
        setData(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const sources = data?.by_source ? Object.entries(data.by_source) : [];

  // Build a TOML hint from the most-edited sender across all sources.
  const topHint = (() => {
    let best = null;
    for (const [src, info] of sources) {
      for (const s of (info.senders || [])) {
        if (!s.entity_id) continue;
        if (!best || s.count > best.count) {
          best = { src, entity_id: s.entity_id, count: s.count };
        }
      }
    }
    if (!best || best.src !== 'gmail') return null;
    return best;
  })();

  return (
    <div className="content-inner wide" style={{ padding: '24px 40px', display: 'flex', flexDirection: 'column', gap: 18, overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div className="t-mono" style={{ fontSize: 11, color: 'var(--text-dim)' }}>Memory · Edit Insights (debug)</div>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={load}
          disabled={loading}
        >
          {loading ? 'Loading…' : 'Reload'}
        </button>
      </div>

      <div style={{ fontSize: 13, color: 'var(--text)' }}>
        Total edits: <strong>{data?.total_edits ?? '—'}</strong>
        {' · '}
        Total userPriority changes: <strong>{data?.total_user_priority_changes ?? '—'}</strong>
      </div>

      {!data && !loading && (
        <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>
          No insights data — check the backend connection or that summaries exist.
        </div>
      )}

      {sources.length === 0 && data && (
        <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>
          No edits yet. Edits start showing here after users edit summary
          fields (Phase 4 inline edit) or set userPriority overrides.
        </div>
      )}

      {sources.map(([src, info]) => (
        <div key={src} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="t-mono" style={{ fontSize: 11, color: 'var(--text-dim)', letterSpacing: '0.08em' }}>
            {src}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 1fr) auto auto', columnGap: 16, rowGap: 4, fontSize: 13 }}>
            {(info.senders || []).map((s, i) => {
              const fieldStr = Object.entries(s.fields || {})
                .map(([k, v]) => `${k} (${v})`)
                .join(', ');
              return (
                <React.Fragment key={`${src}:${i}`}>
                  <span style={{ color: 'var(--text)', wordBreak: 'break-all' }}>
                    {s.entity_id || '(no entity_id)'}
                  </span>
                  <span style={{ color: 'var(--text)' }}>{s.count} edit{s.count === 1 ? '' : 's'}</span>
                  <span style={{ color: 'var(--text-mute)' }}>{fieldStr}</span>
                </React.Fragment>
              );
            })}
          </div>
        </div>
      ))}

      {topHint && (
        <div style={{ background: 'var(--surface-mute)', border: '1px solid var(--border)', borderRadius: 4, padding: 12, fontSize: 12, color: 'var(--text-mute)' }}>
          <div style={{ marginBottom: 6, color: 'var(--text)' }}>
            Hint: To suppress an aggressive sender, add to your TOML:
          </div>
          <div style={{ marginBottom: 6 }}>
            Open <code>&lt;app data&gt;/heuristic_patterns.toml</code> and add:
          </div>
          <pre style={{ margin: 0, fontSize: 12, fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap' }}>
{`[[gmail.sender_contains]]
pattern = "${topHint.entity_id}"
priority = "low"
reason = "Frequently downgraded by user"`}
          </pre>
        </div>
      )}

      <div>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => setShowRaw((v) => !v)}
        >
          {showRaw ? 'Hide raw aggregation JSON' : 'Show raw aggregation JSON ▾'}
        </button>
        {showRaw && data && (
          <pre style={{ marginTop: 8, padding: 12, background: 'var(--surface-mute)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 11, fontFamily: 'var(--font-mono)', overflowX: 'auto' }}>
{JSON.stringify(data, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

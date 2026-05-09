import { useState, useEffect, useCallback } from 'react';
import { msToLocal, humanBytes } from '../lib/format';
import { tauriInvokeSilent } from '../lib/tauri-invoke';
import type { DbStatsData } from '../types';

export function TabDbStats() {
  const [data, setData] = useState<DbStatsData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const out = await tauriInvokeSilent<DbStatsData>("shogun_memory_debug_stats", { payload: {} });
      setData(out);
    } catch (e: unknown) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (err) return <div className="mdbg-err">Error: {err}</div>;
  if (!data) return <div>Loading…</div>;

  return (
    <div className="mdbg-tab mdbg-stats">
      <div>
        total rows: <strong>{data.total}</strong> / FTS rows: <strong>{data.fts_total}</strong>
        {" "}<span className={data.fts_integrity ? "mdbg-ok" : "mdbg-err-cell"}>
          {data.fts_integrity ? "FTS ✓" : "FTS MISMATCH"}
        </span>
        {" — "}db size: <strong>{humanBytes(data.db_bytes)}</strong>
        {" — "}earliest: {msToLocal(data.earliest_ms ?? undefined)} / latest: {msToLocal(data.latest_ms ?? undefined)}
      </div>
      <h3>By source</h3>
      <table className="mdbg-table">
        <thead>
          <tr><th>source</th><th>rows</th><th>with_embed</th><th>coverage</th></tr>
        </thead>
        <tbody>
          {data.by_source.map((s) => (
            <tr key={s.source}>
              <td>{s.source}</td>
              <td>{s.rows}</td>
              <td>{s.with_embed}</td>
              <td>{s.rows ? Math.round((s.with_embed / s.rows) * 100) : 0}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>By provenance</h3>
      <table className="mdbg-table">
        <thead><tr><th>provenance</th><th>rows</th></tr></thead>
        <tbody>
          {data.by_provenance.map((p) => (
            <tr key={p.provenance}><td>{p.provenance}</td><td>{p.rows}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

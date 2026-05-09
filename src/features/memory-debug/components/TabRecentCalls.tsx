import { useState, useEffect, useCallback } from 'react';
import { msToLocal } from '../lib/format';
import { tauriInvokeSilent } from '../lib/tauri-invoke';
import type { RecentCall, RecentCallsResult } from '../types';

export function TabRecentCalls() {
  const [items, setItems] = useState<RecentCall[]>([]);
  const [selected, setSelected] = useState<RecentCall | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const out = await tauriInvokeSilent<RecentCallsResult>("shogun_memory_debug_recent_calls", {
        payload: { limit: 50 },
      });
      setItems((out && out.calls) || []);
    } catch (e: unknown) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const getStatusLabel = (status: RecentCall["status"]): string => {
    if (typeof status === "string") return status;
    if (status && typeof status === "object" && "Err" in status) return "err";
    return "ok";
  };

  return (
    <div className="mdbg-tab mdbg-recent">
      {err && <div className="mdbg-err">Error: {err}</div>}
      <table className="mdbg-table">
        <thead>
          <tr>
            <th>time</th>
            <th>route</th>
            <th>query</th>
            <th>hits</th>
            <th>elapsed</th>
            <th>status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((c, i) => (
            <tr key={`${c.ts_ms}_${i}`} onClick={() => setSelected(c)} className={selected === c ? "sel" : ""}>
              <td>{msToLocal(c.ts_ms)}</td>
              <td>{c.route}</td>
              <td className="mdbg-q">{c.query_preview || "(empty)"}</td>
              <td>{c.hits_count}</td>
              <td>{c.elapsed_ms} ms</td>
              <td>{getStatusLabel(c.status)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {selected && (
        <div className="mdbg-detail">
          <h3>Detail</h3>
          <div>provenance: screen={selected.provenance_counts.screen} connector={selected.provenance_counts.connector} meeting={selected.provenance_counts.meeting} user={selected.provenance_counts.user}</div>
          <div>block: {selected.block_chars} chars / limit: {selected.limit} / semantic: {String(selected.semantic)}</div>
          {selected.assembled_block && (
            <pre className="mdbg-pre">{selected.assembled_block}</pre>
          )}
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';
import { msToLocal } from '../lib/format';
import { tauriInvokeSilent } from '../lib/tauri-invoke';
import type { SyncHealthData, SyncSourceStatus } from '../types';

export function TabSyncHealth() {
  const [data, setData] = useState<SyncHealthData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const out = await tauriInvokeSilent<SyncHealthData>("shogun_memory_debug_sync_status", { payload: {} });
      setData(out);
    } catch (e: unknown) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  if (err) return <div className="mdbg-err">Error: {err}</div>;
  if (!data) return <div>Loading…</div>;

  const row = (name: string, d: SyncSourceStatus) => (
    <tr key={name}>
      <td>{name}</td>
      <td>{msToLocal(d.last_sync_ms ?? undefined)}</td>
      <td>{d.last_ingested ?? "—"}</td>
      <td className={d.last_error ? "mdbg-err-cell" : ""}>{d.last_error || "—"}</td>
      <td>{d.last_duration_ms ? `${d.last_duration_ms} ms` : "—"}</td>
      <td>{d.credentials_present ? "✓" : "—"}</td>
      <td>{d.auto_enabled ? "✓" : "—"}</td>
    </tr>
  );

  return (
    <table className="mdbg-table">
      <thead>
        <tr>
          <th>source</th>
          <th>last_sync</th>
          <th>ingested</th>
          <th>error</th>
          <th>duration</th>
          <th>creds</th>
          <th>auto</th>
        </tr>
      </thead>
      <tbody>
        {row("google_calendar", data.google_calendar)}
        {row("gmail", data.gmail)}
      </tbody>
    </table>
  );
}

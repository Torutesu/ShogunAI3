import { useState, useEffect, useCallback } from 'react';
import { msToLocal } from '../lib/format';
import { tauriInvoke } from '../lib/tauri-invoke';
import type { KiokuDebugStats, SliData, SliThresholds } from '../types';

const DEFAULT_THRESHOLDS: SliThresholds = {
  bad: { successLt: 95, p95Gt: 3000, backlogGt: 40 },
  warn: { successLt: 99, p95Gt: 1500, backlogGt: 15 },
};

export function TabKiokuStats() {
  const [data, setData] = useState<KiokuDebugStats | null>(null);
  const [sli, setSli] = useState<SliData | null>(null);
  const [sliThresholds, setSliThresholds] = useState<SliThresholds>(DEFAULT_THRESHOLDS);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await tauriInvoke<KiokuDebugStats>("shogun_kioku_debug_stats", { payload: {} });
      setData(r);
      const s = await tauriInvoke<{ sli?: SliData }>("shogun_stats", { payload: { stage: "sli" } });
      setSli((s && s.sli) || null);
      const settings = await tauriInvoke<{
        settings?: {
          sections?: {
            observability?: {
              sliThresholds?: {
                bad?: { successLt?: number; p95Gt?: number; backlogGt?: number };
                warn?: { successLt?: number; p95Gt?: number; backlogGt?: number };
              };
            };
          };
        };
      }>("app_settings_load", { payload: {} });
      const t = settings?.settings?.sections?.observability?.sliThresholds;
      if (t && typeof t === "object") {
        setSliThresholds({
          bad: {
            successLt: Number(t.bad?.successLt ?? 95),
            p95Gt: Number(t.bad?.p95Gt ?? 3000),
            backlogGt: Number(t.bad?.backlogGt ?? 40),
          },
          warn: {
            successLt: Number(t.warn?.successLt ?? 99),
            p95Gt: Number(t.warn?.p95Gt ?? 1500),
            backlogGt: Number(t.warn?.backlogGt ?? 15),
          },
        });
      }
    } catch (e: unknown) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const h = setInterval(refresh, 30_000);
    return () => clearInterval(h);
  }, [refresh]);

  if (err) {
    return (
      <div className="mdbg-pane">
        <div className="mdbg-error">{err}</div>
        <button onClick={refresh}>Retry</button>
      </div>
    );
  }
  if (!data) {
    return <div className="mdbg-pane">Loading…</div>;
  }

  const flags = data.flags || {};
  const queue = data.queue || {};
  const cost = data.cost || {};
  const graph = data.graph || {};
  const rules = data.rules || {};

  const oldestPendingLabel = queue.oldest_pending_capture_ms
    ? msToLocal(queue.oldest_pending_capture_ms)
    : "—";

  const capPct =
    (cost.monthly_cap_usd ?? 0) > 0
      ? Math.min(100, Math.round(((cost.spent_usd ?? 0) / (cost.monthly_cap_usd ?? 1)) * 100))
      : 0;
  const capColor = capPct >= 100 ? "red" : capPct >= 80 ? "orange" : "green";
  const sliSuccess = Number(sli && sli.successRate ? sli.successRate : 0);
  const sliP95 = Number(sli && sli.p95LatencyMs ? sli.p95LatencyMs : 0);
  const sliBacklog = Number(sli && sli.backlog ? sli.backlog : 0);
  const bad = sliThresholds.bad;
  const warn = sliThresholds.warn;
  const sliTone =
    sliSuccess < bad.successLt || sliP95 > bad.p95Gt || sliBacklog > bad.backlogGt
      ? "bad"
      : sliSuccess < warn.successLt || sliP95 > warn.p95Gt || sliBacklog > warn.backlogGt
      ? "warn"
      : "good";

  const statusBadge = (label: string, on: boolean) => (
    <span className={`mdbg-badge mdbg-badge-${on ? "on" : "off"}`}>{label}</span>
  );

  return (
    <div className="mdbg-pane">
      <div className="mdbg-header-row">
        <button onClick={refresh} disabled={busy}>
          {busy ? "Refreshing…" : "Refresh now"}
        </button>
        <span className="mdbg-timestamp">snapshot: {msToLocal(data.now_ms)}</span>
      </div>

      <h3>Flags</h3>
      <div className="mdbg-flag-row">
        {statusBadge(`read_path: ${flags.read_path || "legacy"}`, flags.read_path === "graph")}
        {statusBadge("worker_enabled", !!flags.worker_enabled)}
        {statusBadge("capture_to_mem_captures", !!flags.capture_to_mem_captures)}
        {statusBadge("meeting_extraction", !!flags.meeting_extraction_enabled)}
      </div>
      {(data as any).meeting_pipeline && (
        <p className="mdbg-muted" style={{ marginTop: 8 }}>
          Meeting captures in KIOKU raw layer: {(data as any).meeting_pipeline.captures ?? 0}
        </p>
      )}
      {data.summary && (
        <p className="mdbg-muted" style={{ marginTop: 8 }}>
          Job completion:{' '}
          {data.summary.job_completion_rate != null
            ? `${Math.round(Number(data.summary.job_completion_rate) * 100)}%`
            : '—'}
          {' · '}
          Edge density: {Number(data.summary.edge_density ?? 0).toFixed(2)} (
          {data.summary.edges_active ?? 0}/{data.summary.mem_items_active ?? 0})
        </p>
      )}

      <h3>Queue</h3>
      {sli && (
        <div
          className="mdbg-flag-row"
          style={{
            marginBottom: 10,
            padding: "8px 10px",
            borderRadius: 8,
            border: sliTone === "bad"
              ? "1px solid color-mix(in srgb, var(--danger) 55%, var(--border) 45%)"
              : (sliTone === "warn"
                ? "1px solid color-mix(in srgb, var(--warn) 55%, var(--border) 45%)"
                : "1px solid color-mix(in srgb, var(--success) 55%, var(--border) 45%)"),
            background: sliTone === "bad"
              ? "color-mix(in srgb, var(--danger) 10%, var(--bg) 90%)"
              : (sliTone === "warn"
                ? "color-mix(in srgb, var(--warn) 10%, var(--bg) 90%)"
                : "color-mix(in srgb, var(--success) 10%, var(--bg) 90%)"),
          }}
        >
          <span><strong>24h SLI</strong></span>
          <span>success: <strong>{sliSuccess.toFixed(1)}%</strong></span>
          <span>p95: <strong>{sli.p95LatencyMs ?? "—"} ms</strong></span>
          <span>backlog: <strong>{sli.backlog ?? 0}</strong></span>
          <span>done/failed: <strong>{sli.done ?? 0}/{sli.failed ?? 0}</strong></span>
        </div>
      )}
      <div className="mdbg-grid-3">
        <div>
          <strong>mem_captures</strong>
          <table className="mdbg-table">
            <tbody>
              <tr>
                <td>queued</td>
                <td>{queue.captures_pending || 0}</td>
              </tr>
              <tr>
                <td>running</td>
                <td>{queue.captures_running || 0}</td>
              </tr>
              <tr>
                <td>done</td>
                <td>{queue.captures_done || 0}</td>
              </tr>
              <tr>
                <td>failed</td>
                <td>{queue.captures_failed || 0}</td>
              </tr>
              <tr>
                <td>expired</td>
                <td>{queue.captures_expired || 0}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div>
          <strong>extraction_jobs</strong>
          <table className="mdbg-table">
            <tbody>
              <tr>
                <td>queued</td>
                <td>{queue.jobs_queued || 0}</td>
              </tr>
              <tr>
                <td>running</td>
                <td>{queue.jobs_running || 0}</td>
              </tr>
              <tr>
                <td>done</td>
                <td>{queue.jobs_done || 0}</td>
              </tr>
              <tr>
                <td>failed</td>
                <td>{queue.jobs_failed || 0}</td>
              </tr>
              <tr>
                <td>expired</td>
                <td>{queue.jobs_expired || 0}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div>
          <strong>oldest pending capture</strong>
          <div className="mdbg-big">{oldestPendingLabel}</div>
        </div>
      </div>

      <h3>Cost (this month)</h3>
      <div className="mdbg-cost-row">
        <div className="mdbg-bar-track">
          <div
            className={`mdbg-bar-fill mdbg-bar-${capColor}`}
            style={{ width: `${capPct}%` }}
          />
        </div>
        <div className="mdbg-cost-label">
          ${(cost.spent_usd || 0).toFixed(4)} / ${(cost.monthly_cap_usd || 0).toFixed(2)} (
          {capPct}%)
        </div>
      </div>
      <div className="mdbg-cost-meta">
        <span>status: <strong>{cost.status || "—"}</strong></span>
        <span>cap_action: {cost.cap_action || "—"}</span>
        <span>model: {cost.extraction_model || "—"}</span>
        <span>fallback: {cost.fallback_model || "—"}</span>
      </div>

      <h3>Graph</h3>
      <div className="mdbg-grid-2">
        <div>
          <strong>mem_items</strong>
          <table className="mdbg-table">
            <tbody>
              <tr>
                <td>active (valid_to NULL)</td>
                <td>{graph.mem_items_active || 0}</td>
              </tr>
              <tr>
                <td>retired</td>
                <td>{graph.mem_items_retired || 0}</td>
              </tr>
              <tr>
                <td>total</td>
                <td>{graph.mem_items_total || 0}</td>
              </tr>
              <tr>
                <td>captures (raw)</td>
                <td>{graph.captures_total || 0}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div>
          <strong>mem_edges</strong>
          <table className="mdbg-table">
            <tbody>
              <tr>
                <td>active</td>
                <td>{graph.edges_active || 0}</td>
              </tr>
              <tr>
                <td>total</td>
                <td>{graph.edges_total || 0}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {graph.by_node_kind && graph.by_node_kind.length > 0 && (
        <>
          <h4>by node_kind (active)</h4>
          <table className="mdbg-table">
            <thead>
              <tr>
                <th>kind</th>
                <th>count</th>
              </tr>
            </thead>
            <tbody>
              {graph.by_node_kind.map((row, i) => (
                <tr key={i}>
                  <td>{row.kind}</td>
                  <td>{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {graph.by_edge_type && graph.by_edge_type.length > 0 && (
        <>
          <h4>by edge_type (active)</h4>
          <table className="mdbg-table">
            <thead>
              <tr>
                <th>edge_type</th>
                <th>count</th>
              </tr>
            </thead>
            <tbody>
              {graph.by_edge_type.map((row, i) => (
                <tr key={i}>
                  <td>{row.edge_type}</td>
                  <td>{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3>Rules ({rules.count || 0})</h3>
      {(rules.titles || []).length === 0 ? (
        <div className="mdbg-empty">No kioku_rules configured.</div>
      ) : (
        <ul className="mdbg-rules">
          {(rules.titles || []).map((t, i) => (
            <li key={i}>{t || "(untitled)"}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

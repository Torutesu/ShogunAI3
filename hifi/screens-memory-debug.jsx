/* global React */
const { useState, useEffect, useCallback } = React;

function msToLocal(ms) {
  if (!ms) return "—";
  try {
    return new Date(Number(ms)).toLocaleString();
  } catch (_) {
    return "—";
  }
}

function humanBytes(n) {
  if (!n || n < 1024) return `${n || 0} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function TabQueryTester() {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(12);
  const [semantic, setSemantic] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
      if (!invoke) {
        throw new Error("Tauri IPC unavailable");
      }
      const out = await invoke("shogun_memory_debug_query", {
        payload: { query, limit, semantic },
      });
      setResult(out);
    } catch (e) {
      setErr(String(e && e.message ? e.message : e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }, [query, limit, semantic]);

  return (
    <div className="mdbg-tab mdbg-query">
      <div className="mdbg-form">
        <input
          type="text"
          placeholder="クエリ（空欄で最新 N 件）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <input
          type="number"
          min="1"
          max="80"
          value={limit}
          onChange={(e) => setLimit(Math.max(1, Math.min(80, Number(e.target.value) || 12)))}
        />
        <label>
          <input type="checkbox" checked={semantic} onChange={(e) => setSemantic(e.target.checked)} />
          semantic
        </label>
        <button onClick={run} disabled={busy}>{busy ? "…" : "Run"}</button>
      </div>
      {err && <div className="mdbg-err">Error: {err}</div>}
      {result && (
        <div className="mdbg-result">
          <h3>Hits ({result.hits.length})</h3>
          <ol>
            {result.hits.map((h) => (
              <li key={h.id}>
                <strong>[{h.provenance}]</strong> {h.title || "(no title)"} — <code>{h.id}</code>
                <div className="mdbg-snip">{(h.snippet || "").slice(0, 200)}</div>
              </li>
            ))}
          </ol>
          <h3>draft_block ({result.draft_block.length} chars)</h3>
          <pre className="mdbg-pre">{result.draft_block}</pre>
          <h3>brief_block ({result.brief_block.length} chars)</h3>
          <pre className="mdbg-pre">{result.brief_block}</pre>
          <h3>reply_block ({result.reply_block.length} chars)</h3>
          <pre className="mdbg-pre">{result.reply_block}</pre>
        </div>
      )}
    </div>
  );
}

function TabKiokuStats() {
  const [data, setData] = useState(null);
  const [sli, setSli] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
      if (!invoke) {
        throw new Error("Tauri IPC unavailable");
      }
      const r = await invoke("shogun_kioku_debug_stats", { payload: {} });
      setData(r);
      const s = await invoke("shogun_stats", { payload: { stage: "sli" } });
      setSli((s && s.sli) || null);
    } catch (e) {
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
    cost.monthly_cap_usd > 0
      ? Math.min(100, Math.round((cost.spent_usd / cost.monthly_cap_usd) * 100))
      : 0;
  const capColor = capPct >= 100 ? "red" : capPct >= 80 ? "orange" : "green";
  const sliSuccess = Number(sli && sli.successRate ? sli.successRate : 0);
  const sliP95 = Number(sli && sli.p95LatencyMs ? sli.p95LatencyMs : 0);
  const sliBacklog = Number(sli && sli.backlog ? sli.backlog : 0);
  const sliTone = sliSuccess < 95 || sliP95 > 3000 || sliBacklog > 40
    ? "bad"
    : (sliSuccess < 99 || sliP95 > 1500 || sliBacklog > 15 ? "warn" : "good");

  const statusBadge = (label, on) => (
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
      </div>

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

function TabRecentCalls() {
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(null);
  const [err, setErr] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
      if (!invoke) return;
      const out = await invoke("shogun_memory_debug_recent_calls", {
        payload: { limit: 50 },
      });
      setItems((out && out.calls) || []);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

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
              <td>{typeof c.status === "string" ? c.status : (c.status && c.status.Err ? "err" : "ok")}</td>
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

function TabSyncHealth() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
      if (!invoke) return;
      const out = await invoke("shogun_memory_debug_sync_status", { payload: {} });
      setData(out);
    } catch (e) {
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

  const row = (name, d) => (
    <tr key={name}>
      <td>{name}</td>
      <td>{msToLocal(d.last_sync_ms)}</td>
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

function TabDbStats() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
      if (!invoke) return;
      const out = await invoke("shogun_memory_debug_stats", { payload: {} });
      setData(out);
    } catch (e) {
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
        {" — "}earliest: {msToLocal(data.earliest_ms)} / latest: {msToLocal(data.latest_ms)}
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

function ScreenMemoryDebug() {
  const [tab, setTab] = useState("query");
  const tabLabel = (t) => {
    switch (t) {
      case "query": return "Query Tester";
      case "recent": return "Recent Calls";
      case "sync": return "Sync Health";
      case "stats": return "DB Stats";
      case "kioku": return "KIOKU Graph";
      default: return t;
    }
  };
  return (
    <div className="content-memory-debug">
      <div className="mdbg-header">
        <h1>Memory Debugger (dev)</h1>
        <div className="mdbg-tabs">
          {["query", "recent", "sync", "stats", "kioku"].map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {tabLabel(t)}
            </button>
          ))}
        </div>
      </div>
      {tab === "query" && <TabQueryTester />}
      {tab === "recent" && <TabRecentCalls />}
      {tab === "sync" && <TabSyncHealth />}
      {tab === "stats" && <TabDbStats />}
      {tab === "kioku" && <TabKiokuStats />}
    </div>
  );
}

window.ScreenMemoryDebug = ScreenMemoryDebug;

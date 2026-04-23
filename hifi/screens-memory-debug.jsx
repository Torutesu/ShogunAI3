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
      const api = window.ShogunAPI;
      if (!api || !api.memoryDebugQuery) {
        throw new Error("API unavailable");
      }
      const out = await api.memoryDebugQuery({ query, limit, semantic });
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

function TabRecentCalls() {
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(null);
  const [err, setErr] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const out = await window.ShogunAPI.memoryDebugRecentCalls({ limit: 50 });
      setItems(out.calls || []);
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
      const out = await window.ShogunAPI.memoryDebugSyncStatus();
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
      const out = await window.ShogunAPI.memoryDebugStats();
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
  return (
    <div className="content-memory-debug">
      <div className="mdbg-header">
        <h1>Memory Debugger (dev)</h1>
        <div className="mdbg-tabs">
          {["query", "recent", "sync", "stats"].map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {t === "query" ? "Query Tester" : t === "recent" ? "Recent Calls" : t === "sync" ? "Sync Health" : "DB Stats"}
            </button>
          ))}
        </div>
      </div>
      {tab === "query" && <TabQueryTester />}
      {tab === "recent" && <TabRecentCalls />}
      {tab === "sync" && <TabSyncHealth />}
      {tab === "stats" && <TabDbStats />}
    </div>
  );
}

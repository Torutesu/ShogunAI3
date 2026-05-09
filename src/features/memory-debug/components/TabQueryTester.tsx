import { useState, useCallback } from 'react';
import { tauriInvoke } from '../lib/tauri-invoke';
import type { QueryResult } from '../types';

export function TabQueryTester() {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(12);
  const [semantic, setSemantic] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const out = await tauriInvoke<QueryResult>("shogun_memory_debug_query", {
        payload: { query, limit, semantic },
      });
      setResult(out);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
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

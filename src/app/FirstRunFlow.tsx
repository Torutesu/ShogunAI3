// First-run "aha" flow (spec: docs/superpowers/specs/2026-07-16-first-run-aha-flow-design.md)
//
// Three acts, target under 3 minutes, on the user's own data:
//   1. permission  — grant Accessibility; auto-advances when trusted
//   2. capture     — watch the first memory fragments appear (live counter)
//   3. search      — first search over your own memory = the aha
//
// Runs between EntitlementGate and McpSetupGate (value before setup). Uses raw
// IPC only — SHOGUN_RUNTIME does not exist yet at gate time. Zero Rust changes.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ShogunIpcClient } from '@/shared/ipc/ipc-client';

type Ipc = ReturnType<typeof ShogunIpcClient.createIpcClient>;

type GateState = 'loading' | 'bypass' | 'ok' | 'flow';

function isFirstRunComplete(sections: Record<string, unknown> | null | undefined): boolean {
  const raw = sections && (sections as Record<string, unknown>).onboarding;
  if (!raw || typeof raw !== 'object') return false;
  return Boolean((raw as Record<string, unknown>).firstRunComplete);
}

const JA = (typeof navigator !== 'undefined' ? navigator.language || '' : '').toLowerCase().startsWith('ja');
const T = {
  permTitle: JA ? 'SHOGUN はあなたの画面のテキストを読みます。' : 'SHOGUN reads the text on your screen.',
  permSub: JA ? 'だから最初に、その許可を。' : "So first, it asks for permission.",
  permPoints: JA
    ? ['スクリーンショットではなく、テキストだけ', '記憶はこの Mac から出ません', 'パスワード欄・決済ページは除外されます']
    : ['Text, not screenshots', 'Memory never leaves this Mac', 'Password fields and payment pages are excluded'],
  permBtn: JA ? 'システム設定を開く' : 'Open System Settings',
  permWaiting: JA ? '許可を待っています…（許可すると自動で進みます）' : 'Waiting for permission… (advances automatically)',
  skip: JA ? 'あとで' : 'Skip for now',
  capTitle: JA ? '最初の記憶が生まれています。' : 'Your first memories are forming.',
  capSub: JA ? 'いつもの作業をどうぞ。SHOGUN は見ています。' : 'Go do your normal work. SHOGUN is watching.',
  capCount: JA ? '記憶した断片' : 'fragments remembered',
  capHint: JA ? '増えないときは、前面のアプリを切り替えてみてください。' : 'Not moving? Try switching to another app window.',
  capCta: JA ? '最初の検索をする →' : 'Run your first search →',
  searchTitle: JA ? 'あなたの記憶に、聞いてみてください。' : 'Now ask your own memory.',
  searchPh: (app: string) =>
    JA ? `さっき ${app} で見ていたこと…` : `Something you just saw in ${app}…`,
  searchPhGeneric: JA ? 'ついさっき画面で見ていたこと…' : 'Something you saw on screen just now…',
  searchBtn: JA ? '検索' : 'Search',
  ahaLine: JA ? 'これがあなたの記憶です。今日から、勝手に増えていきます。' : 'This is your memory. From today, it grows on its own.',
  noHits: JA ? 'まだヒットしません — 数分使ってから、アプリ内でもう一度試せます。' : 'No hits yet — give it a few minutes; you can search again inside the app.',
  openApp: JA ? 'SHOGUN を開く' : 'Open SHOGUN',
};

const box: React.CSSProperties = {
  maxWidth: 560,
  margin: '10vh auto 0',
  padding: '36px 40px',
  background: 'var(--surface, #141414)',
  border: '1px solid var(--border, #2a2a2a)',
  borderRadius: 14,
};
const h1s: React.CSSProperties = { fontSize: 22, fontWeight: 600, lineHeight: 1.3, margin: 0 };
const subS: React.CSSProperties = { color: 'var(--text-mute, #999)', fontSize: 14, marginTop: 10, lineHeight: 1.6 };
const dimLink: React.CSSProperties = {
  background: 'none', border: 'none', color: 'var(--text-dim, #666)', fontSize: 12, cursor: 'pointer', padding: 4,
};

export function FirstRunFlow({ ipc, onComplete }: { ipc: Ipc; onComplete: () => void }) {
  const [act, setAct] = useState<1 | 2 | 3>(1);
  const [trusted, setTrusted] = useState<boolean | null>(null);
  const [count, setCount] = useState(0);
  const [lastApp, setLastApp] = useState('');
  const [stalled, setStalled] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Array<{ id?: string; title?: string; snippet?: string }> | null>(null);
  const [searching, setSearching] = useState(false);
  const enteredCaptureAt = useRef(0);

  const finish = useCallback(async () => {
    await ipc
      .invoke('app_settings_save', { section: 'onboarding', firstRunComplete: true })
      .catch(() => undefined);
    onComplete();
  }, [ipc, onComplete]);

  // Act 1: poll Accessibility trust; auto-advance on grant.
  useEffect(() => {
    if (act !== 1) return;
    let alive = true;
    const tick = async () => {
      const res = await ipc.invoke('shogun_capture_status', {});
      if (!alive) return;
      const ok = Boolean(
        res.ok && res.data && res.data.permissions && res.data.permissions.accessibilityTrusted,
      );
      setTrusted(ok);
      if (ok) setAct(2);
    };
    void tick();
    const id = window.setInterval(tick, 2000);
    return () => { alive = false; window.clearInterval(id); };
  }, [act, ipc]);

  // Act 2: live fragment counter.
  useEffect(() => {
    if (act !== 2) return;
    enteredCaptureAt.current = Date.now();
    let alive = true;
    const tick = async () => {
      const res = await ipc.invoke('shogun_capture_live_events', { limit: 50 });
      if (!alive) return;
      const events = (res.ok && res.data && Array.isArray(res.data.events)) ? res.data.events : [];
      // Prefer the count of captures actually persisted; fall back to the live
      // event ring only if the backend didn't report it. Input events climb from
      // clicks/scrolls even when nothing is stored, so they overstate progress.
      const persisted = (res.ok && res.data && typeof res.data.persistedCaptures === 'number')
        ? res.data.persistedCaptures as number
        : null;
      const shown = persisted ?? events.length;
      setCount(shown);
      const last = events[0] as { app?: string } | undefined;
      if (last && typeof last.app === 'string' && last.app) setLastApp(last.app);
      if (shown === 0 && Date.now() - enteredCaptureAt.current > 60_000) setStalled(true);
    };
    void tick();
    const id = window.setInterval(tick, 2000);
    return () => { alive = false; window.clearInterval(id); };
  }, [act, ipc]);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    const res = await ipc.invoke('shogun_memory_search', { query: q, limit: 3 });
    setSearching(false);
    const found = (res.ok && res.data && Array.isArray(res.data.hits)) ? res.data.hits : [];
    setHits(found);
  }, [ipc, query, searching]);

  // Strip FTS highlight sentinels (STX/ETX) from titles/snippets.
  // eslint-disable-next-line no-control-regex
  const clean = (s: unknown) => String(s || '').replace(/[\u0002\u0003]/g, '');
  const placeholder = useMemo(
    () => (lastApp ? T.searchPh(lastApp) : T.searchPhGeneric),
    [lastApp],
  );

  return (
    <div data-testid="firstrun" style={{ minHeight: '100vh', background: 'var(--bg, #080808)' }}>
      <style>{`
        @keyframes fr-pulse { 0% { box-shadow: 0 0 0 0 rgba(200,169,110,.45); } 100% { box-shadow: 0 0 0 18px rgba(200,169,110,0); } }
        .fr-hit-fresh { animation: fr-pulse .9s ease-out 1; }
        @media (prefers-reduced-motion: reduce) { .fr-hit-fresh { animation: none; } }
      `}</style>

      {act === 1 && (
        <div style={box} data-testid="firstrun-permission">
          <h1 style={h1s}>{T.permTitle}</h1>
          <p style={subS}>{T.permSub}</p>
          <ul style={{ margin: '18px 0 0', padding: 0, listStyle: 'none' }}>
            {T.permPoints.map((p) => (
              <li key={p} style={{ ...subS, marginTop: 6, display: 'flex', gap: 8 }}>
                <span style={{ color: 'var(--gold, #C8A96E)' }}>—</span>{p}
              </li>
            ))}
          </ul>
          <div style={{ marginTop: 26 }}>
            <button
              type="button"
              className="btn"
              onClick={() => void ipc.invoke('app_permissions_manage', { target: 'accessibility', source: 'first_run' })}
            >
              {T.permBtn}
            </button>
          </div>
          {trusted === false && <p style={{ ...subS, fontSize: 12, marginTop: 16 }}>{T.permWaiting}</p>}
          <div style={{ textAlign: 'right', marginTop: 18 }}>
            <button type="button" style={dimLink} data-testid="firstrun-skip" onClick={() => void finish()}>
              {T.skip}
            </button>
          </div>
        </div>
      )}

      {act === 2 && (
        <div style={box} data-testid="firstrun-capture">
          <h1 style={h1s}>{T.capTitle}</h1>
          <p style={subS}>{T.capSub}</p>
          <div style={{ textAlign: 'center', margin: '34px 0 8px' }}>
            <div data-testid="firstrun-count" style={{ fontSize: 52, fontWeight: 600, color: 'var(--gold, #C8A96E)', lineHeight: 1 }}>
              {count}
            </div>
            <div style={{ ...subS, marginTop: 8, fontFamily: 'JetBrains Mono, SF Mono, monospace', fontSize: 12 }}>
              {T.capCount}
            </div>
          </div>
          {stalled && count === 0 && <p style={{ ...subS, fontSize: 12 }}>{T.capHint}</p>}
          <div style={{ textAlign: 'center', marginTop: 24, minHeight: 40 }}>
            {count >= 5 && (
              <button type="button" className="btn" data-testid="firstrun-to-search" onClick={() => setAct(3)}>
                {T.capCta}
              </button>
            )}
          </div>
          <div style={{ textAlign: 'right', marginTop: 8 }}>
            <button type="button" style={dimLink} data-testid="firstrun-skip" onClick={() => void finish()}>
              {T.skip}
            </button>
          </div>
        </div>
      )}

      {act === 3 && (
        <div style={box} data-testid="firstrun-search">
          <h1 style={h1s}>{T.searchTitle}</h1>
          <form
            style={{ display: 'flex', gap: 8, marginTop: 22 }}
            onSubmit={(e) => { e.preventDefault(); void runSearch(); }}
          >
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={placeholder}
              aria-label={T.searchTitle}
              style={{
                flex: 1, background: 'var(--bg, #080808)', border: '1px solid var(--border, #2a2a2a)',
                borderRadius: 8, color: 'var(--text, #fff)', padding: '12px 14px', fontSize: 14,
              }}
            />
            <button type="submit" className="btn" disabled={searching || !query.trim()}>
              {T.searchBtn}
            </button>
          </form>

          {hits !== null && (
            <div style={{ marginTop: 20 }} data-testid="firstrun-hits">
              {hits.length > 0 ? (
                <>
                  {hits.map((h, i) => (
                    <div
                      key={h.id || i}
                      className={i === 0 ? 'fr-hit-fresh' : undefined}
                      style={{
                        border: '1px solid var(--border, #2a2a2a)', borderRadius: 10,
                        padding: '12px 14px', marginTop: 10, background: 'var(--surface, #141414)',
                      }}
                    >
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{clean(h.title)}</div>
                      <div style={{ ...subS, fontSize: 12, marginTop: 4 }}>{clean(h.snippet).slice(0, 160)}</div>
                    </div>
                  ))}
                  <p style={{ ...subS, marginTop: 18, color: 'var(--gold, #C8A96E)' }}>{T.ahaLine}</p>
                </>
              ) : (
                <p style={{ ...subS }}>{T.noHits}</p>
              )}
            </div>
          )}

          <div style={{ textAlign: 'right', marginTop: 26 }}>
            <button type="button" className="btn" data-testid="firstrun-finish" onClick={() => void finish()}>
              {T.openApp}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function FirstRunGate({ children }: { children: React.ReactNode }) {
  const [gate, setGate] = useState<GateState>('loading');

  const ipc = useMemo(() => {
    if (!ShogunIpcClient || !ShogunIpcClient.createIpcClient) return null;
    return ShogunIpcClient.createIpcClient();
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!ipc) { setGate('bypass'); return; }
      const res = await ipc.invoke('app_settings_load', {});
      if (cancelled) return;
      const sections =
        res.ok && res.data && res.data.settings ? res.data.settings.sections : null;
      setGate(isFirstRunComplete(sections) ? 'ok' : 'flow');
    })();
    return () => { cancelled = true; };
  }, [ipc]);

  if (gate === 'loading') {
    return <div style={{ padding: 32, color: 'var(--text-dim)', fontSize: 13 }}>Loading…</div>;
  }
  if (gate === 'bypass' || gate === 'ok') return <>{children}</>;
  return ipc ? <FirstRunFlow ipc={ipc} onComplete={() => setGate('ok')} /> : <>{children}</>;
}

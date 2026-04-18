/* global Icon, React */
const { useState, useEffect, useMemo, useCallback } = React;

function runRuntimeActionA(key, payload, options) {
  if (!window.SHOGUN_RUNTIME || !window.SHOGUN_RUNTIME.executeAction) return Promise.resolve({ ok:false });
  return window.SHOGUN_RUNTIME.executeAction(key, payload || {}, options || {});
}

function requestWriteActionA(actionKey, payload, title, description) {
  if (!window.SHOGUN_RUNTIME || !window.SHOGUN_RUNTIME.requestWriteAction) return;
  window.SHOGUN_RUNTIME.requestWriteAction(actionKey, payload, title, description);
}

function memoryHitToRiverEvent(hit) {
  const ts = hit.created_at != null ? Number(hit.created_at) : Date.now();
  const d = new Date(ts);
  const hRaw = d.getHours() + d.getMinutes() / 60;
  const h = Math.max(6, Math.min(22, hRaw));
  const t = d.toTimeString().slice(0, 5);
  const rawSrc = String(hit.source || '').toLowerCase();
  let src = 'note';
  if (rawSrc === 'meetings' || (Array.isArray(hit.kinds) && hit.kinds.indexOf('audio') >= 0)) src = 'meet';
  else if (rawSrc === 'chat') src = 'chat';
  else if (rawSrc === 'work') src = 'code';
  return {
    t,
    h,
    src,
    title: hit.title || 'Memory',
    snippet: hit.snippet || '',
    memoryId: hit.id,
    big: false,
  };
}

function mergeIndexHitsIntoRiver(res, setEvents, setScrubIdx) {
  if (!res || !res.ok || !res.data) return;
  const hits = res.data.hits;
  if (!Array.isArray(hits) || hits.length === 0) {
    setEvents([]);
    setScrubIdx(0);
    return;
  }
  const mapped = hits.map(memoryHitToRiverEvent);
  setEvents(mapped);
  setScrubIdx(0);
}

// ═══════════════════════════════════════════════════════════════════════════
// L1 · HOME — the launch pad
// ═══════════════════════════════════════════════════════════════════════════
function ScreenHome() {
  const [morningBrief, setMorningBrief] = useState(null);
  const [briefErr, setBriefErr] = useState(null);
  const [memoryTotal, setMemoryTotal] = useState(null);
  const headLine = useMemo(() => {
    const d = new Date();
    const h = d.getHours();
    const greet = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    const dateStr = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    return { greet, dateStr };
  }, []);

  useEffect(() => {
    let cancelled = false;
    runRuntimeActionA('stats.get', {}, { silentError: true }).then((r) => {
      if (cancelled || !r?.ok || !r.data) return;
      const n = Number(r.data.memoryTotal);
      if (!Number.isNaN(n)) setMemoryTotal(n);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await runRuntimeActionA(
        "brief.get",
        { span: "today", source: "home" },
        { silentError: true }
      );
      if (cancelled) return;
      if (!res.ok || !res.data) {
        setBriefErr("brief unavailable");
        return;
      }
      const inner = res.data;
      if (inner.skipped || !inner.brief) {
        setMorningBrief(null);
        return;
      }
      setMorningBrief(inner.brief);
      if (window.BriefTelemetry) {
        window.BriefTelemetry.log(window.BriefTelemetry.EVENTS.BRIEF_RENDERED, {
          itemCount: inner.brief.items?.length || 0,
        });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const runBriefMcp = (item, tool) => {
    if (!tool?.tool_name) return;
    const key = tool.tool_name;
    const payload = {
      ...(tool.arguments && typeof tool.arguments === "object" ? tool.arguments : {}),
      brief_item: {
        id: item.id,
        what: item.what,
        why_now: item.why_now,
        related_context: item.related_context,
        category: item.category,
        priority: item.priority,
        time_hint: item.time_hint,
      },
    };
    runRuntimeActionA(key, payload, { successMessage: item.next_action?.label || "Done" });
    if (window.BriefTelemetry) {
      window.BriefTelemetry.log(window.BriefTelemetry.EVENTS.NEXT_ACTION_CLICK, {
        itemId: item.id,
        tool: key,
      });
    }
  };

  const dismissBriefItem = (item) => {
    setMorningBrief((prev) => {
      if (!prev?.items) return prev;
      return {
        ...prev,
        items: prev.items.filter((i) => i.id !== item.id),
      };
    });
    if (window.BriefTelemetry) {
      window.BriefTelemetry.log(window.BriefTelemetry.EVENTS.ITEM_DISMISS, { itemId: item.id });
    }
  };

  const submitBriefRating = (n) => {
    if (window.BriefTelemetry) {
      window.BriefTelemetry.log(window.BriefTelemetry.EVENTS.RATING, { score: n });
    }
    runRuntimeActionA("settings.save", { section: "brief", rating: n }, { successMessage: "Thanks — saved locally" });
  };

  return (
    <div className="content-inner" style={{maxWidth:880, margin:'0 auto', padding:'clamp(36px, 8vw, 80px) clamp(20px, 4vw, 40px) clamp(40px, 6vw, 64px)'}}>
      <div style={{marginBottom:48}}>
        <div className="t-mono" style={{marginBottom:12}}>{headLine.dateStr}</div>
        <h1 style={{fontSize:'clamp(28px, 5vw, 40px)', fontWeight:600, letterSpacing:'-0.02em', margin:'0 0 10px'}}>{headLine.greet}.</h1>
        <div style={{color:'var(--text-mute)', fontSize:16}}>
          {memoryTotal != null ? (
            <span><span className="en-only">{memoryTotal} memories indexed locally.</span><span className="jp">ローカルに索引済みの記憶: {memoryTotal} 件</span></span>
          ) : (
            <span className="muted">Loading memory stats…</span>
          )}
        </div>
      </div>

      {morningBrief && (
        <div className="card" style={{padding:28, borderColor:'var(--gold-dim)', marginBottom:20, background:'var(--surface)'}}>
          <div className="row" style={{marginBottom:14, alignItems:'baseline', gap:12}}>
            <div className="t-mono gold">MORNING BRIEF · AMC</div>
            <span className="pill" style={{fontSize:10}}>{morningBrief.posture}</span>
            <span className="spacer"/>
            <span className="t-mono xsmall muted">{morningBrief.generated_at?.slice(11,16)} JST</span>
          </div>
          <div style={{fontSize:20, fontWeight:600, marginBottom:18, lineHeight:1.35}}>{morningBrief.headline}</div>
          <div style={{display:'flex', flexDirection:'column', gap:12}}>
            {(morningBrief.items || []).map((item) => (
              <div key={item.id} style={{border:'1px solid var(--border)', borderRadius:'var(--radius-md)', padding:14}}>
                <div className="row" style={{gap:8, marginBottom:6, flexWrap:'wrap'}}>
                  <span className="t-mono xsmall" style={{color:'var(--gold)'}}>P{item.priority}</span>
                  <span className="t-mono xsmall muted">{item.category}</span>
                  {item.time_hint && <span className="t-mono xsmall">{item.time_hint}</span>}
                  <span className="spacer"/>
                  <button type="button" className="btn btn-sm btn-ghost" style={{fontSize:10, height:24}} onClick={()=>dismissBriefItem(item)}>見送る</button>
                </div>
                <div style={{fontSize:15, fontWeight:600, marginBottom:4}}>{item.what}</div>
                <div style={{fontSize:12, color:'var(--text-dim)', marginBottom:10, lineHeight:1.5}}>{item.why_now}</div>
                {(item.related_context || []).length > 0 && (
                  <div style={{fontSize:11, color:'var(--text-mute)', marginBottom:10}}>
                    {(item.related_context || []).map((r) => (
                      <span key={r.uri} style={{marginRight:10}}>{r.title} · {r.last_touched}</span>
                    ))}
                  </div>
                )}
                <div className="row" style={{gap:8, flexWrap:'wrap'}}>
                  {item.next_action?.mcp_tool ? (
                    <button type="button" className="btn btn-sm btn-secondary" onClick={()=>runBriefMcp(item, item.next_action.mcp_tool)}>
                      {item.next_action.label} <Icon name="arrowRight" size={14}/>
                    </button>
                  ) : (
                    <span className="xsmall muted">No MCP action</span>
                  )}
                </div>
              </div>
            ))}
          </div>
          {morningBrief.deferred_count > 0 && (
            <div className="xsmall muted" style={{marginTop:14}}>+ {morningBrief.deferred_count} deferred</div>
          )}
          <div className="row" style={{marginTop:16, gap:6, alignItems:'center'}}>
            <span className="xsmall muted">今日の品質 (1–5)</span>
            {[1,2,3,4,5].map((n) => (
              <button key={n} type="button" className="btn btn-sm btn-ghost" style={{minWidth:32, height:28, fontSize:11}} onClick={()=>submitBriefRating(n)}>{n}</button>
            ))}
          </div>
        </div>
      )}
      {briefErr && (
        <div className="xsmall muted" style={{marginBottom:16}}>{briefErr}</div>
      )}
      {/* Ask SHOGUN — opens Chat */}
      <div style={{display:'flex', gap:12, alignItems:'center', padding:'4px 0'}}>
        <div
          role="button"
          tabIndex={0}
          className="row"
          style={{
            flex: 1,
            height: 56,
            padding: '0 20px',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)',
            color: 'var(--text-dim)',
            fontSize: 15,
            cursor: 'pointer',
          }}
          onClick={() => window.SHOGUN_RUNTIME?.setActiveScreen?.('chat')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              window.SHOGUN_RUNTIME?.setActiveScreen?.('chat');
            }
          }}
        >
          <Icon name="search" size={16}/>
          <span className="en-only">Open Chat to query memory…</span>
          <span className="jp">チャットで記憶を検索…</span>
          <span className="spacer"/>
          <span className="t-mono" style={{fontSize:11, border:'1px solid var(--border)', padding:'2px 8px', borderRadius:4}}>⌘K</span>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// L2 · MEMORY TIMELINE — HERO
// ═══════════════════════════════════════════════════════════════════════════
function ScreenMemory() {
  const [view, setView] = useState('river');
  const [events, setEvents] = useState(() => []);
  const [scrubIdx, setScrubIdx] = useState(0);
  const [sourceEntities, setSourceEntities] = useState([]);
  const [semanticMemorySearch, setSemanticMemorySearch] = useState(true);
  const [memorySettingsLoaded, setMemorySettingsLoaded] = useState(false);
  const timelineLoading = !memorySettingsLoaded;
  const withSemantic = useCallback(
    (payload) => {
      if (!semanticMemorySearch) return payload;
      const q = String((payload && payload.query) || '').trim();
      if (!q) return payload;
      return { ...payload, semantic: true };
    },
    [semanticMemorySearch],
  );
  const refreshSourceEntities = () => {
    runRuntimeActionA('entity.query', { query: '' }, { silentError: true }).then((res) => {
      if (!res || !res.ok || !res.data || !Array.isArray(res.data.entities)) return;
      setSourceEntities(res.data.entities);
    });
  };
  useEffect(() => {
    refreshSourceEntities();
  }, []);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await runRuntimeActionA('settings.load', {}, { silentError: true });
      if (cancelled) return;
      const mem = r?.ok && r.data?.settings?.sections?.memory;
      if (mem && typeof mem === 'object' && typeof mem.semanticRerank === 'boolean') {
        setSemanticMemorySearch(mem.semanticRerank);
      }
      setMemorySettingsLoaded(true);
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!memorySettingsLoaded) return;
    let cancelled = false;
    (async () => {
      const res = await runRuntimeActionA('memory.search', withSemantic({ query: '', limit: 40 }), { silentError: true });
      if (cancelled) return;
      mergeIndexHitsIntoRiver(res, setEvents, setScrubIdx);
    })();
    return () => { cancelled = true; };
  }, [memorySettingsLoaded, withSemantic]);
  useEffect(() => {
    const onIndexChanged = async () => {
      const r = await runRuntimeActionA('memory.search', withSemantic({ query: '', limit: 40 }), { silentError: true });
      mergeIndexHitsIntoRiver(r, setEvents, setScrubIdx);
      refreshSourceEntities();
    };
    window.addEventListener('shogun-memory-index-changed', onIndexChanged);
    return () => window.removeEventListener('shogun-memory-index-changed', onIndexChanged);
  }, [withSemantic]);
  useEffect(() => {
    setScrubIdx((i) => {
      if (events.length === 0) return 0;
      return Math.min(i, events.length - 1);
    });
  }, [events.length]);
  useEffect(() => {
    const onJump = () => {
      setView('river');
      requestAnimationFrame(() => {
        const el = document.querySelector('.memory-scrub-stage');
        if (el && typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      });
    };
    window.addEventListener('shogun-jump-memory-timeline', onJump);
    return () => window.removeEventListener('shogun-jump-memory-timeline', onJump);
  }, []);
  const { bins, maxBin } = useMemo(() => {
    const binCount = 64;
    const b = new Array(binCount).fill(0);
    events.forEach((e) => {
      const p = Math.max(0, Math.min(1, (e.h - 6) / (22 - 6)));
      b[Math.floor(p * (binCount - 1))] += e.big ? 2 : 1;
    });
    return { bins: b, maxBin: Math.max(...b, 1) };
  }, [events]);
  const scrubbed = timelineLoading
    ? { t: '--', h: 12, src: 'note', title: '', snippet: '', memoryId: null }
    : events.length
      ? events[Math.min(scrubIdx, events.length - 1)]
      : { t: '--', h: 12, src: 'note', title: 'No memories', snippet: '' };
  const srcIcon = s => s==='chat'?'chat':s==='meet'?'calendar':s==='note'?'note':s==='mail'?'mail':s==='agent'?'bot':s==='code'?'terminal':'file';
  const srcLabel = s => ({chat:'Conversation',meet:'Meeting',note:'Note',mail:'Email',agent:'Agent run',code:'Code'})[s]||'Event';
  const memoryHeadDate = useMemo(() => {
    const d = new Date();
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  }, []);

  const hourIndexFromEvents = useMemo(() => {
    const counts = new Array(24).fill(0);
    const firstIdx = new Array(24).fill(-1);
    events.forEach((e, i) => {
      const hh = Math.floor(Number(e.h));
      const h = Math.max(0, Math.min(23, Number.isFinite(hh) ? hh : 12));
      if (firstIdx[h] < 0) firstIdx[h] = i;
      counts[h] += 1;
    });
    const maxC = Math.max(1, ...counts);
    return { counts, firstIdx, maxC };
  }, [events]);

  const timeSpanLabel = useMemo(() => {
    if (!events.length) return '—';
    const hs = events.map((e) => Number(e.h)).filter((n) => Number.isFinite(n));
    if (!hs.length) return '—';
    const mn = Math.min(...hs);
    const mx = Math.max(...hs);
    const fmt = (x) => {
      const h = Math.floor(x);
      const m = Math.round((x - h) * 60) % 60;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };
    return `${fmt(mn)}–${fmt(mx)}`;
  }, [events]);

  return (
    <div className="content-inner wide" style={{padding:0, height:'100%', display:'flex', flexDirection:'column'}}>
      {/* Header */}
      <div style={{padding:'24px 40px 0', display:'flex', alignItems:'flex-end', gap:20}}>
        <div>
          <div className="t-mono" style={{marginBottom:6}}>MEMORY / TIMELINE</div>
          <h1 style={{margin:0, fontSize:28, fontWeight:600}}>{memoryHeadDate} <span className="jp muted" style={{fontSize:16, fontWeight:300, marginLeft:8}}>時間軸</span></h1>
          <div className="muted" style={{marginTop:8, fontSize:12, lineHeight:1.45, maxWidth:560}}>
            Memory index stays on this Mac in this build (no SHOGUN cloud sync).
            <span className="jp" style={{display:'block', fontSize:11, marginTop:4, color:'var(--text-dim)'}}>このビルドでは Memory はこの Mac にローカル保存です（SHOGUN クラウド同期なし）。</span>
          </div>
        </div>
        <span className="spacer"/>
        <div style={{display:'flex', border:'1px solid var(--border)', borderRadius:'var(--radius-md)', overflow:'hidden'}}>
          {[['river','Timeline'],['stack','List']].map(([k,l])=>(
            <button key={k} type="button" onClick={()=>setView(k)} className="btn btn-sm" style={{borderRadius:0, border:0, background: view===k?'var(--surface-2)':'transparent', color: view===k?'var(--gold)':'var(--text-mute)'}}>{l}</button>
          ))}
        </div>
        <div className="row" style={{gap:8, alignItems:'center', flexWrap:'wrap'}}>
          <label className="row" style={{gap:6, alignItems:'center', fontSize:11, color:'var(--text-dim)', cursor:'pointer', userSelect:'none'}}>
            <input
              type="checkbox"
              data-testid="memory-semantic-rerank"
              checked={semanticMemorySearch}
              onChange={(e) => {
                const next = e.target.checked;
                setSemanticMemorySearch(next);
                void runRuntimeActionA(
                  'settings.save',
                  { section: 'memory', semanticRerank: next },
                  { silentError: true },
                );
              }}
            />
            <span className="en-only">Semantic re-rank</span>
            <span className="jp" style={{fontSize:10}}>意味で再ランク（API 1回/検索）</span>
          </label>
          <button type="button" className="btn btn-sm btn-secondary" onClick={async ()=>{
            const res = await runRuntimeActionA('memory.search', withSemantic({ query:'filters timeline', kinds:['screen','audio','input'], limit:50 }), { successMessage:'Filters applied' });
            mergeIndexHitsIntoRiver(res, setEvents, setScrubIdx);
          }}><Icon name="filter" size={14}/>Filters</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={async ()=>{
            await runRuntimeActionA('memory.ingest', { title:'Quick capture · '+new Date().toLocaleTimeString(), snippet:'Saved from Memory screen.', source:'capture', kinds:['input'] }, { successMessage:'Memory indexed' });
            const r = await runRuntimeActionA('memory.search', withSemantic({ query:'', limit:40 }), { silentError:true });
            mergeIndexHitsIntoRiver(r, setEvents, setScrubIdx);
            refreshSourceEntities();
          }}>Quick save</button>
        </div>
      </div>

      <div
        className="memory-entity-sources"
        data-testid="memory-entity-sources"
        style={{padding:'8px 40px 4px', borderBottom:'1px solid var(--border)'}}
      >
        <div className="t-mono" style={{fontSize:10, color:'var(--text-mute)', marginBottom:6}}>SOURCES IN INDEX · カタログ別件数</div>
        <div style={{display:'flex', flexWrap:'wrap', gap:8, alignItems:'center'}}>
          {sourceEntities.length === 0 ? (
            <span style={{fontSize:12, color:'var(--text-dim)'}}>No indexed sources yet — ingest or sync to populate.</span>
          ) : (
            sourceEntities.map((row) => (
              <span key={row.id || row.label} className="label" style={{fontSize:11}}>
                {row.label || 'unknown'} · {row.mentions != null ? row.mentions : '—'}
              </span>
            ))
          )}
          <button type="button" className="btn btn-sm btn-ghost" style={{marginLeft:'auto', fontSize:11}} onClick={() => refreshSourceEntities()}>Refresh</button>
        </div>
      </div>

      {/* Hour distribution from index (click a bar to jump to that hour) */}
      <div style={{padding:'12px 40px 8px', display:'flex', alignItems:'center', gap:14, flexWrap:'wrap'}}>
        <span className="t-mono" style={{fontSize:10, color:'var(--text-mute)'}}>
          <span className="en-only">By hour</span>
          <span className="jp">時間帯</span>
        </span>
        <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)'}}>
          {timelineLoading ? (
            <span className="muted">
              <span className="en-only">Loading…</span>
              <span className="jp">読み込み中…</span>
            </span>
          ) : (
            <>
              {events.length} {events.length === 1 ? 'event' : 'events'} · {timeSpanLabel}
            </>
          )}
        </span>
      </div>
      <div style={{padding:'0 40px 16px'}}>
        <div className="card" style={{padding:'12px 14px'}}>
          {timelineLoading ? (
            <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
              <span className="en-only">Loading timeline…</span>
              <span className="jp">タイムラインを読み込み中…</span>
            </div>
          ) : events.length === 0 ? (
            <div style={{fontSize:12, color:'var(--text-dim)'}}>No events in the index yet — use Quick save or ingest from the desktop app.</div>
          ) : (
            <div style={{display:'flex', gap:4, alignItems:'flex-end', overflowX:'auto', paddingBottom:4}}>
              {hourIndexFromEvents.counts.map((cnt, h) => {
                const hgt = cnt === 0 ? 2 : 4 + (cnt / hourIndexFromEvents.maxC) * 52;
                const has = cnt > 0;
                const jump = hourIndexFromEvents.firstIdx[h];
                const sel = has && events[scrubIdx] && Math.floor(Number(events[scrubIdx].h)) === h;
                return (
                  <button
                    key={h}
                    type="button"
                    title={has ? `${String(h).padStart(2, '0')}:00 · ${cnt} — click to open` : `${String(h).padStart(2, '0')}:00`}
                    disabled={!has}
                    onClick={() => has && jump >= 0 && setScrubIdx(jump)}
                    style={{
                      flex: '0 0 26px',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 4,
                      background: 'transparent',
                      border: 'none',
                      padding: '4px 0 0',
                      cursor: has ? 'pointer' : 'default',
                      opacity: has ? 1 : 0.35,
                    }}
                  >
                    <div
                      style={{
                        width: 14,
                        height: hgt,
                        borderRadius: 2,
                        background: sel ? 'var(--gold)' : 'var(--text-dim)',
                        opacity: sel ? 1 : has ? 0.55 : 0.25,
                      }}
                    />
                    <span className="t-mono" style={{ fontSize: 8, color: sel ? 'var(--gold)' : 'var(--text-dim)' }}>{String(h).padStart(2, '0')}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>


      {/* River view — scrubbable timeline */}
      {view==='river' && (
        <div style={{flex:1, padding:'0 40px 32px', minHeight:0, overflow:'hidden', display:'flex', flexDirection:'column', gap:14}}>

          {/* Scrubbed moment preview — top stage */}
          <div className="card memory-scrub-stage" style={{flex:1, padding:0, minHeight:0, display:'flex', overflow:'hidden'}}>
            {/* Left: what happened */}
            <div style={{flex:'0 0 42%', padding:'24px 28px', borderRight:'1px solid var(--border)', display:'flex', flexDirection:'column', gap:12, overflow:'auto'}}>
              <div className="row" style={{gap:10}}>
                <div style={{width:32, height:32, borderRadius:'var(--radius-md)', background:'var(--surface-2)', border:'1px solid var(--gold-dim)', display:'flex', alignItems:'center', justifyContent:'center'}}>
                  <Icon name={srcIcon(scrubbed.src)} size={14} className="gold"/>
                </div>
                <div>
                  <div className="t-mono" style={{fontSize:10}}>{srcLabel(scrubbed.src).toUpperCase()} · {scrubbed.t}</div>
                  <div style={{fontSize:18, fontWeight:500, marginTop:2, letterSpacing:'-0.01em'}}>
                    {timelineLoading ? (
                      <span className="muted">
                        <span className="en-only">Loading timeline…</span>
                        <span className="jp">読み込み中…</span>
                      </span>
                    ) : (
                      scrubbed.title
                    )}
                  </div>
                </div>
              </div>

              <div className="row" style={{gap:6, flexWrap:'wrap', marginTop:2}}>
                {scrubbed.tag==='auto' && <span className="label label-gold"><Icon name="bot" size={10} style={{marginRight:4}}/>auto-captured</span>}
                {scrubbed.memoryId && <span className="label">index</span>}
                {scrubbed.dur && <span className="label"><Icon name="clock" size={10} style={{marginRight:4}}/>{scrubbed.dur}</span>}
              </div>

              <div style={{fontSize:13, lineHeight:1.65, color:'var(--text-mute)', marginTop:4}}>
                {timelineLoading ? (
                  <span className="muted">
                    <span className="en-only">Applying Memory search preferences before the first fetch.</span>
                    <span className="jp" style={{ display: 'block', marginTop: 4 }}>初回取得の前に設定を適用しています。</span>
                  </span>
                ) : (
                  scrubbed.snippet || (events.length ? 'No snippet text for this entry.' : 'No memories in the index yet.')
                )}
              </div>

              <span className="spacer"/>
              <div className="row" style={{gap:8, paddingTop:10, borderTop:'1px solid var(--border)', marginTop:10, flexWrap:'wrap'}}>
                <button type="button" className="btn btn-sm btn-secondary" disabled={timelineLoading} onClick={()=>runRuntimeActionA('memory.search', withSemantic({ query:scrubbed.title, limit:10 }), { successMessage:'Search run' })}><Icon name="chat" size={12}/>Search title</button>
                <button type="button" className="btn btn-sm btn-secondary" disabled={timelineLoading} onClick={()=>runRuntimeActionA('memory.search', withSemantic({ query:`source:${scrubbed.src} ${scrubbed.title}`, limit:10 }), { successMessage:'Search run' })}><Icon name="file" size={12}/>Search source</button>
                {scrubbed.memoryId && (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => requestWriteActionA(
                      'memory.delete',
                      { id: scrubbed.memoryId },
                      'Remove from memory index',
                      'Deletes this entry from the local memory index.',
                    )}
                  ><Icon name="x" size={12}/>Remove from index</button>
                )}
              </div>
            </div>

            <div style={{flex:1, background:'var(--surface-2)', overflow:'auto', minWidth:0, padding:'24px 28px'}}>
              <div className="t-mono" style={{fontSize:10, color:'var(--text-dim)', marginBottom:10}}>
                PREVIEW · {timelineLoading ? '—' : scrubbed.t} ·{' '}
                {timelineLoading ? '—' : events.length ? `${scrubIdx + 1}/${events.length}` : '—'}
              </div>
              <div style={{fontSize:16, fontWeight:600, marginBottom:12, letterSpacing:'-0.01em'}}>
                {timelineLoading ? (
                  <span className="muted">
                    <span className="en-only">Loading…</span>
                    <span className="jp">読み込み中…</span>
                  </span>
                ) : (
                  scrubbed.title
                )}
              </div>
              <div style={{fontSize:13, lineHeight:1.65, color:'var(--text-mute)', whiteSpace:'pre-wrap'}}>
                {timelineLoading ? '—' : scrubbed.snippet || '—'}
              </div>
            </div>
          </div>

          {/* Scrubber strip */}
          <div className="card memory-scrubber">
            <div className="row" style={{padding:'10px 14px', borderBottom:'1px solid var(--border)', gap:10}}>
              <span className="t-mono" style={{color:'var(--gold)'}}>TIMELINE</span>
              <span className="jp dim" style={{fontSize:10}}>さかのぼる</span>
              <span className="spacer"/>
              <div className="row" style={{gap:4}}>
                <button type="button" className="btn btn-sm btn-ghost" disabled={events.length===0} onClick={()=>setScrubIdx(Math.max(0, scrubIdx-1))} style={{padding:'0 6px'}}><Icon name="arrowLeft" size={12}/></button>
                <button type="button" className="btn btn-sm btn-ghost" disabled={events.length===0} onClick={()=>setScrubIdx(Math.min(Math.max(events.length - 1, 0), scrubIdx+1))} style={{padding:'0 6px'}}><Icon name="arrowRight" size={12}/></button>
              </div>
              <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)'}}>
                {timelineLoading ? (
                  <span className="muted">
                    <span className="en-only">Loading…</span>
                    <span className="jp">読み込み中…</span>
                  </span>
                ) : (
                  <>
                    {events.length} {events.length === 1 ? 'EVENT' : 'EVENTS'} · {timeSpanLabel}
                  </>
                )}
              </span>
            </div>

            <div className="scrub-track">
              {/* hour rule */}
              <div className="scrub-hours">
                {['06','08','10','12','14','16','18','20','22'].map((h,i) => (
                  <span key={h} style={{left:`${(i*2)/16*100}%`}}>{h}</span>
                ))}
              </div>
              {/* density histogram */}
              <div className="scrub-density">
                {bins.map((v,i)=>(
                  <div key={i} style={{height:`${(v/maxBin)*100}%`}}/>
                ))}
              </div>
              {/* hour ticks */}
              <div className="scrub-ticks">
                {Array.from({length:17}).map((_,i)=>(
                  <div key={i} style={{left:`${(i/16)*100}%`, height: i%2===0?12:6}}/>
                ))}
              </div>
              {/* event dots */}
              <div className="scrub-events">
                {events.map((e,i) => {
                  const pct = Math.max(0, Math.min(1, (Number(e.h) - 6) / (22 - 6)));
                  const selected = i===scrubIdx;
                  return (
                    <button
                      key={i}
                      onClick={()=>setScrubIdx(i)}
                      className={`scrub-dot scrub-dot-${e.src} ${selected?'selected':''} ${e.big?'big':''}`}
                      style={{left:`${pct*100}%`}}
                      title={`${e.t} · ${e.title}`}
                    >
                      <Icon name={srcIcon(e.src)} size={selected?11:9}/>
                    </button>
                  );
                })}
              </div>
              {/* playhead */}
              <div className="scrub-playhead" style={{left:`${Math.max(0, Math.min(1, (Number(scrubbed.h) - 6) / (22 - 6))) * 100}%`}}>
                <div className="scrub-playhead-head"><span className="t-mono">{scrubbed.t}</span></div>
              </div>
            </div>
          </div>

          {/* Scoped styles */}
          <style>{`
            .memory-scrub-stage { border-color:var(--border); }

            .memory-scrubber { padding:0; overflow:visible; }
            .scrub-track {
              position:relative; height:96px; padding:0 14px;
              background:var(--surface);
            }
            .scrub-hours {
              position:absolute; top:6px; left:14px; right:14px; height:14px;
            }
            .scrub-hours span {
              position:absolute; transform:translateX(-50%);
              font-family:var(--font-mono); font-size:9px; color:var(--text-dim);
              letter-spacing:0.1em;
            }
            .scrub-density {
              position:absolute; top:22px; left:14px; right:14px; height:26px;
              display:flex; align-items:flex-end; gap:1px;
            }
            .scrub-density div {
              flex:1; background:color-mix(in srgb, var(--gold) 30%, transparent);
              border-radius:1px 1px 0 0; min-height:1px;
            }
            .scrub-ticks {
              position:absolute; top:50px; left:14px; right:14px; height:12px;
            }
            .scrub-ticks div {
              position:absolute; width:1px; background:var(--border-hi); top:0;
            }
            .scrub-events {
              position:absolute; top:60px; left:14px; right:14px; height:28px;
            }
            .scrub-dot {
              position:absolute; top:50%; transform:translate(-50%, -50%);
              width:20px; height:20px; border-radius:50%;
              background:var(--surface-2); border:1px solid var(--border-hi);
              display:flex; align-items:center; justify-content:center;
              color:var(--text-mute); cursor:pointer;
              transition:transform 120ms, border-color 120ms, background 120ms;
            }
            .scrub-dot:hover { border-color:var(--gold-dim); color:var(--text); }
            .scrub-dot.big { width:22px; height:22px; }
            .scrub-dot.selected {
              width:28px; height:28px; background:var(--gold);
              border-color:var(--gold); color:#151212;
              box-shadow:0 0 0 4px color-mix(in srgb, var(--gold) 25%, transparent);
              z-index:3;
            }
            .scrub-dot-agent { color:var(--gold); }
            .scrub-playhead {
              position:absolute; top:20px; bottom:4px; width:2px;
              background:color-mix(in srgb, var(--gold) 70%, var(--text));
              z-index:2; transform:translateX(-1px);
              pointer-events:none;
            }
            .scrub-playhead-head {
              position:absolute; bottom:-18px; left:50%; transform:translateX(-50%);
              padding:2px 6px; background:var(--gold); color:#151212;
              border-radius:3px; font-size:10px;
              box-shadow:0 2px 6px rgba(0,0,0,0.3);
            }
            .scrub-playhead-head span { color:inherit; letter-spacing:0.05em; }
          `}</style>
        </div>
      )}

      {/* Kakejiku (vertical scroll per day) */}
      {view==='stack' && (
        <div style={{flex:1, padding:'0 40px 40px', minHeight:0, overflow:'auto'}}>
          <div style={{maxWidth:820, margin:'0 auto'}}>
            {events.map((e,i) => (
              <div key={i} className="row" style={{gap:24, padding:'18px 0', borderBottom:'1px solid var(--border)'}}>
                <div style={{width:60, textAlign:'right'}}>
                  <div className="t-mono" style={{fontSize:12, color:'var(--text)'}}>{e.t}</div>
                  {i%3===0 && <div className="jp" style={{fontSize:11, color:'var(--text-dim)', marginTop:2}}>{i<4?'朝':i<7?'昼':'夕'}</div>}
                </div>
                <div style={{width:1, background:'var(--border)', alignSelf:'stretch', position:'relative'}}>
                  <div style={{position:'absolute', left:-4, top:4, width:9, height:9, borderRadius:'50%', background: e.tag==='auto'?'var(--gold)':'var(--text)'}}/>
                </div>
                <div style={{flex:1}}>
                  <div className="row" style={{gap:8, marginBottom:4}}>
                    <Icon name={e.src==='chat'?'chat':e.src==='meet'?'calendar':e.src==='note'?'note':e.src==='mail'?'mail':e.src==='agent'?'bot':'file'} size={14} className="dim"/>
                    <span className="t-mono" style={{fontSize:10}}>{e.src}</span>
                    {e.dur && <span className="label" style={{height:18, fontSize:10}}>{e.dur}</span>}
                  </div>
                  <div style={{fontSize:15, fontWeight: e.big?500:400}}>{e.title}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}

window.ScreenHome = ScreenHome;
window.ScreenMemory = ScreenMemory;

/* global Icon, Kamon, IntegrationLogo, React, ShogunIntegrationConnectors */

function runRuntimeAction(key, payload, options) {
  if (!window.SHOGUN_RUNTIME || !window.SHOGUN_RUNTIME.executeAction) return Promise.resolve({ ok:false });
  return window.SHOGUN_RUNTIME.executeAction(key, payload || {}, options || {});
}

// ═══════════════════════════════════════════════════════════════════════════
// L5 · WORK — documents, tasks generated from memory
// ═══════════════════════════════════════════════════════════════════════════
function workProvenanceLabel(prov) {
  const p = prov || 'user';
  if (p === 'screen') return '画面';
  if (p === 'connector') return '連携';
  if (p === 'meeting') return '会議';
  return '手動';
}

function srcIconFromSource(source) {
  const s = source ? String(source).toLowerCase() : '';
  if (s === 'chat') return 'chat';
  if (s.includes('mail')) return 'mail';
  if (s === 'google_calendar' || s === 'meetings') return 'calendar';
  if (s === 'work') return 'file';
  return 'note';
}

function WorkDocDetail({ doc, siblings, onBack, onSelect, allowServerMemoryAssembly }) {
  const [tab, setTab] = React.useState('preview');

  const editedAt = React.useMemo(() => {
    const ms = doc.created_at ? Number(doc.created_at) : null;
    if (!Number.isFinite(ms)) return null;
    const d = new Date(ms);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  }, [doc.created_at]);

  const linked = React.useMemo(
    () => (siblings || []).filter((s) => s && s.id !== doc.id && (s.title || s.snippet)).slice(0, 8),
    [siblings, doc.id],
  );
  const summary = (doc.snippet && String(doc.snippet).trim()) || '';
  const sourceLabel = doc.source ? String(doc.source) : 'memory';

  const openInChat = React.useCallback(() => {
    openWorkMemoryEntryInChat(
      { title: doc.title, snippet: doc.snippet },
      { memoryAssemblyQuery: doc.title || '', memoryAssemblyLimit: 14, allowServerMemoryAssembly },
    );
  }, [doc.title, doc.snippet, allowServerMemoryAssembly]);

  const expandAsDraft = React.useCallback(() => {
    const prompt =
      'Expand this memory into a structured Markdown work note with headings (Summary, Key points, Open questions) and bullets.\n\n' +
      '**Title:** ' + (doc.title || '') +
      '\n\n**Snippet:**\n' + String(doc.snippet || '').slice(0, 4000);
    const payload = { target: 'work_document', source: 'work_doc_detail', prompt };
    if (allowServerMemoryAssembly) {
      payload.memoryAssembly = { query: String(doc.title || '').slice(0, 240), limit: 12, semantic: true };
    }
    runRuntimeAction('draft.create', payload, { successMessage: 'Draft ready' });
  }, [doc.title, doc.snippet, allowServerMemoryAssembly]);

  const removeFromIndex = React.useCallback(() => {
    if (!doc.id) return;
    requestWriteAction(
      'memory.delete',
      { id: doc.id },
      'Remove from memory index',
      'Deletes this entry from the local memory index.',
    );
  }, [doc.id]);

  const tabs = [
    { k: 'preview',   l: 'Preview' },
    { k: 'sources',   l: `Sources · ${linked.length}` },
    { k: 'revisions', l: 'Revisions' },
  ];

  return (
    <div style={{display:'grid', gridTemplateColumns:'minmax(0, 1fr) 320px', gap:'var(--space-8)', alignItems:'flex-start'}}>
      {/* Main column */}
      <div style={{minWidth:0}}>
        {/* Back link */}
        <div style={{marginBottom:'var(--space-4)'}}>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onBack} style={{padding:'0 8px'}}>
            <Icon name="chevronLeft" size={13}/> Back to Work
          </button>
        </div>

        {/* Tabs + Edit */}
        <div className="row" style={{alignItems:'center', gap:'var(--space-3)', marginBottom:'var(--space-4)'}}>
          {tabs.map((t) => (
            <button
              key={t.k}
              type="button"
              onClick={() => setTab(t.k)}
              style={{
                all:'unset', cursor:'pointer',
                padding:'8px 14px', borderRadius:'var(--radius-md)',
                fontSize:13,
                background: tab === t.k ? 'var(--surface-2)' : 'transparent',
                color: tab === t.k ? 'var(--text)' : 'var(--text-mute)',
                border: tab === t.k ? '1px solid var(--border-hi)' : '1px solid transparent',
              }}
            >
              {t.l}
            </button>
          ))}
          <span className="spacer"/>
          <button type="button" className="btn btn-sm btn-secondary" onClick={expandAsDraft} title="Expand this memory into a draft via memoryAssembly">
            <Icon name="edit" size={13}/> Expand as draft
          </button>
        </div>

        <div style={{borderTop:'1px solid var(--border)', paddingTop:'var(--space-8)'}}>
          {/* Draft metadata */}
          <div style={{display:'inline-flex', alignItems:'center', gap:8, marginBottom:'var(--space-4)'}}>
            <span style={{width:10, height:10, transform:'rotate(45deg)', background:'var(--gold)', display:'inline-block'}}/>
            <span className="t-mono" style={{color:'var(--gold)'}}>
              MEMORY · {sourceLabel.toUpperCase()}{linked.length > 0 ? ` · ${linked.length} RELATED` : ''}
            </span>
          </div>

          {/* Title + byline */}
          <h1 className="t-h1" style={{margin:0, wordBreak:'break-word'}}>
            {doc.title || 'Untitled memory'}
          </h1>
          <div style={{marginTop:'var(--space-3)', color:'var(--text-dim)', fontSize:13}}>
            {editedAt ? `Captured ${editedAt}` : 'Captured time unknown'}
            {doc.entity_id ? <> · <span className="t-mono" style={{fontSize:11}}>entity {String(doc.entity_id).slice(0, 16)}</span></> : null}
          </div>

          {/* Tab contents */}
          {tab === 'preview' && (
            <div>
              <h2 className="t-h3" style={{marginTop:'var(--space-12)', marginBottom:'var(--space-4)', fontWeight:600}}>Summary</h2>
              {summary ? (
                <p style={{margin:0, fontSize:15, lineHeight:1.7, color:'var(--text)', whiteSpace:'pre-wrap'}}>{summary}</p>
              ) : (
                <p style={{margin:0, fontSize:14, color:'var(--text-mute)', lineHeight:1.6}}>
                  This memory entry has a title only. Use <strong>Expand as draft</strong> to synthesize a summary from context.
                </p>
              )}

              <div className="row" style={{gap:'var(--space-2)', marginTop:'var(--space-8)', flexWrap:'wrap'}}>
                <button type="button" className="btn btn-sm btn-secondary" onClick={openInChat}>
                  <Icon name="chat" size={13}/> Open in Chat
                </button>
                <button type="button" className="btn btn-sm btn-secondary" onClick={expandAsDraft}>
                  <Icon name="edit" size={13}/> Expand as draft
                </button>
                {doc.id && (
                  <button type="button" className="btn btn-sm btn-ghost" onClick={removeFromIndex}>
                    <Icon name="x" size={13}/> Remove from index
                  </button>
                )}
              </div>
            </div>
          )}

          {tab === 'sources' && (
            <div>
              <h2 className="t-h3" style={{marginTop:'var(--space-12)', marginBottom:'var(--space-4)', fontWeight:600}}>Linked memories</h2>
              {linked.length === 0 ? (
                <p style={{margin:0, fontSize:14, color:'var(--text-mute)', lineHeight:1.6}}>
                  No other indexed memories sit near this one. Capture more or run a broader search from the Memory page.
                </p>
              ) : (
                <div style={{display:'flex', flexDirection:'column', gap:'var(--space-3)'}}>
                  {linked.map((m) => (
                    <button
                      key={m.id || m.title}
                      type="button"
                      onClick={() => onSelect && onSelect(m)}
                      className="card card-interactive"
                      style={{all:'unset', cursor:'pointer', display:'block', padding:'var(--space-4) var(--space-6)', borderRadius:'var(--radius-lg)', border:'1px solid var(--border)', background:'var(--surface)'}}
                    >
                      <div className="row" style={{gap:'var(--space-2)', marginBottom:'var(--space-2)', flexWrap:'wrap'}}>
                        <Icon name={srcIconFromSource(m.source)} size={13} className="dim"/>
                        <span className="t-mono" style={{color:'var(--text-mute)'}}>{String(m.source || 'memory').toUpperCase()}</span>
                        {m.provenance && (
                          <span className="label" style={{borderColor:'var(--gold-dim)', color:'var(--gold)'}}>
                            {workProvenanceLabel(m.provenance)}
                          </span>
                        )}
                      </div>
                      <div style={{fontSize:15, fontWeight:500, marginBottom:'var(--space-2)'}}>{m.title || 'Untitled'}</div>
                      {m.snippet && (
                        <div style={{fontSize:13, color:'var(--text-dim)', lineHeight:1.5, display:'-webkit-box', WebkitBoxOrient:'vertical', WebkitLineClamp:2, overflow:'hidden'}}>{m.snippet}</div>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'revisions' && (
            <div>
              <h2 className="t-h3" style={{marginTop:'var(--space-12)', marginBottom:'var(--space-4)', fontWeight:600}}>Revisions</h2>
              <div className="card" style={{padding:'var(--space-6)', color:'var(--text-mute)', fontSize:14, lineHeight:1.6}}>
                Revision history is not tracked for local memory entries in this build. When this item becomes a draft document, revisions will appear here.
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Right sidebar */}
      <div style={{display:'flex', flexDirection:'column', gap:'var(--space-8)', position:'sticky', top:'var(--space-6)', alignSelf:'flex-start'}}>
        {/* Linked memories */}
        <div>
          <div className="t-mono" style={{marginBottom:'var(--space-3)'}}>
            LINKED MEMORIES · {linked.length}
          </div>
          {linked.length === 0 ? (
            <div className="card" style={{padding:'var(--space-4) var(--space-6)', fontSize:12.5, color:'var(--text-dim)', lineHeight:1.5}}>
              No related memories indexed yet.
            </div>
          ) : (
            <div style={{display:'flex', flexDirection:'column', gap:'var(--space-2)'}}>
              {linked.slice(0, 5).map((m) => {
                const title = m.title || m.snippet || 'Memory';
                const icon = srcIconFromSource(m.source);
                const meta = m.created_at ? new Date(Number(m.created_at)).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
                return (
                  <button
                    key={m.id || title}
                    type="button"
                    onClick={() => onSelect && onSelect(m)}
                    className="card card-interactive"
                    style={{all:'unset', cursor:'pointer', display:'flex', alignItems:'flex-start', gap:'var(--space-2)', padding:'var(--space-3) var(--space-4)', borderRadius:'var(--radius-md)', border:'1px solid var(--border)', background:'var(--surface)'}}
                  >
                    <Icon name={icon} size={14} className="dim"/>
                    <div style={{flex:1, minWidth:0}}>
                      <div style={{fontSize:12.5, color:'var(--text)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{title}</div>
                      <div className="t-mono" style={{marginTop:3, fontSize:10}}>{meta}</div>
                    </div>
                    <Icon name="arrowUpRight" size={12} className="dim"/>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Actions */}
        <div>
          <div className="t-mono" style={{marginBottom:'var(--space-3)'}}>ACTIONS</div>
          <div style={{display:'flex', flexDirection:'column', gap:'var(--space-2)'}}>
            <button type="button" className="btn btn-secondary" onClick={openInChat}>
              <Icon name="chat" size={14}/> Open in Chat
            </button>
            <button type="button" className="btn btn-secondary" onClick={expandAsDraft}>
              <Icon name="edit" size={14}/> Expand as draft
            </button>
            {doc.id && (
              <button type="button" className="btn btn-ghost" onClick={removeFromIndex}>
                <Icon name="x" size={14}/> Remove from index
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Redirect a memory entry into the Chat composer (pre-fills + opens Chat). */
function openWorkMemoryEntryInChat(entry, options) {
  const title = entry && entry.title ? String(entry.title) : '';
  const snippet = entry && entry.snippet ? String(entry.snippet) : '';
  const textParts = [];
  if (title) textParts.push(title);
  if (snippet) textParts.push(snippet.slice(0, 800));
  const text = textParts.join('\n\n') || 'Explore this memory.';
  const allow = options && options.allowServerMemoryAssembly !== false;
  const detail = { text, webSearch: false, assembleMemory: allow };
  if (allow) {
    detail.memoryAssemblyPreset = {
      query: (options && options.memoryAssemblyQuery) || title || '',
      limit: (options && options.memoryAssemblyLimit) || 14,
      semantic: true,
    };
  } else {
    detail.clearMemoryAssemblyPreset = true;
  }
  window.dispatchEvent(new CustomEvent('shogun-chat-composer-seed', { detail }));
  window.SHOGUN_RUNTIME?.setActiveScreen?.('chat');
}

function ScreenWork() {
  const [hits, setHits] = React.useState([]);
  const [selectedDoc, setSelectedDoc] = React.useState(null);
  const [draftWithMemory, setDraftWithMemory] = React.useState(true);
  /** Mirrors `sections.privacy.allowChatServerMemoryAssembly` (default true). */
  const [allowServerMemoryAssembly, setAllowServerMemoryAssembly] = React.useState(true);
  React.useEffect(() => {
    let cancelled = false;
    void runRuntimeAction('settings.load', {}, { silentError: true }).then((r) => {
      if (cancelled || !r?.ok || !r.data?.settings?.sections?.privacy) return;
      const priv = r.data.settings.sections.privacy;
      if (priv && typeof priv === 'object') {
        setAllowServerMemoryAssembly(priv.allowChatServerMemoryAssembly !== false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  React.useEffect(() => {
    const onPrivacy = () => {
      void runRuntimeAction('settings.load', {}, { silentError: true }).then((r) => {
        const priv = r?.ok && r.data?.settings?.sections?.privacy;
        if (priv && typeof priv === 'object') {
          setAllowServerMemoryAssembly(priv.allowChatServerMemoryAssembly !== false);
        }
      });
    };
    window.addEventListener('shogun-privacy-settings-changed', onPrivacy);
    return () => window.removeEventListener('shogun-privacy-settings-changed', onPrivacy);
  }, []);
  const refresh = React.useCallback(() => {
    runRuntimeAction('memory.search', { query: '', limit: 24 }, { silentError: true }).then((res) => {
      if (!res?.ok || !Array.isArray(res.data?.hits)) return;
      setHits(res.data.hits);
    });
  }, []);
  React.useEffect(() => { refresh(); }, [refresh]);

  const buildDraftPayload = React.useCallback((prompt, memoryQuery) => {
    const payload = {
      target: 'work_document',
      source: 'work_screen',
      prompt,
    };
    if (draftWithMemory && allowServerMemoryAssembly) {
      payload.memoryAssembly = {
        query: String(memoryQuery || '').slice(0, 480),
        limit: 12,
        semantic: true,
      };
    }
    return payload;
  }, [draftWithMemory, allowServerMemoryAssembly]);

  if (selectedDoc) {
    return (
      <div className="content-inner" style={{padding:'var(--space-8) var(--space-12) var(--space-12)', maxWidth:1280, margin:'0 auto'}}>
        <WorkDocDetail
          doc={selectedDoc}
          siblings={hits}
          onBack={() => setSelectedDoc(null)}
          onSelect={(nextDoc) => setSelectedDoc(nextDoc)}
          allowServerMemoryAssembly={allowServerMemoryAssembly}
        />
      </div>
    );
  }

  return (
    <div className="content-inner">
      <div className="page-head">
        <div>
          <div className="t-mono" style={{marginBottom:8}}>OPERATIONS LAYER</div>
          <h1>Work <span className="jp">任務</span></h1>
          <div className="sub">Recent items from your local memory index. Drafts can include <code className="t-mono" style={{fontSize:11}}>memoryAssembly</code> for extra local context.</div>
        </div>
        <div className="row" style={{flexWrap:'wrap', gap:8}}>
          <label className="row" style={{gap:6, alignItems:'center', fontSize:12, color:'var(--text-dim)', cursor:'pointer', userSelect:'none'}}>
            <input
              type="checkbox"
              checked={draftWithMemory}
              onChange={(e) => setDraftWithMemory(e.target.checked)}
            />
            <span>Memory を下書きに取り込む</span>
          </label>
          <button className="btn btn-secondary" type="button" onClick={refresh}><Icon name="filter" size={14}/>Refresh</button>
          <button
            className="btn btn-primary"
            type="button"
            onClick={() =>
              runRuntimeAction(
                'draft.create',
                buildDraftPayload('Create new document shell', ''),
                { successMessage: 'Draft ready' },
              )}
          ><Icon name="plus" size={14}/>New document</button>
        </div>
      </div>

      {hits.length === 0 ? (
        <div className="card" style={{padding:28}}>
          <p style={{fontSize:14, color:'var(--text-mute)', margin:0, lineHeight:1.6}}>
            No indexed memories yet. Ingest content from Memory or Capture in the desktop app, then refresh.
          </p>
        </div>
      ) : (
        <div className="shogun-grid-cards">
          {hits.map((h) => (
            <button
              key={h.id || h.title}
              type="button"
              className="card card-interactive"
              style={{all:'unset', cursor:'pointer', padding:18, borderRadius:14, border:'1px solid var(--border)', background:'var(--surface)', display:'block'}}
              onClick={() => setSelectedDoc(h)}
            >
              <div className="row" style={{gap:10, marginBottom:10, flexWrap:'wrap'}}>
                <Icon name="file" size={14} className="gold"/>
                <span className="t-mono" style={{fontSize:10}}>{String(h.source || 'memory')}</span>
                {h.provenance && (
                  <span className="label" style={{fontSize:10, borderColor:'var(--gold-dim)', color:'var(--gold)'}}>
                    {workProvenanceLabel(h.provenance)}
                  </span>
                )}
              </div>
              <div style={{fontSize:15, fontWeight:500, marginBottom:8}}>{h.title || 'Untitled'}</div>
              <div style={{fontSize:12, color:'var(--text-dim)', lineHeight:1.5, marginBottom:12}}>{h.snippet || '—'}</div>
              <div
                role="button"
                tabIndex={0}
                className="btn btn-sm btn-secondary"
                onClick={(e) => {
                  e.stopPropagation();
                  const prompt =
                    'Expand this memory into a structured Markdown work note (headings + bullets).\n\n**Title:** ' +
                    (h.title || '') +
                    '\n\n**Snippet:**\n' +
                    String(h.snippet || '').slice(0, 4000);
                  runRuntimeAction('draft.create', buildDraftPayload(prompt, h.title || ''), { successMessage: 'Draft ready' });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.stopPropagation();
                    e.preventDefault();
                    const prompt =
                      'Expand this memory into a structured Markdown work note (headings + bullets).\n\n**Title:** ' +
                      (h.title || '') +
                      '\n\n**Snippet:**\n' +
                      String(h.snippet || '').slice(0, 4000);
                    runRuntimeAction('draft.create', buildDraftPayload(prompt, h.title || ''), { successMessage: 'Draft ready' });
                  }
                }}
                style={{display:'inline-flex', alignItems:'center', gap:6}}
              ><Icon name="edit" size={12}/> Draft from memory</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// L6 · CAPTURE — ingest (Accessibility API, not screenshots)
// ═══════════════════════════════════════════════════════════════════════════
function ScreenCapture() {
  const [isPaused, setIsPaused] = React.useState(false);
  const [axRich, setAxRich] = React.useState(false);
  const [sampleIv, setSampleIv] = React.useState(8);
  const [axMinIv, setAxMinIv] = React.useState(0);
  const [captureStats, setCaptureStats] = React.useState({ events:'1,248', memories:'23', appCoverage:[] });
  const refreshCaptureSettings = React.useCallback(() => {
    return runRuntimeAction('settings.load', {}, { silentError:true }).then((res) => {
      const cap = res.ok && res.data?.settings?.sections?.capture;
      if (!cap || typeof cap !== 'object') return res;
      setAxRich(!!cap.axRichCapture);
      const s = Number(cap.sampleIntervalSecs);
      setSampleIv(Number.isFinite(s) ? Math.min(600, Math.max(4, s)) : 8);
      const a = Number(cap.axMinIntervalSecs);
      setAxMinIv(Number.isFinite(a) ? Math.min(600, Math.max(0, a)) : 0);
      return res;
    });
  }, []);
  React.useEffect(() => {
    let mounted = true;
    runRuntimeAction('stats.get', { stage:'capture' }, { silentError:true }).then((res) => {
      if (!mounted || !res.ok || !res.data) return;
      const data = res.data;
      setCaptureStats({
        events: data.eventsToday || '1,248',
        memories: data.memoriesToday || '23',
        appCoverage: data.appCoverage || [],
      });
      const cap = data.settings?.sections?.capture;
      if (cap && typeof cap === 'object') {
        setAxRich(!!cap.axRichCapture);
        const s = Number(cap.sampleIntervalSecs);
        if (Number.isFinite(s)) setSampleIv(Math.min(600, Math.max(4, s)));
        const a = Number(cap.axMinIntervalSecs);
        if (Number.isFinite(a)) setAxMinIv(Math.min(600, Math.max(0, a)));
      }
    });
    refreshCaptureSettings();
    return () => { mounted = false; };
  }, [refreshCaptureSettings]);
  return (
    <div className="content-inner">
      <div className="page-head">
        <div>
          <div className="t-mono" style={{marginBottom:8}}>INGEST LAYER</div>
          <h1>Capture <span className="jp">捕捉</span></h1>
          <div className="sub">macOS: 再開中は設定した間隔でフォーカス情報を Memory に取り込みます（スクリーンショットなし）。既定は最前面アプリ名のみ。アクセシビリティ許可と「AX リッチ取得」でフォーカス要素の短いスナップショットを試みます。AX 最小間隔で取り込みレートを抑えられます。</div>
        </div>
        <div className="row">
          <span className="label" style={{background:'var(--surface-2)', borderColor:'var(--border)', color:'var(--text-mute)'}}><span style={{width:6, height:6, borderRadius:'50%', background:'var(--text-dim)', marginRight:6}}/>PREVIEW · v1</span>
          <button
            type="button"
            className={'btn btn-sm ' + (axRich ? 'btn-secondary' : 'btn-ghost')}
            onClick={async () => {
              const next = !axRich;
              const res = await runRuntimeAction(
                'settings.save',
                { section:'capture', axRichCapture: next },
                { silentError:true, successMessage: next ? 'AX rich capture enabled' : 'Switched to app-name only sampling' },
              );
              if (res.ok) setAxRich(next);
            }}
          ><Icon name="capture" size={14}/>{axRich ? 'AX rich ON' : 'AX rich OFF'}</button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={async () => {
              const next = !isPaused;
              const action = next ? 'capture.pause' : 'capture.resume';
              const res = await runRuntimeAction(action, { source:'capture_screen' }, { silentError:true });
              if (res.ok) setIsPaused(next);
            }}
          ><Icon name="pause" size={14}/>{isPaused ? 'Resume' : 'Pause'}</button>
        </div>
      </div>

      {/* Live stream */}
      <div className="shogun-grid-split-wide">
        <div className="card" style={{padding:0, overflow:'hidden'}}>
          <div style={{padding:'16px 20px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center'}}>
            <div style={{fontSize:13, fontWeight:500}}>Live capture</div>
            <span className="label label-gold" style={{marginLeft:10}}>TAIL -F</span>
            <span className="spacer"/>
            <span className="t-mono" style={{fontSize:10}}>24 EVENTS / MIN</span>
          </div>
          <div style={{padding:'4px 0', fontFamily:'var(--font-mono)', fontSize:12, maxHeight:280, overflowY:'auto'}}>
            {[
              ['14:32:08', 'chrome', 'url: notion.so/100x-user-framework'],
              ['14:31:54', 'claude', 'msg_in · 142 tokens'],
              ['14:31:41', 'claude', 'msg_out · 518 tokens'],
              ['14:30:22', 'slack', 'dm from Matt · 3 lines'],
              ['14:28:10', 'vscode', 'file: shogun/app.tsx · 42 edits'],
              ['14:25:00', 'chrome', 'url: revenuecat.com/pricing'],
              ['14:22:17', 'claude', 'new conversation: rev-cat pricing'],
              ['14:18:00', 'terminal', 'cmd: git commit -m "ia v2"'],
            ].map((l,i)=>(
              <div key={i} className="row" style={{padding:'6px 20px', gap:14, borderBottom:'1px dashed var(--border)'}}>
                <span style={{color:'var(--text-dim)'}}>{l[0]}</span>
                <span className="gold" style={{minWidth:70}}>{l[1]}</span>
                <span style={{color:'var(--text-mute)'}}>{l[2]}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Stats */}
        <div className="stack-4">
          <div className="card" style={{padding:20}}>
            <div className="t-mono" style={{marginBottom:12}}>TODAY · CAPTURED</div>
            <div className="shogun-grid-2">
              <div><div style={{fontSize:32, fontWeight:600}}>{captureStats.events}</div><div style={{fontSize:11, color:'var(--text-dim)'}}>events</div></div>
              <div><div style={{fontSize:32, fontWeight:600}}>{captureStats.memories}</div><div style={{fontSize:11, color:'var(--text-dim)'}}>memories</div></div>
            </div>
            <div style={{height:1, background:'var(--border)', margin:'16px 0'}}/>
            <div style={{fontSize:12, color:'var(--text-mute)', lineHeight:1.6}}>
              Captured via Accessibility API · <span className="gold">0 screenshots taken</span> · <span className="gold">0 OCR runs</span>
            </div>
          </div>

          <div className="card" style={{padding:20}}>
            <div className="t-mono" style={{marginBottom:12}}>APP COVERAGE</div>
            {(captureStats.appCoverage.length ? captureStats.appCoverage : [
              ['Claude', 542, 94],
              ['Chrome', 318, 72],
              ['Slack', 142, 68],
              ['VSCode', 98, 40],
              ['Gmail', 76, 52],
            ]).map(([n,c,w],i)=>(
              <div key={i} style={{marginBottom:10}}>
                <div className="row" style={{marginBottom:4}}>
                  <span style={{fontSize:12}}>{n}</span>
                  <span className="spacer"/>
                  <span className="t-mono" style={{fontSize:10}}>{c}</span>
                </div>
                <div style={{height:3, background:'var(--surface-2)', borderRadius:2, overflow:'hidden'}}>
                  <div style={{height:'100%', width:w+'%', background:'var(--gold)'}}/>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card" style={{padding:20, marginBottom:20, borderColor:'var(--border-hi)'}}>
        <div className="t-mono" style={{marginBottom:10}}>SAMPLER · INTERVALS</div>
        <div style={{fontSize:12, color:'var(--text-mute)', marginBottom:14, lineHeight:1.5}}>
          サンプル間隔（秒・4–600）はバックグラウンドのウェイク間隔です。AX 最小間隔（0–600、0 で無効）は、内容が変わった AX 取り込みの最短間隔です（同一内容はハッシュで抑止）。
        </div>
        <div className="row" style={{flexWrap:'wrap', gap:14, alignItems:'center'}}>
          <label style={{fontSize:12, display:'flex', alignItems:'center', gap:8}}>
            Sample every
            <input className="s-input" type="number" min={4} max={600} style={{width:72}} value={sampleIv} onChange={(e)=>setSampleIv(Number(e.target.value))}/>
 sec
          </label>
          <label style={{fontSize:12, display:'flex', alignItems:'center', gap:8}}>
            AX min gap
            <input className="s-input" type="number" min={0} max={600} style={{width:72}} value={axMinIv} onChange={(e)=>setAxMinIv(Number(e.target.value))}/>
            sec
          </label>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={async () => {
              const s = Math.min(600, Math.max(4, Math.round(sampleIv) || 8));
              const a = Math.min(600, Math.max(0, Math.round(axMinIv) || 0));
              const res = await runRuntimeAction(
                'settings.save',
                { section:'capture', sampleIntervalSecs: s, axMinIntervalSecs: a },
                { silentError:true, successMessage:'Capture sampler settings saved' },
              );
              if (res.ok) {
                setSampleIv(s);
                setAxMinIv(a);
              }
            }}
          >Apply</button>
        </div>
      </div>

      {/* Permissions card */}
      <div className="card" style={{padding:20, background:'var(--surface-2)', borderColor:'var(--border-hi)'}}>
        <div className="row" style={{marginBottom:12, flexWrap:'wrap', gap:8}}>
          <Icon name="shield" size={16} className="gold"/>
          <div style={{fontSize:14, fontWeight:500}}>What SHOGUN can see</div>
          <span className="spacer"/>
          <button type="button" className="btn btn-sm btn-ghost" onClick={()=>runRuntimeAction('permissions.manage', { target:'accessibility', source:'capture.permissions' }, { successMessage:'Opened Accessibility privacy settings' })}>Accessibility <Icon name="arrowUpRight" size={12}/></button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={()=>runRuntimeAction('permissions.manage', { target:'screen_capture', source:'capture.permissions' }, { successMessage:'Opened Screen Recording privacy settings' })}>Screen Recording <Icon name="arrowUpRight" size={12}/></button>
        </div>
        <div className="shogun-grid-4">
          {[
            ['Accessibility','Granted','on'],
            ['Calendar','Granted','on'],
            ['Contacts','Not granted','off'],
            ['Screen recording','Not requested','off'],
          ].map(([n,s,o],i)=>(
            <div key={i} style={{padding:12, border:'1px solid var(--border)', borderRadius:'var(--radius-md)', background:'var(--bg)'}}>
              <div className="row" style={{marginBottom:6}}>
                <span style={{fontSize:12}}>{n}</span>
                <span className="spacer"/>
                <div className={'switch '+(o==='on'?'on':'')} style={{transform:'scale(0.8)', transformOrigin:'right'}}/>
              </div>
              <div className="t-mono" style={{fontSize:9, color: o==='on'?'var(--success)':'var(--text-dim)'}}>{s.toUpperCase()}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// L7 · INTEGRATIONS — MCP tools, apps
// ═══════════════════════════════════════════════════════════════════════════
function ScreenIntegrations() {
  const [calCred, setCalCred] = React.useState(false);
  const [calRefresh, setCalRefresh] = React.useState(false);
  const [tools, setTools] = React.useState(() => {
    const C = typeof window !== 'undefined' ? window.ShogunIntegrationConnectors : null;
    const base = C && C.hydrateTools ? C.hydrateTools(C.DEFAULT_GRID_TOOLS) : [
      { slug: 'gmail', name: 'Gmail', cat: 'Mail', jp: 'メール', connected: false, ops: ['read', 'draft', 'send'] },
      { slug: 'google_calendar', name: 'Google Calendar', cat: 'Calendar', jp: '予定', connected: false, ops: ['read', 'create'] },
      { slug: 'slack', name: 'Slack', cat: 'Chat', jp: '会話', connected: false, ops: ['read', 'post'] },
      { slug: 'notion', name: 'Notion', cat: 'Docs', jp: '文書', connected: false, ops: ['read', 'write'] },
      { slug: 'linear', name: 'Linear', cat: 'Tasks', jp: '課題', connected: false, ops: ['read', 'create'] },
      { slug: 'github', name: 'GitHub', cat: 'Code', jp: 'コード', connected: false, ops: ['read', 'comment'] },
      { slug: 'arc_browser', name: 'Arc Browser', cat: 'Web', jp: '閲覧', connected: false, ops: ['capture'] },
      { slug: 'claude', name: 'Claude', cat: 'LLM', jp: '対話', connected: false, ops: ['chat'] },
      { slug: 'figma', name: 'Figma', cat: 'Design', jp: '意匠', connected: false, ops: ['read'] },
      { slug: 'raycast', name: 'Raycast', cat: 'Launcher', jp: '起動', connected: false, ops: ['trigger'] },
      { slug: 'obsidian', name: 'Obsidian', cat: 'Notes', jp: '手記', connected: false, ops: ['read', 'write'] },
      { slug: 'zapier_mcp', name: 'Zapier MCP', cat: 'Bridge', jp: '橋梁', connected: false, ops: ['any'] },
    ];
    return base;
  });
  const refreshCalStatus = React.useCallback(() => {
    return runRuntimeAction('integrations.credentials_status', { provider:'google_calendar' }, { silentError:true }).then((res) => {
      if (res.ok && res.data) {
        setCalCred(!!res.data.configured);
        setCalRefresh(!!res.data.tokenRefreshReady);
      }
      return res;
    });
  }, []);
  React.useEffect(() => { refreshCalStatus(); }, [refreshCalStatus]);
  React.useEffect(() => {
    const onCred = () => {
      void refreshCalStatus();
      const C = window.ShogunIntegrationConnectors;
      if (C && typeof C.hydrateTools === 'function') {
        setTools(C.hydrateTools(C.DEFAULT_GRID_TOOLS));
      }
    };
    window.addEventListener('shogun-credentials-updated', onCred);
    return () => window.removeEventListener('shogun-credentials-updated', onCred);
  }, [refreshCalStatus]);
  const nConnected = tools.filter((t) => t.connected).length;

  return (
    <div className="content-inner">
      <div className="page-head">
        <div>
          <div className="t-mono" style={{marginBottom:8}}>CONNECTION LAYER</div>
          <h1>Integrations <span className="jp">接続</span></h1>
          <div className="sub">Browser mock: Connect / toggles persist per connector in localStorage. OAuth is not implemented in-app. Google Calendar: have an external agent import tokens into Keychain, then use the card below to sync events into Memory.</div>
        </div>
        <div className="row">
          <div style={{fontSize:13, color:'var(--text-mute)'}}><span className="gold" style={{fontSize:20, fontWeight:600}}>{nConnected}</span> / {tools.length} connected</div>
          <button className="btn btn-primary" onClick={()=>runRuntimeAction('integrations.connect', { provider:'new_tool' }, { silentError:true })}><Icon name="plus" size={14}/>Add tool</button>
        </div>
      </div>

      <div className="shogun-grid-3">
        {tools.map((t,i)=>(
          <div key={i} className="card card-hover" style={{padding:20, opacity: t.connected?1:0.6}}>
            <div className="row" style={{marginBottom:14, gap:12}}>
              <IntegrationLogo slug={t.slug} size={40} title={t.name} className={t.connected ? 's-intg-logo-on' : 's-intg-logo-off'} />
              <div style={{flex:1}}>
                <div style={{fontSize:14, fontWeight:500}}>{t.name}</div>
                <div className="row" style={{gap:6, marginTop:2}}>
                  <span className="t-mono" style={{fontSize:10}}>{t.cat}</span>
                  <span className="jp dim" style={{fontSize:10}}>{t.jp}</span>
                </div>
              </div>
              <div
                className={'switch '+(t.connected?'on':'')}
                style={{transform:'scale(0.85)', cursor:'pointer'}}
                onClick={async (e) => {
                  e.stopPropagation();
                  const next = !t.connected;
                  const res = await runRuntimeAction('integrations.toggle', { provider: t.slug || t.name, connected: next }, { silentError: true });
                  if (res.ok && res.data && !res.data.notImplemented) {
                    setTools((prev) => prev.map((item) => (item.slug === t.slug ? { ...item, connected: next } : item)));
                  }
                }}
              />
            </div>
            <div className="row" style={{gap:4, flexWrap:'wrap'}}>
              {t.ops.map(o => <span key={o} className="label" style={{fontSize:10, height:20}}>{o}</span>)}
            </div>
          </div>
        ))}
      </div>

      <div className="card" style={{padding:20, marginTop:20, borderColor:'var(--border-hi)'}}>
        <div className="t-mono" style={{marginBottom:8}}>EXTERNAL AGENT · GOOGLE CALENDAR</div>
        <div style={{fontSize:13, color:'var(--text-mute)', lineHeight:1.6, marginBottom:14}}>
          Credentials: Tauri invoke <code style={{fontSize:12}}>app_integration_import_credentials</code> with <code style={{fontSize:12}}>provider: &quot;google_calendar&quot;</code>, <code style={{fontSize:12}}>accessToken</code>, optional <code style={{fontSize:12}}>refreshToken</code>, <code style={{fontSize:12}}>expiresAt</code>, <code style={{fontSize:12}}>oauthClientId</code> (and <code style={{fontSize:12}}>oauthClientSecret</code> if required), <code style={{fontSize:12}}>scopes</code>. OAuth flow is out of scope for this app.
        </div>
        <div className="row" style={{gap:10, flexWrap:'wrap', alignItems:'center'}}>
          <span className={'label ' + (calCred ? 'label-success' : '')}>{calCred ? 'Token imported' : 'No token'}</span>
          {calCred ? (
            <span className={'label ' + (calRefresh ? 'label-success' : '')} style={{fontSize:11}}>
              {calRefresh ? 'Auto-refresh ready' : 'Add oauthClientId + refresh for auto-refresh'}
            </span>
          ) : null}
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => { refreshCalStatus(); }}>Refresh status</button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => runRuntimeAction('calendar.sync', { calendarId:'primary', maxResults:25 }, { successMessage:'Calendar synced to Memory' })}>Sync to Memory</button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// L8 · SETTINGS — system layer, BYOK, privacy
// ═══════════════════════════════════════════════════════════════════════════
function ScreenSettings() {
  const [storage, setStorage] = React.useState({ memories:'12,408', disk:'3.4 GB', days:'68 days', usagePercent:22 });
  React.useEffect(() => {
    let mounted = true;
    runRuntimeAction('stats.get', { section:'storage' }, { silentError:true }).then((res) => {
      if (!mounted || !res.ok || !res.data) return;
      const data = res.data;
      setStorage({
        memories: data.memories || '12,408',
        disk: data.disk || '3.4 GB',
        days: data.historyDays || '68 days',
        usagePercent: Number.isFinite(data.usagePercent) ? data.usagePercent : 22,
      });
    });
    return () => { mounted = false; };
  }, []);
  return (
    <div className="content-inner">
      <div className="page-head">
        <div>
          <div className="t-mono" style={{marginBottom:8}}>SYSTEM LAYER</div>
          <h1>Settings <span className="jp">設定</span></h1>
          <div className="sub">Your keys. Your machine. Your data.</div>
        </div>
      </div>

      <div className="shogun-settings-2col">
        <div className="stack-2">
          {['Profile','BYOK · Keys','Storage','Privacy','Dream cycle','Billing','Danger zone'].map((s,i)=>(
            <div key={i} className="nav-item" style={{background: i===1?'var(--surface-2)':'transparent', borderColor: i===1?'var(--border)':'transparent', color: i===1?'var(--text)':'var(--text-mute)'}}>
              <span>{s}</span>
            </div>
          ))}
        </div>

        <div className="stack-6 shogun-settings-body">
          {/* BYOK */}
          <div className="card" style={{padding:24}}>
            <div className="row" style={{marginBottom:6}}>
              <Icon name="key" size={16} className="gold"/>
              <div style={{fontSize:16, fontWeight:500}}>Bring your own key</div>
            </div>
            <div style={{fontSize:13, color:'var(--text-mute)', lineHeight:1.6, marginBottom:20}}>
              SHOGUN does not proxy your LLM calls. Your keys, your billing, your rate limits. We never see prompts or responses.
            </div>
            <div className="stack-4">
              {[
                ['Anthropic', 'sk-ant-•••••••••••••••••••••••w72A', true],
                ['OpenAI', 'sk-proj-•••••••••••••••••••••jR8k', true],
                ['Google AI', 'not configured', false],
              ].map(([p,k,ok],i)=>(
                <div key={i} className="row" style={{padding:'12px 16px', background:'var(--surface-2)', border:'1px solid var(--border)', borderRadius:'var(--radius-md)', gap:12}}>
                  <div style={{width:28, height:28, background:'var(--bg)', border:'1px solid var(--border)', borderRadius:'var(--radius-sm)', display:'flex', alignItems:'center', justifyContent:'center'}}>
                    <Icon name="key" size={12} className={ok?'gold':'dim'}/>
                  </div>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13, fontWeight:500}}>{p}</div>
                    <div style={{fontSize:11, color: ok?'var(--text-dim)':'var(--text-dim)', fontFamily:ok?'var(--font-mono)':'inherit', marginTop:2}}>{k}</div>
                  </div>
                  {ok ? <span className="label label-success">ACTIVE</span> : <button className="btn btn-sm btn-secondary" onClick={()=>runRuntimeAction('settings.save', { section:'keys', provider:p }, { successMessage:'Key setup flow opened' })}>Add</button>}
                </div>
              ))}
            </div>
          </div>

          {/* Privacy */}
          <div className="card" style={{padding:24}}>
            <div className="row" style={{marginBottom:20}}>
              <Icon name="shield" size={16} className="gold"/>
              <div style={{fontSize:16, fontWeight:500}}>Privacy posture</div>
              <span className="spacer"/>
              <span className="label label-success">AUDITED</span>
            </div>
            {[
              ['Local storage', 'Memory index: SQLite + FTS5 on this Mac (memory.db)', true],
              ['No SHOGUN Memory sync', 'Memory index stays on this Mac; not uploaded to SHOGUN cloud in this build', true],
              ['No screenshots', 'SHOGUN reads via Accessibility API only', true],
              ['No telemetry', 'Anonymous usage metrics: opt-in', false],
            ].map(([l,d,on],i)=>(
              <div key={i} className="row" style={{padding:'14px 0', borderBottom:i<3?'1px solid var(--border)':'none', gap:14}}>
                <div style={{flex:1}}>
                  <div style={{fontSize:13, fontWeight:500}}>{l}</div>
                  <div style={{fontSize:12, color:'var(--text-dim)', marginTop:2}}>{d}</div>
                </div>
                <div className={'switch '+(on?'on':'')}/>
              </div>
            ))}
          </div>

          {/* Storage */}
          <div className="card" style={{padding:24}}>
            <div className="row" style={{marginBottom:16}}>
              <Icon name="database" size={16} className="gold"/>
              <div style={{fontSize:16, fontWeight:500}}>Storage</div>
              <span className="spacer"/>
              <span className="t-mono">~/Library/SHOGUN</span>
            </div>
            <div className="shogun-grid-3" style={{marginBottom:16}}>
              <div><div style={{fontSize:24, fontWeight:600}}>{storage.memories}</div><div style={{fontSize:11, color:'var(--text-dim)'}}>memories</div></div>
              <div><div style={{fontSize:24, fontWeight:600}}>{storage.disk}</div><div style={{fontSize:11, color:'var(--text-dim)'}}>on disk</div></div>
              <div><div style={{fontSize:24, fontWeight:600}}>{storage.days}</div><div style={{fontSize:11, color:'var(--text-dim)'}}>history</div></div>
            </div>
            <div style={{height:6, background:'var(--surface-2)', borderRadius:3, overflow:'hidden', marginBottom:8}}>
              <div style={{width:storage.usagePercent+'%', height:'100%', background:'var(--gold)'}}/>
            </div>
            <div style={{fontSize:11, color:'var(--text-dim)'}}>{storage.disk} of 15 GB allocated</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// L · TASKS — what Shogun surfaced for you to do
// ═══════════════════════════════════════════════════════════════════════════

const TASKS_DEMO = [
  {
    id: 't-draft-pricing',
    title: 'Draft pricing page',
    from: 'Rev-cat CTO chat · today',
    status: 'due tomorrow',
    level: 'due',
    done: true,
    why: 'Matt pushed for a 3-tier model in the Rev-cat chat. Deadline was set to tomorrow.',
    priority: 'High',
    source: 'Rev-cat CTO chat',
    people: ['Matt', 'Toru'],
    linkedDoc: 'Pricing page draft',
    breakdown: [
      { id: 'b1', label: 'Review Rev-cat tier proposal', done: true },
      { id: 'b2', label: 'Match tone to Matt’s quote', done: true },
      { id: 'b3', label: 'Draft hero section', done: false },
      { id: 'b4', label: 'Send to Matt for review', done: false },
    ],
    activity: [
      { who: 'you', what: 'checked "Match tone to Matt’s quote"', at: '14:22' },
      { who: 'shogun', what: 'surfaced this task from Rev-cat chat', at: '14:08' },
      { who: 'shogun', what: 'linked to Pricing page draft', at: '14:08' },
    ],
  },
  {
    id: 't-follow-matt',
    title: 'Follow up with Matt on Q2 roadmap',
    from: 'All PJ meeting',
    status: 'today 17:00',
    level: 'today',
    done: true,
    why: 'Matt owed a written recap after the Q2 roadmap review.',
    priority: 'Med',
    source: 'All PJ meeting',
    people: ['Matt'],
    linkedDoc: null,
    breakdown: [
      { id: 'b1', label: 'Draft recap note', done: true },
      { id: 'b2', label: 'Ping Matt on Slack', done: false },
    ],
    activity: [
      { who: 'shogun', what: 'surfaced this task from All PJ meeting', at: '13:20' },
    ],
  },
  {
    id: 't-reply-elevenlabs',
    title: 'Reply to Elevenlabs intro',
    from: 'Gmail thread',
    status: 'no deadline',
    level: 'none',
    done: false,
    why: 'Warm intro from Kevin. Stale 2 days.',
    priority: 'Med',
    source: 'Gmail thread',
    people: ['Kevin', 'Elevenlabs'],
    linkedDoc: 'Pricing page draft',
    breakdown: [
      { id: 'b1', label: 'Review Rev-cat tier proposal', done: true },
      { id: 'b2', label: 'Match tone to Matt’s quote', done: true },
      { id: 'b3', label: 'Draft hero section', done: false },
      { id: 'b4', label: 'Send to Matt for review', done: false },
    ],
    activity: [
      { who: 'you', what: 'checked "Match tone to Matt’s quote"', at: '14:22' },
      { who: 'shogun', what: 'surfaced this task from Rev-cat chat', at: '14:08' },
      { who: 'shogun', what: 'linked to Pricing page draft', at: '14:08' },
    ],
  },
  {
    id: 't-byok-decision',
    title: 'Decide on BYOK vs hosted default',
    from: 'Open since Apr 10',
    status: 'flagged 3x',
    level: 'flag',
    done: false,
    why: 'Kept returning as a blocker across 3 different chats this week. Needs a call.',
    priority: 'High',
    source: 'Multiple chats',
    people: ['Toru'],
    linkedDoc: null,
    breakdown: [
      { id: 'b1', label: 'Summarize Matt’s concerns', done: false },
      { id: 'b2', label: 'List tradeoffs', done: false },
      { id: 'b3', label: 'Book 15m to decide', done: false },
    ],
    activity: [
      { who: 'shogun', what: 'flagged this task for the 3rd time', at: 'Apr 18' },
      { who: 'shogun', what: 'surfaced this task from onboarding chat', at: 'Apr 10' },
    ],
  },
];

function TaskStatusPill({ level, children }) {
  const palette = {
    due:   { color: 'var(--gold)',      border: 'color-mix(in srgb, var(--gold) 45%, var(--border))' },
    today: { color: 'var(--gold)',      border: 'color-mix(in srgb, var(--gold) 45%, var(--border))' },
    flag:  { color: 'var(--text-mute)', border: 'var(--border)' },
    none:  { color: 'var(--text-dim)',  border: 'var(--border)' },
  }[level] || { color: 'var(--text-dim)', border: 'var(--border)' };
  return (
    <span className="label" style={{borderColor: palette.border, color: palette.color}}>
      {children}
    </span>
  );
}

function TasksContextMenu({ x, y, onClose, onAction }) {
  const items = [
    { id: 'open',      icon: 'file',     label: 'Open task details' },
    { id: 'resched',   icon: 'clock',    label: 'Reschedule…' },
    { id: 'delegate',  icon: 'bot',      label: 'Delegate to agent' },
    { id: 'linkmem',   icon: 'link',     label: 'Link memory…' },
    { id: 'delete',    icon: 'x',        label: 'Delete task' },
  ];
  return ReactDOM.createPortal(
    <>
      <div role="presentation" style={{position:'fixed', inset:0, zIndex:1200}} onMouseDown={onClose}/>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          position:'fixed', left:x, top:y, zIndex:1201,
          minWidth:240, padding:6,
          borderRadius:'var(--radius-lg)',
          border:'1px solid var(--border-hi)',
          background:'var(--surface-2)',
          boxShadow:'0 26px 54px -16px rgba(0,0,0,0.65), 0 4px 12px rgba(0,0,0,0.36)',
        }}
      >
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            onClick={() => { onAction(it.id); onClose(); }}
            style={{
              all:'unset', cursor:'pointer',
              display:'flex', alignItems:'center', gap:12,
              width:'100%', boxSizing:'border-box',
              padding:'10px 12px', borderRadius:'var(--radius-md)',
              fontSize:13, color: it.id === 'delete' ? 'var(--text-mute)' : 'var(--text)',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--surface) 70%, var(--bg))'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <Icon name={it.icon} size={14} className="dim"/>
            <span style={{flex:1}}>{it.label}</span>
          </button>
        ))}
      </div>
    </>,
    document.body,
  );
}

function TaskDetailDrawer({ task, onClose, onToggleBreakdown, onMarkComplete }) {
  if (!task) return null;
  return ReactDOM.createPortal(
    <>
      <div role="presentation" style={{position:'fixed', inset:0, zIndex:1210, background:'rgba(0,0,0,0.32)'}} onMouseDown={onClose}/>
      <aside
        role="dialog"
        aria-label={`Task · ${task.title}`}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          position:'fixed', top:0, right:0, bottom:0,
          width:'min(460px, 92vw)', zIndex:1211,
          background:'var(--surface)', borderLeft:'1px solid var(--border-hi)',
          boxShadow:'-26px 0 54px -16px rgba(0,0,0,0.65)',
          display:'flex', flexDirection:'column',
        }}
      >
        {/* Drawer head */}
        <div style={{display:'flex', alignItems:'center', gap:'var(--space-3)', padding:'var(--space-4) var(--space-6)', borderBottom:'1px solid var(--border)'}}>
          <span className="t-mono">TASK · 任務</span>
          <span className="spacer"/>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-label="Open in larger view"
            title="Open in larger view"
            onClick={() => window.SHOGUN_RUNTIME?.pushToast?.('Opening full task view (preview)', 'info')}
            style={{padding:'0 8px'}}
          >
            <Icon name="popout" size={14}/>
          </button>
          <button type="button" className="btn btn-sm btn-ghost" aria-label="Close" onClick={onClose} style={{padding:'0 8px'}}>
            <Icon name="x" size={14}/>
          </button>
        </div>

        <div style={{flex:1, overflowY:'auto', padding:'var(--space-6)'}}>
          {/* Title row */}
          <div className="row" style={{alignItems:'flex-start', gap:'var(--space-3)', marginBottom:'var(--space-4)'}}>
            <button
              type="button"
              onClick={onMarkComplete}
              aria-pressed={task.done}
              aria-label={task.done ? 'Mark as not done' : 'Mark as done'}
              style={{
                all:'unset', cursor:'pointer',
                width:22, height:22, borderRadius:6,
                border: task.done ? '1.5px solid var(--gold)' : '1.5px solid var(--border-hi)',
                background: task.done ? 'color-mix(in srgb, var(--gold) 14%, transparent)' : 'transparent',
                display:'inline-flex', alignItems:'center', justifyContent:'center', flexShrink:0,
              }}
            >
              {task.done && <Icon name="check" size={13} className="gold"/>}
            </button>
            <h2 className="t-h3" style={{margin:0, lineHeight:1.3, wordBreak:'break-word', textDecoration: task.done ? 'line-through' : 'none', color: task.done ? 'var(--text-dim)' : 'var(--text)'}}>
              {task.title}
            </h2>
          </div>

          {/* Why */}
          <div className="t-mono" style={{marginTop:'var(--space-6)', marginBottom:'var(--space-2)'}}>WHY · SHOGUN SAYS</div>
          <div className="card" style={{padding:'var(--space-3) var(--space-4)', fontSize:13, lineHeight:1.6, color:'var(--text-mute)'}}>
            {task.why}
          </div>

          {/* Metadata grid */}
          <div style={{display:'grid', gridTemplateColumns:'repeat(2, minmax(0, 1fr))', gap:'var(--space-3)', marginTop:'var(--space-4)'}}>
            {[
              { label: 'DUE',      icon: 'clock',    value: task.status },
              { label: 'PRIORITY', icon: 'zap',      value: task.priority },
              { label: 'SOURCE',   icon: 'link',     value: task.source },
              { label: 'PEOPLE',   icon: 'agents',   value: task.people.join(', ') },
            ].map((m) => (
              <div key={m.label} className="card" style={{padding:'var(--space-3) var(--space-4)'}}>
                <div className="row" style={{gap:6, alignItems:'center', marginBottom:6}}>
                  <Icon name={m.icon} size={12} className="dim"/>
                  <span className="t-mono">{m.label}</span>
                </div>
                <div style={{fontSize:13, color:'var(--text)', wordBreak:'break-word'}}>{m.value}</div>
              </div>
            ))}
          </div>

          {/* Linked doc */}
          <div className="t-mono" style={{marginTop:'var(--space-6)', marginBottom:'var(--space-2)'}}>LINKED DOC</div>
          {task.linkedDoc ? (
            <button
              type="button"
              onClick={() => window.SHOGUN_RUNTIME?.setActiveScreen?.('work')}
              className="card card-interactive"
              style={{all:'unset', cursor:'pointer', display:'flex', alignItems:'center', gap:'var(--space-2)', padding:'var(--space-3) var(--space-4)', borderRadius:'var(--radius-md)', border:'1px solid var(--border)', background:'var(--surface)', width:'100%', boxSizing:'border-box'}}
            >
              <Icon name="file" size={14} className="gold"/>
              <span style={{flex:1, fontSize:13, color:'var(--text)'}}>{task.linkedDoc}</span>
              <Icon name="arrowUpRight" size={12} className="dim"/>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => window.SHOGUN_RUNTIME?.pushToast?.('Linking docs from tasks is preview-only', 'info')}
              style={{
                all:'unset', cursor:'pointer',
                display:'flex', alignItems:'center', justifyContent:'center', gap:'var(--space-2)',
                padding:'var(--space-3) var(--space-4)', borderRadius:'var(--radius-md)',
                border:'1px dashed var(--border)', background:'transparent',
                color:'var(--text-dim)', fontSize:13, width:'100%', boxSizing:'border-box',
              }}
            >
              <Icon name="plus" size={13}/> Link to a document
            </button>
          )}

          {/* Breakdown */}
          <div className="t-mono" style={{marginTop:'var(--space-6)', marginBottom:'var(--space-2)'}}>BREAKDOWN</div>
          <div style={{display:'flex', flexDirection:'column', gap:0}}>
            {task.breakdown.map((b, i) => (
              <div key={b.id} style={{display:'flex', alignItems:'center', gap:'var(--space-3)', padding:'var(--space-3) 0', borderBottom: i < task.breakdown.length - 1 ? '1px dashed var(--border)' : 'none'}}>
                <button
                  type="button"
                  onClick={() => onToggleBreakdown(b.id)}
                  aria-pressed={b.done}
                  style={{
                    all:'unset', cursor:'pointer',
                    width:18, height:18, borderRadius:5,
                    border: b.done ? '1.5px solid var(--gold)' : '1.5px solid var(--border-hi)',
                    background: b.done ? 'color-mix(in srgb, var(--gold) 14%, transparent)' : 'transparent',
                    display:'inline-flex', alignItems:'center', justifyContent:'center', flexShrink:0,
                  }}
                >
                  {b.done && <Icon name="check" size={11} className="gold"/>}
                </button>
                <span style={{flex:1, fontSize:13, color: b.done ? 'var(--text-dim)' : 'var(--text)', textDecoration: b.done ? 'line-through' : 'none'}}>{b.label}</span>
              </div>
            ))}
            <button
              type="button"
              onClick={() => window.SHOGUN_RUNTIME?.pushToast?.('Adding sub-tasks is preview-only', 'info')}
              style={{
                all:'unset', cursor:'pointer',
                display:'inline-flex', alignItems:'center', gap:'var(--space-2)',
                padding:'var(--space-3) 0',
                color:'var(--text-mute)', fontSize:13,
              }}
            >
              <Icon name="plus" size={13}/> Add sub-task
            </button>
          </div>

          {/* Activity */}
          <div className="t-mono" style={{marginTop:'var(--space-6)', marginBottom:'var(--space-2)'}}>ACTIVITY</div>
          <div style={{display:'flex', flexDirection:'column', gap:'var(--space-2)'}}>
            {task.activity.map((a, i) => (
              <div key={i} style={{fontSize:12.5, color:'var(--text-mute)', lineHeight:1.5}}>
                <span style={{color: a.who === 'shogun' ? 'var(--gold)' : 'var(--text)'}}>{a.who}</span>
                {' '}
                {a.what}
                {' · '}
                <span className="t-mono" style={{fontSize:11}}>{a.at}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Drawer foot actions */}
        <div style={{display:'flex', gap:'var(--space-2)', padding:'var(--space-4) var(--space-6)', borderTop:'1px solid var(--border)'}}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => window.SHOGUN_RUNTIME?.pushToast?.('Delegating to agent (preview)', 'info')}
          >
            <Icon name="bot" size={14}/> Delegate to agent
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => window.SHOGUN_RUNTIME?.pushToast?.('Reschedule (preview)', 'info')}
          >
            <Icon name="clock" size={14}/> Reschedule
          </button>
          <span className="spacer"/>
          <button type="button" className="btn btn-primary" onClick={onMarkComplete}>
            <Icon name="check" size={14}/> {task.done ? 'Reopen' : 'Complete'}
          </button>
        </div>
      </aside>
    </>,
    document.body,
  );
}

function ScreenTasks() {
  const [tasks, setTasks] = React.useState(TASKS_DEMO);
  const [selectedId, setSelectedId] = React.useState(null);
  const [contextMenu, setContextMenu] = React.useState(null); // { x, y, taskId }
  const [filter, setFilter] = React.useState('all'); // all | open | done | flag

  const filteredTasks = React.useMemo(() => {
    if (filter === 'open') return tasks.filter((t) => !t.done);
    if (filter === 'done') return tasks.filter((t) => t.done);
    if (filter === 'flag') return tasks.filter((t) => t.level === 'flag');
    return tasks;
  }, [tasks, filter]);

  const selected = selectedId ? tasks.find((t) => t.id === selectedId) : null;

  const toggleDone = (id) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  };
  const toggleBreakdown = (taskId, subId) => {
    setTasks((prev) => prev.map((t) => {
      if (t.id !== taskId) return t;
      return { ...t, breakdown: t.breakdown.map((b) => (b.id === subId ? { ...b, done: !b.done } : b)) };
    }));
  };
  const deleteTask = (id) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const filters = [
    { k: 'all',  l: `All · ${tasks.length}` },
    { k: 'open', l: `Open · ${tasks.filter((t) => !t.done).length}` },
    { k: 'done', l: `Done · ${tasks.filter((t) => t.done).length}` },
    { k: 'flag', l: `Flagged · ${tasks.filter((t) => t.level === 'flag').length}` },
  ];

  return (
    <div className="content-inner" style={{padding:'var(--space-8) var(--space-12) var(--space-12)', maxWidth:1280, margin:'0 auto'}}>
      {/* Header */}
      <div className="page-head">
        <div>
          <div className="t-mono" style={{marginBottom:'var(--space-2)'}}>INTENT LAYER</div>
          <h1>Tasks <span className="jp">任務</span></h1>
          <div className="sub">Tasks · surfaced from memory. SHOGUN watches your meetings, chats and inbox and lifts follow-ups to here.</div>
        </div>
        <div className="row" style={{gap:'var(--space-2)', flexWrap:'wrap'}}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => window.SHOGUN_RUNTIME?.pushToast?.('Creating a task manually (preview)', 'info')}
          >
            <Icon name="plus" size={14}/> New task
          </button>
        </div>
      </div>

      {/* Filter pills */}
      <div className="row" style={{gap:'var(--space-2)', marginBottom:'var(--space-4)'}}>
        {filters.map((f) => (
          <button
            key={f.k}
            type="button"
            onClick={() => setFilter(f.k)}
            style={{
              all:'unset', cursor:'pointer',
              padding:'6px 14px', borderRadius:999,
              border: filter === f.k ? '1px solid var(--border-hi)' : '1px solid var(--border)',
              background: filter === f.k ? 'var(--surface-2)' : 'var(--surface)',
              color: filter === f.k ? 'var(--text)' : 'var(--text-mute)',
              fontSize:12,
            }}
          >
            {f.l}
          </button>
        ))}
      </div>

      {/* Task list */}
      <div className="card" style={{padding:0, overflow:'hidden'}}>
        {filteredTasks.length === 0 ? (
          <div style={{padding:'var(--space-8)', textAlign:'center', color:'var(--text-dim)', fontSize:13}}>
            No tasks in this filter.
          </div>
        ) : (
          filteredTasks.map((t, i) => (
            <div
              key={t.id}
              style={{
                display:'grid', gridTemplateColumns:'auto 1fr auto auto',
                alignItems:'center', gap:'var(--space-3)',
                padding:'var(--space-4) var(--space-6)',
                borderBottom: i < filteredTasks.length - 1 ? '1px solid var(--border)' : 'none',
              }}
            >
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); toggleDone(t.id); }}
                aria-pressed={t.done}
                aria-label={t.done ? 'Mark as not done' : 'Mark as done'}
                style={{
                  all:'unset', cursor:'pointer',
                  width:22, height:22, borderRadius:6,
                  border: t.done ? '1.5px solid var(--gold)' : '1.5px solid var(--border-hi)',
                  background: t.done ? 'color-mix(in srgb, var(--gold) 14%, transparent)' : 'transparent',
                  display:'inline-flex', alignItems:'center', justifyContent:'center', flexShrink:0,
                }}
              >
                {t.done && <Icon name="check" size={13} className="gold"/>}
              </button>

              <button
                type="button"
                onClick={() => setSelectedId(t.id)}
                style={{all:'unset', cursor:'pointer', minWidth:0}}
              >
                <div style={{fontSize:14, fontWeight:500, color: t.done ? 'var(--text-dim)' : 'var(--text)', textDecoration: t.done ? 'line-through' : 'none', marginBottom:2, wordBreak:'break-word'}}>
                  {t.title}
                </div>
                <div style={{fontSize:12, color:'var(--text-dim)'}}>From {t.from}</div>
              </button>

              <TaskStatusPill level={t.level}>{t.status}</TaskStatusPill>

              <button
                type="button"
                aria-label="Task actions"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setContextMenu({ x: r.right - 240, y: r.bottom + 6, taskId: t.id });
                }}
                style={{
                  all:'unset', cursor:'pointer',
                  padding:'6px 8px', borderRadius:'var(--radius-sm)',
                  color:'var(--text-dim)',
                }}
              >
                <Icon name="more" size={15}/>
              </button>
            </div>
          ))
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <TasksContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onAction={(id) => {
            const task = tasks.find((t) => t.id === contextMenu.taskId);
            if (!task) return;
            if (id === 'open')      setSelectedId(task.id);
            if (id === 'resched')   window.SHOGUN_RUNTIME?.pushToast?.('Rescheduling task (preview)', 'info');
            if (id === 'delegate')  window.SHOGUN_RUNTIME?.pushToast?.('Delegating to agent (preview)', 'info');
            if (id === 'linkmem')   window.SHOGUN_RUNTIME?.pushToast?.('Linking memory (preview)', 'info');
            if (id === 'delete')    deleteTask(task.id);
          }}
        />
      )}

      {/* Detail drawer */}
      <TaskDetailDrawer
        task={selected}
        onClose={() => setSelectedId(null)}
        onToggleBreakdown={(subId) => toggleBreakdown(selected.id, subId)}
        onMarkComplete={() => { toggleDone(selected.id); }}
      />
    </div>
  );
}

window.ScreenWork = ScreenWork;
window.ScreenCapture = ScreenCapture;
window.ScreenIntegrations = ScreenIntegrations;
window.ScreenTasks = ScreenTasks;
window.ScreenSettings = ScreenSettings;

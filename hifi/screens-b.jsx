/* global Icon, Kamon, React */
const { useState: useStateB, useEffect: useEffectB } = React;

function runRuntimeActionB(key, payload, options) {
  if (!window.SHOGUN_RUNTIME || !window.SHOGUN_RUNTIME.executeAction) return Promise.resolve({ ok:false });
  return window.SHOGUN_RUNTIME.executeAction(key, payload || {}, options || {});
}

// ═══════════════════════════════════════════════════════════════════════════
// L3 · CHAT — interaction layer (memory-aware conversations)
// ═══════════════════════════════════════════════════════════════════════════
function ScreenChat() {
  const [messages, setMessages] = useStateB([]);
  const [composerText, setComposerText] = useStateB('');
  const [memoryContext, setMemoryContext] = useStateB('');
  const [loading, setLoading] = useStateB(false);
  const [memoryTotal, setMemoryTotal] = useStateB(0);
  const [modelHint, setModelHint] = useStateB('');

  useEffectB(() => {
    let cancelled = false;
    (async () => {
      const r = await runRuntimeActionB('stats.get', {}, { silentError: true });
      if (cancelled || !r.ok || !r.data) return;
      setMemoryTotal(Number(r.data.memoryTotal) || 0);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffectB(() => {
    let cancelled = false;
    (async () => {
      const r = await runRuntimeActionB('settings.load', {}, { silentError: true });
      if (cancelled || !r.ok || !r.data?.settings?.sections?.llm) return;
      const m = r.data.settings.sections.llm.model;
      if (m) setModelHint(String(m));
    })();
    return () => { cancelled = true; };
  }, []);

  const toast = (msg, kind) => {
    if (window.SHOGUN_RUNTIME && window.SHOGUN_RUNTIME.pushToast) {
      window.SHOGUN_RUNTIME.pushToast(msg, kind || 'info');
    }
  };

  const attachMemory = async () => {
    const r = await runRuntimeActionB('memory.search', { query: '', limit: 12 }, { silentError: true });
    if (!r.ok || !r.data?.hits?.length) {
      toast('No memory items to attach', 'warn');
      return;
    }
    const block = r.data.hits.map((h) => (h.title || '') + ': ' + (h.snippet || '')).join('\n');
    setMemoryContext(block.slice(0, 12000));
    toast('Memory snippets attached for the next message', 'success');
  };

  const sendChat = async () => {
    const text = composerText.trim();
    if (!text || loading) return;
    const userTurn = { role: 'user', content: text };
    const next = messages.concat(userTurn);
    setMessages(next);
    setComposerText('');
    setLoading(true);
    const res = await runRuntimeActionB('chat.complete', {
      messages: next,
      memoryContext: memoryContext || undefined,
    }, { silentError: true });
    setLoading(false);
    if (!res.ok) {
      toast(res.error?.message || 'Chat request failed', 'error');
      return;
    }
    const d = res.data;
    let assistantText;
    if (d && d.mock) {
      assistantText = 'Mock transport: open the macOS app (Tauri) with an API key in Settings → Model & API for real replies.';
    } else {
      assistantText = d && d.message != null ? String(d.message) : 'Empty response';
    }
    setMessages((prev) => prev.concat({ role: 'assistant', content: assistantText }));
  };

  const newChat = () => {
    setMessages([]);
    setMemoryContext('');
    setComposerText('');
  };

  const openLlmSettings = () => {
    if (window.SHOGUN_RUNTIME && window.SHOGUN_RUNTIME.openSettingsPane) {
      window.SHOGUN_RUNTIME.openSettingsPane('llm');
    } else {
      toast('Open Settings → Model & API', 'info');
    }
  };

  return (
    <div style={{display:'grid', gridTemplateColumns:'1fr 300px', height:'100%'}}>
      <div style={{display:'flex', flexDirection:'column', overflow:'hidden'}}>
        <div style={{padding:'14px 32px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:12}}>
          <button className="btn btn-sm btn-ghost" onClick={newChat} style={{padding:'0 8px'}}><Icon name="plus" size={13}/>New</button>
          <div style={{width:1, height:20, background:'var(--border)'}}/>
          <div>
            <div style={{fontSize:14, fontWeight:500}}>Chat <span className="jp dim" style={{fontSize:11, marginLeft:6}}>対話</span></div>
            <div className="t-mono" style={{fontSize:9, marginTop:2}}>
              {modelHint || 'model from settings'} · {memoryTotal} memories indexed
            </div>
          </div>
          <span className="spacer"/>
          <button className="btn btn-sm btn-ghost" type="button" onClick={openLlmSettings}>Model & API</button>
        </div>

        <div style={{flex:1, overflowY:'auto', padding:'24px 32px'}}>
          <div style={{maxWidth:720, margin:'0 auto', display:'flex', flexDirection:'column', gap:20}}>
            {messages.length === 0 && (
              <div style={{textAlign:'center', color:'var(--text-mute)', fontSize:14, marginBottom:8}}>
                Ask anything. Attach local memory with <strong>Memory</strong>, then send. API key: Settings → Model & API.
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth:'85%'}}>
                <div style={{
                  background: m.role === 'user' ? 'var(--surface-2)' : 'transparent',
                  padding: m.role === 'user' ? '12px 16px' : '0',
                  borderRadius: m.role === 'user' ? 'var(--radius-lg) var(--radius-lg) 2px var(--radius-lg)' : 0,
                  fontSize:14,
                  lineHeight:1.65,
                  color:'var(--text)',
                  whiteSpace:'pre-wrap',
                }}>
                  {m.role === 'assistant' && (
                    <div className="row" style={{marginBottom:8, gap:8}}>
                      <Kamon size={16} color="var(--gold)"/>
                      <span style={{fontSize:11, color:'var(--gold)', fontWeight:500}}>SHOGUN</span>
                    </div>
                  )}
                  {m.content}
                </div>
                <div className="t-mono" style={{fontSize:9, marginTop:4, textAlign: m.role === 'user' ? 'right' : 'left', color:'var(--text-dim)'}}>
                  {m.role === 'user' ? 'YOU' : 'ASSISTANT'}
                </div>
              </div>
            ))}
            {loading && (
              <div style={{color:'var(--text-mute)', fontSize:13}}>Waiting for model…</div>
            )}
          </div>
        </div>

        <div className="composer-wrap">
          <div style={{maxWidth:720, margin:'0 auto'}}>
            <div className="composer">
              <textarea
                className="s-input"
                style={{width:'100%', minHeight:72, resize:'vertical', background:'transparent', border:'none', fontSize:14, fontFamily:'inherit', color:'var(--text)'}}
                placeholder="Message…"
                value={composerText}
                onChange={(e) => setComposerText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    sendChat();
                  }
                }}
              />
              <div className="row" style={{gap:8, marginTop:8}}>
                <button className="btn btn-sm btn-ghost" type="button" style={{padding:'0 8px'}} onClick={attachMemory}><Icon name="memory" size={13}/>Memory</button>
                <button className="btn btn-sm btn-ghost" type="button" style={{padding:'0 8px'}} onClick={() => toast('Agents are not available in v1', 'warn')}><Icon name="agents" size={13}/>Agent</button>
                <button className="btn btn-sm btn-ghost" type="button" style={{padding:'0 8px'}} onClick={() => toast('Tool picker is not available in v1', 'warn')}><Icon name="plug" size={13}/>Tool</button>
                <span className="spacer"/>
                <button className="btn btn-sm btn-primary" type="button" disabled={loading} onClick={sendChat}><Icon name="arrowRight" size={13}/>Send</button>
              </div>
            </div>
            <div className="t-mono" style={{fontSize:9, marginTop:8, textAlign:'center', color:'var(--text-dim)'}}>
              {memoryTotal} MEMORIES INDEXED · LOCAL
              <span className="jp" style={{marginLeft:10}}>⌘ + Enter で送信</span>
            </div>
          </div>
        </div>
      </div>

      <div style={{borderLeft:'1px solid var(--border)', overflowY:'auto', padding:'20px 20px', background:'var(--surface)'}}>
        <div className="row" style={{marginBottom:14}}>
          <span className="t-mono">MEMORY CONTEXT</span>
          <span className="jp dim" style={{fontSize:10, marginLeft:6}}>文脈</span>
          <span className="spacer"/>
          <button className="btn btn-sm btn-ghost" type="button" style={{padding:'0 6px'}} onClick={() => setMemoryContext('')}>Clear</button>
        </div>
        <pre style={{fontSize:11, lineHeight:1.5, color:'var(--text-mute)', whiteSpace:'pre-wrap', wordBreak:'break-word', maxHeight:280, overflow:'auto', margin:0, padding:10, background:'var(--bg)', border:'1px solid var(--border)', borderRadius:'var(--radius-sm)'}}>
          {memoryContext || '— Use Memory in the composer to load snippets from your index —'}
        </pre>
        <div style={{marginTop:16, fontSize:11, color:'var(--text-dim)'}}>
          v1: integrations, scheduling, and share-from-here use honest stubs or export only.
        </div>
      </div>

      <style>{`
        .chat-hero-composer {
          border:1px solid var(--border-hi); background:var(--surface);
          border-radius:var(--radius-lg);
          box-shadow:0 2px 0 rgba(0,0,0,0.2), 0 20px 40px -20px rgba(0,0,0,0.35);
        }
        .composer-wrap { padding:16px 32px 24px; border-top:1px solid var(--border); background:var(--bg); }
        .composer {
          border:1px solid var(--border-hi); border-radius:var(--radius-lg);
          padding:12px 14px; background:var(--surface);
          box-shadow:0 1px 0 rgba(0,0,0,0.2);
        }
        .composer:focus-within { border-color:var(--gold-dim); }
      `}</style>
    </div>
  );
}

// L4 · AGENTS — execution layer
// ═══════════════════════════════════════════════════════════════════════════
function ScreenAgents() {
  return (
    <div className="content-inner">
      <div className="page-head">
        <div>
          <div className="t-mono" style={{marginBottom:8}}>EXECUTION LAYER</div>
          <h1>Agents <span className="jp">家臣</span></h1>
          <div className="sub">Agents that read your memory and act. 20 MCP tools available.</div>
        </div>
        <div className="row">
          <button className="btn btn-secondary" onClick={()=>runRuntimeActionB('settings.save', { section:'agents', action:'open_mcp_console' }, { successMessage:'MCP console opened' })}><Icon name="terminal" size={14}/>MCP console</button>
          <button className="btn btn-primary" onClick={()=>runRuntimeActionB('schedule.create', { source:'agents', action:'new_agent' }, { silentError:true })}><Icon name="plus" size={14}/>New agent</button>
        </div>
      </div>

      {/* Status overview */}
      <div style={{display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:16, marginBottom:32}}>
        {[
          ['Running','4','var(--success)'],
          ['Scheduled','7','var(--gold)'],
          ['Paused','2','var(--text-dim)'],
          ['Tools connected','20','var(--text)'],
        ].map((s,i)=>(
          <div key={i} className="card" style={{padding:20}}>
            <div className="t-mono" style={{marginBottom:10}}>{s[0]}</div>
            <div style={{fontSize:36, fontWeight:600, color: s[2], letterSpacing:'-0.02em'}}>{s[1]}</div>
          </div>
        ))}
      </div>

      {/* Agent grid */}
      <div style={{fontSize:13, fontWeight:500, marginBottom:14, color:'var(--text-mute)'}}>Your agents</div>
      <div style={{display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap:16, marginBottom:32}}>
        {[
          {name:'Inbox triage', jp:'受信整理', desc:'Sorts Gmail by memory-derived priority. Drafts replies for you to approve.', status:'running', schedule:'every 2 hours', tools:['mail','memory'], runs:142, icon:'mail'},
          {name:'Meeting notes', jp:'議事録', desc:'Captures calendar events, extracts decisions into memory, links to entities.', status:'idle', schedule:'trigger: cal event', tools:['calendar','memory'], runs:87, icon:'calendar'},
          {name:'Daily digest', jp:'日報', desc:'Synthesizes the day at 21:00. Writes a morning brief for tomorrow at 07:00.', status:'scheduled', schedule:'21:00 daily', tools:['memory','note'], runs:38, icon:'note'},
          {name:'Weekly review', jp:'週次', desc:'Sunday morning. What moved this week? What needs decisions. Drafts a retro.', status:'scheduled', schedule:'Sun 10:00', tools:['memory','note','calendar'], runs:5, icon:'clock'},
        ].map((a,i)=>(
          <div key={i} className="card card-hover" style={{padding:0, overflow:'hidden'}}>
            <div style={{padding:'18px 20px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:12}}>
              <div style={{width:36, height:36, border:'1px solid var(--border)', borderRadius:'var(--radius-md)', display:'flex', alignItems:'center', justifyContent:'center', background:'var(--surface-2)'}}>
                <Icon name={a.icon} size={16} className="gold"/>
              </div>
              <div style={{flex:1}}>
                <div className="row" style={{gap:8}}>
                  <span style={{fontSize:14, fontWeight:500}}>{a.name}</span>
                  <span className="jp muted" style={{fontSize:11}}>{a.jp}</span>
                </div>
                <div className="row" style={{gap:6, marginTop:4}}>
                  <span className="dot" style={{width:6, height:6, borderRadius:'50%', background: a.status==='running'?'var(--success)':a.status==='idle'?'var(--text-dim)':'var(--gold)'}}/>
                  <span className="t-mono" style={{fontSize:10, textTransform:'none', letterSpacing:'0.05em', color:'var(--text-mute)'}}>{a.status} · {a.schedule}</span>
                </div>
              </div>
              <button className="btn btn-sm btn-ghost" onClick={()=>runRuntimeActionB('settings.save', { section:'agents', action:'agent_row_menu', agent:a.name }, { successMessage:'Agent menu opened' })}><Icon name="more" size={14}/></button>
            </div>
            <div style={{padding:'16px 20px', fontSize:13, color:'var(--text-mute)', lineHeight:1.5}}>
              {a.desc}
            </div>
            <div style={{padding:'12px 20px', borderTop:'1px solid var(--border)', background:'var(--surface-2)', display:'flex', alignItems:'center', gap:8}}>
              <span className="t-mono" style={{fontSize:10}}>{a.runs} RUNS</span>
              <span className="spacer"/>
              {a.tools.map(t => <span key={t} className="label"><Icon name={t} size={10} style={{marginRight:4}}/>{t}</span>)}
            </div>
          </div>
        ))}
      </div>

      {/* Live activity log */}
      <div style={{fontSize:13, fontWeight:500, marginBottom:14, color:'var(--text-mute)'}}>Live activity</div>
      <div className="card" style={{padding:0, fontFamily:'var(--font-mono)', fontSize:12, background:'var(--bg)'}}>
        {[
          ['14:31:08', 'inbox-triage', 'Read 3 emails · drafted 1 reply', 'success'],
          ['14:18:42', 'meeting-notes', 'Processed "All PJ" meeting · 6 decisions extracted', 'success'],
          ['14:02:15', 'memory', 'Indexed conversation · 42 messages · 3 entities linked', 'info'],
          ['13:58:00', 'meeting-notes', 'Triggered by cal event: All PJ', 'info'],
          ['13:22:44', 'inbox-triage', 'Skipped · no new emails since 11:00', 'muted'],
        ].map((r,i) => (
          <div key={i} className="row" style={{padding:'10px 20px', borderBottom:i<4?'1px solid var(--border)':'none', gap:14}}>
            <span style={{color:'var(--text-dim)', fontSize:11}}>{r[0]}</span>
            <span className="gold" style={{minWidth:120}}>{r[1]}</span>
            <span style={{flex:1, color: r[3]==='muted'?'var(--text-dim)':'var(--text)'}}>{r[2]}</span>
            <span className="label" style={{background:'transparent', color: r[3]==='success'?'var(--success)':r[3]==='info'?'var(--text-mute)':'var(--text-dim)', borderColor: r[3]==='success'?'color-mix(in srgb, var(--success) 40%, transparent)':'var(--border)'}}>{r[3].toUpperCase()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

window.ScreenChat = ScreenChat;
window.ScreenAgents = ScreenAgents;

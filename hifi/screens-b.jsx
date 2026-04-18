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
  const [chatMax, setChatMax] = useStateB(false);
  const [voiceRecording, setVoiceRecording] = useStateB(false);

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

  useEffectB(() => {
    const syncFromShell = () => {
      const seed = window.SHOGUN_DEMO_SEED;
      const rt = window.SHOGUN_RUNTIME;
      const id =
        (typeof window !== 'undefined' && window.__SHOGUN_SHELL_ACTIVE_CHAT__) ||
        (rt && rt.__activeChatId) ||
        (rt && typeof rt.getActiveChat === 'function' && rt.getActiveChat() && rt.getActiveChat().id) ||
        null;
      if (!id || !seed || !seed.chatThreads || !seed.chatThreads[id]) {
        setMessages([]);
        setMemoryContext('');
        return;
      }
      setMessages(seed.chatThreads[id].map((m) => ({ ...m })));
      const ctx = seed.chatMemoryContext && seed.chatMemoryContext[id];
      setMemoryContext(ctx ? String(ctx) : '');
    };
    syncFromShell();
    window.addEventListener('shogun-active-chat-changed', syncFromShell);
    return () => window.removeEventListener('shogun-active-chat-changed', syncFromShell);
  }, []);

  useEffectB(() => {
    const onMax = () => setChatMax((v) => !v);
    const onVoiceToggle = () => {
      setVoiceRecording((v) => {
        const next = !v;
        toast(next ? 'Voice recording started (preview — no audio in browser)' : 'Voice recording stopped', 'info');
        return next;
      });
    };
    const onVoiceCancel = () => {
      setVoiceRecording((was) => {
        if (was) toast('Voice recording cancelled', 'info');
        return false;
      });
    };
    window.addEventListener('shogun-chat-toggle-max', onMax);
    window.addEventListener('shogun-voice-toggle', onVoiceToggle);
    window.addEventListener('shogun-voice-cancel', onVoiceCancel);
    return () => {
      window.removeEventListener('shogun-chat-toggle-max', onMax);
      window.removeEventListener('shogun-voice-toggle', onVoiceToggle);
      window.removeEventListener('shogun-voice-cancel', onVoiceCancel);
    };
  }, []);

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
    <div className={'shogun-chat-layout' + (chatMax ? ' shogun-chat-max' : '')}>
      <div className="shogun-chat-main">
        <div className="shogun-chat-header">
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

        <div className="shogun-chat-scroll">
          <div
            className={'shogun-chat-thread' + (messages.length === 0 && !loading ? ' shogun-chat-thread--empty' : '')}
            style={{maxWidth:720, margin:'0 auto', display:'flex', flexDirection:'column', gap:20, width:'100%'}}
          >
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
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendChat();
                    return;
                  }
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    sendChat();
                  }
                }}
              />
              <div className="row" style={{gap:8, marginTop:8}}>
                <button className="btn btn-sm btn-ghost" type="button" style={{padding:'0 8px'}} onClick={attachMemory}><Icon name="memory" size={13}/>Memory</button>
                <button className="btn btn-sm btn-ghost" type="button" style={{padding:'0 8px'}} onClick={() => window.SHOGUN_RUNTIME?.setActiveScreen?.('agents')}><Icon name="agents" size={13}/>Agents</button>
                <button className="btn btn-sm btn-ghost" type="button" style={{padding:'0 8px'}} onClick={() => window.SHOGUN_RUNTIME?.openSettingsPane?.('integrations')}><Icon name="plug" size={13}/>Integrations</button>
                <span className="spacer"/>
                <button className="btn btn-sm btn-primary" type="button" disabled={loading} onClick={sendChat}><Icon name="arrowRight" size={13}/>Send</button>
              </div>
            </div>
            <div className="t-mono" style={{fontSize:9, marginTop:8, textAlign:'center', color:'var(--text-dim)'}}>
              {memoryTotal} MEMORIES INDEXED · LOCAL
              <span style={{marginLeft:10}}>Return sends · Shift+Return new line · Cmd+Return also sends</span>
              {voiceRecording && (
                <span style={{marginLeft:10, color:'var(--gold)'}}>● voice</span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="shogun-chat-context">
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
        .shogun-chat-layout .composer-wrap { border-top:1px solid var(--border); background:var(--bg); }
        .composer {
          border:1px solid var(--border-hi); border-radius:var(--radius-lg);
          padding:12px 14px; background:var(--surface);
          box-shadow:0 1px 0 rgba(0,0,0,0.2);
        }
        .composer:focus-within { border-color:var(--gold-dim); }
        .shogun-chat-thread--empty { min-height:100%; justify-content:center; box-sizing:border-box; padding-block:12px; }
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
          <div className="sub">Automations and MCP-backed agents are not listed in this preview. Use the desktop app to register and run them.</div>
        </div>
      </div>
      <div className="card" style={{padding:32, maxWidth:560}}>
        <p style={{fontSize:14, color:'var(--text-mute)', lineHeight:1.65, margin:0}}>
          No agents are connected here. For tools and OAuth, open Settings → Integrations from the user menu, or use Chat for one-off tasks.
        </p>
        <div className="row" style={{gap:10, marginTop:22, flexWrap:'wrap'}}>
          <button className="btn btn-secondary" type="button" onClick={() => window.SHOGUN_RUNTIME?.openSettingsPane?.('integrations')}>
            <Icon name="plug" size={14}/> Integrations
          </button>
          <button className="btn btn-ghost" type="button" onClick={() => window.SHOGUN_RUNTIME?.setActiveScreen?.('chat')}>
            <Icon name="chat" size={14}/> Chat
          </button>
        </div>
      </div>
    </div>
  );
}

window.ScreenChat = ScreenChat;
window.ScreenAgents = ScreenAgents;

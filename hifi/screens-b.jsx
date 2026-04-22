/* global Icon, Kamon, React */
const { useState: useStateB, useEffect: useEffectB, useRef: useRefB } = React;

/** One-shot Memory assembly overrides from `shogun-chat-composer-seed` (Memory / Agents). */
function normalizeSeedMemoryAssembly(d) {
  if (!d || typeof d !== 'object') return null;
  if (d.memoryAssemblyPreset && typeof d.memoryAssemblyPreset === 'object') {
    const p = d.memoryAssemblyPreset;
    const q = String(p.query || '').trim().slice(0, 480);
    const limRaw = p.limit != null ? Number(p.limit) : 12;
    const lim = Number.isFinite(limRaw) ? Math.min(80, Math.max(1, Math.floor(limRaw))) : 12;
    const semantic = p.semantic !== false;
    return { query: q, limit: lim, semantic };
  }
  if (d.memoryAssemblyQuery != null && String(d.memoryAssemblyQuery).trim()) {
    const q = String(d.memoryAssemblyQuery).trim().slice(0, 480);
    const limRaw = d.memoryAssemblyLimit != null ? Number(d.memoryAssemblyLimit) : 12;
    const lim = Number.isFinite(Number(limRaw)) ? Math.min(80, Math.max(1, Math.floor(Number(limRaw)))) : 12;
    const semantic = d.memoryAssemblySemantic !== false;
    return { query: q, limit: lim, semantic };
  }
  return null;
}

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
  const [webSearchOn, setWebSearchOn] = useStateB(true);
  /** Server-side Memory assembly (`memoryAssembly` on `chat.complete`); desktop runs search / semantic rerank. */
  const [assembleMemoryOn, setAssembleMemoryOn] = useStateB(false);
  /** Mirrors `sections.privacy.allowChatServerMemoryAssembly` (default true). */
  const [allowServerMemoryAssembly, setAllowServerMemoryAssembly] = useStateB(true);
  const pendingMemoryAssemblyRef = useRefB(null);
  const pendingAutoSendRef = useRefB(false);

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
      if (cancelled || !r.ok || !r.data?.settings?.sections) return;
      const llm = r.data.settings.sections.llm;
      if (llm && typeof llm === 'object' && llm.model) setModelHint(String(llm.model));
      const priv = r.data.settings.sections.privacy;
      if (priv && typeof priv === 'object') {
        setAllowServerMemoryAssembly(priv.allowChatServerMemoryAssembly !== false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffectB(() => {
    const onPrivacy = () => {
      void runRuntimeActionB('settings.load', {}, { silentError: true }).then((r) => {
        const priv = r?.ok && r.data?.settings?.sections?.privacy;
        if (priv && typeof priv === 'object') {
          setAllowServerMemoryAssembly(priv.allowChatServerMemoryAssembly !== false);
        }
      });
    };
    window.addEventListener('shogun-privacy-settings-changed', onPrivacy);
    return () => window.removeEventListener('shogun-privacy-settings-changed', onPrivacy);
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
    const onComposerSeed = (ev) => {
      const d = ev && ev.detail ? ev.detail : {};
      if (d.text != null) setComposerText(String(d.text));
      if (typeof d.webSearch === 'boolean') setWebSearchOn(d.webSearch);
      if (typeof d.assembleMemory === 'boolean') setAssembleMemoryOn(d.assembleMemory);
      const preset = normalizeSeedMemoryAssembly(d);
      if (preset) pendingMemoryAssemblyRef.current = preset;
      else if (d.clearMemoryAssemblyPreset) pendingMemoryAssemblyRef.current = null;
      if (d.autoSend && d.text != null && String(d.text).trim()) {
        pendingAutoSendRef.current = true;
      }
    };
    window.addEventListener('shogun-chat-toggle-max', onMax);
    window.addEventListener('shogun-chat-composer-seed', onComposerSeed);
    return () => {
      window.removeEventListener('shogun-chat-toggle-max', onMax);
      window.removeEventListener('shogun-chat-composer-seed', onComposerSeed);
    };
  }, []);

  const attachMemory = async () => {
    const r = await runRuntimeActionB('memory.search', { query: '', limit: 12 }, { silentError: true });
    if (!r.ok || !r.data?.hits?.length) {
      toast('No memory items to attach', 'warn');
      return;
    }
    const block = r.data.hits
      .map((h) => '[' + (h.provenance || 'user') + '] ' + (h.title || '') + ': ' + (h.snippet || ''))
      .join('\n');
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
    const payload = {
      messages: next,
      memoryContext: memoryContext || undefined,
      webSearch: webSearchOn,
    };
    const preset = pendingMemoryAssemblyRef.current;
    const usePreset = preset && typeof preset.query === 'string';
    const shouldAssemble = assembleMemoryOn || usePreset;
    const assemblyAllowed = shouldAssemble && allowServerMemoryAssembly;
    if (assemblyAllowed) {
      if (usePreset) {
        payload.memoryAssembly = {
          query: preset.query,
          limit: preset.limit != null ? preset.limit : 12,
          semantic: preset.semantic !== false,
        };
        pendingMemoryAssemblyRef.current = null;
      } else {
        payload.memoryAssembly = {
          query: text.slice(0, 480),
          limit: 12,
          semantic: true,
        };
      }
    }
    const manualCtx = (memoryContext || '').trim();
    if (global.BriefTelemetry && global.BriefTelemetry.log && global.BriefTelemetry.EVENTS) {
      global.BriefTelemetry.log(global.BriefTelemetry.EVENTS.CHAT_COMPLETION_CONTEXT, {
        hasManualMemoryContext: manualCtx.length > 0,
        manualMemoryContextChars: manualCtx.length,
        memoryAssemblyRequested: shouldAssemble,
        memoryAssemblySent: assemblyAllowed && Boolean(payload.memoryAssembly),
        memoryAssemblyPreset: usePreset,
        privacyAllowsServerAssembly: allowServerMemoryAssembly,
      });
    }
    const res = await runRuntimeActionB('chat.complete', payload, { silentError: true });
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
    pendingMemoryAssemblyRef.current = null;
  };

  const openLlmSettings = () => {
    if (window.SHOGUN_RUNTIME && window.SHOGUN_RUNTIME.openSettingsPane) {
      window.SHOGUN_RUNTIME.openSettingsPane('llm');
    } else {
      toast('Open Settings → Model & API', 'info');
    }
  };

  useEffectB(() => {
    if (!pendingAutoSendRef.current) return;
    if (!composerText.trim() || loading) return;
    pendingAutoSendRef.current = false;
    void sendChat();
  }, [composerText, loading]);

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
                Ask anything. Use <strong>Memory</strong> for pasted snippets, <strong>Assemble</strong> for server-side index pull, or open from <strong>Memory / Agents</strong> with a one-shot preset. API key: Settings → Model & API.
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
              <div className="row composer-actions" style={{gap:6, marginTop:8}}>
                <button className="composer-pill" type="button" onClick={attachMemory}><Icon name="memory" size={13}/>Memory</button>
                <button
                  className={'composer-pill' + (webSearchOn ? ' is-on' : '')}
                  type="button"
                  title="Web research mode (prompts the model for current-style answers; no live browse unless you paste URLs)"
                  onClick={() => setWebSearchOn((v) => !v)}
                >
                  <Icon name="globe" size={13} /> Web
                </button>
                <button
                  className={'composer-pill' + (assembleMemoryOn ? ' is-on' : '')}
                  type="button"
                  title="memoryAssembly: server assembles context from local Memory (semantic search when API key is set)"
                  onClick={() => setAssembleMemoryOn((v) => !v)}
                >
                  <Icon name="memory" size={13} /> Assemble
                </button>
                <button className="composer-pill" type="button" onClick={() => window.SHOGUN_RUNTIME?.setActiveScreen?.('agents')}><Icon name="agents" size={13}/>Agents</button>
                <button className="composer-pill" type="button" onClick={() => window.SHOGUN_RUNTIME?.openSettingsPane?.('integrations')}><Icon name="plug" size={13}/>Integrations</button>
                <span className="spacer"/>
                <button className="composer-send" type="button" aria-label="Send" disabled={loading} onClick={sendChat}><Icon name="arrowUp" size={16}/></button>
              </div>
            </div>
            <div className="t-mono" style={{fontSize:9, marginTop:8, textAlign:'center', color:'var(--text-dim)'}}>
              {memoryTotal} MEMORIES INDEXED · LOCAL
              <span style={{marginLeft:10}}>Return sends · Shift+Return new line · Cmd+Return also sends</span>
            </div>
          </div>
        </div>
      </div>

      <div className="shogun-chat-context">
        <div className="memory-context-head">
          <div className="memory-context-head-main">
            <div className="memory-context-icon" aria-hidden>
              <Icon name="memory" size={15} />
            </div>
            <div>
              <div className="memory-context-title">
                <span className="en-only">Memory context</span>
                <span className="jp">記憶コンテキスト</span>
              </div>
              <div className="memory-context-sub dim">
                <span className="en-only">Snippets attached to this thread</span>
                <span className="jp">このスレッドに載せる記憶スニペット</span>
              </div>
            </div>
          </div>
          <button
            className="memory-context-clear"
            type="button"
            disabled={!memoryContext}
            onClick={() => setMemoryContext('')}
          >
            Clear
          </button>
        </div>
        {memoryContext ? (
          <div className="memory-context-body memory-context-body--filled">
            {memoryContext}
          </div>
        ) : (
          <div className="memory-context-body memory-context-body--empty">
            <div className="memory-context-empty-icon" aria-hidden>
              <Icon name="memory" size={22} />
            </div>
            <div className="memory-context-empty-title">
              <span className="en-only">No context yet</span>
              <span className="jp">まだ文脈はありません</span>
            </div>
            <div className="memory-context-empty-desc">
              <span className="en-only">
                Use <strong>Memory</strong> in the composer below to pull snippets from your index — they appear here.
              </span>
              <span className="jp">
                下のコンポーザーで <strong>Memory</strong> から取り込んだスニペットがここに表示されます。
              </span>
            </div>
          </div>
        )}
        <p className="memory-context-foot">
          <span className="en-only">From your local Memory index on this device only.</span>
          <span className="jp">ローカルの Memory インデックス由来 · この端末に保存された範囲のみ</span>
        </p>
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
        .composer-actions { align-items:center; }
        .composer-pill {
          display:inline-flex; align-items:center; gap:6px;
          height:30px; padding:0 12px;
          border-radius:999px;
          border:1px solid var(--border);
          background:color-mix(in srgb, var(--surface) 65%, var(--bg) 35%);
          color:var(--text-mute);
          font-size:12.5px; font-weight:450; letter-spacing:0.01em;
          font-family:inherit; cursor:pointer;
          transition:border-color 120ms, background 120ms, color 120ms;
        }
        .composer-pill:hover {
          border-color:var(--border-hi);
          background:var(--surface);
          color:var(--text);
        }
        .composer-pill.is-on {
          color:var(--gold);
          border-color:color-mix(in srgb, var(--gold-dim) 60%, var(--border) 40%);
          background:color-mix(in srgb, var(--gold) 8%, var(--surface) 92%);
        }
        .composer-pill:focus-visible {
          outline:2px solid var(--gold);
          outline-offset:2px;
        }
        .composer-send {
          display:inline-flex; align-items:center; justify-content:center;
          width:38px; height:38px;
          border-radius:12px;
          border:0;
          background:var(--gold);
          color:#fff;
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.18),
            0 1px 0 rgba(0,0,0,0.35),
            0 2px 8px -2px color-mix(in srgb, var(--gold) 55%, transparent);
          cursor:pointer;
          transition:background 120ms, transform 80ms, box-shadow 120ms;
        }
        .composer-send:hover:not(:disabled) {
          background:var(--gold-hover);
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.22),
            0 1px 0 rgba(0,0,0,0.35),
            0 4px 14px -2px color-mix(in srgb, var(--gold) 70%, transparent);
        }
        .composer-send:active:not(:disabled) { transform:scale(0.96); }
        .composer-send:disabled {
          opacity:0.5;
          cursor:not-allowed;
          box-shadow:none;
        }
        .composer-send:focus-visible {
          outline:2px solid var(--gold);
          outline-offset:2px;
        }
        .shogun-chat-thread--empty { min-height:100%; justify-content:center; box-sizing:border-box; padding-block:12px; }
      `}</style>
    </div>
  );
}

// L4 · AGENTS — execution layer
// ═══════════════════════════════════════════════════════════════════════════
function ScreenAgents() {
  const [runPrompt, setRunPrompt] = React.useState('');
  const [allowServerMemoryAssembly, setAllowServerMemoryAssembly] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    void runRuntimeActionB('settings.load', {}, { silentError: true }).then((r) => {
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
      void runRuntimeActionB('settings.load', {}, { silentError: true }).then((r) => {
        const priv = r?.ok && r.data?.settings?.sections?.privacy;
        if (priv && typeof priv === 'object') {
          setAllowServerMemoryAssembly(priv.allowChatServerMemoryAssembly !== false);
        }
      });
    };
    window.addEventListener('shogun-privacy-settings-changed', onPrivacy);
    return () => window.removeEventListener('shogun-privacy-settings-changed', onPrivacy);
  }, []);

  const draftWithMemory = React.useCallback(() => {
    const raw = runPrompt.trim();
    const prompt =
      raw ||
      'Summarize actionable items from my recent local memory index. Output Markdown: bullets, owners if known, and open questions.';
    const payload = {
      target: 'agent_run',
      source: 'agents_playground',
      prompt,
    };
    if (allowServerMemoryAssembly) {
      payload.memoryAssembly = {
        query: raw.slice(0, 480) || '',
        limit: 14,
        semantic: true,
      };
    }
    return runRuntimeActionB('draft.create', payload, { successMessage: 'Draft ready', silentError: true }).then((r) => {
      if (!r.ok && window.SHOGUN_RUNTIME && window.SHOGUN_RUNTIME.pushToast) {
        window.SHOGUN_RUNTIME.pushToast(r.error && r.error.message ? r.error.message : 'Draft failed', 'warn');
      }
    });
  }, [runPrompt, allowServerMemoryAssembly]);

  const openChatWithMemory = React.useCallback(() => {
    const raw = runPrompt.trim();
    const text =
      raw ||
      'You are my execution agent. Use local memory context to propose the next 3 concrete steps (bullets).';
    const q = raw.slice(0, 480) || '';
    const detail = { text, webSearch: false, assembleMemory: allowServerMemoryAssembly };
    if (allowServerMemoryAssembly) {
      detail.memoryAssemblyPreset = { query: q, limit: 14, semantic: true };
    } else {
      detail.clearMemoryAssemblyPreset = true;
    }
    window.dispatchEvent(new CustomEvent('shogun-chat-composer-seed', { detail }));
    window.SHOGUN_RUNTIME?.setActiveScreen?.('chat');
  }, [runPrompt, allowServerMemoryAssembly]);

  const applyQuick = (line) => {
    setRunPrompt(line);
  };

  return (
    <div className="content-inner">
      <div className="page-head">
        <div>
          <div className="t-mono" style={{marginBottom:8}}>EXECUTION LAYER</div>
          <h1>Agents <span className="jp">家臣</span></h1>
          <div className="sub">
            <span className="en-only">Playground: drafts and Chat can pull </span>
            <code className="t-mono" style={{ fontSize: 11 }}>memoryAssembly</code>
            <span className="en-only"> from your local index. Register real agents in the desktop app.</span>
            <span className="jp" style={{ display: 'block', fontSize: 12, marginTop: 6, color: 'var(--text-dim)' }}>
              下書き・チャットはローカル Memory を検索して文脈を足せます。本番のエージェントはデスクトップで登録してください。
            </span>
          </div>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" type="button" onClick={() => window.SHOGUN_RUNTIME?.openSettingsPane?.('integrations')}>
            <Icon name="plug" size={14}/> Integrations
          </button>
          <button className="btn btn-ghost" type="button" onClick={() => window.SHOGUN_RUNTIME?.setActiveScreen?.('chat')}>
            <Icon name="chat" size={14}/> Chat
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 24, maxWidth: 640 }}>
        <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-mute)', marginBottom: 8 }}>GOAL · 指示</div>
        <textarea
          className="s-input"
          style={{
            width: '100%',
            minHeight: 88,
            resize: 'vertical',
            fontSize: 14,
            fontFamily: 'inherit',
            background: 'var(--surface)',
            border: '1px solid var(--border-hi)',
            borderRadius: 'var(--radius-md)',
            padding: 12,
            color: 'var(--text)',
          }}
          placeholder="例: 今週のリスクを Memory から洗い出して / 投資家向けに1段落…"
          value={runPrompt}
          onChange={(e) => setRunPrompt(e.target.value)}
        />
        <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" type="button" onClick={draftWithMemory}>
            <Icon name="edit" size={14}/> Draft + Memory
          </button>
          <button className="btn btn-secondary" type="button" onClick={openChatWithMemory}>
            <Icon name="chat" size={14}/> Open in Chat
          </button>
        </div>
        <div style={{ marginTop: 16, fontSize: 12, color: 'var(--text-dim)' }}>
          <span className="t-mono" style={{ marginRight: 8 }}>QUICK</span>
          {[
            '今週のブロッカーを Memory から列挙',
            'カレンダー関連メモのフォローアップ案',
            '会議メモに出てくる名前の整理',
          ].map((q) => (
            <button
              key={q}
              type="button"
              className="btn btn-sm btn-ghost"
              style={{ marginRight: 6, marginBottom: 6 }}
              onClick={() => applyQuick(q)}
            >
              {q.length > 28 ? q.slice(0, 28) + '…' : q}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

window.ScreenChat = ScreenChat;
window.ScreenAgents = ScreenAgents;

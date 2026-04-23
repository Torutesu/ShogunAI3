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
  const [attachments, setAttachments] = useStateB([]);
  const [dropActive, setDropActive] = useStateB(false);
  const dragDepthRef = useRefB(0);
  const fileInputRef = useRefB(null);

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

  const formatAttachmentSize = (bytes) => {
    if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const addFiles = (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const mapped = files.map((f) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: f.name || 'file',
      type: f.type || '',
      size: Number(f.size) || 0,
      file: f,
    }));
    setAttachments((prev) => prev.concat(mapped));
    toast(`${mapped.length} ${mapped.length === 1 ? 'file' : 'files'} attached`, 'success');
  };

  const removeAttachment = (id) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const openFilePicker = () => {
    if (fileInputRef.current) fileInputRef.current.click();
  };

  const sendChat = async () => {
    const text = composerText.trim();
    if ((!text && attachments.length === 0) || loading) return;
    const attachmentSummary = attachments.length
      ? '\n\n[Attached: ' + attachments.map((a) => a.name).join(', ') + ']'
      : '';
    const userTurn = { role: 'user', content: text + attachmentSummary };
    const next = messages.concat(userTurn);
    setMessages(next);
    setComposerText('');
    setAttachments([]);
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
    <div
      className={'shogun-chat-layout' + (chatMax ? ' shogun-chat-max' : '') + (dropActive ? ' shogun-chat-dropping' : '')}
      onDragEnter={(e) => {
        if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
        e.preventDefault();
        dragDepthRef.current += 1;
        setDropActive(true);
      }}
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(e) => {
        if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDropActive(false);
      }}
      onDrop={(e) => {
        if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
        e.preventDefault();
        dragDepthRef.current = 0;
        setDropActive(false);
        const dropped = e.dataTransfer?.files;
        if (dropped && dropped.length) addFiles(dropped);
      }}
    >
      {dropActive && (
        <div className="shogun-chat-drop-overlay" aria-hidden="true">
          <div className="shogun-chat-drop-card">
            <Icon name="paperclip" size={22} />
            <div className="shogun-chat-drop-title">
              <span className="en-only">Drop to attach</span>
              <span className="jp">ドロップして添付</span>
            </div>
            <div className="shogun-chat-drop-sub">
              <span className="en-only">Files & images — added to this message</span>
              <span className="jp">ファイル・画像をこのメッセージに添付</span>
            </div>
          </div>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          addFiles(e.target.files);
          e.target.value = '';
        }}
      />
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
              {attachments.length > 0 && (
                <div className="composer-attachments">
                  {attachments.map((a) => (
                    <span key={a.id} className="composer-attachment-chip" title={`${a.name} · ${formatAttachmentSize(a.size)}`}>
                      <Icon name={a.type.startsWith('image/') ? 'note' : 'file'} size={12} />
                      <span className="composer-attachment-name">{a.name}</span>
                      <span className="composer-attachment-size">{formatAttachmentSize(a.size)}</span>
                      <button
                        type="button"
                        className="composer-attachment-remove"
                        aria-label={`Remove ${a.name}`}
                        onClick={() => removeAttachment(a.id)}
                      >
                        <Icon name="x" size={10} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="row composer-actions" style={{gap:6, marginTop:8}}>
                <button className="composer-pill" type="button" onClick={openFilePicker} title="Attach files or images"><Icon name="paperclip" size={13}/>Attach</button>
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
                <button
                  className="composer-send"
                  type="button"
                  disabled={loading || (!composerText.trim() && attachments.length === 0)}
                  onClick={sendChat}
                  aria-label="Send message"
                  title="Send (Return)"
                >
                  <Icon name="arrowUp" size={18} />
                </button>
              </div>
            </div>
            <div className="t-mono" style={{fontSize:11, marginTop:8, textAlign:'center', color:'var(--text-dim)', textTransform:'none', letterSpacing:'0.02em'}}>
              {memoryTotal} memories indexed · Local
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

        .composer-send {
          width:36px; height:36px; border-radius:10px;
          display:inline-flex; align-items:center; justify-content:center;
          background:var(--gold); color:#151212;
          border:0; padding:0; cursor:pointer;
          transition:background var(--dur-base) var(--ease-out), transform var(--dur-base) var(--ease-out), opacity var(--dur-base) var(--ease-out);
          box-shadow:0 1px 0 rgba(0,0,0,0.25);
        }
        .composer-send:hover:not(:disabled) { background:var(--gold-hover); }
        .composer-send:active:not(:disabled) { transform:translateY(1px); }
        .composer-send:disabled { opacity:0.45; cursor:not-allowed; }
        .composer-send:focus-visible { outline:2px solid var(--gold); outline-offset:2px; }

        .composer-attachments {
          display:flex; flex-wrap:wrap; gap:6px; margin-top:10px;
        }
        .composer-attachment-chip {
          display:inline-flex; align-items:center; gap:6px;
          height:26px; padding:0 6px 0 8px;
          background:var(--surface-2); border:1px solid var(--border);
          border-radius:var(--radius-sm);
          font-size:11px; color:var(--text);
          max-width:240px;
        }
        .composer-attachment-name {
          overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
          max-width:140px;
        }
        .composer-attachment-size {
          font-family:var(--font-mono); font-size:10px; color:var(--text-dim);
        }
        .composer-attachment-remove {
          display:inline-flex; align-items:center; justify-content:center;
          width:16px; height:16px; border-radius:4px;
          color:var(--text-dim); background:transparent; border:0; cursor:pointer;
        }
        .composer-attachment-remove:hover { color:var(--text); background:var(--surface); }

        .shogun-chat-layout { position:relative; }
        .shogun-chat-drop-overlay {
          position:absolute; inset:0; z-index:50;
          display:flex; align-items:center; justify-content:center;
          background:color-mix(in srgb, var(--bg) 70%, transparent);
          backdrop-filter:blur(2px);
          pointer-events:none;
        }
        .shogun-chat-drop-card {
          display:flex; flex-direction:column; align-items:center; gap:8px;
          padding:24px 32px;
          border:2px dashed var(--gold);
          border-radius:var(--radius-lg);
          background:var(--surface);
          color:var(--text);
          box-shadow:0 20px 40px -16px rgba(0,0,0,0.5);
        }
        .shogun-chat-drop-title { font-size:15px; font-weight:500; color:var(--gold); }
        .shogun-chat-drop-sub { font-size:12px; color:var(--text-mute); }
      `}</style>
    </div>
  );
}

// L4 · AGENTS — execution layer
// ═══════════════════════════════════════════════════════════════════════════
const AGENTS_DEMO = [
  {
    id: 'inbox-triage',
    name: 'Inbox triage',
    icon: 'mail',
    status: 'running',
    trigger: 'every 2 hours',
    description: 'Sorts Gmail by memory-derived priority. Drafts replies for you to approve.',
    runs: 142,
    tools: [{ name: 'mail', icon: 'mail' }, { name: 'memory', icon: 'memory' }],
  },
  {
    id: 'meeting-notes',
    name: 'Meeting notes',
    icon: 'calendar',
    status: 'idle',
    trigger: 'trigger: cal event',
    description: 'Captures calendar events, extracts decisions into memory, links to entities.',
    runs: 87,
    tools: [{ name: 'calendar', icon: 'calendar' }, { name: 'memory', icon: 'memory' }],
  },
  {
    id: 'daily-digest',
    name: 'Daily digest',
    icon: 'note',
    status: 'scheduled',
    trigger: '21:00 daily',
    description: 'Synthesizes the day at 21:00. Writes a morning brief for tomorrow at 07:00.',
    runs: 38,
    tools: [{ name: 'memory', icon: 'memory' }, { name: 'note', icon: 'note' }],
  },
  {
    id: 'weekly-review',
    name: 'Weekly review',
    icon: 'clock',
    status: 'scheduled',
    trigger: 'Sun 10:00',
    description: 'Sunday morning. What moved this week? What needs decisions. Drafts a retro.',
    runs: 5,
    tools: [{ name: 'memory', icon: 'memory' }, { name: 'note', icon: 'note' }, { name: 'calendar', icon: 'calendar' }],
  },
];

const AGENTS_LIVE = [
  { t: '14:31:08', agent: 'inbox-triage', msg: 'Read 3 emails · drafted 1 reply', level: 'success' },
  { t: '14:18:42', agent: 'meeting-notes', msg: 'Processed "All PJ" meeting · 6 decisions extracted', level: 'success' },
  { t: '14:02:15', agent: 'memory', msg: 'Indexed conversation · 48 messages · 3 entities linked', level: 'info' },
  { t: '13:46:02', agent: 'inbox-triage', msg: 'Polled inbox · no new priority mail', level: 'info' },
  { t: '13:20:37', agent: 'daily-digest', msg: 'Scheduled: next run at 21:00', level: 'info' },
];

const AGENT_STATUS_META = {
  running: { color: 'var(--success)', label: 'running' },
  scheduled: { color: 'var(--gold)', label: 'scheduled' },
  idle: { color: 'var(--text-mute)', label: 'idle' },
  paused: { color: 'var(--text-dim)', label: 'paused' },
};

function AgentsKpiCard({ label, value, tone }) {
  const toneColor = tone === 'success' ? 'var(--success)' : tone === 'gold' ? 'var(--gold)' : tone === 'dim' ? 'var(--text-mute)' : 'var(--text)';
  return (
    <div className="card" style={{display:'flex', flexDirection:'column', gap:'var(--space-3)'}}>
      <div className="t-mono">{label}</div>
      <div className="t-h2" style={{color:toneColor, margin:0}}>{value}</div>
    </div>
  );
}

function AgentCard({ agent }) {
  const status = AGENT_STATUS_META[agent.status] || AGENT_STATUS_META.idle;
  return (
    <div className="card card-hover" style={{padding:0, overflow:'hidden'}}>
      <div style={{padding:'var(--space-4) var(--space-6)', display:'flex', alignItems:'flex-start', gap:'var(--space-3)'}}>
        <div style={{
          width:40, height:40, borderRadius:'var(--radius-md)',
          background:'var(--surface-2)', border:'1px solid var(--border)',
          display:'flex', alignItems:'center', justifyContent:'center',
          color:'var(--gold)', flexShrink:0,
        }}>
          <Icon name={agent.icon} size={18}/>
        </div>
        <div style={{flex:1, minWidth:0}}>
          <div style={{fontSize:16, fontWeight:600, letterSpacing:'-0.01em', marginBottom:4}}>{agent.name}</div>
          <div className="t-mono" style={{display:'inline-flex', alignItems:'center', gap:'var(--space-2)'}}>
            <span style={{width:6, height:6, borderRadius:999, background:status.color, display:'inline-block'}}/>
            {status.label} · {agent.trigger}
          </div>
        </div>
        <button type="button" aria-label="Agent actions" style={{
          all:'unset',
          padding:6, borderRadius:'var(--radius-sm)', color:'var(--text-dim)', cursor:'pointer',
        }}>
          <Icon name="more" size={15}/>
        </button>
      </div>
      <div style={{borderTop:'1px solid var(--border)', padding:'var(--space-4) var(--space-6)', color:'var(--text-mute)'}} className="t-sm">
        {agent.description}
      </div>
      <div style={{padding:'var(--space-3) var(--space-6)', borderTop:'1px solid var(--border)', display:'flex', alignItems:'center', gap:'var(--space-2)'}}>
        <span className="t-mono">{agent.runs} RUNS</span>
        <span style={{flex:1}}/>
        {agent.tools.map((tool) => (
          <span key={tool.name} className="label" style={{display:'inline-flex', alignItems:'center', gap:5}}>
            <Icon name={tool.icon} size={11}/>{tool.name}
          </span>
        ))}
      </div>
    </div>
  );
}

function ScreenAgents() {
  const [runPrompt, setRunPrompt] = React.useState('');
  const [allowServerMemoryAssembly, setAllowServerMemoryAssembly] = React.useState(true);
  const [playgroundOpen, setPlaygroundOpen] = React.useState(false);

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
    const payload = { target: 'agent_run', source: 'agents_playground', prompt };
    if (allowServerMemoryAssembly) {
      payload.memoryAssembly = { query: raw.slice(0, 480) || '', limit: 14, semantic: true };
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

  const runningCount = AGENTS_DEMO.filter((a) => a.status === 'running').length;
  const scheduledCount = AGENTS_DEMO.filter((a) => a.status === 'scheduled').length;
  const pausedCount = AGENTS_DEMO.filter((a) => a.status === 'paused').length;

  return (
    <div className="content-inner" style={{padding:'var(--space-8) var(--space-12) var(--space-12)', maxWidth:1280, margin:'0 auto'}}>
      {/* Header */}
      <div className="page-head">
        <div>
          <div className="t-mono" style={{marginBottom:'var(--space-2)'}}>EXECUTION LAYER</div>
          <h1>Agents</h1>
          <div className="sub">Agents that read your memory and act. {runningCount + scheduledCount + pausedCount + 8} MCP tools available.</div>
        </div>
        <div className="row" style={{gap:'var(--space-2)', flexWrap:'wrap'}}>
          <button type="button" className="btn btn-secondary" onClick={() => setPlaygroundOpen((v) => !v)}>
            <Icon name="terminal" size={14}/> MCP console
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setPlaygroundOpen(true)}>
            <Icon name="plus" size={14}/> New agent
          </button>
        </div>
      </div>

      {/* KPI row */}
      <div style={{display:'grid', gridTemplateColumns:'repeat(4, minmax(0, 1fr))', gap:'var(--space-4)', marginBottom:'var(--space-8)'}}>
        <AgentsKpiCard label="RUNNING" value={runningCount} tone="success"/>
        <AgentsKpiCard label="SCHEDULED" value={scheduledCount} tone="gold"/>
        <AgentsKpiCard label="PAUSED" value={pausedCount} tone="dim"/>
        <AgentsKpiCard label="TOOLS CONNECTED" value={20} tone="gold"/>
      </div>

      {/* Agents section */}
      <div style={{marginBottom:'var(--space-4)', color:'var(--text-mute)'}} className="t-sm">Your agents</div>
      <div style={{display:'grid', gridTemplateColumns:'repeat(2, minmax(0, 1fr))', gap:'var(--space-4)', marginBottom:'var(--space-8)'}}>
        {AGENTS_DEMO.map((a) => (
          <AgentCard key={a.id} agent={a}/>
        ))}
      </div>

      {/* Live activity */}
      <div style={{marginBottom:'var(--space-3)', color:'var(--text-mute)'}} className="t-sm">Live activity</div>
      <div className="card" style={{padding:0, overflow:'hidden'}}>
        {AGENTS_LIVE.map((row, i) => (
          <div key={i} style={{
            display:'grid', gridTemplateColumns:'120px 140px 1fr auto', columnGap:'var(--space-4)',
            alignItems:'center', padding:'var(--space-3) var(--space-6)',
            borderBottom: i < AGENTS_LIVE.length - 1 ? '1px solid var(--border)' : 'none',
          }} className="t-sm">
            <span className="t-mono">{row.t}</span>
            <span className="t-mono" style={{color:'var(--text-mute)'}}>{row.agent}</span>
            <span style={{color:'var(--text)', lineHeight:1.5}}>{row.msg}</span>
            <span
              className="label"
              style={{
                borderColor: row.level === 'success' ? 'color-mix(in srgb, var(--success) 60%, var(--border))' : 'var(--border)',
                color: row.level === 'success' ? 'var(--success)' : 'var(--text-mute)',
              }}
            >
              {row.level.toUpperCase()}
            </span>
          </div>
        ))}
      </div>

      {/* Playground drawer — kept for the memory-aware draft + chat flows */}
      {playgroundOpen && (
        <div className="card" style={{
          marginTop:'var(--space-8)',
          borderColor:'var(--gold-dim)',
        }}>
          <div style={{display:'flex', alignItems:'center', gap:10, marginBottom:14}}>
            <div className="t-mono" style={{fontSize:11, color:'var(--gold)', letterSpacing:'0.16em'}}>NEW AGENT · PLAYGROUND</div>
            <span style={{flex:1}}/>
            <button
              type="button"
              onClick={() => setPlaygroundOpen(false)}
              style={{all:'unset', padding:4, color:'var(--text-mute)', cursor:'pointer'}}
              aria-label="Close"
            >
              <Icon name="x" size={14}/>
            </button>
          </div>
          <textarea
            className="s-input"
            style={{
              width:'100%', minHeight:88, resize:'vertical',
              fontSize:14, fontFamily:'inherit',
              background:'var(--surface)', border:'1px solid var(--border-hi)',
              borderRadius:'var(--radius-md)', padding:12, color:'var(--text)',
              boxSizing:'border-box',
            }}
            placeholder="例: 今週のリスクを Memory から洗い出して / 投資家向けに1段落…"
            value={runPrompt}
            onChange={(e) => setRunPrompt(e.target.value)}
          />
          <div style={{display:'flex', gap:8, marginTop:12, flexWrap:'wrap'}}>
            <button className="btn btn-primary" type="button" onClick={draftWithMemory}>
              <Icon name="edit" size={14}/> Draft + Memory
            </button>
            <button className="btn btn-secondary" type="button" onClick={openChatWithMemory}>
              <Icon name="chat" size={14}/> Open in Chat
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

window.ScreenChat = ScreenChat;
window.ScreenAgents = ScreenAgents;

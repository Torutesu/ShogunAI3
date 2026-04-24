/* global Icon, Kamon, IntegrationLogo, React, ShogunIntegrationConnectors */

function runRuntimeAction(key, payload, options) {
  if (!window.SHOGUN_RUNTIME || !window.SHOGUN_RUNTIME.executeAction) return Promise.resolve({ ok:false });
  return window.SHOGUN_RUNTIME.executeAction(key, payload || {}, options || {});
}

// ═══════════════════════════════════════════════════════════════════════════
// L5 · WORK — workspace manager (projects/jobs carved out of memory context)
// ═══════════════════════════════════════════════════════════════════════════
function useWorkProjects() {
  const [projects, setProjects] = React.useState(() => {
    const get = window.SHOGUN_RUNTIME && window.SHOGUN_RUNTIME.getWorkProjects;
    return typeof get === 'function' ? get() : [];
  });
  React.useEffect(() => {
    const sync = () => {
      const get = window.SHOGUN_RUNTIME && window.SHOGUN_RUNTIME.getWorkProjects;
      if (typeof get === 'function') setProjects(get());
    };
    sync();
    window.addEventListener('shogun-work-projects-changed', sync);
    return () => window.removeEventListener('shogun-work-projects-changed', sync);
  }, []);
  return projects;
}

function ScreenWork() {
  const projects = useWorkProjects();
  const [showArchived, setShowArchived] = React.useState(false);
  const [newName, setNewName] = React.useState('');
  const [renaming, setRenaming] = React.useState({ id: null, value: '' });
  const [menuFor, setMenuFor] = React.useState(null);

  const visible = React.useMemo(
    () => projects.filter((p) => !!p.archived === showArchived),
    [projects, showArchived],
  );

  const createProject = React.useCallback(() => {
    const name = newName.trim();
    if (!name) return;
    const create = window.SHOGUN_RUNTIME && window.SHOGUN_RUNTIME.createWorkProject;
    if (typeof create === 'function') create(name);
    setNewName('');
  }, [newName]);

  const confirmRename = React.useCallback(() => {
    const id = renaming.id;
    const name = renaming.value.trim();
    if (!id || !name) {
      setRenaming({ id: null, value: '' });
      return;
    }
    const fn = window.SHOGUN_RUNTIME && window.SHOGUN_RUNTIME.renameWorkProject;
    if (typeof fn === 'function') fn(id, name);
    setRenaming({ id: null, value: '' });
  }, [renaming]);

  const archiveProject = React.useCallback((id, archived) => {
    const fn = window.SHOGUN_RUNTIME && window.SHOGUN_RUNTIME.archiveWorkProject;
    if (typeof fn === 'function') fn(id, !!archived);
    setMenuFor(null);
  }, []);

  const deleteProject = React.useCallback((id, name) => {
    const label = String(name || 'このWorkspace');
    const ok = typeof window.confirm === 'function'
      ? window.confirm(`「${label}」を削除しますか？\n関連するチャットは残ります。`)
      : true;
    if (!ok) return;
    const fn = window.SHOGUN_RUNTIME && window.SHOGUN_RUNTIME.deleteWorkProject;
    if (typeof fn === 'function') fn(id);
    setMenuFor(null);
  }, []);

  React.useEffect(() => {
    if (menuFor == null) return undefined;
    const onDocClick = () => setMenuFor(null);
    window.addEventListener('click', onDocClick);
    return () => window.removeEventListener('click', onDocClick);
  }, [menuFor]);

  return (
    <div className="content-inner">
      <div className="page-head">
        <div>
          <div className="t-mono" style={{marginBottom:8}}>OPERATIONS LAYER</div>
          <h1>Work <span className="jp">任務</span></h1>
          <div className="sub">
            <span className="en-only">Workspaces group your memory context by project or job.</span>
            <span className="jp">Workspace はメモリのコンテキストをプロジェクト / 仕事単位にまとめる器です。</span>
          </div>
        </div>
        <div className="row" style={{flexWrap:'wrap', gap:8, alignItems:'center'}}>
          <label className="row" style={{gap:6, alignItems:'center', fontSize:12, color:'var(--text-dim)', cursor:'pointer', userSelect:'none'}}>
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            <span>
              <span className="en-only">Show archived</span>
              <span className="jp">アーカイブを表示</span>
            </span>
          </label>
        </div>
      </div>

      <div className="card" style={{padding:16, marginBottom:18, display:'flex', gap:10, alignItems:'center', flexWrap:'wrap'}}>
        <Icon name="plus" size={14} className="gold"/>
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') createProject(); }}
          placeholder="New workspace name / 新規Workspace名"
          style={{
            flex:1, minWidth:200,
            padding:'8px 12px',
            borderRadius:8,
            border:'1px solid var(--border)',
            background:'var(--surface)',
            color:'var(--text)',
            fontSize:13,
            fontFamily:'inherit',
          }}
        />
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={createProject}
          disabled={!newName.trim()}
          style={!newName.trim() ? {opacity:0.5, cursor:'not-allowed'} : undefined}
        >
          <span className="en-only">Create</span>
          <span className="jp">作成</span>
        </button>
      </div>

      {visible.length === 0 ? (
        <div className="card" style={{padding:28, textAlign:'center'}}>
          <p style={{fontSize:14, color:'var(--text-mute)', margin:0, lineHeight:1.6}}>
            {showArchived ? (
              <>
                <span className="en-only">No archived workspaces.</span>
                <span className="jp">アーカイブ済みのWorkspaceはありません。</span>
              </>
            ) : (
              <>
                <span className="en-only">No workspaces yet. Create one above to start grouping memory context by project.</span>
                <span className="jp">Workspaceがまだありません。上のフォームから作成して、プロジェクト単位でコンテキストをまとめましょう。</span>
              </>
            )}
          </p>
        </div>
      ) : (
        <div className="shogun-grid-cards">
          {visible.map((p) => (
            <div key={p.id} className="card card-interactive" style={{padding:18, position:'relative'}}>
              <div className="row" style={{gap:8, marginBottom:10, flexWrap:'wrap', alignItems:'center'}}>
                <Icon name="work" size={14} className="gold"/>
                <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)'}}>WORKSPACE</span>
                {p.archived && (
                  <span className="label" style={{fontSize:10, borderColor:'var(--border-hi)', color:'var(--text-mute)'}}>
                    <span className="en-only">Archived</span>
                    <span className="jp">アーカイブ済み</span>
                  </span>
                )}
                <span style={{flex:1}}/>
                <button
                  type="button"
                  aria-label="More actions"
                  onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === p.id ? null : p.id); }}
                  style={{
                    display:'inline-flex', alignItems:'center', justifyContent:'center',
                    width:26, height:26, padding:0,
                    border:'1px solid transparent', borderRadius:8,
                    background:'transparent', color:'var(--text-mute)', cursor:'pointer',
                  }}
                >
                  <Icon name="more" size={14}/>
                </button>
                {menuFor === p.id && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      position:'absolute', top:44, right:14, zIndex:5,
                      minWidth:180,
                      background:'var(--surface)',
                      border:'1px solid var(--border-hi)',
                      borderRadius:10,
                      boxShadow:'0 10px 30px -8px rgba(0,0,0,0.5)',
                      padding:4,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => { setRenaming({ id: p.id, value: p.name || '' }); setMenuFor(null); }}
                      style={{display:'block', width:'100%', textAlign:'left', padding:'8px 10px', border:0, background:'transparent', color:'var(--text)', fontSize:12, cursor:'pointer', borderRadius:6}}
                    >
                      <span className="en-only">Rename</span>
                      <span className="jp">名前を変更</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => archiveProject(p.id, !p.archived)}
                      style={{display:'block', width:'100%', textAlign:'left', padding:'8px 10px', border:0, background:'transparent', color:'var(--text)', fontSize:12, cursor:'pointer', borderRadius:6}}
                    >
                      {p.archived ? (
                        <>
                          <span className="en-only">Unarchive</span>
                          <span className="jp">復元</span>
                        </>
                      ) : (
                        <>
                          <span className="en-only">Archive</span>
                          <span className="jp">アーカイブ</span>
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteProject(p.id, p.name)}
                      style={{display:'block', width:'100%', textAlign:'left', padding:'8px 10px', border:0, background:'transparent', color:'var(--danger)', fontSize:12, cursor:'pointer', borderRadius:6}}
                    >
                      <span className="en-only">Delete</span>
                      <span className="jp">削除</span>
                    </button>
                  </div>
                )}
              </div>

              {renaming.id === p.id ? (
                <div className="row" style={{gap:8, alignItems:'center'}}>
                  <input
                    autoFocus
                    type="text"
                    value={renaming.value}
                    onChange={(e) => setRenaming({ id: p.id, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') confirmRename();
                      else if (e.key === 'Escape') setRenaming({ id: null, value: '' });
                    }}
                    style={{
                      flex:1,
                      padding:'6px 10px',
                      borderRadius:8,
                      border:'1px solid var(--border-hi)',
                      background:'var(--bg)',
                      color:'var(--text)',
                      fontSize:15,
                      fontFamily:'inherit',
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    onClick={confirmRename}
                  >
                    OK
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => setRenaming({ id: null, value: '' })}
                  >
                    <Icon name="x" size={12}/>
                  </button>
                </div>
              ) : (
                <div style={{fontSize:16, fontWeight:500, lineHeight:1.3}}>
                  {p.name || <span style={{color:'var(--text-dim)'}}>Untitled</span>}
                </div>
              )}

              <div style={{fontSize:11, color:'var(--text-dim)', marginTop:10, lineHeight:1.5}}>
                <span className="en-only">Context assignment coming in a later phase.</span>
                <span className="jp">コンテキスト割当は次フェーズ対応予定。</span>
              </div>
            </div>
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
  const [gmailCred, setGmailCred] = React.useState(false);
  const [gmailRefresh, setGmailRefresh] = React.useState(false);
  const [slackCred, setSlackCred] = React.useState(false);
  const [notionCred, setNotionCred] = React.useState(false);
  const [githubCred, setGithubCred] = React.useState(false);
  const [linearCred, setLinearCred] = React.useState(false);
  const [calHistDays, setCalHistDays] = React.useState(null);
  const [gmailHistDays, setGmailHistDays] = React.useState(null);
  const [slackHistDays, setSlackHistDays] = React.useState(null);
  const [notionHistDays, setNotionHistDays] = React.useState(null);
  const [githubHistDays, setGithubHistDays] = React.useState(null);
  const [linearHistDays, setLinearHistDays] = React.useState(null);
  // Per-provider auto-sync toggle. Backend reads
  // `sections.integrations.<provider>AutoSync`.
  const [autoSync, setAutoSync] = React.useState({
    gmail: false,
    slack: false,
    notion: false,
    github: false,
    linear: false,
  });
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
  const refreshGmailStatus = React.useCallback(() => {
    return runRuntimeAction('integrations.credentials_status', { provider:'gmail' }, { silentError:true }).then((res) => {
      if (res.ok && res.data) {
        setGmailCred(!!res.data.configured);
        setGmailRefresh(!!res.data.tokenRefreshReady);
      }
      return res;
    });
  }, []);
  const refreshSlackStatus = React.useCallback(() => {
    return runRuntimeAction('integrations.credentials_status', { provider:'slack' }, { silentError:true }).then((res) => {
      if (res.ok && res.data) {
        setSlackCred(!!res.data.configured);
      }
      return res;
    });
  }, []);
  const refreshNotionStatus = React.useCallback(() => {
    return runRuntimeAction('integrations.credentials_status', { provider:'notion' }, { silentError:true }).then((res) => {
      if (res.ok && res.data) {
        setNotionCred(!!res.data.configured);
      }
      return res;
    });
  }, []);
  const toggleAutoSync = React.useCallback((provider, next) => {
    setAutoSync((prev) => ({ ...prev, [provider]: next }));
    const key = `${provider}AutoSync`;
    return runRuntimeAction(
      'settings.save',
      { section: 'integrations', [key]: next },
      { silentError: true },
    );
  }, []);
  const refreshGithubStatus = React.useCallback(() => {
    return runRuntimeAction('integrations.credentials_status', { provider:'github' }, { silentError:true }).then((res) => {
      if (res.ok && res.data) {
        setGithubCred(!!res.data.configured);
      }
      return res;
    });
  }, []);
  const refreshLinearStatus = React.useCallback(() => {
    return runRuntimeAction('integrations.credentials_status', { provider:'linear' }, { silentError:true }).then((res) => {
      if (res.ok && res.data) {
        setLinearCred(!!res.data.configured);
      }
      return res;
    });
  }, []);
  const refreshHistSettings = React.useCallback(() => {
    return runRuntimeAction('settings.load', {}, { silentError:true }).then((res) => {
      const sec = res && res.ok && res.data && res.data.settings && res.data.settings.sections;
      if (sec) {
        const g = sec.gmail && typeof sec.gmail === 'object' ? sec.gmail.historicalSyncDays : null;
        const c = sec.google_calendar && typeof sec.google_calendar === 'object' ? sec.google_calendar.historicalSyncDays : null;
        const s = sec.slack && typeof sec.slack === 'object' ? sec.slack.historicalSyncDays : null;
        const n = sec.notion && typeof sec.notion === 'object' ? sec.notion.historicalSyncDays : null;
        const gh = sec.github && typeof sec.github === 'object' ? sec.github.historicalSyncDays : null;
        const li = sec.linear && typeof sec.linear === 'object' ? sec.linear.historicalSyncDays : null;
        setGmailHistDays(Number.isFinite(Number(g)) ? Number(g) : null);
        setCalHistDays(Number.isFinite(Number(c)) ? Number(c) : null);
        setSlackHistDays(Number.isFinite(Number(s)) ? Number(s) : null);
        setNotionHistDays(Number.isFinite(Number(n)) ? Number(n) : null);
        setGithubHistDays(Number.isFinite(Number(gh)) ? Number(gh) : null);
        setLinearHistDays(Number.isFinite(Number(li)) ? Number(li) : null);
        const integ = sec.integrations && typeof sec.integrations === 'object' ? sec.integrations : {};
        setAutoSync({
          gmail: !!integ.gmailAutoSync,
          slack: !!integ.slackAutoSync,
          notion: !!integ.notionAutoSync,
          github: !!integ.githubAutoSync,
          linear: !!integ.linearAutoSync,
        });
      }
      return res;
    });
  }, []);
  React.useEffect(() => {
    refreshCalStatus();
    refreshGmailStatus();
    refreshSlackStatus();
    refreshNotionStatus();
    refreshGithubStatus();
    refreshLinearStatus();
    refreshHistSettings();
  }, [refreshCalStatus, refreshGmailStatus, refreshSlackStatus, refreshNotionStatus, refreshGithubStatus, refreshLinearStatus, refreshHistSettings]);
  React.useEffect(() => {
    const onCred = () => {
      void refreshCalStatus();
      void refreshGmailStatus();
      void refreshSlackStatus();
      void refreshNotionStatus();
      void refreshGithubStatus();
      void refreshLinearStatus();
      void refreshHistSettings();
      const C = window.ShogunIntegrationConnectors;
      if (C && typeof C.hydrateTools === 'function') {
        setTools(C.hydrateTools(C.DEFAULT_GRID_TOOLS));
      }
    };
    window.addEventListener('shogun-credentials-updated', onCred);
    return () => window.removeEventListener('shogun-credentials-updated', onCred);
  }, [refreshCalStatus, refreshGmailStatus, refreshSlackStatus, refreshNotionStatus, refreshGithubStatus, refreshLinearStatus, refreshHistSettings]);
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

      <div className="card" style={{padding:20, marginTop:20, borderColor:'var(--border-hi)'}}>
        <div className="t-mono" style={{marginBottom:8}}>HISTORICAL IMPORT</div>
        <div style={{fontSize:13, color:'var(--text-mute)', lineHeight:1.6, marginBottom:14}}>
          Pull past data from connected Gmail / Google Calendar into Memory. Up to 1 year. Re-running an import may create duplicates.
        </div>

        <div className="row" style={{gap:10, flexWrap:'wrap', alignItems:'center', marginBottom:10}}>
          <span style={{fontSize:13, minWidth:120}}>Google Calendar</span>
          {calCred ? (
            <span className="label label-success" style={{fontSize:11}}>Connected</span>
          ) : (
            <span className="label" style={{fontSize:11, opacity:0.7}}>Not connected</span>
          )}
          {calHistDays != null && calHistDays > 0 ? (
            <span className="label" style={{fontSize:11}}>Last imported: past {calHistDays}d</span>
          ) : calHistDays === 0 ? (
            <span className="label" style={{fontSize:11, opacity:0.7}}>Skipped previously</span>
          ) : null}
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={!calCred}
            style={!calCred ? {opacity:0.5, cursor:'not-allowed'} : undefined}
            onClick={() => {
              const rt = window.SHOGUN_RUNTIME;
              if (rt && typeof rt.openHistoricalImport === 'function') {
                rt.openHistoricalImport('google_calendar', calHistDays && calHistDays > 0 ? calHistDays : 30);
              }
            }}
          >
            {calHistDays != null ? 'Re-sync past…' : 'Import past…'}
          </button>
        </div>

        <div className="row" style={{gap:10, flexWrap:'wrap', alignItems:'center'}}>
          <span style={{fontSize:13, minWidth:120}}>Gmail</span>
          {gmailCred ? (
            <span className="label label-success" style={{fontSize:11}}>Connected</span>
          ) : (
            <span className="label" style={{fontSize:11, opacity:0.7}}>Not connected</span>
          )}
          {gmailCred && gmailRefresh ? (
            <span className="label label-success" style={{fontSize:11}}>Auto-refresh ready</span>
          ) : null}
          {gmailHistDays != null && gmailHistDays > 0 ? (
            <span className="label" style={{fontSize:11}}>Last imported: past {gmailHistDays}d</span>
          ) : gmailHistDays === 0 ? (
            <span className="label" style={{fontSize:11, opacity:0.7}}>Skipped previously</span>
          ) : null}
          {gmailCred && gmailHistDays != null && gmailHistDays > 0 && (
            <label className="row" style={{gap:6, alignItems:'center', fontSize:11, color:'var(--text-dim)', cursor:'pointer', userSelect:'none'}}>
              <input
                type="checkbox"
                checked={!!autoSync.gmail}
                onChange={(e) => { void toggleAutoSync('gmail', e.target.checked); }}
              />
              <span>Auto-sync</span>
            </label>
          )}
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={!gmailCred}
            style={!gmailCred ? {opacity:0.5, cursor:'not-allowed'} : undefined}
            onClick={() => {
              const rt = window.SHOGUN_RUNTIME;
              if (rt && typeof rt.openHistoricalImport === 'function') {
                rt.openHistoricalImport('gmail', gmailHistDays && gmailHistDays > 0 ? gmailHistDays : 30);
              }
            }}
          >
            {gmailHistDays != null ? 'Re-sync past…' : 'Import past…'}
          </button>
        </div>

        <div className="row" style={{gap:10, flexWrap:'wrap', alignItems:'center', marginTop:10}}>
          <span style={{fontSize:13, minWidth:120}}>Slack</span>
          {slackCred ? (
            <span className="label label-success" style={{fontSize:11}}>Connected</span>
          ) : (
            <span className="label" style={{fontSize:11, opacity:0.7}}>Not connected</span>
          )}
          {slackHistDays != null && slackHistDays > 0 ? (
            <span className="label" style={{fontSize:11}}>Last imported: past {slackHistDays}d</span>
          ) : slackHistDays === 0 ? (
            <span className="label" style={{fontSize:11, opacity:0.7}}>Skipped previously</span>
          ) : null}
          {!slackCred && (
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => {
                const rt = window.SHOGUN_RUNTIME;
                if (rt && typeof rt.openPasteToken === 'function') {
                  rt.openPasteToken('slack');
                }
              }}
            >
              Paste token…
            </button>
          )}
          {slackCred && slackHistDays != null && slackHistDays > 0 && (
            <label className="row" style={{gap:6, alignItems:'center', fontSize:11, color:'var(--text-dim)', cursor:'pointer', userSelect:'none'}}>
              <input
                type="checkbox"
                checked={!!autoSync.slack}
                onChange={(e) => { void toggleAutoSync('slack', e.target.checked); }}
              />
              <span>Auto-sync</span>
            </label>
          )}
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={!slackCred}
            style={!slackCred ? {opacity:0.5, cursor:'not-allowed'} : undefined}
            onClick={() => {
              const rt = window.SHOGUN_RUNTIME;
              if (rt && typeof rt.openHistoricalImport === 'function') {
                rt.openHistoricalImport('slack', slackHistDays && slackHistDays > 0 ? slackHistDays : 30);
              }
            }}
          >
            {slackHistDays != null ? 'Re-sync past…' : 'Import past…'}
          </button>
        </div>

        <div className="row" style={{gap:10, flexWrap:'wrap', alignItems:'center', marginTop:10}}>
          <span style={{fontSize:13, minWidth:120}}>Notion</span>
          {notionCred ? (
            <span className="label label-success" style={{fontSize:11}}>Connected</span>
          ) : (
            <span className="label" style={{fontSize:11, opacity:0.7}}>Not connected</span>
          )}
          {notionHistDays != null && notionHistDays > 0 ? (
            <span className="label" style={{fontSize:11}}>Last imported: past {notionHistDays}d</span>
          ) : notionHistDays === 0 ? (
            <span className="label" style={{fontSize:11, opacity:0.7}}>Skipped previously</span>
          ) : null}
          {!notionCred && (
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => {
                const rt = window.SHOGUN_RUNTIME;
                if (rt && typeof rt.openPasteToken === 'function') {
                  rt.openPasteToken('notion');
                }
              }}
            >
              Paste token…
            </button>
          )}
          {notionCred && notionHistDays != null && notionHistDays > 0 && (
            <label className="row" style={{gap:6, alignItems:'center', fontSize:11, color:'var(--text-dim)', cursor:'pointer', userSelect:'none'}}>
              <input
                type="checkbox"
                checked={!!autoSync.notion}
                onChange={(e) => { void toggleAutoSync('notion', e.target.checked); }}
              />
              <span>Auto-sync</span>
            </label>
          )}
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={!notionCred}
            style={!notionCred ? {opacity:0.5, cursor:'not-allowed'} : undefined}
            onClick={() => {
              const rt = window.SHOGUN_RUNTIME;
              if (rt && typeof rt.openHistoricalImport === 'function') {
                rt.openHistoricalImport('notion', notionHistDays && notionHistDays > 0 ? notionHistDays : 30);
              }
            }}
          >
            {notionHistDays != null ? 'Re-sync past…' : 'Import past…'}
          </button>
        </div>

        <div className="row" style={{gap:10, flexWrap:'wrap', alignItems:'center', marginTop:10}}>
          <span style={{fontSize:13, minWidth:120}}>GitHub</span>
          {githubCred ? (
            <span className="label label-success" style={{fontSize:11}}>Connected</span>
          ) : (
            <span className="label" style={{fontSize:11, opacity:0.7}}>Not connected</span>
          )}
          {githubHistDays != null && githubHistDays > 0 ? (
            <span className="label" style={{fontSize:11}}>Last imported: past {githubHistDays}d</span>
          ) : githubHistDays === 0 ? (
            <span className="label" style={{fontSize:11, opacity:0.7}}>Skipped previously</span>
          ) : null}
          {!githubCred && (
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => {
                const rt = window.SHOGUN_RUNTIME;
                if (rt && typeof rt.openPasteToken === 'function') {
                  rt.openPasteToken('github');
                }
              }}
            >
              Paste token…
            </button>
          )}
          {githubCred && githubHistDays != null && githubHistDays > 0 && (
            <label className="row" style={{gap:6, alignItems:'center', fontSize:11, color:'var(--text-dim)', cursor:'pointer', userSelect:'none'}}>
              <input
                type="checkbox"
                checked={!!autoSync.github}
                onChange={(e) => { void toggleAutoSync('github', e.target.checked); }}
              />
              <span>Auto-sync</span>
            </label>
          )}
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={!githubCred}
            style={!githubCred ? {opacity:0.5, cursor:'not-allowed'} : undefined}
            onClick={() => {
              const rt = window.SHOGUN_RUNTIME;
              if (rt && typeof rt.openHistoricalImport === 'function') {
                rt.openHistoricalImport('github', githubHistDays && githubHistDays > 0 ? githubHistDays : 30);
              }
            }}
          >
            {githubHistDays != null ? 'Re-sync past…' : 'Import past…'}
          </button>
        </div>

        <div className="row" style={{gap:10, flexWrap:'wrap', alignItems:'center', marginTop:10}}>
          <span style={{fontSize:13, minWidth:120}}>Linear</span>
          {linearCred ? (
            <span className="label label-success" style={{fontSize:11}}>Connected</span>
          ) : (
            <span className="label" style={{fontSize:11, opacity:0.7}}>Not connected</span>
          )}
          {linearHistDays != null && linearHistDays > 0 ? (
            <span className="label" style={{fontSize:11}}>Last imported: past {linearHistDays}d</span>
          ) : linearHistDays === 0 ? (
            <span className="label" style={{fontSize:11, opacity:0.7}}>Skipped previously</span>
          ) : null}
          {!linearCred && (
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => {
                const rt = window.SHOGUN_RUNTIME;
                if (rt && typeof rt.openPasteToken === 'function') {
                  rt.openPasteToken('linear');
                }
              }}
            >
              Paste token…
            </button>
          )}
          {linearCred && linearHistDays != null && linearHistDays > 0 && (
            <label className="row" style={{gap:6, alignItems:'center', fontSize:11, color:'var(--text-dim)', cursor:'pointer', userSelect:'none'}}>
              <input
                type="checkbox"
                checked={!!autoSync.linear}
                onChange={(e) => { void toggleAutoSync('linear', e.target.checked); }}
              />
              <span>Auto-sync</span>
            </label>
          )}
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={!linearCred}
            style={!linearCred ? {opacity:0.5, cursor:'not-allowed'} : undefined}
            onClick={() => {
              const rt = window.SHOGUN_RUNTIME;
              if (rt && typeof rt.openHistoricalImport === 'function') {
                rt.openHistoricalImport('linear', linearHistDays && linearHistDays > 0 ? linearHistDays : 30);
              }
            }}
          >
            {linearHistDays != null ? 'Re-sync past…' : 'Import past…'}
          </button>
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

window.ScreenWork = ScreenWork;
window.ScreenCapture = ScreenCapture;
window.ScreenIntegrations = ScreenIntegrations;
window.ScreenSettings = ScreenSettings;

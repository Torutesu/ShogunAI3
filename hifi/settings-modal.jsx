/* global Icon, Kamon, React */
const { useState: useStateS } = React;

const SETTINGS_NAV = [
  {id:'general',      label:'General',            jp:'一般', icon:'settings'},
  {id:'system',       label:'System',             jp:'系統', icon:'terminal'},
  {id:'appearance',   label:'Appearance',         jp:'外観', icon:'eye'},
  {id:'privacy',      label:'Privacy Controls',   jp:'守秘', icon:'shield'},
  {id:'data',         label:'Data Controls',      jp:'資料', icon:'memory'},
  {id:'hummingbird',  label:'Hummingbird',        jp:'鳥',   icon:'zap'},
  {id:'meetings',     label:'Meetings',           jp:'会議', icon:'calendar'},
  {id:'brief',        label:'Morning Brief',      jp:'朝礼', icon:'note'},
  {id:'chat',         label:'Chat',               jp:'対話', icon:'chat'},
  {id:'llm',          label:'Model & API',        jp:'モデル', icon:'key'},
  {id:'integrations', label:'Integrations',       jp:'連携', icon:'plug'},
  {id:'shortcuts',    label:'Keyboard Shortcuts', jp:'捷径', icon:'keyboard'},
  {id:'subscription', label:'Subscription',       jp:'契約', icon:'gift'},
  {id:'team',         label:'Team',               jp:'組',   icon:'users'},
  {id:'support',      label:'Support',            jp:'支援', icon:'info'},
];

// Alias panes from quick menu to the canonical settings panes
const PANE_ALIAS = {
  upgrade:'subscription', feedback:'support', download:'general',
  referral:'subscription', changelog:'general', api:'llm',
};

function Toggle({on, onClick}) {
  return (
    <div onClick={onClick} className="s-toggle" data-on={on?'1':'0'}>
      <div className="s-toggle-knob"/>
    </div>
  );
}

function Row({title, desc, children, last}) {
  return (
    <div className={'s-row' + (last?' last':'')}>
      <div style={{flex:1, minWidth:0}}>
        <div className="s-row-title">{title}</div>
        {desc && <div className="s-row-desc">{desc}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Field({label, children, hint}) {
  return (
    <div style={{marginBottom:18}}>
      <div className="s-field-label">{label}</div>
      {children}
      {hint && <div className="s-field-hint">{hint}</div>}
    </div>
  );
}

/** After a successful appearance save, live-apply tokens in `app.jsx` without closing the modal. */
function scheduleAppearanceLive(run, appearance) {
  void run(
    'settings.save',
    { section: 'appearance', ...appearance },
    { silentError: true },
  ).then((res) => {
    if (res && res.ok) {
      window.dispatchEvent(
        new CustomEvent('shogun-appearance-changed', { detail: { appearance } }),
      );
    }
  });
}

function useRuntimeActions() {
  const run = async (key, payload, options) => {
    if (!window.SHOGUN_RUNTIME || !window.SHOGUN_RUNTIME.executeAction) return { ok:false };
    return window.SHOGUN_RUNTIME.executeAction(key, payload, options || {});
  };
  const confirmWrite = (key, payload, title, description) => {
    if (!window.SHOGUN_RUNTIME || !window.SHOGUN_RUNTIME.requestWriteAction) return;
    window.SHOGUN_RUNTIME.requestWriteAction(key, payload, title, description);
  };
  const toast = (message, kind) => {
    if (window.SHOGUN_RUNTIME && window.SHOGUN_RUNTIME.pushToast) {
      window.SHOGUN_RUNTIME.pushToast(message, kind || 'info');
    }
  };
  return { run, confirmWrite, toast };
}

/** Sections map from `app_settings_load` → `settings.sections`; consumed by settings panes. */
const SettingsHydrationContext = React.createContext({ sections: {}, refreshSections: null });

function Pane({title, jp, children, subtitle}) {
  return (
    <div className="s-pane">
      <div className="s-pane-head">
        <h2 style={{margin:0, fontSize:22, fontWeight:500, letterSpacing:'-0.01em'}}>
          {title}
          <span className="jp" style={{fontSize:14, marginLeft:10, color:'var(--text-dim)', fontWeight:300}}>{jp}</span>
        </h2>
        {subtitle && <div className="s-pane-sub">{subtitle}</div>}
      </div>
      <div className="s-pane-body">{children}</div>
    </div>
  );
}

function PaneGeneral() {
  const { run, toast } = useRuntimeActions();
  const { sections } = React.useContext(SettingsHydrationContext);
  const [name, setName] = useStateS('Toru Tano');
  const [aliases, setAliases] = useStateS('torubj0904@gmail.com, @toru, toru.t');
  const [email, setEmail] = useStateS('torubj0904@gmail.com');
  const [clerkState, setClerkState] = useStateS({ enabled: false, signedIn: false, label: '' });
  React.useEffect(() => {
    const g = sections.general;
    if (!g || typeof g !== 'object') return;
    if (g.name != null) setName(String(g.name));
    if (g.aliases != null) setAliases(String(g.aliases));
    if (g.email != null) setEmail(String(g.email));
  }, [sections]);
  React.useEffect(() => {
    const refresh = async () => {
      const exec = window.SHOGUN_RUNTIME && window.SHOGUN_RUNTIME.executeAction;
      const r = exec ? await exec('auth.status', {}, { silentError: true }) : { ok: false };
      const enabled = !!(r.ok && r.data && r.data.clerk && r.data.clerk.enabled);
      const snap = r.ok && r.data && r.data.snapshot && typeof r.data.snapshot === 'object' ? r.data.snapshot : null;
      const auth = window.ShogunClerkAuth;
      const u = auth && typeof auth.getClerkUser === 'function' ? auth.getClerkUser() : null;
      const signedIn = !!(u || (auth && typeof auth.isSignedIn === 'function' && auth.isSignedIn()));
      const emailPart =
        (u && u.primaryEmailAddress && u.primaryEmailAddress.emailAddress) ||
        (snap && snap.primaryEmail) ||
        '';
      const namePart = (u && (u.fullName || u.username)) || (snap && snap.displayName) || '';
      const label =
        namePart && emailPart ? `${namePart} · ${emailPart}` : emailPart || namePart || (signedIn ? 'Signed in' : '');
      setClerkState({ enabled, signedIn, label });
    };
    const t = window.setTimeout(() => void refresh(), 0);
    const onCh = () => void refresh();
    window.addEventListener('shogun-clerk-auth-changed', onCh);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('shogun-clerk-auth-changed', onCh);
    };
  }, []);
  return (
    <Pane title="General" jp="一般">
      <Field
        label="Clerk account"
        hint="Free tier: sign in with email, Google, etc. (in-app overlay). Add your dev URL and shogun-ai:// under Clerk → Redirect URLs if OAuth redirects fail; the app may fall back to the system browser. For Touch ID / Face ID on this device without a paid Clerk plan, use Privacy → Biometric app lock."
      >
        {!clerkState.enabled && (
          <div className="s-field-hint" style={{ marginTop: 0 }}>
            Clerk is not configured. Set CLERK_PUBLISHABLE_KEY and CLERK_FRONTEND_API in a .env file at the project root
            (see .env.example).
          </div>
        )}
        {clerkState.enabled && !clerkState.signedIn && (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button
              className="btn btn-sm btn-secondary"
              type="button"
              onClick={() =>
                run('auth.clerk_sign_in', {}, { successMessage: 'サインインを表示しました' })
              }
            >
              <Icon name="key" size={12} />
              Sign in
            </button>
            <button
              className="btn btn-sm btn-ghost"
              type="button"
              onClick={() =>
                run('auth.clerk_sign_up', {}, { successMessage: 'サインアップを表示しました' })
              }
            >
              Sign up
            </button>
          </div>
        )}
        {clerkState.enabled && clerkState.signedIn && (
          <div className="s-meta" style={{ marginTop: 0 }}>
            <div style={{ fontSize: 14, color: 'var(--text)' }}>{clerkState.label || 'Signed in'}</div>
          </div>
        )}
      </Field>
      <Field label="What should SHOGUN call you?">
        <input className="s-input" value={name} onChange={e=>setName(e.target.value)}/>
      </Field>
      <Field label="Aliases" hint="Include your nicknames, online handles, and other identifiers, separated by commas">
        <input className="s-input" value={aliases} onChange={e=>setAliases(e.target.value)}/>
      </Field>
      <Field label="Email">
        <div className="row" style={{gap:8}}>
          <input className="s-input" value={email} onChange={e=>setEmail(e.target.value)} style={{flex:1}}/>
          <button className="btn btn-sm btn-secondary" onClick={()=>run('settings.save', { section:'general', name, aliases, email }, { successMessage:'Profile updated' })}><Icon name="edit" size={12}/></button>
        </div>
      </Field>
      <div className="s-meta">
        <div style={{fontSize:13, color:'var(--text)'}}>SHOGUN v0.4.1 <span className="label label-gold" style={{marginLeft:6}}>Stable</span></div>
        <div className="s-field-hint" style={{marginTop:4}}>You are on the latest version · Channel: Stable</div>
        <div className="s-field-hint">Runtime: local · MLX 0.18.2 · Node 22.11</div>
      </div>
      <button
        className="btn btn-secondary"
        style={{ marginTop: 20 }}
        type="button"
        onClick={async () => {
          const r = await run('auth.clerk_sign_out', {}, { successMessage: 'Signed out' });
          if (!r.ok) toast(r.error?.message || 'Sign out failed', 'error');
        }}
      >
        <Icon name="logout" size={12} />
        Sign Out
      </button>
    </Pane>
  );
}

function PaneSystem() {
  const { run } = useRuntimeActions();
  const { sections } = React.useContext(SettingsHydrationContext);
  const [startup, setStartup] = useStateS(true);
  const [notif, setNotif] = useStateS(true);
  const [sound, setSound] = useStateS(false);
  const [timeFormat, setTimeFormat] = useStateS('24-hour');
  const [showAppIn, setShowAppIn] = useStateS('Dock and Menu Bar');
  const persist = (patch) => run('settings.save', { section:'system', startup, notif, sound, timeFormat, showAppIn, ...patch }, { silentError:true });
  React.useEffect(() => {
    const s = sections.system;
    if (!s || typeof s !== 'object') return;
    if (typeof s.startup === 'boolean') setStartup(s.startup);
    if (typeof s.notif === 'boolean') setNotif(s.notif);
    if (typeof s.sound === 'boolean') setSound(s.sound);
    if (s.timeFormat != null) setTimeFormat(String(s.timeFormat));
    if (s.showAppIn != null) setShowAppIn(String(s.showAppIn));
  }, [sections]);
  return (
    <Pane title="System" jp="系統">
      <div className="s-card">
        <Row title="Launch SHOGUN on startup" desc="Automatically start SHOGUN when you log in to your computer">
          <Toggle on={startup} onClick={()=>{ const next = !startup; setStartup(next); persist({ startup: next }); }}/>
        </Row>
        <Row title="Notifications" desc="Show SHOGUN notifications">
          <Toggle on={notif} onClick={()=>{ const next = !notif; setNotif(next); persist({ notif: next }); }}/>
        </Row>
        <Row title="Notification Sound" desc="Play a sound for notifications like meeting reminders and more">
          <Toggle on={sound} onClick={()=>{ const next = !sound; setSound(next); persist({ sound: next }); }}/>
        </Row>
        <Row title="Time Format" desc="How times are displayed throughout the app">
          <select className="s-select" value={timeFormat} onChange={(e)=>{ const v = e.target.value; setTimeFormat(v); run('settings.save', { section:'system', startup, notif, sound, timeFormat: v, showAppIn }, { silentError:true }); }}>
            <option value="24-hour">24-hour</option>
            <option value="12-hour">12-hour</option>
          </select>
        </Row>
        <Row title="Show App In" desc="Control the visibility of the app when closed" last>
          <select className="s-select" value={showAppIn} onChange={(e)=>{ const v = e.target.value; setShowAppIn(v); run('settings.save', { section:'system', startup, notif, sound, timeFormat, showAppIn: v }, { silentError:true }); }}>
            <option value="Dock and Menu Bar">Dock and Menu Bar</option>
            <option value="Menu Bar only">Menu Bar only</option>
            <option value="Dock only">Dock only</option>
          </select>
        </Row>
      </div>
    </Pane>
  );
}

function PaneAppearance() {
  const { run } = useRuntimeActions();
  const { sections } = React.useContext(SettingsHydrationContext);
  const [mode, setMode] = useStateS('dark');
  const [wide, setWide] = useStateS(false);
  const [wrap, setWrap] = useStateS(true);
  const [fontSize, setFontSize] = useStateS('Normal');
  React.useEffect(() => {
    const a = sections.appearance;
    if (!a || typeof a !== 'object') return;
    if (a.colorMode != null) setMode(String(a.colorMode));
    if (typeof a.extraWideChat === 'boolean') setWide(a.extraWideChat);
    if (typeof a.codeBlockWrap === 'boolean') setWrap(a.codeBlockWrap);
    if (a.fontSize != null) setFontSize(String(a.fontSize));
  }, [sections]);
  return (
    <Pane title="Appearance" jp="外観">
      <div className="s-field-label" style={{marginBottom:10}}>Color Mode</div>
      <div style={{display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:14, marginBottom:24}}>
        {[['light','Light'],['dark','Dark'],['auto','Match System']].map(([k,l])=>(
          <div key={k} onClick={()=>{ setMode(k); scheduleAppearanceLive(run, { colorMode: k, extraWideChat: wide, codeBlockWrap: wrap, fontSize }); }} className={'s-color-card '+(mode===k?'active':'')}>
            <div className="s-color-preview" data-mode={k}>
              <div className="s-color-bar"><span/><span/><span/></div>
              <div className="s-color-title">What's on your mind?</div>
              <div className="s-color-input"/>
            </div>
            <div style={{marginTop:8, fontSize:12, textAlign:'center', color: mode===k?'var(--gold)':'var(--text-mute)'}}>{l}</div>
          </div>
        ))}
      </div>
      <div className="s-card">
        <Row title="Extra Wide Chat" desc="Choose whether to make the chat extra wide">
          <Toggle on={wide} onClick={()=>{ const next = !wide; setWide(next); scheduleAppearanceLive(run, { colorMode: mode, extraWideChat: next, codeBlockWrap: wrap, fontSize }); }}/>
        </Row>
        <Row title="Font Size" desc="Adjust the size of text across the app">
          <select className="s-select" value={fontSize} onChange={(e)=>{ const v = e.target.value; setFontSize(v); scheduleAppearanceLive(run, { colorMode: mode, extraWideChat: wide, codeBlockWrap: wrap, fontSize: v }); }}>
            <option value="Normal">Normal</option>
            <option value="Compact">Compact</option>
            <option value="Comfortable">Comfortable</option>
          </select>
        </Row>
        <Row title="Code Block Wrapping" desc="Enable or disable code block wrapping" last>
          <Toggle on={wrap} onClick={()=>{ const next = !wrap; setWrap(next); scheduleAppearanceLive(run, { colorMode: mode, extraWideChat: wide, codeBlockWrap: next, fontSize }); }}/>
        </Row>
      </div>
    </Pane>
  );
}

function PanePrivacy() {
  const { run, toast } = useRuntimeActions();
  const { sections, refreshSections } = React.useContext(SettingsHydrationContext);
  const secSecurity = sections.security && typeof sections.security === 'object' ? sections.security : {};
  const [tab, setTab] = useStateS('apps');
  const [apps, setApps] = useStateS([
    {name:'Finder', icon:'📁', on:true},
    {name:'1Password', icon:'🔐', on:true},
    {name:'Banking', icon:'🏦', on:true},
  ]);
  const [bioLock, setBioLock] = useStateS(!!secSecurity.biometricLockEnabled);
  const [bioStatus, setBioStatus] = useStateS(null);
  React.useEffect(() => {
    setBioLock(!!secSecurity.biometricLockEnabled);
  }, [secSecurity.biometricLockEnabled]);
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await run('auth.biometric.status', {}, { silentError: true });
      if (!cancelled && r && r.ok && r.data) setBioStatus(r.data);
    })();
    return () => { cancelled = true; };
  }, [run]);
  return (
    <Pane title="Privacy Controls" jp="守秘" subtitle={<span>Control what SHOGUN can see. Excluded content won't appear in your context. <a className="s-link">Learn more <Icon name="arrowUpRight" size={10}/></a></span>}>
      <div className="s-card" style={{marginBottom:14}}>
        <Row
          title={<span><span className="en-only">Biometric app lock</span><span className="jp">生体認証でロック</span></span>}
          desc="Device-level protection (no cloud passkey): Touch ID or Face ID after launch and when returning from the background. Pair with Clerk sign-in above for account identity. Requires the Tauri desktop app on a supported Mac."
          last
        >
          <Toggle
            on={bioLock}
            onClick={async () => {
              const next = !bioLock;
              if (next) {
                const st = await run('auth.biometric.status', {}, { silentError: true });
                const d = st && st.data;
                if (!d || !d.supported || !d.enrolled) {
                  toast(
                    'この環境では生体認証が使えません（デスクトップアプリと Touch ID 等の登録が必要です）。',
                    'warn',
                  );
                  return;
                }
              }
              setBioLock(next);
              const r = await run(
                'settings.save',
                { section: 'security', biometricLockEnabled: next },
                { successMessage: next ? '生体ロックを有効にしました' : '生体ロックをオフにしました' },
              );
              if (r && r.ok && refreshSections) await refreshSections();
            }}
          />
        </Row>
        {bioStatus && (
          <div className="s-field-hint" style={{marginTop:10, padding:'0 16px 14px'}}>
            {bioStatus.stub
              ? 'ブラウザプレビュー: 実際の生体認証はデスクトップアプリで有効になります。'
              : !bioStatus.supported
                ? 'このプラットフォームでは LocalAuthentication が利用できません。'
                : !bioStatus.enrolled
                  ? '端末に生体情報が登録されていません。システム設定で Touch ID を設定してから有効にしてください。'
                  : `状態: 利用可能（${bioStatus.biometryType || 'biometry'}）`}
          </div>
        )}
      </div>
      <div className="row" style={{gap:4, background:'var(--surface)', border:'1px solid var(--border)', padding:3, borderRadius:'var(--radius-md)', width:'fit-content', marginBottom:14}}>
        <button className="btn btn-sm" style={{background:tab==='apps'?'var(--surface-2)':'transparent', borderColor:'transparent'}} onClick={()=>setTab('apps')}>Exclude Apps <span style={{color:'var(--text-dim)', marginLeft:4}}>3</span></button>
        <button className="btn btn-sm btn-ghost" onClick={()=>setTab('websites')}>Exclude Websites <span style={{color:'var(--text-dim)', marginLeft:4}}>11</span></button>
      </div>
      <div className="row" style={{gap:10, marginBottom:10}}>
        <input className="s-input" placeholder="Search applications…" style={{flex:1}}/>
        <select className="s-select">
          <option>Filter</option>
          <option>Enabled</option>
          <option>Disabled</option>
        </select>
      </div>
      <div className="s-card">
        {apps.map((a,i,arr)=>(
          <div key={i} className={'s-row'+(i===arr.length-1?' last':'')}>
            <div style={{width:24, height:24, borderRadius:6, background:'var(--surface-2)', border:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, marginRight:12}}>{a.icon}</div>
            <div style={{flex:1, fontSize:13}}>{a.name}</div>
            <Toggle on={a.on} onClick={async ()=>{
              const next = !a.on;
              setApps(prev => prev.map(item => item.name===a.name ? { ...item, on: next } : item));
              await run('settings.save', { section:'privacy', app:a.name, enabled:next }, { successMessage:'Privacy rule updated' });
            }}/>
          </div>
        ))}
      </div>
      <div className="s-field-hint" style={{marginTop:14, textAlign:'center'}}>Can't find your app? <a className="s-link">Select it manually</a></div>
    </Pane>
  );
}

function PaneData() {
  const { confirmWrite } = useRuntimeActions();
  return (
    <Pane title="Data Controls" jp="資料">
      <div className="s-field-label">Manage Context Collected</div>
      <div className="s-card">
        <Row title="Delete Last Hour of Context" desc="Remove all context collected in the last hour">
          <button className="btn btn-sm btn-secondary" onClick={()=>confirmWrite('data.delete_range', { range:'last_hour' }, 'Delete last hour', 'This permanently deletes local memory for the selected range.')}>Delete</button>
        </Row>
        <Row title="Delete Last Day of Context" desc="Remove all context collected in the last 24 hours">
          <button className="btn btn-sm btn-secondary" onClick={()=>confirmWrite('data.delete_range', { range:'last_day' }, 'Delete last day', 'This permanently deletes local memory for the selected range.')}>Delete</button>
        </Row>
        <Row title="Delete Context for Custom Time Period" desc="Choose a custom time period to remove context (e.g., last 2 hours, last 3 days)">
          <button className="btn btn-sm btn-secondary" onClick={()=>confirmWrite('data.delete_range', { range:'custom' }, 'Delete custom range', 'This permanently deletes local memory for a custom range.')}>Select</button>
        </Row>
        <Row title="Delete All Context" desc="Permanently remove all context collected. This action cannot be undone." last>
          <button className="btn btn-sm" style={{background:'transparent', border:'1px solid #8a4a4a', color:'#d9857a'}} onClick={()=>confirmWrite('data.delete_all', {}, 'Delete all context', 'This deletes all locally stored events and embeddings.')}>Delete</button>
        </Row>
      </div>
      <div className="s-field-label" style={{marginTop:22}}>Manage your Account</div>
      <div className="s-card">
        <Row title="Delete Your Account" desc="Permanently delete your account and all associated data" last>
          <button className="btn btn-sm" style={{background:'transparent', border:'1px solid #8a4a4a', color:'#d9857a'}} onClick={()=>confirmWrite('account.delete', {}, 'Delete account', 'This action removes the account identity and local mappings.')}>Delete</button>
        </Row>
      </div>
    </Pane>
  );
}

function PaneHummingbird() {
  const { run } = useRuntimeActions();
  const { sections } = React.useContext(SettingsHydrationContext);
  const [open, setOpen] = useStateS(true);
  const [enabled, setEnabled] = useStateS(true);
  const [alwaysNew, setAlwaysNew] = useStateS(false);
  const [mode, setMode] = useStateS('any_app');
  React.useEffect(() => {
    const h = sections.hummingbird;
    if (!h || typeof h !== 'object') return;
    if (h.mode != null) setMode(String(h.mode));
    if (typeof h.enabled === 'boolean') setEnabled(h.enabled);
    if (typeof h.alwaysNew === 'boolean') setAlwaysNew(h.alwaysNew);
  }, [sections]);
  return (
    <Pane title="Hummingbird" jp="鳥" subtitle="Chat with anything on your screen — apps, meetings, or selected text.">
      <div className="s-card" style={{padding:0, overflow:'hidden'}}>
        <div onClick={()=>setOpen(!open)} className="row" style={{padding:'12px 16px', cursor:'pointer'}}>
          <Icon name={open?'chevronDown':'chevronRight'} size={12} className="dim"/>
          <span style={{fontSize:13, fontWeight:500, marginLeft:6}}>See in action</span>
        </div>
        {open && (
          <div style={{borderTop:'1px solid var(--border)'}}>
            <div className="row" style={{padding:'10px 16px', gap:6}}>
              <button className="btn btn-sm" style={{background:mode==='any_app'?'var(--surface-2)':'transparent'}} onClick={()=>{ setMode('any_app'); run('settings.save', { section:'hummingbird', mode:'any_app', enabled, alwaysNew }, { silentError:true }); }}>Any app</button>
              <button className="btn btn-sm btn-ghost" onClick={()=>{ setMode('meeting'); run('settings.save', { section:'hummingbird', mode:'meeting', enabled, alwaysNew }, { silentError:true }); }}>Ongoing meeting</button>
              <button className="btn btn-sm btn-ghost" onClick={()=>{ setMode('selection'); run('settings.save', { section:'hummingbird', mode:'selection', enabled, alwaysNew }, { silentError:true }); }}>Selected text</button>
            </div>
            <div style={{margin:'0 16px 16px', border:'1px solid var(--border)', borderRadius:'var(--radius-md)', background:'#f4f1ea', padding:'40px 30px', fontFamily:'Georgia, serif', color:'#2a2420', position:'relative', minHeight:180}}>
              <div style={{fontSize:22, fontWeight:500, marginBottom:8}}>Creativity Is a Process, Not an Event</div>
              <div style={{fontSize:10, letterSpacing:'0.15em', color:'#6a5a4a', marginBottom:20}}>WRITTEN BY JAMES CLEAR · CREATIVITY</div>
              <div style={{fontSize:13, lineHeight:1.7, color:'#4a3a2a'}}>In 1666, one of the most influential scientists in history was strolling through a garden when he was struck with a flash of creative brilliance that would change the world.</div>
              <div style={{position:'absolute', bottom:20, left:'50%', transform:'translateX(-50%)', width:'70%', maxWidth:380, background:'var(--surface-2)', border:'1px solid var(--gold-dim)', borderRadius:'var(--radius-md)', padding:'10px 14px', display:'flex', alignItems:'center', gap:10, boxShadow:'0 8px 24px rgba(0,0,0,0.3)'}}>
                <Kamon size={12} color="var(--gold)"/>
                <span style={{fontSize:12, color:'var(--text-mute)'}}>Summarize this article about creativity</span>
                <span className="spacer"/>
                <button className="btn btn-sm btn-primary" style={{width:22, height:22, padding:0}} onClick={()=>run('settings.save', { section:'hummingbird', mode, enabled, alwaysNew }, { successMessage:'Hummingbird mode saved' })}><Icon name="arrowUpRight" size={10}/></button>
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="s-card" style={{marginTop:14}}>
        <Row title="Enable Hummingbird" desc="Open SHOGUN from anywhere and ask about what's on your screen.">
          <Toggle on={enabled} onClick={()=>{ const next = !enabled; setEnabled(next); run('settings.save', { section:'hummingbird', mode, enabled: next, alwaysNew }, { silentError:true }); }}/>
        </Row>
        <Row title="Global Shortcut" desc="Choose the global shortcut used to open Hummingbird">
          <select className="s-select"><option>Tap Option twice</option><option>⌘ + Space</option></select>
        </Row>
        <Row title="Always Start New Chat" desc="Start with a fresh chat each time you open Hummingbird" last>
          <Toggle on={alwaysNew} onClick={()=>{ const next = !alwaysNew; setAlwaysNew(next); run('settings.save', { section:'hummingbird', mode, enabled, alwaysNew: next }, { silentError:true }); }}/>
        </Row>
      </div>
    </Pane>
  );
}

function PaneBrief() {
  const { run } = useRuntimeActions();
  const { sections } = React.useContext(SettingsHydrationContext);
  const [morningBriefVersion, setMorningBriefVersion] = useStateS('1');
  React.useEffect(() => {
    const b = sections.brief;
    if (!b || typeof b !== 'object') return;
    if (b.morningBriefVersion != null) setMorningBriefVersion(String(b.morningBriefVersion));
  }, [sections]);
  return (
    <Pane title="Morning Brief" jp="朝礼">
      <div className="s-card">
        <Row
          title="Brief format"
          desc="v2 uses AMC (What, Why-now, Related context, Next action). v1 uses the legacy LLM sections layout."
          last
        >
          <select
            className="s-select"
            value={morningBriefVersion}
            onChange={(e) => {
              const v = e.target.value;
              setMorningBriefVersion(v);
              window.__SHOGUN_SETTINGS_BRIEF__ = { morningBriefVersion: v };
              run(
                'settings.save',
                { section: 'brief', morningBriefVersion: v },
                { successMessage: v === '2' ? 'Morning Brief v2 enabled' : 'Morning Brief v1 enabled' },
              );
            }}
          >
            <option value="1">v1 — Legacy sections</option>
            <option value="2">v2 — AMC cards</option>
          </select>
        </Row>
        <div className="s-field-hint" style={{ marginTop: 12 }}>
          Dev: append <code>?brief=v2</code> to the URL to force v2 in the browser mock.
        </div>
      </div>
    </Pane>
  );
}

function PaneMeetings() {
  const [r, setR] = useStateS(true);
  const [ex, setEx] = useStateS(true);
  const [det, setDet] = useStateS(true);
  const [auto, setAuto] = useStateS(false);
  return (
    <Pane title="Meetings" jp="会議">
      <div className="s-card">
        <Row title="Meeting Notifications" desc="Choose when to get notified for upcoming meetings">
          <select className="s-select"><option>Confirmed Only</option><option>All meetings</option></select>
        </Row>
        <Row title="Meeting Language" desc="Choose the language that will be used for transcriptions">
          <select className="s-select"><option>Japanese</option><option>English</option><option>Auto-detect</option></select>
        </Row>
        <Row title="Meeting Reminders" desc="Show notifications before meetings start">
          <Toggle on={r} onClick={()=>setR(!r)}/>
        </Row>
        <Row title="Reminder Time" desc="Set the time before a meeting to get a reminder">
          <select className="s-select"><option>1 Minute</option><option>5 Minutes</option><option>15 Minutes</option></select>
        </Row>
        <Row title="Exclude Events Without Guests" desc="Don't show notifications for events without other guests or meeting links">
          <Toggle on={ex} onClick={()=>setEx(!ex)}/>
        </Row>
        <Row title="Meeting App Detection Alerts" desc="Show notifications when a meeting app is detected">
          <Toggle on={det} onClick={()=>setDet(!det)}/>
        </Row>
        <Row title="Auto-Start Recording on Detection" desc="Automatically start recording when a meeting app is detected and the notification timer expires">
          <Toggle on={auto} onClick={()=>setAuto(!auto)}/>
        </Row>
        <Row title="Auto-Stop Inactivity Timeout" desc="Automatically stop transcription after inactivity" last>
          <select className="s-select"><option>15 Minutes</option><option>5 Minutes</option><option>30 Minutes</option></select>
        </Row>
      </div>
    </Pane>
  );
}

function PaneChat() {
  const { run, toast } = useRuntimeActions();
  const { sections } = React.useContext(SettingsHydrationContext);
  const [instr, setInstr] = useStateS('');
  const [notes, setNotes] = useStateS('');
  React.useEffect(() => {
    const i = sections['chat.instructions'];
    const n = sections['chat.notes'];
    if (i && i.value != null) setInstr(String(i.value));
    if (n && n.value != null) setNotes(String(n.value));
  }, [sections]);
  return (
    <Pane title="Chat" jp="対話">
      <Field label="Custom Instructions" hint="Personalize your interactions with SHOGUN by providing your own instructions">
        <textarea className="s-textarea" value={instr} onChange={e=>setInstr(e.target.value)} placeholder="Enter your custom instructions" rows={7}/>
        <div className="row" style={{marginTop:8}}>
          <span className="s-field-hint">No unsaved changes</span>
          <span className="spacer"/>
          <button className="btn btn-sm btn-ghost" onClick={()=>setInstr('')}>Discard</button>
          <button className="btn btn-sm btn-secondary" onClick={()=>run('settings.save', { section:'chat.instructions', value:instr }, { successMessage:'Instructions saved' })}>Save</button>
        </div>
      </Field>
      <Field label="Assistant Notes" hint="Review and edit what SHOGUN has remembered from past chats to guide future conversations">
        <textarea className="s-textarea" value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Edit SHOGUN's memory" rows={8}/>
        <div className="row" style={{marginTop:8}}>
          <span className="s-field-hint">{notes.length} / 2000 characters</span>
          <span className="spacer"/>
          <button className="btn btn-sm btn-ghost" onClick={()=>setNotes('')}>Discard</button>
          <button className="btn btn-sm btn-secondary" onClick={async ()=>{
            if (notes.length > 2000) return toast('Assistant notes exceed 2000 characters', 'error');
            await run('settings.save', { section:'chat.notes', value:notes }, { successMessage:'Assistant notes saved' });
          }}>Save</button>
        </div>
      </Field>
    </Pane>
  );
}

function PaneLLM() {
  const { run, toast } = useRuntimeActions();
  const { sections, refreshSections } = React.useContext(SettingsHydrationContext);
  const [baseUrl, setBaseUrl] = useStateS('');
  const [model, setModel] = useStateS('');
  const [maxTokens, setMaxTokens] = useStateS('');
  const [apiKeyDraft, setApiKeyDraft] = useStateS('');
  const [keyConfigured, setKeyConfigured] = useStateS(false);

  const refreshKeyStatus = React.useCallback(async () => {
    const r = await run('llm.api_key_status', {}, { silentError: true });
    if (r.ok && r.data && typeof r.data.configured === 'boolean') {
      setKeyConfigured(r.data.configured);
    }
  }, [run]);

  React.useEffect(() => {
    void refreshKeyStatus();
  }, [refreshKeyStatus]);

  React.useEffect(() => {
    const l = sections.llm;
    if (!l || typeof l !== 'object') return;
    if (l.baseUrl != null) setBaseUrl(String(l.baseUrl));
    if (l.model != null) setModel(String(l.model));
    if (l.maxTokens != null) setMaxTokens(String(l.maxTokens));
  }, [sections]);

  return (
    <Pane
      title="Model & API"
      jp="モデル"
      subtitle="OpenAI-compatible chat/completions over HTTPS. Endpoint and model are saved in local settings; the API key is stored only in the macOS Keychain."
    >
      <div className="s-card" style={{padding:20, marginBottom:16}}>
        <Field label="Base URL" hint="e.g. https://api.openai.com/v1 — if the path has no /v1, it is appended automatically.">
          <input
            className="s-input"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            autoComplete="off"
          />
        </Field>
        <Field label="Model" hint="Passed as the model field in chat/completions requests.">
          <input
            className="s-input"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-4o-mini"
            autoComplete="off"
          />
        </Field>
        <Field label="Max output tokens" hint="Upper bound for completion tokens (default in app: 2048).">
          <input
            className="s-input"
            type="number"
            min={1}
            value={maxTokens}
            onChange={(e) => setMaxTokens(e.target.value)}
            placeholder="2048"
          />
        </Field>
        <div className="row" style={{marginTop:4}}>
          <span className="s-field-hint">Saved to settings JSON (not the secret).</span>
          <span className="spacer"/>
          <button
            className="btn btn-sm btn-secondary"
            type="button"
            onClick={async () => {
              const mt = parseInt(String(maxTokens).trim(), 10);
              if (!Number.isFinite(mt) || mt < 1) {
                toast('Max output tokens must be a positive number', 'error');
                return;
              }
              const r = await run(
                'settings.save',
                { section: 'llm', baseUrl: baseUrl.trim(), model: model.trim(), maxTokens: mt },
                { successMessage: 'LLM endpoint settings saved' },
              );
              if (r.ok && refreshSections) await refreshSections();
            }}
          >
            Save endpoint
          </button>
        </div>
      </div>

      <div className="s-card" style={{padding:20}}>
        <Field
          label="API key"
          hint="Stored in the login keychain (service ai.shogun.desktop). Never written to settings files."
        >
          <input
            className="s-input"
            type="password"
            value={apiKeyDraft}
            onChange={(e) => setApiKeyDraft(e.target.value)}
            placeholder={keyConfigured ? '•••••••• (replace by typing a new key)' : 'sk-…'}
            autoComplete="off"
          />
          <div className="row" style={{marginTop:10}}>
            <span className="s-field-hint" style={{marginTop:0}}>
              Keychain: {keyConfigured ? 'configured' : 'not set'}
            </span>
            <span className="spacer"/>
            <button
              className="btn btn-sm btn-ghost"
              type="button"
              disabled={!keyConfigured}
              onClick={async () => {
                const r = await run('llm.clear_api_key', {}, { successMessage: 'API key removed from Keychain' });
                if (r.ok) {
                  setApiKeyDraft('');
                  await refreshKeyStatus();
                }
              }}
            >
              Remove
            </button>
            <button
              className="btn btn-sm btn-secondary"
              type="button"
              onClick={async () => {
                const k = apiKeyDraft.trim();
                if (!k) {
                  toast('Enter an API key to save', 'error');
                  return;
                }
                const r = await run('llm.save_api_key', { apiKey: k }, { successMessage: 'API key saved to Keychain' });
                if (r.ok) {
                  setApiKeyDraft('');
                  await refreshKeyStatus();
                }
              }}
            >
              Save key
            </button>
          </div>
        </Field>
      </div>
    </Pane>
  );
}

function PaneIntegrations() {
  const { run } = useRuntimeActions();
  const [googleCalCred, setGoogleCalCred] = useStateS(false);
  const [googleCalRefresh, setGoogleCalRefresh] = useStateS(false);
  const [calAutoSync, setCalAutoSync] = useStateS(false);
  const [calSyncMins, setCalSyncMins] = useStateS(15);

  const refreshGoogleCalStatus = React.useCallback(async () => {
    const r = await run('integrations.credentials_status', { provider: 'google_calendar' }, { silentError: true });
    if (r.ok && r.data && typeof r.data.configured === 'boolean') {
      setGoogleCalCred(r.data.configured);
      setGoogleCalRefresh(!!r.data.tokenRefreshReady);
    }
  }, [run]);

  React.useEffect(() => {
    void refreshGoogleCalStatus();
  }, [refreshGoogleCalStatus]);

  React.useEffect(() => {
    void (async () => {
      const r = await run('settings.load', {}, { silentError: true });
      const integ = r.ok && r.data?.settings?.sections?.integrations;
      if (!integ || typeof integ !== 'object') return;
      setCalAutoSync(!!integ.googleCalendarAutoSync);
      const m = Number(integ.googleCalendarSyncIntervalMins);
      if (Number.isFinite(m)) setCalSyncMins(Math.min(1440, Math.max(5, m)));
    })();
  }, [run]);

  React.useEffect(() => {
    const onCred = () => {
      void refreshGoogleCalStatus();
    };
    window.addEventListener('shogun-credentials-updated', onCred);
    return () => window.removeEventListener('shogun-credentials-updated', onCred);
  }, [refreshGoogleCalStatus]);

  return (
    <Pane title="All Integrations" jp="連携" subtitle="v1: In-app OAuth is not wired. Google Calendar tokens can be imported by an external agent (Keychain); use Refresh / Sync below. Other Connect rows show an honest notice where applicable.">
      <div className="s-field-hint" style={{marginBottom:14, padding:12, background:'var(--surface-2)', border:'1px solid var(--border)', borderRadius:'var(--radius-sm)'}}>
        Workspace Integrations screen has the same agent contract. Tauri invoke: <code style={{fontSize:11}}>app_integration_import_credentials</code> with <code style={{fontSize:11}}>provider: &quot;google_calendar&quot;</code>, <code style={{fontSize:11}}>accessToken</code>, optional <code style={{fontSize:11}}>refreshToken</code>, <code style={{fontSize:11}}>expiresAt</code>, <code style={{fontSize:11}}>oauthClientId</code> (for automatic token refresh).
      </div>
      <div className="s-card" style={{marginBottom:10}}>
        <Row title={<div className="row" style={{gap:10}}><div className="s-intg-icon" style={{background:'#1a1a1a'}}>📅</div><div><div style={{fontSize:13, fontWeight:500}}>Apple Calendar <span className="label label-gold" style={{marginLeft:4}}>Beta</span></div><div className="s-field-hint">See your events in Apple Calendar</div></div></div>} last>
          <button className="btn btn-sm btn-secondary" type="button" onClick={()=>run('integrations.connect', { provider:'apple_calendar' }, { silentError:true })}>Connect</button>
        </Row>
      </div>
      <div className="s-card" style={{marginBottom:10}}>
        <Row title={<div className="row" style={{gap:10}}><div className="s-intg-icon" style={{background:'#2a1a1a'}}>📋</div><div><div style={{fontSize:13, fontWeight:500}}>Apple Reminders <span className="label label-gold" style={{marginLeft:4}}>Beta</span></div><div className="s-field-hint">See your reminders and tasks in Apple Reminders</div></div></div>} last>
          <button className="btn btn-sm btn-secondary" type="button" onClick={()=>run('integrations.connect', { provider:'apple_reminders' }, { silentError:true })}>Connect</button>
        </Row>
      </div>
      <div className="s-card" style={{marginBottom:10}}>
        <div className="row" style={{padding:'14px 16px'}}>
          <div className="s-intg-icon" style={{background:'#fff'}}>✉</div>
          <span style={{fontSize:13, fontWeight:500, marginLeft:10}}>Gmail</span>
          <span className="spacer"/>
          <Icon name="chevronDown" size={12} className="dim"/>
        </div>
        <div style={{borderTop:'1px solid var(--border)', padding:'12px 16px', display:'flex', alignItems:'center', gap:10}}>
          <span style={{fontSize:12, color:'var(--text-mute)'}}>example@gmail.com</span>
          <span className="label" style={{background:'var(--surface-2)', color:'var(--text-dim)', borderColor:'var(--border)'}}>Not linked · v1</span>
          <span className="spacer"/>
          <button className="btn btn-sm btn-ghost" type="button" style={{padding:'0 6px'}} onClick={()=>run('integrations.toggle', { provider:'gmail', action:'edit' }, { silentError:true })}><Icon name="edit" size={12}/></button>
          <button className="btn btn-sm btn-ghost" type="button" style={{padding:'0 6px'}} onClick={()=>run('integrations.toggle', { provider:'gmail', action:'settings' }, { silentError:true })}><Icon name="settings" size={12}/></button>
        </div>
        <div style={{borderTop:'1px solid var(--border)', padding:'10px 16px', fontSize:12, color:'var(--text-dim)', cursor:'pointer'}}>
          <Icon name="plus" size={12} style={{marginRight:6}}/>Add another account
        </div>
      </div>
      <div className="s-card" style={{marginBottom:10}}>
        <div className="row" style={{padding:'14px 16px'}}>
          <div className="s-intg-icon" style={{background:'#fff'}}>🗓</div>
          <div style={{marginLeft:10}}>
            <div style={{fontSize:13, fontWeight:500}}>Google Calendar</div>
            <div className="s-field-hint">Manage and see your calendar events and appointments through Google Calendar.</div>
          </div>
          <span className="spacer"/>
          <Icon name="chevronDown" size={12} className="dim"/>
        </div>
        <div style={{borderTop:'1px solid var(--border)', padding:'12px 16px', display:'flex', flexWrap:'wrap', alignItems:'center', gap:10}}>
          <span style={{fontSize:12, color:'var(--text-mute)'}}>Agent-imported token</span>
          <span className={'label ' + (googleCalCred ? 'label-success' : '')} style={{borderColor:'var(--border)'}}>
            {googleCalCred ? 'Keychain · configured' : 'No token · import via agent'}
          </span>
          {googleCalCred ? (
            <span className={'label ' + (googleCalRefresh ? 'label-success' : '')} style={{borderColor:'var(--border)', fontSize:11}}>
              {googleCalRefresh ? 'Refresh: client+refresh token' : 'Refresh: add oauthClientId + refreshToken'}
            </span>
          ) : null}
          <span className="spacer"/>
          <button className="btn btn-sm btn-secondary" type="button" onClick={() => { void refreshGoogleCalStatus(); }}>Refresh status</button>
          <button className="btn btn-sm btn-primary" type="button" onClick={() => run('calendar.sync', { calendarId:'primary', maxResults:25 }, { successMessage:'Calendar synced to Memory' })}>Sync to Memory</button>
          <button className="btn btn-sm btn-ghost" type="button" style={{padding:'0 6px'}} onClick={()=>run('integrations.toggle', { provider:'google_calendar', action:'edit' }, { silentError:true })}><Icon name="edit" size={12}/></button>
          <button className="btn btn-sm btn-ghost" type="button" style={{padding:'0 6px'}} onClick={()=>run('integrations.toggle', { provider:'google_calendar', action:'settings' }, { silentError:true })}><Icon name="settings" size={12}/></button>
        </div>
        <div style={{borderTop:'1px solid var(--border)', padding:'12px 16px', display:'flex', flexWrap:'wrap', alignItems:'center', gap:12}}>
          <label style={{fontSize:12, display:'flex', alignItems:'center', gap:8, opacity: googleCalCred ? 1 : 0.45}}>
            <input type="checkbox" checked={calAutoSync} disabled={!googleCalCred} onChange={(e) => setCalAutoSync(e.target.checked)} />
            Background sync to Memory
          </label>
          <label style={{fontSize:12, display:'flex', alignItems:'center', gap:6, opacity: googleCalCred ? 1 : 0.45}}>
            Every
            <input className="s-input" type="number" min={5} max={1440} style={{width:64}} value={calSyncMins} disabled={!googleCalCred} onChange={(e) => setCalSyncMins(Number(e.target.value))} />
            min (5–1440)
          </label>
          <button
            className="btn btn-sm btn-secondary"
            type="button"
            disabled={!googleCalCred}
            onClick={async () => {
              const m = Math.min(1440, Math.max(5, Math.round(calSyncMins) || 15));
              const r = await run(
                'settings.save',
                { section: 'integrations', googleCalendarAutoSync: calAutoSync, googleCalendarSyncIntervalMins: m },
                { silentError: true, successMessage: 'Calendar auto-sync saved' },
              );
              if (r.ok) setCalSyncMins(m);
            }}
          >Save auto-sync</button>
        </div>
      </div>
      {[['Google Drive','☁'],['Outlook','✉'],['Notion','📝'],['Linear','◣'],['Slack','#']].map((s,i)=>(
        <div key={i} className="s-card" style={{marginBottom:8}}>
          <Row last title={<div className="row" style={{gap:10}}><div className="s-intg-icon">{s[1]}</div><div style={{fontSize:13, fontWeight:500}}>{s[0]}</div></div>}>
            <button className="btn btn-sm btn-secondary" type="button" onClick={()=>run('integrations.connect', { provider:s[0].toLowerCase().replace(/\s+/g,'_') }, { silentError:true })}>Connect</button>
          </Row>
        </div>
      ))}
    </Pane>
  );
}

function PaneShortcuts() {
  const groups = [
    {name:'General', items:[
      ['New chat', ['⌘','N']],
      ['Search', ['⌘','K']],
      ['Open settings', ['⌘',',']],
      ['Toggle sidebar', ['⌘','S']],
    ]},
    {name:'Navigation', items:[
      ['Go back', ['⌘','[']],
      ['Go forward', ['⌘',']']],
    ]},
    {name:'Chat', items:[
      ['Send message', ['↵']],
      ['New line', ['⇧','↵']],
      ['Toggle Max', ['⌃','T']],
      ['Start voice recording (press again to stop)', ['⌥','↵']],
      ['Cancel voice recording', ['⌥','↺']],
    ]},
    {name:'Memory', items:[
      ['Capture moment', ['⌘','⇧','C']],
      ['Jump to timeline', ['⌘','⇧','T']],
    ]},
  ];
  return (
    <Pane title="Keyboard Shortcuts" jp="捷径">
      {groups.map(g=>(
        <div key={g.name} style={{marginBottom:18}}>
          <div className="s-field-label" style={{marginBottom:8}}>{g.name}</div>
          <div className="s-card">
            {g.items.map((it, i, arr)=>(
              <div key={i} className={'s-row'+(i===arr.length-1?' last':'')}>
                <div style={{flex:1, fontSize:13}}>{it[0]}</div>
                <div className="row" style={{gap:4}}>
                  {it[1].map((k,j)=><span key={j} className="s-kbd">{k}</span>)}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </Pane>
  );
}

function PaneSubscription() {
  const { run } = useRuntimeActions();
  const { sections } = React.useContext(SettingsHydrationContext);
  const [billingCycle, setBillingCycle] = useStateS('annual');
  React.useEffect(() => {
    const s = sections.subscription;
    if (s && s.billingCycle != null) setBillingCycle(String(s.billingCycle));
  }, [sections]);
  return (
    <Pane title="Subscription" jp="契約">
      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:14}}>
        <div className="s-card" style={{padding:20}}>
          <div className="row">
            <div style={{fontSize:16, fontWeight:500}}>Plus</div>
            <span className="spacer"/>
            <div style={{display:'flex', border:'1px solid var(--border)', borderRadius:'var(--radius-sm)', overflow:'hidden'}}>
              <button className="btn btn-sm btn-ghost" style={{borderRadius:0, background:billingCycle==='monthly'?'var(--surface-2)':'transparent', color:billingCycle==='monthly'?'var(--text)':'var(--text-mute)'}} onClick={()=>{ setBillingCycle('monthly'); run('settings.save', { section:'subscription', billingCycle:'monthly' }, { silentError:true }); }}>Monthly</button>
              <button className="btn btn-sm" style={{borderRadius:0, background:billingCycle==='annual'?'var(--surface-2)':'transparent', color:billingCycle==='annual'?'var(--text)':'var(--text-mute)'}} onClick={()=>{ setBillingCycle('annual'); run('settings.save', { section:'subscription', billingCycle:'annual' }, { silentError:true }); }}>Annual</button>
            </div>
          </div>
          <div style={{fontSize:36, fontWeight:600, marginTop:16, letterSpacing:'-0.02em'}}>
            $17<span style={{fontSize:14, color:'var(--text-dim)', fontWeight:400}}>/mo</span>
            <span className="label label-gold" style={{marginLeft:8, verticalAlign:'middle'}}>-15%</span>
          </div>
          <div style={{marginTop:18, fontSize:12, color:'var(--text-mute)'}}>Includes everything in Basic, and:</div>
          <ul style={{margin:'8px 0 0', padding:0, listStyle:'none', fontSize:12, lineHeight:1.9}}>
            {['Advanced intelligence in chat','Enhanced memory and personalization','Additional daily chats','Additional active routines','Unlimited meeting notes','Access to max intelligence for complex tasks and deep research','Access to standard image generation','Priority support'].map(f=>(
              <li key={f}><Icon name="check" size={11} className="gold" style={{marginRight:8}}/>{f}</li>
            ))}
          </ul>
          <button className="btn btn-secondary" style={{width:'100%', marginTop:18}} onClick={()=>run('settings.save', { section:'subscription', plan:'plus_trial' }, { successMessage:'Trial request submitted' })}>Start 14-day free trial</button>
        </div>
        <div className="s-card" style={{padding:20}}>
          <div style={{fontSize:16, fontWeight:500}}>Pro</div>
          <div style={{fontSize:36, fontWeight:600, marginTop:16, letterSpacing:'-0.02em'}}>
            From $100<span style={{fontSize:14, color:'var(--text-dim)', fontWeight:400}}>/mo</span>
          </div>
          <div style={{marginTop:18, fontSize:12, color:'var(--text-mute)'}}>Includes everything in Plus, and:</div>
          <ul style={{margin:'8px 0 0', padding:0, listStyle:'none', fontSize:12, lineHeight:1.9}}>
            {['Choose 5x or 12x more usage than Plus','Auto-detect language in meeting notes','Higher limits for max intelligence','Access to premium image generation','Early access to new features'].map(f=>(
              <li key={f}><Icon name="check" size={11} className="gold" style={{marginRight:8}}/>{f}</li>
            ))}
          </ul>
          <button className="s-tier-btn" onClick={()=>run('settings.save', { section:'subscription', plan:'pro_5x' }, { successMessage:'Plan selection submitted' })}><span>Choose Pro 5x</span><span style={{color:'var(--text-dim)'}}>$100/mo</span></button>
          <button className="s-tier-btn" onClick={()=>run('settings.save', { section:'subscription', plan:'pro_12x' }, { successMessage:'Plan selection submitted' })}><span>Choose Pro 12x</span><span style={{color:'var(--text-dim)'}}>$200/mo</span></button>
        </div>
      </div>
      <div className="s-card" style={{marginTop:14, padding:16}}>
        <div style={{fontSize:13, fontWeight:500}}>Have a referral code?</div>
        <div className="s-field-hint" style={{marginTop:2}}>Enter a code to unlock referral rewards</div>
        <div className="row" style={{gap:8, marginTop:10}}>
          <input className="s-input" placeholder="Enter referral code" style={{flex:1}}/>
          <button className="btn btn-sm btn-secondary" onClick={()=>run('settings.save', { section:'subscription', action:'apply_referral' }, { successMessage:'Referral code submitted' })}>Apply</button>
        </div>
      </div>
      <div style={{marginTop:14, textAlign:'center', fontSize:12, color:'var(--text-dim)'}}>
        Want SHOGUN for your team or business? <a className="s-link">Contact us <Icon name="arrowUpRight" size={10}/></a>
      </div>
    </Pane>
  );
}

function PaneTeam() {
  const { run } = useRuntimeActions();
  return (
    <Pane title="Team" jp="組">
      <div className="s-card" style={{padding:20}}>
        <div style={{fontSize:16, fontWeight:500}}>SHOGUN for Teams <span className="jp dim" style={{fontSize:11, marginLeft:6}}>組織版</span></div>
        <div className="s-field-hint" style={{marginTop:6}}>Get SHOGUN for your whole company with one subscription.</div>
        <ul style={{margin:'16px 0 0', padding:0, listStyle:'none', fontSize:13, lineHeight:2}}>
          {['Centralized billing for your company','Invite and manage team members','Mix Plus and Pro seats in one team'].map(f=>(
            <li key={f}><Icon name="check" size={11} className="gold" style={{marginRight:8}}/>{f}</li>
          ))}
        </ul>
        <div style={{borderTop:'1px solid var(--border)', marginTop:16, paddingTop:14}} className="row">
          <button className="btn btn-secondary" onClick={()=>run('settings.save', { section:'team', action:'create' }, { successMessage:'Team creation flow started' })}>Create a Team</button>
          <span className="s-field-hint" style={{marginLeft:12}}>Starting at $17/seat/mo billed annually</span>
        </div>
      </div>
    </Pane>
  );
}

function PaneSupport() {
  const { run } = useRuntimeActions();
  return (
    <Pane title="Support" jp="支援">
      <div className="s-card">
        <Row title="Email Support" desc="Contact us at support@shogun.local">
          <button className="btn btn-sm btn-secondary" onClick={()=>run('settings.save', { section:'support', action:'email' }, { successMessage:'Support action queued' })}>Email Support</button>
        </Row>
        <Row title="Join our Discord" desc="Join our Discord server for real time support and discussions">
          <button className="btn btn-sm btn-secondary" onClick={()=>run('settings.save', { section:'support', action:'discord' }, { successMessage:'Discord action queued' })}>Join Discord</button>
        </Row>
        <Row title="Report Performance Issues" desc="Experiencing slowdowns or high resource usage? Create a 5-second diagnostic snapshot to help us troubleshoot the issue." last>
          <button className="btn btn-sm btn-secondary" onClick={()=>run('diagnostics.report', { source:'settings.support' }, { successMessage:'Diagnostics report started' })}>Report</button>
        </Row>
      </div>
    </Pane>
  );
}

const PANES = {
  general: PaneGeneral, system: PaneSystem, appearance: PaneAppearance,
  privacy: PanePrivacy, data: PaneData, hummingbird: PaneHummingbird,
  meetings: PaneMeetings, brief: PaneBrief, chat: PaneChat, llm: PaneLLM, integrations: PaneIntegrations,
  shortcuts: PaneShortcuts, subscription: PaneSubscription,
  team: PaneTeam, support: PaneSupport,
};

function SettingsModal({pane, setPane, close}) {
  const resolved = PANE_ALIAS[pane] || pane;
  const PaneComp = PANES[resolved] || PANES.general;
  const [hydratedSections, setHydratedSections] = useStateS({});
  const refreshSections = React.useCallback(async () => {
    if (!window.SHOGUN_RUNTIME || !window.SHOGUN_RUNTIME.executeAction) {
      setHydratedSections({});
      return;
    }
    const res = await window.SHOGUN_RUNTIME.executeAction('settings.load', {}, { silentError: true });
    const inner = res && res.data;
    const sec = inner && inner.settings && inner.settings.sections;
    setHydratedSections(sec && typeof sec === 'object' ? sec : {});
  }, []);
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      await refreshSections();
      if (cancelled) return;
    })();
    return () => { cancelled = true; };
  }, [refreshSections]);
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <SettingsHydrationContext.Provider value={{ sections: hydratedSections, refreshSections }}>
    <>
      <div className="s-backdrop" onClick={close}/>
      <div className="s-modal">
        <div className="s-sidebar">
          <div className="t-mono" style={{padding:'18px 18px 20px', fontSize:10, color:'var(--text-dim)', letterSpacing:'0.2em'}}>
            SETTINGS · 設定
          </div>
          <div style={{flex:1, overflowY:'auto', padding:'0 8px'}}>
            {SETTINGS_NAV.map(n => (
              <div key={n.id} className={'s-nav '+(resolved===n.id?'active':'')} onClick={()=>setPane(n.id)}>
                <Icon name={n.icon} size={13}/>
                <span className="en-only">{n.label}</span>
                <span className="jp">{n.jp}</span>
              </div>
            ))}
          </div>
          <div style={{padding:'12px 18px', borderTop:'1px solid var(--border)', display:'flex', alignItems:'center', gap:8}}>
            <Kamon size={11} color="var(--gold)"/>
            <span className="t-mono" style={{fontSize:9, color:'var(--text-dim)'}}>SHOGUN v0.4.1</span>
          </div>
        </div>
        <div className="s-content">
          <button className="s-close" onClick={close}><Icon name="x" size={14}/></button>
          <PaneComp/>
        </div>
      </div>

      <style>{`
        .s-backdrop {
          position:fixed; inset:0; z-index:95;
          background:rgba(10,9,8,0.55);
          backdrop-filter: blur(6px);
          animation: sBackIn 160ms var(--ease-out);
        }
        @keyframes sBackIn { from {opacity:0;} to {opacity:1;} }
        .s-modal {
          position:fixed; z-index:96;
          top:50%; left:50%; transform:translate(-50%, -50%);
          width:min(1020px, 94vw); height:min(720px, 90vh);
          background:var(--bg);
          border:1px solid var(--border-hi);
          border-radius:var(--radius-lg);
          box-shadow:0 40px 80px -20px rgba(0,0,0,0.7), 0 2px 0 rgba(0,0,0,0.4);
          display:flex; overflow:hidden;
          animation: sModalIn 220ms var(--ease-out);
        }
        @keyframes sModalIn {
          from { opacity:0; transform:translate(-50%, -48%) scale(0.98); }
          to { opacity:1; transform:translate(-50%, -50%) scale(1); }
        }
        .s-sidebar {
          width:220px; flex-shrink:0;
          border-right:1px solid var(--border);
          background:var(--surface);
          display:flex; flex-direction:column;
        }
        .s-nav {
          display:flex; align-items:center; gap:10px;
          padding:8px 12px; border-radius:var(--radius-sm);
          color:var(--text-mute); font-size:13px; cursor:pointer;
          margin-bottom:1px;
        }
        .s-nav:hover { background:var(--surface-2); color:var(--text); }
        .s-nav.active {
          background:var(--surface-2); color:var(--text);
          border:1px solid var(--border);
        }
        .s-nav .jp { font-family:var(--font-jp); font-weight:300; font-size:10.5px; color:var(--text-dim); margin-left:-4px; }

        .s-content {
          flex:1; overflow-y:auto; position:relative;
          padding:30px 40px 50px;
        }
        .s-close {
          position:absolute; top:16px; right:16px;
          width:28px; height:28px; border-radius:6px;
          background:transparent; border:1px solid transparent;
          color:var(--text-mute); cursor:pointer;
          display:flex; align-items:center; justify-content:center;
          z-index:2;
        }
        .s-close:hover { background:var(--surface); border-color:var(--border); color:var(--text); }

        .s-pane-head { margin-bottom:22px; }
        .s-pane-sub { margin-top:8px; font-size:12.5px; color:var(--text-mute); line-height:1.55; max-width:560px; }
        .s-pane-body { max-width:640px; }

        .s-card {
          background:var(--surface);
          border:1px solid var(--border);
          border-radius:var(--radius-md);
          overflow:hidden;
        }
        .s-row {
          display:flex; align-items:center; gap:14px;
          padding:14px 16px;
          border-bottom:1px solid var(--border);
        }
        .s-row.last { border-bottom:none; }
        .s-row-title { font-size:13px; color:var(--text); font-weight:500; }
        .s-row-desc { font-size:11.5px; color:var(--text-dim); margin-top:2px; line-height:1.4; }

        .s-field-label { font-size:13px; color:var(--text); margin-bottom:8px; font-weight:500; }
        .s-field-hint { font-size:11.5px; color:var(--text-dim); margin-top:6px; line-height:1.5; }
        .s-input, .s-textarea, .s-select {
          width:100%; padding:9px 12px;
          background:var(--surface); border:1px solid var(--border);
          border-radius:var(--radius-sm);
          color:var(--text); font-size:13px; font-family:inherit;
        }
        .s-textarea { resize:vertical; line-height:1.55; }
        .s-input:focus, .s-textarea:focus, .s-select:focus {
          outline:none; border-color:var(--gold-dim);
        }
        .s-select {
          width:auto; padding:6px 28px 6px 10px;
          font-size:12px; background-image:none; cursor:pointer;
          appearance:none; -webkit-appearance:none;
          background-position: right 8px center;
        }

        .s-link { color:var(--gold); cursor:pointer; }
        .s-link:hover { text-decoration:underline; }

        .s-meta {
          padding:14px 16px;
          background:var(--surface);
          border:1px solid var(--border);
          border-radius:var(--radius-md);
          margin-top:10px;
        }

        .s-toggle {
          width:34px; height:18px; border-radius:9px;
          background:var(--surface-2); border:1px solid var(--border);
          position:relative; cursor:pointer; transition:background 120ms;
          flex-shrink:0;
        }
        .s-toggle[data-on="1"] { background:var(--gold); border-color:var(--gold); }
        .s-toggle-knob {
          position:absolute; top:1px; left:1px;
          width:14px; height:14px; border-radius:50%;
          background:var(--text-mute); transition:transform 160ms, background 120ms;
        }
        .s-toggle[data-on="1"] .s-toggle-knob {
          background:#fff; transform:translateX(16px);
        }

        .s-color-card {
          padding:4px; border-radius:var(--radius-md);
          cursor:pointer; border:1px solid transparent;
          transition:border-color 120ms;
        }
        .s-color-card.active { border-color:var(--gold); }
        .s-color-preview {
          aspect-ratio:16/10; border-radius:var(--radius-sm);
          border:1px solid var(--border);
          padding:8px; display:flex; flex-direction:column; gap:8px;
          position:relative; overflow:hidden;
        }
        .s-color-preview[data-mode="light"] { background:#f4f1ea; color:#2a2420; }
        .s-color-preview[data-mode="dark"] { background:#151212; color:#d9d4ca; }
        .s-color-preview[data-mode="auto"] {
          background:linear-gradient(90deg, #f4f1ea 50%, #151212 50%);
          color:#2a2420;
        }
        .s-color-bar { display:flex; gap:3px; }
        .s-color-bar span { width:5px; height:5px; border-radius:50%; background:currentColor; opacity:0.4; }
        .s-color-title { font-size:10px; opacity:0.9; text-align:center; flex:1; display:flex; align-items:center; justify-content:center; }
        .s-color-input {
          height:10px; border-radius:3px;
          background:color-mix(in srgb, currentColor 10%, transparent);
          border:1px solid color-mix(in srgb, currentColor 15%, transparent);
        }

        .s-intg-icon {
          width:30px; height:30px; border-radius:6px;
          background:var(--surface-2); border:1px solid var(--border);
          display:flex; align-items:center; justify-content:center;
          font-size:14px; flex-shrink:0;
        }

        .s-kbd {
          min-width:24px; height:24px;
          padding:0 6px; border-radius:5px;
          background:var(--bg); border:1px solid var(--border);
          display:inline-flex; align-items:center; justify-content:center;
          font-family:var(--font-mono); font-size:11px;
          color:var(--text-mute);
        }

        .s-tier-btn {
          display:flex; justify-content:space-between; align-items:center;
          width:100%; margin-top:10px;
          padding:10px 14px;
          background:var(--surface-2); border:1px solid var(--border);
          border-radius:var(--radius-sm);
          font-size:13px; color:var(--text); cursor:pointer;
        }
        .s-tier-btn:hover { border-color:var(--gold-dim); }
      `}</style>
    </>
    </SettingsHydrationContext.Provider>
  );
}

window.SettingsModal = SettingsModal;

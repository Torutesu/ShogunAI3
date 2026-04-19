/* global Icon, Kamon, IntegrationLogo, React, ReactDOM, ShogunKeyboardShortcuts */
const { useState: useStateS } = React;

const SETTINGS_NAV = [
  {id:'general',      label:'General',            jp:'一般', icon:'settings'},
  {id:'system',       label:'System',             jp:'系統', icon:'terminal'},
  {id:'appearance',   label:'Appearance',         jp:'外観', icon:'eye'},
  {id:'privacy',      label:'Privacy Controls',   jp:'守秘', icon:'shield'},
  {id:'data',         label:'Data Controls',      jp:'資料', icon:'memory'},
  {id:'hummingbird',  label:'Hummingbird',        jp:'鳥',   icon:'zap'},
  {id:'meetings',     label:'Meetings',           jp:'会議', icon:'calendar'},
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
  brief: 'general',
};

/**
 * Commercial build: customer-facing legal URLs (optional). Leave empty to rely on bundled markdown
 * (docs/TERMS_OF_SERVICE.md, docs/TERMS_OF_SERVICE_EN.md, PRIVACY.md). Replace supportMailto with your support address.
 */
const PRODUCT = {
  supportMailto: 'mailto:support@yourcompany.com?subject=SHOGUN%20support',
  termsJaUrl: '',
  termsEnUrl: '',
  privacyUrl: '',
};

function ProductLegalLinks() {
  const hasHosted = !!(PRODUCT.termsJaUrl || PRODUCT.termsEnUrl || PRODUCT.privacyUrl);
  return (
    <div className="row" style={{ marginTop: 12, gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
      {PRODUCT.termsJaUrl ? (
        <a className="s-link" href={PRODUCT.termsJaUrl} target="_blank" rel="noopener noreferrer">
          Terms / 利用規約（日本語） <Icon name="arrowUpRight" size={10} />
        </a>
      ) : null}
      {PRODUCT.termsEnUrl ? (
        <a className="s-link" href={PRODUCT.termsEnUrl} target="_blank" rel="noopener noreferrer">
          Terms (English) <Icon name="arrowUpRight" size={10} />
        </a>
      ) : null}
      {PRODUCT.privacyUrl ? (
        <a className="s-link" href={PRODUCT.privacyUrl} target="_blank" rel="noopener noreferrer">
          Privacy / プライバシー <Icon name="arrowUpRight" size={10} />
        </a>
      ) : null}
      <a className="s-link" href={PRODUCT.supportMailto}>
        Contact support / サポート <Icon name="arrowUpRight" size={10} />
      </a>
      {!hasHosted ? (
        <span className="s-field-hint" style={{ fontSize: 11, maxWidth: 420 }}>
          Full legal text is supplied as markdown with your license (JP/EN Terms + Privacy). Host URLs in PRODUCT.* in source when you publish web pages.
        </span>
      ) : null}
    </div>
  );
}

/** In notices when hosted Terms URL may be unset — underline non-link. */
function TermsNoticeAnchor({ children }) {
  const href = PRODUCT.termsJaUrl || PRODUCT.termsEnUrl;
  if (!href) {
    return (
      <span
        className="s-link"
        style={{ cursor: 'help', textDecoration: 'underline dotted' }}
        title="See TERMS_OF_SERVICE.md and TERMS_OF_SERVICE_EN.md included with your purchase"
      >
        {children}
      </span>
    );
  }
  return (
    <a className="s-link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** Stable fallback so `sections.security` missing does not allocate a new `{}` every render. */
const EMPTY_SETTINGS_SECURITY = {};

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

const EMBED_BACKFILL_BATCH_OPTS = [20, 40, 80, 120, 200];
const EMBED_BACKFILL_DELAY_OPTS = [0, 250, 500, 1000];

function normalizeEmbedBackfillBatch(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 40;
  const r = Math.min(200, Math.max(20, Math.round(n)));
  return EMBED_BACKFILL_BATCH_OPTS.includes(r) ? r : 40;
}

function normalizeEmbedBackfillDelayMs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return EMBED_BACKFILL_DELAY_OPTS.includes(n) ? n : 0;
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
  const run = React.useCallback(async (key, payload, options) => {
    if (!window.SHOGUN_RUNTIME || !window.SHOGUN_RUNTIME.executeAction) return { ok:false };
    return window.SHOGUN_RUNTIME.executeAction(key, payload, options || {});
  }, []);
  const confirmWrite = React.useCallback((key, payload, title, description) => {
    if (!window.SHOGUN_RUNTIME || !window.SHOGUN_RUNTIME.requestWriteAction) return;
    window.SHOGUN_RUNTIME.requestWriteAction(key, payload, title, description);
  }, []);
  const toast = React.useCallback((message, kind) => {
    if (window.SHOGUN_RUNTIME && window.SHOGUN_RUNTIME.pushToast) {
      window.SHOGUN_RUNTIME.pushToast(message, kind || 'info');
    }
  }, []);
  return { run, confirmWrite, toast };
}

/** Sections map from `app_settings_load` → `settings.sections`; consumed by settings panes. */
const SettingsHydrationContext = React.createContext({ sections: {}, refreshSections: null });

/**
 * Read a value saved either as a dotted top-level key (`sections['chat.instructions']`)
 * or nested (`sections.chat.instructions`), with optional `{ value: string }` wrapper.
 */
function readSectionValue(sections, dottedKey) {
  if (!sections || typeof sections !== 'object') return undefined;
  const direct = sections[dottedKey];
  if (direct != null && typeof direct === 'object' && 'value' in direct) {
    return direct.value == null ? '' : String(direct.value);
  }
  if (typeof direct === 'string') return direct;
  const parts = String(dottedKey || '')
    .split('.')
    .filter(Boolean);
  if (parts.length < 2) return undefined;
  let cur = sections;
  for (let i = 0; i < parts.length; i++) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[parts[i]];
  }
  if (cur != null && typeof cur === 'object' && 'value' in cur) {
    return cur.value == null ? '' : String(cur.value);
  }
  if (typeof cur === 'string') return cur;
  return undefined;
}

function Pane({title, jp, children, subtitle}) {
  return (
    <div className="s-pane">
      <div className="s-pane-head">
        <h2 style={{margin:0, fontSize:19, fontWeight:500, letterSpacing:'-0.01em'}}>
          {title}
          <span className="jp" style={{fontSize:12.5, marginLeft:8, color:'var(--text-dim)', fontWeight:300}}>{jp}</span>
        </h2>
        {subtitle && <div className="s-pane-sub">{subtitle}</div>}
      </div>
      <div className="s-pane-body">{children}</div>
    </div>
  );
}

function PaneGeneral() {
  const { run, toast } = useRuntimeActions();
  const { sections, refreshSections } = React.useContext(SettingsHydrationContext);
  const [name, setName] = useStateS('');
  const [aliases, setAliases] = useStateS('');
  const [email, setEmail] = useStateS('');
  const [clerkState, setClerkState] = useStateS({ enabled: false, signedIn: false, label: '' });
  const saveProfile = React.useCallback(
    async (opts) => {
      const quiet = opts && opts.quiet;
      const r = await run(
        'settings.save',
        { section: 'general', name, aliases, email },
        quiet ? { silentError: true } : { silentError: true, successMessage: 'Profile updated' },
      );
      if (r && r.ok && refreshSections) await refreshSections();
    },
    [run, refreshSections, name, aliases, email],
  );
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
      <div
        className="s-field-hint"
        style={{
          marginBottom: 16,
          padding: 14,
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          lineHeight: 1.55,
          fontSize: 12,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 8 }}>SHOGUN v1 — product scope / 製品範囲</div>
        <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-dim)' }}>
          <li>
            <strong className="en-only">Platform:</strong>
            <strong className="jp">対象:</strong> macOS desktop (Tauri). Other OS are not supported in this release.
          </li>
          <li>
            <strong className="en-only">Morning Brief:</strong> content may be a <strong>stub</strong> or generated via{' '}
            <strong>your configured LLM</strong>; it is not guaranteed to match a separate AMC batch pipeline unless you wire
            that yourself.
          </li>
          <li>
            <strong className="en-only">Integrations:</strong> many &quot;Connect&quot; rows are <strong>preview / not wired</strong> in v1 — expect
            warnings where OAuth is unavailable.
          </li>
          <li>
            <strong className="en-only">Billing UI:</strong> subscription screens may be <strong>illustrative</strong> until checkout is connected — see Terms.
          </li>
        </ul>
        <div className="jp" style={{ marginTop: 10, fontSize: 11, color: 'var(--text-dim)' }}>
          Morning Brief は環境によりスタブまたはご自身の LLM 経由の生成です。連携の Connect は v1 では未接続のことがあります。契約画面の金額はイメージの場合があります（利用規約参照）。
        </div>
        <ProductLegalLinks />
      </div>
      <Field
        label="Clerk account"
        hint="Free tier: sign in with email, Google, etc. (in-app overlay). Add your dev URL and shogun-ai:// under Clerk → Redirect URLs if OAuth redirects fail; the app may fall back to the system browser. For Touch ID / Face ID on this device without a paid Clerk plan, use Privacy → Biometric app lock. When Clerk is enabled, Clerk’s own Terms of Service and Privacy Policy (clerk.com) apply to authentication and account data processed by Clerk, in addition to SHOGUN’s documents."
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
        <input
          className="s-input"
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void saveProfile({ quiet: true })}
        />
      </Field>
      <Field label="Aliases" hint="Include your nicknames, online handles, and other identifiers, separated by commas">
        <input
          className="s-input"
          placeholder="e.g. @handle, nickname"
          value={aliases}
          onChange={(e) => setAliases(e.target.value)}
          onBlur={() => void saveProfile({ quiet: true })}
        />
      </Field>
      <Field label="Email">
        <div className="row" style={{gap:8}}>
          <input
            className="s-input"
            placeholder="you@example.com"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{flex:1}}
            onBlur={() => void saveProfile({ quiet: true })}
          />
          <button className="btn btn-sm btn-secondary" type="button" onClick={() => void saveProfile()}>
            <Icon name="edit" size={12}/>
          </button>
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
      <div className="s-appearance-grid">
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
  const secSecurity =
    sections.security && typeof sections.security === 'object'
      ? sections.security
      : EMPTY_SETTINGS_SECURITY;
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
    const defer = window.setTimeout(() => {
      void (async () => {
        const fallback = {
          supported: false,
          enrolled: false,
          stub: true,
          biometryType: 'none',
          platform: 'timeout',
        };
        try {
          const r = await Promise.race([
            run('auth.biometric.status', {}, { silentError: true }),
            new Promise((resolve) =>
              window.setTimeout(() => resolve({ __bioStatusTimeout: true }), 15000),
            ),
          ]);
          if (cancelled) return;
          if (r && r.__bioStatusTimeout) {
            setBioStatus(fallback);
            return;
          }
          if (r && r.ok && r.data) setBioStatus(r.data);
        } catch (_) {
          if (!cancelled) setBioStatus(fallback);
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(defer);
    };
  }, [run]);
  return (
    <Pane title="Privacy Controls" jp="守秘" subtitle={<span>Control what SHOGUN can see. Excluded content won't appear in your context. <a className="s-link">Learn more <Icon name="arrowUpRight" size={10}/></a></span>}>
      <div className="s-field-hint" style={{marginBottom:14, padding:12, background:'var(--surface-2)', border:'1px solid var(--border)', borderRadius:'var(--radius-sm)', lineHeight:1.55, fontSize:12}}>
        <div style={{fontWeight:600, marginBottom:6}}>Local-first · ローカルファースト</div>
        <div>Memory and ingested context stay in this app&apos;s data on this Mac. There is no SHOGUN cloud sync for the Memory index in this build. Chat / LLM and Clerk still send data to those services when you use them.</div>
        <div className="jp" style={{marginTop:8, fontSize:11, color:'var(--text-dim)'}}>Memory と取り込んだコンテキストはこの Mac のアプリデータにのみ保存されます。Memory本体の SHOGUN クラウド同期はありません。Chat・LLM や Clerk 利用時は各サービスへ送信されます。</div>
        <div className="row" style={{ marginTop: 12, gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          {PRODUCT.privacyUrl ? (
            <a className="s-link" href={PRODUCT.privacyUrl} target="_blank" rel="noopener noreferrer">
              Privacy summary <Icon name="arrowUpRight" size={10} />
            </a>
          ) : (
            <span className="s-field-hint" style={{ fontSize: 11 }}>
              Privacy: see <code style={{ fontSize: 10 }}>PRIVACY.md</code> with your license
            </span>
          )}
          {PRODUCT.termsJaUrl ? (
            <a className="s-link" href={PRODUCT.termsJaUrl} target="_blank" rel="noopener noreferrer">
              Terms / 利用規約 <Icon name="arrowUpRight" size={10} />
            </a>
          ) : (
            <span className="s-field-hint" style={{ fontSize: 11 }}>
              Terms: <code style={{ fontSize: 10 }}>TERMS_OF_SERVICE.md</code> / <code style={{ fontSize: 10 }}>TERMS_OF_SERVICE_EN.md</code>
            </span>
          )}
        </div>
      </div>
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
            {bioStatus.platform === 'timeout'
              ? '生体認証の状態を取得できませんでした（タイムアウト）。アプリを再起動するか、しばらくしてから再度お試しください。'
              : bioStatus.stub
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
    <Pane
      title="Data Controls"
      jp="資料"
      subtitle={
        <span style={{ display: 'block', lineHeight: 1.45 }}>
          All actions below apply to local data on this Mac.
          <span className="jp" style={{ display: 'block', fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
            以下はこの Mac に保存されたローカルデータに対する操作です。
          </span>
        </span>
      }
    >
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
  const [globalShortcut, setGlobalShortcut] = useStateS('option_double_tap');
  React.useEffect(() => {
    const h = sections.hummingbird;
    if (!h || typeof h !== 'object') return;
    if (h.mode != null) setMode(String(h.mode));
    if (typeof h.enabled === 'boolean') setEnabled(h.enabled);
    if (typeof h.alwaysNew === 'boolean') setAlwaysNew(h.alwaysNew);
    if (h.globalShortcut != null) setGlobalShortcut(String(h.globalShortcut));
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
              <button type="button" className="btn btn-sm" style={{background:mode==='any_app'?'var(--surface-2)':'transparent'}} onClick={()=>{ setMode('any_app'); run('settings.save', { section:'hummingbird', mode:'any_app', enabled, alwaysNew, globalShortcut }, { silentError:true }); }}>Any app</button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={()=>{ setMode('meeting'); run('settings.save', { section:'hummingbird', mode:'meeting', enabled, alwaysNew, globalShortcut }, { silentError:true }); }}>Ongoing meeting</button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={()=>{ setMode('selection'); run('settings.save', { section:'hummingbird', mode:'selection', enabled, alwaysNew, globalShortcut }, { silentError:true }); }}>Selected text</button>
            </div>
            <div style={{margin:'0 16px 16px', border:'1px solid var(--border)', borderRadius:'var(--radius-md)', background:'#f4f1ea', padding:'40px 30px', fontFamily:'Georgia, serif', color:'#2a2420', position:'relative', minHeight:180}}>
              <div style={{fontSize:22, fontWeight:500, marginBottom:8}}>Creativity Is a Process, Not an Event</div>
              <div style={{fontSize:10, letterSpacing:'0.15em', color:'#6a5a4a', marginBottom:20}}>WRITTEN BY JAMES CLEAR · CREATIVITY</div>
              <div style={{fontSize:13, lineHeight:1.7, color:'#4a3a2a'}}>In 1666, one of the most influential scientists in history was strolling through a garden when he was struck with a flash of creative brilliance that would change the world.</div>
              <div style={{position:'absolute', bottom:20, left:'50%', transform:'translateX(-50%)', width:'70%', maxWidth:380, background:'var(--surface-2)', border:'1px solid var(--gold-dim)', borderRadius:'var(--radius-md)', padding:'10px 14px', display:'flex', alignItems:'center', gap:10, boxShadow:'0 8px 24px rgba(0,0,0,0.3)'}}>
                <Kamon size={12} color="var(--gold)"/>
                <span style={{fontSize:12, color:'var(--text-mute)'}}>Summarize this article about creativity</span>
                <span className="spacer"/>
                <button type="button" className="btn btn-sm btn-primary" style={{width:22, height:22, padding:0}} onClick={()=>run('settings.save', { section:'hummingbird', mode, enabled, alwaysNew, globalShortcut }, { successMessage:'Hummingbird mode saved' })}><Icon name="arrowUpRight" size={10}/></button>
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="s-card" style={{marginTop:14}}>
        <Row title="Enable Hummingbird" desc="Open SHOGUN from anywhere and ask about what's on your screen.">
          <Toggle on={enabled} onClick={()=>{ const next = !enabled; setEnabled(next); run('settings.save', { section:'hummingbird', mode, enabled: next, alwaysNew, globalShortcut }, { silentError:true }); }}/>
        </Row>
        <Row title="Global Shortcut" desc="Choose the global shortcut used to open Hummingbird">
          <select
            className="s-select"
            value={globalShortcut}
            onChange={(e) => {
              const v = e.target.value;
              setGlobalShortcut(v);
              run('settings.save', { section: 'hummingbird', mode, enabled, alwaysNew, globalShortcut: v }, { silentError: true });
            }}
          >
            <option value="option_double_tap">Tap Option twice</option>
            <option value="cmd_space">⌘ + Space</option>
          </select>
        </Row>
        <Row title="Always Start New Chat" desc="Start with a fresh chat each time you open Hummingbird" last>
          <Toggle on={alwaysNew} onClick={()=>{ const next = !alwaysNew; setAlwaysNew(next); run('settings.save', { section:'hummingbird', mode, enabled, alwaysNew: next, globalShortcut }, { silentError:true }); }}/>
        </Row>
      </div>
    </Pane>
  );
}

function PaneMeetings() {
  const { run } = useRuntimeActions();
  const { sections } = React.useContext(SettingsHydrationContext);
  const [notifScope, setNotifScope] = useStateS('confirmed_only');
  const [meetingLang, setMeetingLang] = useStateS('ja');
  const [remindersOn, setRemindersOn] = useStateS(true);
  const [reminderMins, setReminderMins] = useStateS('5');
  const [excludeNoGuests, setExcludeNoGuests] = useStateS(true);
  const [appDetectAlerts, setAppDetectAlerts] = useStateS(true);
  const [autoRecord, setAutoRecord] = useStateS(false);
  const [inactivityMins, setInactivityMins] = useStateS('15');
  const persist = React.useCallback(
    (patch) =>
      run(
        'settings.save',
        {
          section: 'meetings',
          notifScope,
          meetingLang,
          remindersOn,
          reminderMins,
          excludeNoGuests,
          appDetectAlerts,
          autoRecord,
          inactivityMins,
          ...patch,
        },
        { silentError: true },
      ),
    [
      run,
      notifScope,
      meetingLang,
      remindersOn,
      reminderMins,
      excludeNoGuests,
      appDetectAlerts,
      autoRecord,
      inactivityMins,
    ],
  );
  React.useEffect(() => {
    const m = sections.meetings;
    if (!m || typeof m !== 'object') return;
    if (m.notifScope != null) setNotifScope(String(m.notifScope));
    if (m.meetingLang != null) setMeetingLang(String(m.meetingLang));
    if (typeof m.remindersOn === 'boolean') setRemindersOn(m.remindersOn);
    if (m.reminderMins != null) setReminderMins(String(m.reminderMins));
    if (typeof m.excludeNoGuests === 'boolean') setExcludeNoGuests(m.excludeNoGuests);
    if (typeof m.appDetectAlerts === 'boolean') setAppDetectAlerts(m.appDetectAlerts);
    if (typeof m.autoRecord === 'boolean') setAutoRecord(m.autoRecord);
    if (m.inactivityMins != null) setInactivityMins(String(m.inactivityMins));
  }, [sections]);
  return (
    <Pane title="Meetings" jp="会議">
      <div className="s-card">
        <Row title="Meeting Notifications" desc="Choose when to get notified for upcoming meetings">
          <select
            className="s-select"
            value={notifScope}
            onChange={(e) => {
              const v = e.target.value;
              setNotifScope(v);
              void persist({ notifScope: v });
            }}
          >
            <option value="confirmed_only">Confirmed Only</option>
            <option value="all">All meetings</option>
          </select>
        </Row>
        <Row title="Meeting Language" desc="Choose the language that will be used for transcriptions">
          <select
            className="s-select"
            value={meetingLang}
            onChange={(e) => {
              const v = e.target.value;
              setMeetingLang(v);
              void persist({ meetingLang: v });
            }}
          >
            <option value="ja">Japanese</option>
            <option value="en">English</option>
            <option value="auto">Auto-detect</option>
          </select>
        </Row>
        <Row title="Meeting Reminders" desc="Show notifications before meetings start">
          <Toggle
            on={remindersOn}
            onClick={() => {
              const next = !remindersOn;
              setRemindersOn(next);
              void persist({ remindersOn: next });
            }}
          />
        </Row>
        <Row title="Reminder Time" desc="Set the time before a meeting to get a reminder">
          <select
            className="s-select"
            value={reminderMins}
            onChange={(e) => {
              const v = e.target.value;
              setReminderMins(v);
              void persist({ reminderMins: v });
            }}
          >
            <option value="1">1 Minute</option>
            <option value="5">5 Minutes</option>
            <option value="15">15 Minutes</option>
          </select>
        </Row>
        <Row title="Exclude Events Without Guests" desc="Don't show notifications for events without other guests or meeting links">
          <Toggle
            on={excludeNoGuests}
            onClick={() => {
              const next = !excludeNoGuests;
              setExcludeNoGuests(next);
              void persist({ excludeNoGuests: next });
            }}
          />
        </Row>
        <Row title="Meeting App Detection Alerts" desc="Show notifications when a meeting app is detected">
          <Toggle
            on={appDetectAlerts}
            onClick={() => {
              const next = !appDetectAlerts;
              setAppDetectAlerts(next);
              void persist({ appDetectAlerts: next });
            }}
          />
        </Row>
        <Row title="Auto-Start Recording on Detection" desc="Automatically start recording when a meeting app is detected and the notification timer expires">
          <Toggle
            on={autoRecord}
            onClick={() => {
              const next = !autoRecord;
              setAutoRecord(next);
              void persist({ autoRecord: next });
            }}
          />
        </Row>
        <Row title="Auto-Stop Inactivity Timeout" desc="Automatically stop transcription after inactivity" last>
          <select
            className="s-select"
            value={inactivityMins}
            onChange={(e) => {
              const v = e.target.value;
              setInactivityMins(v);
              void persist({ inactivityMins: v });
            }}
          >
            <option value="5">5 Minutes</option>
            <option value="15">15 Minutes</option>
            <option value="30">30 Minutes</option>
          </select>
        </Row>
      </div>
    </Pane>
  );
}

function PaneChat() {
  const { run, toast } = useRuntimeActions();
  const { sections, refreshSections } = React.useContext(SettingsHydrationContext);
  const [instr, setInstr] = useStateS('');
  const [notes, setNotes] = useStateS('');
  React.useEffect(() => {
    const vi = readSectionValue(sections, 'chat.instructions');
    const vn = readSectionValue(sections, 'chat.notes');
    if (vi !== undefined) setInstr(vi);
    if (vn !== undefined) setNotes(vn);
  }, [sections]);
  return (
    <Pane title="Chat" jp="対話">
      <Field label="Custom Instructions" hint="Personalize your interactions with SHOGUN by providing your own instructions">
        <textarea className="s-textarea" value={instr} onChange={e=>setInstr(e.target.value)} placeholder="Enter your custom instructions" rows={7}/>
        <div className="row" style={{marginTop:8}}>
          <span className="s-field-hint">No unsaved changes</span>
          <span className="spacer"/>
          <button type="button" className="btn btn-sm btn-ghost" onClick={()=>setInstr('')}>Discard</button>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={async () => {
              const r = await run(
                'settings.save',
                { section: 'chat.instructions', value: instr },
                { successMessage: 'Instructions saved' },
              );
              if (r && r.ok && refreshSections) await refreshSections();
            }}
          >
            Save
          </button>
        </div>
      </Field>
      <Field label="Assistant Notes" hint="Review and edit what SHOGUN has remembered from past chats to guide future conversations">
        <textarea className="s-textarea" value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Edit SHOGUN's memory" rows={8}/>
        <div className="row" style={{marginTop:8}}>
          <span className="s-field-hint">{notes.length} / 2000 characters</span>
          <span className="spacer"/>
          <button type="button" className="btn btn-sm btn-ghost" onClick={()=>setNotes('')}>Discard</button>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={async ()=>{
              if (notes.length > 2000) return toast('Assistant notes exceed 2000 characters', 'error');
              const r = await run(
                'settings.save',
                { section: 'chat.notes', value: notes },
                { successMessage: 'Assistant notes saved' },
              );
              if (r && r.ok && refreshSections) await refreshSections();
            }}
          >
            Save
          </button>
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
  const [embeddingModel, setEmbeddingModel] = useStateS('');
  const [maxTokens, setMaxTokens] = useStateS('');
  const [apiKeyDraft, setApiKeyDraft] = useStateS('');
  const [keyConfigured, setKeyConfigured] = useStateS(false);
  const [backfillLimit, setBackfillLimit] = useStateS(40);
  const [backfillDelayMs, setBackfillDelayMs] = useStateS(0);
  const [backfillBusy, setBackfillBusy] = useStateS(false);
  const [backfillProgress, setBackfillProgress] = useStateS(null);
  const [memorySemanticDefault, setMemorySemanticDefault] = useStateS(true);

  React.useEffect(() => {
    const listen = typeof window !== 'undefined' && window.__TAURI__?.event?.listen;
    if (typeof listen !== 'function') return undefined;
    let un;
    void (async () => {
      try {
        un = await listen('memory-embed-backfill-progress', (ev) => {
          const p = (ev && ev.payload) || {};
          const index = Number(p.index);
          const total = Number(p.total);
          if (Number.isFinite(index) && Number.isFinite(total)) {
            setBackfillProgress({ index, total });
          }
        });
      } catch (_) {
        /* ignore */
      }
    })();
    return () => {
      if (typeof un === 'function') un();
    };
  }, []);

  const refreshKeyStatus = React.useCallback(async () => {
    const r = await run('llm.api_key_status', {}, { silentError: true });
    if (r.ok && r.data && typeof r.data.configured === 'boolean') {
      setKeyConfigured(r.data.configured);
    }
  }, [run]);

  React.useEffect(() => {
    void refreshKeyStatus();
  }, [refreshKeyStatus]);

  const persistEmbedBackfillPrefs = React.useCallback(
    async (patch) => {
      const r = await run('settings.save', { section: 'llm', ...patch }, { silentError: true });
      if (r.ok && refreshSections) await refreshSections();
    },
    [run, refreshSections],
  );

  React.useEffect(() => {
    const l = sections.llm;
    if (!l || typeof l !== 'object') return;
    if (l.baseUrl != null) setBaseUrl(String(l.baseUrl));
    if (l.model != null) setModel(String(l.model));
    if (l.embeddingModel != null) setEmbeddingModel(String(l.embeddingModel));
    if (l.maxTokens != null) setMaxTokens(String(l.maxTokens));
    if (l.embedBackfillBatch != null) setBackfillLimit(normalizeEmbedBackfillBatch(l.embedBackfillBatch));
    if (l.embedBackfillDelayMs != null) setBackfillDelayMs(normalizeEmbedBackfillDelayMs(l.embedBackfillDelayMs));
  }, [sections]);

  React.useEffect(() => {
    const m = sections.memory;
    if (m && typeof m === 'object' && typeof m.semanticRerank === 'boolean') {
      setMemorySemanticDefault(m.semanticRerank);
    }
  }, [sections]);

  return (
    <Pane
      title="Model & API"
      jp="モデル"
      subtitle="OpenAI-compatible chat/completions and /v1/embeddings (Memory semantic search). Endpoint and models are saved locally; the API key stays in the macOS Keychain."
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
        <Field label="Chat model" hint="Passed as the model field in chat/completions requests.">
          <input
            className="s-input"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-4o-mini"
            autoComplete="off"
          />
        </Field>
        <Field
          label="Embedding model"
          hint="Used for /v1/embeddings (Memory ingest + semantic re-rank). Same API key and base URL."
        >
          <input
            className="s-input"
            value={embeddingModel}
            onChange={(e) => setEmbeddingModel(e.target.value)}
            placeholder="text-embedding-3-small"
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
                {
                  section: 'llm',
                  baseUrl: baseUrl.trim(),
                  model: model.trim(),
                  embeddingModel: embeddingModel.trim() || 'text-embedding-3-small',
                  maxTokens: mt,
                  embedBackfillBatch: backfillLimit,
                  embedBackfillDelayMs: backfillDelayMs,
                },
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

      <div className="s-card" style={{padding:20}}>
        <Field
          label="Memory embeddings"
          hint="Writes missing vectors for indexed memories (skips capture_sampler / capture_ax noise). Uses /v1/embeddings and your key. Large batches can take a while; add a pause between rows if the API rate-limits. Batch and pause are saved to settings when you change them (and with Save endpoint). Transient API errors retry with exponential backoff; only the first error message is kept for the summary toast."
        >
          <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <label className="row" style={{ gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--text-dim)' }}>
              <span>Batch</span>
              <select
                className="s-select"
                style={{ minWidth: 72 }}
                value={String(backfillLimit)}
                disabled={backfillBusy}
                onChange={async (e) => {
                  const n = normalizeEmbedBackfillBatch(e.target.value);
                  setBackfillLimit(n);
                  await persistEmbedBackfillPrefs({ embedBackfillBatch: n });
                }}
              >
                {EMBED_BACKFILL_BATCH_OPTS.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <label className="row" style={{ gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--text-dim)' }}>
              <span>Pause</span>
              <select
                className="s-select"
                style={{ minWidth: 88 }}
                value={String(backfillDelayMs)}
                disabled={backfillBusy}
                onChange={async (e) => {
                  const ms = normalizeEmbedBackfillDelayMs(e.target.value);
                  setBackfillDelayMs(ms);
                  await persistEmbedBackfillPrefs({ embedBackfillDelayMs: ms });
                }}
              >
                <option value={0}>Off</option>
                <option value={250}>250 ms</option>
                <option value={500}>500 ms</option>
                <option value={1000}>1 s</option>
              </select>
            </label>
            {backfillBusy ? (
              <span className="t-mono" style={{ fontSize: 11, color: 'var(--gold)' }}>
                {backfillProgress
                  ? `${backfillProgress.index} / ${backfillProgress.total}`
                  : `0 / ${backfillLimit}`}
              </span>
            ) : null}
            {backfillBusy ? (
              <button
                className="btn btn-sm btn-ghost"
                type="button"
                onClick={() =>
                  void run('memory.embed_backfill_cancel', {}, { silentError: true })
                }
              >
                Cancel
              </button>
            ) : null}
          </div>
          <button
            className="btn btn-sm btn-secondary"
            type="button"
            disabled={!keyConfigured || backfillBusy}
            onClick={async () => {
              setBackfillBusy(true);
              setBackfillProgress({ index: 0, total: backfillLimit });
              try {
                const r = await run(
                  'memory.embed_backfill',
                  { limit: backfillLimit, delayMs: backfillDelayMs },
                  { silentError: true },
                );
                if (!r.ok) {
                  toast(r.error?.message || 'Backfill failed', 'error');
                  return;
                }
                const cancelled = r.data && r.data.cancelled === true;
                if (cancelled) {
                  toast('Backfill cancelled', 'info');
                  return;
                }
                const em = r.data && typeof r.data.embedded === 'number' ? r.data.embedded : 0;
                const fl = r.data && typeof r.data.failed === 'number' ? r.data.failed : 0;
                const rem = r.data && typeof r.data.remaining === 'number' ? r.data.remaining : null;
                const fe = r.data && typeof r.data.firstError === 'string' ? r.data.firstError : '';
                let msg = `Embedded ${em} · failed ${fl}`;
                if (rem != null && rem > 0) msg += ` · ~${rem} still missing`;
                toast(msg, fl ? 'warn' : 'success');
                if (fl > 0 && fe) toast(fe.length > 200 ? `${fe.slice(0, 200)}…` : fe, 'warn');
              } finally {
                setBackfillBusy(false);
                setBackfillProgress(null);
              }
            }}
          >
            Backfill missing vectors
          </button>
        </Field>
      </div>

      <div className="s-card" style={{ padding: 20, marginTop: 16 }}>
        <Row
          title="Memory: semantic search default"
          desc="When enabled, Memory searches that include query text ask the embeddings API once per search to re-rank lexical hits (same setting as the checkbox on the Memory timeline). Stored under settings → memory."
          last
        >
          <Toggle
            on={memorySemanticDefault}
            onClick={() => {
              const next = !memorySemanticDefault;
              setMemorySemanticDefault(next);
              void run(
                'settings.save',
                { section: 'memory', semanticRerank: next },
                { successMessage: 'Memory search preference saved' },
              );
            }}
          />
        </Row>
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
        <Row title={<div className="row" style={{gap:10}}><IntegrationLogo slug="apple_calendar" size={30} title="Apple Calendar" /><div><div style={{fontSize:13, fontWeight:500}}>Apple Calendar <span className="label label-gold" style={{marginLeft:4}}>Beta</span></div><div className="s-field-hint">See your events in Apple Calendar</div></div></div>} last>
          <button className="btn btn-sm btn-secondary" type="button" onClick={()=>run('integrations.connect', { provider:'apple_calendar' }, { silentError:true })}>Connect</button>
        </Row>
      </div>
      <div className="s-card" style={{marginBottom:10}}>
        <Row title={<div className="row" style={{gap:10}}><IntegrationLogo slug="apple_reminders" size={30} title="Apple Reminders" /><div><div style={{fontSize:13, fontWeight:500}}>Apple Reminders <span className="label label-gold" style={{marginLeft:4}}>Beta</span></div><div className="s-field-hint">See your reminders and tasks in Apple Reminders</div></div></div>} last>
          <button className="btn btn-sm btn-secondary" type="button" onClick={()=>run('integrations.connect', { provider:'apple_reminders' }, { silentError:true })}>Connect</button>
        </Row>
      </div>
      <div className="s-card" style={{marginBottom:10}}>
        <div className="row" style={{padding:'14px 16px'}}>
          <IntegrationLogo slug="gmail" size={30} title="Gmail" />
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
          <IntegrationLogo slug="google_calendar" size={30} title="Google Calendar" />
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
      {[
        { slug: 'google_drive', title: 'Google Drive' },
        { slug: 'outlook', title: 'Outlook' },
        { slug: 'notion', title: 'Notion' },
        { slug: 'linear', title: 'Linear' },
        { slug: 'slack', title: 'Slack' },
      ].map((s) => (
        <div key={s.slug} className="s-card" style={{marginBottom:8}}>
          <Row last title={<div className="row" style={{gap:10}}><IntegrationLogo slug={s.slug} size={30} title={s.title} /><div style={{fontSize:13, fontWeight:500}}>{s.title}</div></div>}>
            <button className="btn btn-sm btn-secondary" type="button" onClick={()=>run('integrations.connect', { provider: s.slug }, { silentError:true })}>Connect</button>
          </Row>
        </div>
      ))}
    </Pane>
  );
}

function PaneShortcuts() {
  const { run, toast } = useRuntimeActions();
  const { sections, refreshSections } = React.useContext(SettingsHydrationContext);
  const Kbd = typeof window !== 'undefined' ? window.ShogunKeyboardShortcuts : null;
  const merged = React.useMemo(() => {
    if (!Kbd) return null;
    return Kbd.mergeShortcutBindings(sections.shortcuts && sections.shortcuts.bindings);
  }, [sections.shortcuts, Kbd]);

  const groups = React.useMemo(() => {
    if (!Kbd || !merged) return [];
    return Kbd.SHORTCUT_UI_GROUPS.map((g) => ({
      name: g.name,
      rows: g.items.map(({ label, actionId }) => ({
        label,
        keys: Kbd.bindingToDisplayParts(merged[actionId]),
      })),
    }));
  }, [Kbd, merged]);

  const [jsonText, setJsonText] = useStateS('{}');
  React.useEffect(() => {
    const raw = sections.shortcuts && sections.shortcuts.bindings;
    setJsonText(JSON.stringify(raw && typeof raw === 'object' ? raw : {}, null, 2));
  }, [sections.shortcuts]);

  const applyFromRuntime = React.useCallback((bindings) => {
    if (window.SHOGUN_RUNTIME && window.SHOGUN_RUNTIME.applyShortcutBindings) {
      window.SHOGUN_RUNTIME.applyShortcutBindings(bindings);
    }
  }, []);

  const saveJson = async () => {
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        toast('JSON must be an object: action id -> { key, super, ctrl, alt, shift }', 'error');
        return;
      }
    } catch (_err) {
      toast('Invalid JSON', 'error');
      return;
    }
    const res = await run(
      'settings.save',
      { section: 'shortcuts', bindings: parsed },
      { silentError: true, successMessage: 'Shortcuts saved' },
    );
    if (res && res.ok) {
      applyFromRuntime(parsed);
      await refreshSections();
    }
  };

  const resetDefaults = async () => {
    const res = await run(
      'settings.save',
      { section: 'shortcuts', bindings: {} },
      { silentError: true, successMessage: 'Shortcuts reset to defaults' },
    );
    if (res && res.ok) {
      applyFromRuntime({});
      setJsonText('{}');
      await refreshSections();
    }
  };

  if (!Kbd || !merged) {
    return (
      <Pane title="Keyboard Shortcuts" jp="捷径">
        <div className="s-field-hint">Shortcut module not loaded. Ensure keyboard-shortcuts.js is included before app.jsx.</div>
      </Pane>
    );
  }

  const actionIds = Object.keys(Kbd.DEFAULT_BINDINGS).join(', ');

  return (
    <Pane title="Keyboard Shortcuts" jp="捷径">
      {groups.map((g) => (
        <div key={g.name} style={{ marginBottom: 18 }}>
          <div className="s-field-label" style={{ marginBottom: 8 }}>{g.name}</div>
          <div className="s-card">
            {g.rows.map((row, i, arr) => (
              <div key={row.label} className={'s-row' + (i === arr.length - 1 ? ' last' : '')}>
                <div style={{ flex: 1, fontSize: 13 }}>{row.label}</div>
                <div className="row" style={{ gap: 4 }}>
                  {row.keys.map((k, j) => (
                    <span key={j} className="s-kbd">{k}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      <div style={{ marginTop: 22 }}>
        <div className="s-field-label" style={{ marginBottom: 8 }}>Overrides (JSON)</div>
        <div className="s-field-hint" style={{ marginBottom: 8 }}>
          Only list keys you want to change. Booleans: super (Cmd/Ctrl chord), ctrl (Control), alt, shift. Example:
          {' '}
          <span className="t-mono" style={{ fontSize: 11 }}>{'{"shortcut.new_chat":{"key":"e","super":true,"ctrl":false,"alt":false,"shift":false}}'}</span>
        </div>
        <textarea
          className="s-input"
          value={jsonText}
          onChange={(e) => setJsonText(e.target.value)}
          rows={12}
          style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.45 }}
          spellCheck={false}
        />
        <div className="row" style={{ gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => void saveJson()}>Save</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void resetDefaults()}>Reset to defaults</button>
        </div>
        <div className="s-field-hint" style={{ marginTop: 10, fontSize: 11, lineHeight: 1.5 }}>
          Action ids: <span className="t-mono">{actionIds}</span>
        </div>
      </div>
    </Pane>
  );
}

/** Shown prices are UI copy; billing is finalized at checkout. Annual = 15% off vs list monthly. */
const SUB_PLUS_MONTHLY_USD = 20;
const SUB_PRO_5X_MONTHLY_USD = 100;
const SUB_PRO_12X_MONTHLY_USD = 200;
const SUB_ANNUAL_OFF_PCT = 15;

function subscriptionAnnualEquivMonthly(monthlyUsd) {
  return Math.round(monthlyUsd * (100 - SUB_ANNUAL_OFF_PCT)) / 100;
}

function PaneSubscription() {
  const { run } = useRuntimeActions();
  const { sections } = React.useContext(SettingsHydrationContext);
  const [billingCycle, setBillingCycle] = useStateS('annual');
  const [referralCode, setReferralCode] = useStateS('');
  React.useEffect(() => {
    const s = sections.subscription;
    if (s && s.billingCycle != null) setBillingCycle(String(s.billingCycle));
    if (s && s.referralCodeDraft != null) setReferralCode(String(s.referralCodeDraft));
  }, [sections]);

  const isAnnual = billingCycle === 'annual';
  const plusListMo = SUB_PLUS_MONTHLY_USD;
  const plusEffMo = subscriptionAnnualEquivMonthly(SUB_PLUS_MONTHLY_USD);
  const plusAnnualCharge = Math.round(plusEffMo * 12);
  const pro5Mo = isAnnual ? subscriptionAnnualEquivMonthly(SUB_PRO_5X_MONTHLY_USD) : SUB_PRO_5X_MONTHLY_USD;
  const pro12Mo = isAnnual ? subscriptionAnnualEquivMonthly(SUB_PRO_12X_MONTHLY_USD) : SUB_PRO_12X_MONTHLY_USD;
  const pro5AnnualCharge = Math.round(subscriptionAnnualEquivMonthly(SUB_PRO_5X_MONTHLY_USD) * 12);
  const pro12AnnualCharge = Math.round(subscriptionAnnualEquivMonthly(SUB_PRO_12X_MONTHLY_USD) * 12);

  const persistBilling = (cycle) => {
    setBillingCycle(cycle);
    run('settings.save', { section: 'subscription', billingCycle: cycle }, { silentError: true });
  };

  const plusFeatures = [
    'Higher chat & model limits vs Basic',
    'Full Memory search, ingest, and timeline',
    'Meetings: transcription, notes, and calendar-aware context',
    'Hummingbird: screen-aware quick ask',
    'Standard image generation tier',
    'Email support',
  ];
  const proFeatures = [
    '5× or 12× usage multiplier vs Plus (pick a tier)',
    'Larger context windows and batch jobs',
    'Premium / max-intelligence model routing',
    'Premium image generation tier',
    'Early access to new SHOGUN features',
  ];

  return (
    <Pane title="Subscription" jp="契約">
      <div
        className="s-field-hint"
        style={{
          marginBottom: 14,
          padding: 12,
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 12,
          lineHeight: 1.55,
        }}
      >
        <strong className="en-only">Important:</strong>
        <strong className="jp">重要:</strong> Prices and plan buttons below are <strong>UI / product design</strong> until a payment
        provider is connected. Actions may only persist preferences locally. See{' '}
        <TermsNoticeAnchor>Terms of Service</TermsNoticeAnchor>.
        <div className="jp" style={{ marginTop: 8, fontSize: 11, color: 'var(--text-dim)' }}>
          表示価格・「トライアル」「プラン選択」等は、決済基盤が接続されるまで<strong>画面イメージまたはローカル保存のみ</strong>の場合があります。課金が発生する前に必ず利用規約を確認してください。
        </div>
      </div>
      <div className="s-subscription-grid">
        <div className="s-card" style={{padding:20}}>
          <div className="row">
            <div style={{fontSize:16, fontWeight:500}}>Plus</div>
            <span className="spacer"/>
            <div style={{display:'flex', border:'1px solid var(--border)', borderRadius:'var(--radius-sm)', overflow:'hidden'}}>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                style={{borderRadius:0, background:billingCycle==='monthly'?'var(--surface-2)':'transparent', color:billingCycle==='monthly'?'var(--text)':'var(--text-mute)'}}
                onClick={() => persistBilling('monthly')}
              >
                Monthly
              </button>
              <button
                type="button"
                className="btn btn-sm"
                style={{borderRadius:0, background:billingCycle==='annual'?'var(--surface-2)':'transparent', color:billingCycle==='annual'?'var(--text)':'var(--text-mute)'}}
                onClick={() => persistBilling('annual')}
              >
                Annual
              </button>
            </div>
          </div>
          <div style={{fontSize:36, fontWeight:600, marginTop:16, letterSpacing:'-0.02em', lineHeight:1.15}}>
            ${isAnnual ? plusEffMo : plusListMo}
            <span style={{fontSize:14, color:'var(--text-dim)', fontWeight:400}}>/mo</span>
            {isAnnual ? (
              <span className="label label-gold" style={{marginLeft:8, verticalAlign:'middle'}}>-{SUB_ANNUAL_OFF_PCT}%</span>
            ) : null}
          </div>
          <div className="s-field-hint" style={{marginTop:8, fontSize:12, lineHeight:1.5}}>
            {isAnnual
              ? `Equivalent monthly rate · $${plusAnnualCharge} billed once per year (vs $${plusListMo}/mo on Monthly).`
              : `Billed $${plusListMo} every month · switch to Annual for −${SUB_ANNUAL_OFF_PCT}% (≈ $${plusEffMo}/mo).`}
          </div>
          <div style={{marginTop:18, fontSize:12, color:'var(--text-mute)'}}>Everything in Basic, plus:</div>
          <ul style={{margin:'8px 0 0', padding:0, listStyle:'none', fontSize:12, lineHeight:1.9}}>
            {plusFeatures.map((f) => (
              <li key={f}><Icon name="check" size={11} className="gold" style={{marginRight:8}}/>{f}</li>
            ))}
          </ul>
          <button
            type="button"
            className="btn btn-secondary"
            style={{width:'100%', marginTop:18}}
            onClick={() =>
              run(
                'settings.save',
                { section: 'subscription', plan: 'plus_trial', billingCycle },
                { successMessage: 'Trial request submitted' },
              )
            }
          >
            Start 14-day free trial
          </button>
        </div>
        <div className="s-card" style={{padding:20}}>
          <div className="row" style={{alignItems:'flex-start'}}>
            <div>
              <div style={{fontSize:16, fontWeight:500}}>Pro</div>
              <div className="s-field-hint" style={{marginTop:4, fontSize:11, maxWidth:280}}>
                Same billing toggle as Plus ({isAnnual ? 'Annual' : 'Monthly'}) — prices below update automatically.
              </div>
            </div>
          </div>
          <div style={{fontSize:36, fontWeight:600, marginTop:12, letterSpacing:'-0.02em'}}>
            From ${pro5Mo}<span style={{fontSize:14, color:'var(--text-dim)', fontWeight:400}}>/mo</span>
            {isAnnual ? (
              <span className="label label-gold" style={{marginLeft:8, verticalAlign:'middle', fontSize:11}}>5× tier · annual</span>
            ) : null}
          </div>
          <div className="s-field-hint" style={{marginTop:6, fontSize:12, lineHeight:1.5}}>
            {isAnnual
              ? `5×: $${pro5AnnualCharge}/yr · 12×: $${pro12AnnualCharge}/yr when paid annually.`
              : `5×: $${SUB_PRO_5X_MONTHLY_USD}/mo · 12×: $${SUB_PRO_12X_MONTHLY_USD}/mo billed monthly.`}
          </div>
          <div style={{marginTop:18, fontSize:12, color:'var(--text-mute)'}}>Everything in Plus, plus:</div>
          <ul style={{margin:'8px 0 0', padding:0, listStyle:'none', fontSize:12, lineHeight:1.9}}>
            {proFeatures.map((f) => (
              <li key={f}><Icon name="check" size={11} className="gold" style={{marginRight:8}}/>{f}</li>
            ))}
          </ul>
          <button
            type="button"
            className="s-tier-btn"
            onClick={() =>
              run(
                'settings.save',
                { section: 'subscription', plan: 'pro_5x', billingCycle },
                { successMessage: 'Plan selection submitted' },
              )
            }
          >
            <span>Choose Pro 5×</span>
            <span style={{color:'var(--text-dim)'}}>
              ${pro5Mo}/mo{isAnnual ? ` · $${pro5AnnualCharge}/yr` : ''}
            </span>
          </button>
          <button
            type="button"
            className="s-tier-btn"
            onClick={() =>
              run(
                'settings.save',
                { section: 'subscription', plan: 'pro_12x', billingCycle },
                { successMessage: 'Plan selection submitted' },
              )
            }
          >
            <span>Choose Pro 12×</span>
            <span style={{color:'var(--text-dim)'}}>
              ${pro12Mo}/mo{isAnnual ? ` · $${pro12AnnualCharge}/yr` : ''}
            </span>
          </button>
        </div>
      </div>
      <div className="s-card" style={{marginTop:14, padding:16}}>
        <div style={{fontSize:13, fontWeight:500}}>Have a referral code?</div>
        <div className="s-field-hint" style={{marginTop:2}}>Enter a code to unlock referral rewards</div>
        <div className="row" style={{gap:8, marginTop:10}}>
          <input
            className="s-input"
            placeholder="Enter referral code"
            style={{flex:1}}
            value={referralCode}
            onChange={(e) => setReferralCode(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() =>
              run(
                'settings.save',
                {
                  section: 'subscription',
                  action: 'apply_referral',
                  referralCode: referralCode.trim(),
                  referralCodeDraft: referralCode.trim(),
                },
                { successMessage: 'Referral code submitted' },
              )
            }
          >
            Apply
          </button>
        </div>
      </div>
      <div style={{marginTop:14, textAlign:'center', fontSize:12, color:'var(--text-dim)'}}>
        Want SHOGUN for your team or business?{' '}
        <a className="s-link" href={SHOGUN_ISSUES} target="_blank" rel="noopener noreferrer">
          Contact via GitHub Issues <Icon name="arrowUpRight" size={10} />
        </a>
      </div>
    </Pane>
  );
}

function PaneTeam() {
  const { run } = useRuntimeActions();
  return (
    <Pane title="Team" jp="組">
      <div className="s-card" style={{padding:20}}>
        <div className="s-field-hint" style={{ marginBottom: 12, fontSize: 11, lineHeight: 1.5 }}>
          Team checkout and seat billing are <strong>not connected</strong> in v1 — this pane is a product preview. Use{' '}
          <a className="s-link" href={SHOGUN_ISSUES} target="_blank" rel="noopener noreferrer">
            Issues
          </a>{' '}
          for enterprise interest.
        </div>
        <div style={{fontSize:16, fontWeight:500}}>SHOGUN for Teams <span className="jp dim" style={{fontSize:11, marginLeft:6}}>組織版</span></div>
        <div className="s-field-hint" style={{marginTop:6}}>Get SHOGUN for your whole company with one subscription.</div>
        <ul style={{margin:'16px 0 0', padding:0, listStyle:'none', fontSize:13, lineHeight:2}}>
          {['Centralized billing for your company','Invite and manage team members','Mix Plus and Pro seats in one team'].map(f=>(
            <li key={f}><Icon name="check" size={11} className="gold" style={{marginRight:8}}/>{f}</li>
          ))}
        </ul>
        <div style={{borderTop:'1px solid var(--border)', marginTop:16, paddingTop:14}} className="row">
          <button className="btn btn-secondary" onClick={()=>run('settings.save', { section:'team', action:'create' }, { successMessage:'Team creation flow started' })}>Create a Team</button>
          <span className="s-field-hint" style={{marginLeft:12}}>
            {`Starting at $${subscriptionAnnualEquivMonthly(SUB_PLUS_MONTHLY_USD)}/seat/mo billed annually (vs $${SUB_PLUS_MONTHLY_USD} on monthly)`}
          </span>
        </div>
      </div>
    </Pane>
  );
}

function PaneSupport() {
  const { run } = useRuntimeActions();
  return (
    <Pane title="Support" jp="支援">
      <div className="s-field-hint" style={{ marginBottom: 14, padding: 12, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: 12, lineHeight: 1.55 }}>
        <span className="en-only">Primary channel:</span>
        <span className="jp">主な連絡先:</span>{' '}
        <a className="s-link" href={SHOGUN_ISSUES} target="_blank" rel="noopener noreferrer">
          GitHub Issues（不具合・要望）
        </a>
        。Discord 等のコミュニティは準備中の場合があります。
      </div>
      <div className="s-card">
        <Row title="GitHub Issues" desc="Bug reports, feature requests, and setup questions for this repository.">
          <a className="btn btn-sm btn-secondary" href={SHOGUN_ISSUES} target="_blank" rel="noopener noreferrer">
            Open Issues
          </a>
        </Row>
        <Row title="Join our Discord" desc="Community Discord is not guaranteed in v1 — check Issues for updates.">
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled
            title="Coming soon"
            onClick={() => run('settings.save', { section: 'support', action: 'discord' }, { successMessage: 'Discord action queued' })}
          >
            Join Discord
          </button>
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
  meetings: PaneMeetings, chat: PaneChat, llm: PaneLLM, integrations: PaneIntegrations,
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
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  const hydrationCtxValue = React.useMemo(
    () => ({ sections: hydratedSections, refreshSections }),
    [hydratedSections, refreshSections],
  );
  const tree = (
    <SettingsHydrationContext.Provider value={hydrationCtxValue}>
    <>
      <div className="s-backdrop" role="presentation" tabIndex={-1} onMouseDown={(e) => { e.preventDefault(); close(); }}/>
      <div className="s-modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="s-sidebar">
          <div className="t-mono" style={{padding:'14px 14px 16px', fontSize:10, color:'var(--text-dim)', letterSpacing:'0.2em'}}>
            SETTINGS · 設定
          </div>
          <div className="s-nav-list">
            {SETTINGS_NAV.map(n => (
              <div key={n.id} className={'s-nav '+(resolved===n.id?'active':'')} onClick={()=>setPane(n.id)}>
                <Icon name={n.icon} size={13}/>
                <span className="en-only">{n.label}</span>
                <span className="jp">{n.jp}</span>
              </div>
            ))}
          </div>
          <div style={{padding:'10px 14px', borderTop:'1px solid var(--border)', display:'flex', alignItems:'center', gap:8}}>
            <Kamon size={11} color="var(--gold)"/>
            <span className="t-mono" style={{fontSize:9, color:'var(--text-dim)'}}>SHOGUN v0.4.1</span>
          </div>
        </div>
        <div className="s-content">
          <button type="button" className="s-close" aria-label="Close settings" onClick={(e) => { e.stopPropagation(); close(); }}><Icon name="x" size={14}/></button>
          <PaneComp/>
        </div>
      </div>

      <style>{`
        .s-backdrop {
          position:fixed; inset:0; z-index:1100;
          background:rgba(10,9,8,0.55);
          backdrop-filter: blur(6px);
          animation: sBackIn 160ms var(--ease-out);
        }
        @keyframes sBackIn { from {opacity:0;} to {opacity:1;} }
        .s-modal {
          position:fixed; z-index:1101;
          top:50%; left:50%; transform:translate(-50%, -50%);
          box-sizing:border-box;
          /*
 Centered settings dialog — scales up on large / fullscreen viewports so content is not tiny.
          */
          --s-edge: max(16px, min(48px, 5vmin));
          --s-safe-x: calc(env(safe-area-inset-left, 0px) + env(safe-area-inset-right, 0px));
          --s-safe-y: calc(env(safe-area-inset-top, 0px) + env(safe-area-inset-bottom, 0px));
          --s-max-view-w: calc(100vw - 2 * var(--s-edge) - var(--s-safe-x));
          --s-max-view-h: calc(100dvh - 2 * var(--s-edge) - var(--s-safe-y));
          --s-pref-w: min(1200px, min(92vw, var(--s-max-view-w)));
          --s-pref-h: clamp(400px, 86dvh, min(820px, var(--s-max-view-h)));
          width:min(var(--s-pref-w), var(--s-max-view-w));
          height:min(var(--s-pref-h), var(--s-max-view-h));
          max-width:var(--s-max-view-w);
          max-height:var(--s-max-view-h);
          min-height:min(384px, var(--s-max-view-h));
          background:var(--bg);
          border:1px solid var(--border-hi);
          border-radius:var(--radius-lg);
          box-shadow:0 40px 80px -20px rgba(0,0,0,0.7), 0 2px 0 rgba(0,0,0,0.4);
          display:flex; overflow:hidden;
          animation: sModalIn 220ms var(--ease-out);
        }
        @keyframes sModalIn {
          from { opacity:0; }
          to { opacity:1; }
        }
        .s-nav-list {
          flex:1; min-height:0; overflow-y:auto;
          padding:0 8px;
        }
        .s-sidebar {
          width:200px; flex-shrink:0; min-height:0;
          border-right:1px solid var(--border);
          background:var(--surface);
          display:flex; flex-direction:column;
        }
        .s-appearance-grid {
          display:grid;
          grid-template-columns:repeat(3, minmax(0, 1fr));
          gap:14px;
          margin-bottom:24px;
        }
        .s-subscription-grid {
          display:grid;
          grid-template-columns:repeat(2, minmax(0, 1fr));
          gap:14px;
        }
        .s-nav {
          display:flex; align-items:center; gap:8px;
          padding:7px 10px; border-radius:var(--radius-sm);
          color:var(--text-mute); font-size:12px; cursor:pointer;
          margin-bottom:1px;
        }
        .s-nav:hover { background:var(--surface-2); color:var(--text); }
        .s-nav.active {
          background:var(--surface-2); color:var(--text);
          border:1px solid var(--border);
        }
        .s-nav .jp { font-family:var(--font-jp); font-weight:300; font-size:10.5px; color:var(--text-dim); margin-left:-4px; }

        .s-content {
          flex:1; min-width:0; min-height:0; overflow-y:auto; position:relative;
          padding:22px 28px 36px;
        }
        .s-close {
          position:absolute; top:12px; right:12px;
          width:28px; height:28px; border-radius:6px;
          background:transparent; border:1px solid transparent;
          color:var(--text-mute); cursor:pointer;
          display:flex; align-items:center; justify-content:center;
          z-index:2;
        }
        .s-close:hover { background:var(--surface); border-color:var(--border); color:var(--text); }

        .s-pane-head { margin-bottom:18px; }
        .s-pane-sub { margin-top:6px; font-size:12px; color:var(--text-mute); line-height:1.55; max-width:min(960px, 100%); }
        .s-pane-body { max-width:min(960px, 100%); }

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

        @media (max-width: 1024px) {
          .s-modal {
            width:min(1440px, calc(100vw - 32px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)));
            height:calc(100vh - 32px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
            height:calc(100dvh - 32px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
            max-width:calc(100vw - 32px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px));
            max-height:calc(100vh - 32px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
            max-height:calc(100dvh - 32px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
          }
          .s-sidebar { width:200px; }
          .s-content { padding:24px 28px 40px; }
        }

        @media (max-width: 768px) {
          .s-modal {
            flex-direction:column;
            width:calc(100vw - 24px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px));
            height:calc(100vh - 24px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
            height:calc(100dvh - 24px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
            max-width:calc(100vw - 24px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px));
            max-height:calc(100vh - 24px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
            max-height:calc(100dvh - 24px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
          }
          .s-sidebar {
            width:100%;
            max-height:min(40vh, 280px);
            border-right:none;
            border-bottom:1px solid var(--border);
            flex-shrink:0;
          }
          .s-nav-list {
            flex:1 1 auto;
            overflow-x:auto;
            overflow-y:hidden;
            -webkit-overflow-scrolling:touch;
            display:flex;
            flex-direction:row;
            flex-wrap:nowrap;
            gap:6px;
            padding:4px 10px 10px;
            scrollbar-width:thin;
          }
          .s-nav {
            flex-shrink:0;
            margin-bottom:0;
            padding:10px 14px;
          }
          .s-content {
            flex:1;
            min-height:0;
            padding:20px 18px 32px;
            padding-top:max(20px, env(safe-area-inset-top, 0px));
          }
          .s-close {
            top:max(12px, env(safe-area-inset-top, 0px));
            right:max(12px, env(safe-area-inset-right, 0px));
            width:40px;
            height:40px;
            min-width:44px;
            min-height:44px;
          }
          .s-appearance-grid {
            grid-template-columns:1fr;
            gap:12px;
          }
          .s-subscription-grid {
            grid-template-columns:1fr;
          }
        }

        @media (max-width: 520px) {
          .s-modal {
            width:100%;
            max-width:100%;
            height:100%;
            max-height:100%;
            top:0;
            left:0;
            transform:none;
            border-radius:0;
            border-left:none;
            border-right:none;
            height:100dvh;
            max-height:100dvh;
            padding-top:env(safe-area-inset-top, 0px);
            padding-bottom:env(safe-area-inset-bottom, 0px);
            padding-left:env(safe-area-inset-left, 0px);
            padding-right:env(safe-area-inset-right, 0px);
          }
          .s-content { padding:16px 14px 28px; }
          .s-pane-head h2 { font-size:18px !important; }
          .s-row {
            flex-wrap:wrap;
            align-items:flex-start;
            gap:12px;
          }
          .s-row > div:last-child {
            width:100%;
            display:flex;
            justify-content:flex-end;
          }
          .s-select { max-width:100%; }
        }

        @media (max-width: 768px) and (min-width: 521px) {
          .s-appearance-grid {
            grid-template-columns:repeat(2, minmax(0, 1fr));
          }
        }
      `}</style>
    </>
    </SettingsHydrationContext.Provider>
  );
  return ReactDOM.createPortal(tree, document.body);
}

window.SettingsModal = SettingsModal;

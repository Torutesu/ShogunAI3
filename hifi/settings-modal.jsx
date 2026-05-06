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
  {id:'kioku_graph',    label:'KIOKU Graph',        jp:'記憶グラフ', icon:'memory'},
  {id:'kioku_patterns', label:'KIOKU Patterns',     jp:'常套',     icon:'clock'},
  {id:'kioku_lessons',  label:'KIOKU Lessons',      jp:'教訓',     icon:'graduation'},
  {id:'integrations',   label:'Integrations',       jp:'連携', icon:'plug'},
  {id:'shortcuts',    label:'Keyboard Shortcuts', jp:'捷径', icon:'keyboard'},
  {id:'team',         label:'Team',               jp:'組',   icon:'users'},
  {id:'support',      label:'Support',            jp:'支援', icon:'info'},
];

// Alias panes from quick menu to the canonical settings panes
const PANE_ALIAS = {
  upgrade:'general', feedback:'support', download:'general',
  referral:'general', changelog:'general', api:'llm',
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

const PRIVACY_DEFAULT_APPS = [
  { id: 'preset-finder', name: 'Finder', icon: '📁', enabled: true },
  { id: 'preset-1password', name: '1Password', icon: '🔐', enabled: true },
  { id: 'preset-banking', name: 'Banking', icon: '🏦', enabled: true },
];
const PRIVACY_DEFAULT_SITES = [
  { id: 'site-ex1', host: 'internal.corp.example', label: 'Corporate SSO (example)', enabled: true },
  { id: 'site-ex2', host: 'pay.vendor.example', label: 'Vendor payments (example)', enabled: false },
];

function normalizePrivacyFromSettings(sec) {
  let apps = sec && Array.isArray(sec.excludedApps) ? sec.excludedApps : null;
  let sites = sec && Array.isArray(sec.excludedSites) ? sec.excludedSites : null;
  if (!apps && sec && typeof sec.app === 'string' && sec.app) {
    apps = [{ id: 'legacy-app', name: sec.app, icon: '📱', enabled: !!sec.enabled }];
  }
  if (!apps) apps = PRIVACY_DEFAULT_APPS.map((r) => ({ ...r }));
  if (!sites) sites = PRIVACY_DEFAULT_SITES.map((r) => ({ ...r }));
  return {
    excludedApps: apps.map((r) => ({
      id: String(r.id || r.name || 'app'),
      name: String(r.name || 'App'),
      icon: r.icon != null ? String(r.icon) : '⬚',
      enabled: !!r.enabled,
      path: r.path ? String(r.path) : undefined,
    })),
    excludedSites: sites.map((r) => ({
      id: String(r.id || r.host || 'site'),
      host: String(r.host || '').toLowerCase().replace(/^https?:\/\//i, '').split('/')[0],
      label: r.label != null ? String(r.label) : String(r.host || ''),
      enabled: !!r.enabled,
    })),
  };
}

/** Fired after a successful `settings.save` on `section: privacy` so Chat / Memory / Work reload flags without remounting. */
function notifyPrivacySettingsChanged(detail) {
  try {
    window.dispatchEvent(
      new CustomEvent('shogun-privacy-settings-changed', {
        detail: detail && typeof detail === 'object' ? detail : {},
      }),
    );
  } catch (_) {}
}

function filterPrivacyRows(rows, q, filt, textOf) {
  const qq = (q || '').trim().toLowerCase();
  return rows.filter((r) => {
    if (filt === 'on' && !r.enabled) return false;
    if (filt === 'off' && r.enabled) return false;
    if (!qq) return true;
    return String(textOf(r)).toLowerCase().includes(qq);
  });
}

/** `executeAction` の戻りから IPC ペイロードを取り出す（ShogunAPI の二重ラップを吸収）。 */
function unwrapExecutePayload(res) {
  if (!res || !res.data) return null;
  const d = res.data;
  if (d && d.data !== undefined && d.data !== null && typeof d.data === 'object') return d.data;
  return d;
}

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

const MAX_PROFILE_PHOTO_BYTES = 512 * 1024;

function isProfilePhotoDataUrlSetting(s) {
  const t = s != null ? String(s).trim() : '';
  return t.length > 0 && /^data:image\//i.test(t);
}

function downscaleDataUrlToMaxEdge(dataUrl, maxEdge) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (!w || !h) {
        resolve(dataUrl);
        return;
      }
      const scale = Math.min(1, maxEdge / Math.max(w, h));
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      try {
        const c = document.createElement('canvas');
        c.width = cw;
        c.height = ch;
        const ctx = c.getContext('2d');
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.drawImage(img, 0, 0, cw, ch);
        resolve(c.toDataURL('image/jpeg', 0.88));
      } catch (_e) {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

async function imageFileToAvatarDataUrl(file) {
  if (!file || !file.type.startsWith('image/')) return { error: 'Choose an image file.' };
  if (file.size > MAX_PROFILE_PHOTO_BYTES) {
    return { error: 'Image must be 512 KB or smaller.' };
  }
  const raw = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  let out = typeof raw === 'string' ? raw : '';
  if (out.length > 550000) {
    out = await downscaleDataUrlToMaxEdge(out, 256);
  }
  if (!isProfilePhotoDataUrlSetting(out) || out.length > 900000) {
    return { error: 'Could not store this image — try a smaller file.' };
  }
  return { dataUrl: out };
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
  const [avatarGlyph, setAvatarGlyph] = useStateS('');
  const [avatarImageDataUrl, setAvatarImageDataUrl] = useStateS('');
  const [aliases, setAliases] = useStateS('');
  const [email, setEmail] = useStateS('');
  const [clerkState, setClerkState] = useStateS({ enabled: false, signedIn: false, label: '' });
  const photoInputRef = React.useRef(null);
  const saveProfile = React.useCallback(
    async (opts) => {
      const quiet = opts && opts.quiet;
      const r = await run(
        'settings.save',
        { section: 'general', name, aliases, email, avatarGlyph, avatarImageDataUrl },
        quiet ? { silentError: true } : { silentError: true, successMessage: 'Profile updated' },
      );
      if (r && r.ok && refreshSections) await refreshSections();
      if (r && r.ok) {
        try {
          window.dispatchEvent(
            new CustomEvent('shogun-profile-changed', {
              detail: { name, email, avatarGlyph, avatarImageDataUrl },
            }),
          );
        } catch (_) {
          /* ignore */
        }
      }
    },
    [run, refreshSections, name, aliases, email, avatarGlyph, avatarImageDataUrl],
  );
  React.useEffect(() => {
    const g = sections.general;
    if (!g || typeof g !== 'object') return;
    if (g.name != null) setName(String(g.name));
    if (g.avatarGlyph != null) setAvatarGlyph(String(g.avatarGlyph));
    if (g.avatarImageDataUrl != null) setAvatarImageDataUrl(String(g.avatarImageDataUrl));
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
            <strong className="en-only">Integrations:</strong> many &quot;Connect&quot; rows are <strong>preview (not connected)</strong> in v1 — expect
            warnings where OAuth is unavailable.
          </li>
          <li>
            <strong className="en-only">Billing UI:</strong> billing-related screens are <strong>preview (not connected)</strong> until checkout is connected — see Terms.
          </li>
        </ul>
        <div className="jp" style={{ marginTop: 10, fontSize: 11, color: 'var(--text-dim)' }}>
          Morning Brief は環境によりスタブまたはご自身の LLM 経由の生成です。連携の Connect は v1 ではプレビュー（未接続）です。課金関連画面もプレビュー（未接続）のため、表示価格はイメージの場合があります（利用規約参照）。
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
      <Field
        label={
          <span>
            Avatar{' '}
            <span className="jp" style={{ fontSize: 12, color: 'var(--text-dim)', fontWeight: 400 }}>
              表示アイコン
            </span>
          </span>
        }
        hint={
          <span>
            <span className="en-only">
              Photo (optional, max 512 KB) overrides the letter. Otherwise use one letter or emoji, or leave empty for the first
              character of your display name. Stored locally in settings.
            </span>
            <span className="jp">
              写真（512KB以下・任意）は文字より優先表示されます。未設定なら1文字／絵文字、または「呼び名」の先頭文字。設定にローカル保存されます。
            </span>
          </span>
        }
      >
        <input
          ref={photoInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            void (async () => {
              const f = e.target.files && e.target.files[0];
              e.target.value = '';
              if (!f) return;
              const res = await imageFileToAvatarDataUrl(f);
              if (res.error) {
                toast(res.error, 'warn');
                return;
              }
              setAvatarImageDataUrl(res.dataUrl);
              const r = await run(
                'settings.save',
                {
                  section: 'general',
                  name,
                  aliases,
                  email,
                  avatarGlyph,
                  avatarImageDataUrl: res.dataUrl,
                },
                { silentError: true, successMessage: 'Profile photo updated' },
              );
              if (r && r.ok && refreshSections) await refreshSections();
              if (r && r.ok) {
                try {
                  window.dispatchEvent(
                    new CustomEvent('shogun-profile-changed', {
                      detail: { name, email, avatarGlyph, avatarImageDataUrl: res.dataUrl },
                    }),
                  );
                } catch (_) {
                  /* ignore */
                }
              }
            })();
          }}
        />
        <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div
            className="avatar"
            style={{
              width: 40,
              height: 40,
              fontSize: avatarGlyph.trim() && !isProfilePhotoDataUrlSetting(avatarImageDataUrl) ? 18 : 14,
              flexShrink: 0,
              border: '1px solid var(--border-hi)',
              overflow: 'hidden',
              padding: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            aria-hidden
          >
            {isProfilePhotoDataUrlSetting(avatarImageDataUrl) ? (
              <img
                src={avatarImageDataUrl}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              (() => {
                const g = avatarGlyph.trim();
                if (g) return Array.from(g)[0] || '?';
                const n = String(name || '').trim();
                if (n) {
                  const c = Array.from(n)[0];
                  return /^[a-z]$/i.test(c) ? c.toUpperCase() : c;
                }
                return '?';
              })()
            )}
          </div>
          <input
            className="s-input"
            value={avatarGlyph}
            onChange={(e) => setAvatarGlyph(e.target.value)}
            onBlur={() => void saveProfile({ quiet: true })}
            placeholder="e.g. T or 🎯"
            maxLength={8}
            style={{ flex: 1, minWidth: 120 }}
            aria-label="Avatar letter or emoji"
          />
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => photoInputRef.current && photoInputRef.current.click()}>
            <Icon name="upload" size={12} />
            <span className="en-only">Photo</span>
            <span className="jp">写真</span>
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={!isProfilePhotoDataUrlSetting(avatarImageDataUrl)}
            onClick={() => {
              void (async () => {
                const r = await run(
                  'settings.save',
                  {
                    section: 'general',
                    name,
                    aliases,
                    email,
                    avatarGlyph,
                    avatarImageDataUrl: '',
                  },
                  { silentError: true },
                );
                setAvatarImageDataUrl('');
                if (r && r.ok && refreshSections) await refreshSections();
                if (r && r.ok) {
                  try {
                    window.dispatchEvent(
                      new CustomEvent('shogun-profile-changed', {
                        detail: { name, email, avatarGlyph, avatarImageDataUrl: '' },
                      }),
                    );
                  } catch (_) {
                    /* ignore */
                  }
                }
              })();
            }}
          >
            <span className="en-only">Remove photo</span>
            <span className="jp">写真を削除</span>
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              void (async () => {
                const r = await run(
                  'settings.save',
                  {
                    section: 'general',
                    name,
                    aliases,
                    email,
                    avatarGlyph: '',
                    avatarImageDataUrl,
                  },
                  { silentError: true },
                );
                setAvatarGlyph('');
                if (r && r.ok && refreshSections) await refreshSections();
                if (r && r.ok) {
                  try {
                    window.dispatchEvent(
                      new CustomEvent('shogun-profile-changed', {
                        detail: { name, email, avatarGlyph: '', avatarImageDataUrl },
                      }),
                    );
                  } catch (_) {
                    /* ignore */
                  }
                }
              })();
            }}
          >
            <span className="en-only">Clear letter</span>
            <span className="jp">文字を消す</span>
          </button>
        </div>
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
  const privacySec =
    sections.privacy && typeof sections.privacy === 'object' ? sections.privacy : {};
  const secSecurity =
    sections.security && typeof sections.security === 'object'
      ? sections.security
      : EMPTY_SETTINGS_SECURITY;

  const [tab, setTab] = useStateS('apps');
  const [apps, setApps] = useStateS(() => PRIVACY_DEFAULT_APPS.map((r) => ({ ...r })));
  const [sites, setSites] = useStateS(() => PRIVACY_DEFAULT_SITES.map((r) => ({ ...r })));
  const [appSearch, setAppSearch] = useStateS('');
  const [siteSearch, setSiteSearch] = useStateS('');
  const [appFilter, setAppFilter] = useStateS('all');
  const [siteFilter, setSiteFilter] = useStateS('all');
  const [siteDraft, setSiteDraft] = useStateS('');

  /** When true, `chat.complete` may run local Memory search server-side (`memoryAssembly`). Default on for backward compatibility. */
  const [allowServerMemoryAssembly, setAllowServerMemoryAssembly] = useStateS(true);

  const [bioLock, setBioLock] = useStateS(!!secSecurity.biometricLockEnabled);
  const [bioStatus, setBioStatus] = useStateS(null);

  const persistPrivacy = React.useCallback(
    async (nextApps, nextSites) => {
      const r = await run(
        'settings.save',
        {
          section: 'privacy',
          excludedApps: nextApps,
          excludedSites: nextSites,
          allowChatServerMemoryAssembly: allowServerMemoryAssembly,
        },
        { silentError: true },
      );
      if (r && r.ok && refreshSections) await refreshSections();
      if (r && r.ok) notifyPrivacySettingsChanged({ allowChatServerMemoryAssembly: allowServerMemoryAssembly });
      return r;
    },
    [run, refreshSections, allowServerMemoryAssembly],
  );

  const privacyKey = JSON.stringify(privacySec);
  React.useEffect(() => {
    const { excludedApps, excludedSites } = normalizePrivacyFromSettings(privacySec);
    setApps(excludedApps);
    setSites(excludedSites);
    setAllowServerMemoryAssembly(privacySec.allowChatServerMemoryAssembly !== false);
  }, [privacyKey]);

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
          if (r && r.ok) {
            const bio = unwrapExecutePayload(r);
            if (bio) setBioStatus(bio);
          }
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

  const filteredApps = filterPrivacyRows(apps, appSearch, appFilter, (r) => `${r.name} ${r.icon || ''}`);
  const filteredSites = filterPrivacyRows(sites, siteSearch, siteFilter, (r) => `${r.host} ${r.label || ''}`);

  const learnMore = React.useCallback(async () => {
    if (PRODUCT.privacyUrl) {
      window.open(PRODUCT.privacyUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    await run('permissions.manage', { target: 'screen_capture' }, { silentError: true });
  }, [run]);

  const onPickApp = React.useCallback(async () => {
    const r = await run('privacy.pick_app', {}, { silentError: true });
    const p = unwrapExecutePayload(r);
    if (!r || !r.ok) {
      toast('アプリを選択できませんでした', 'warn');
      return;
    }
    if (!p || p.cancelled) return;
    const name = (p.name && String(p.name)) || 'App';
    const baseId = `bundle:${name
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9.-]/g, '')}`;
    let id = baseId || 'bundle:app';
    let n = 0;
    while (apps.some((a) => a.id === id)) {
      n += 1;
      id = `${baseId}-${n}`;
    }
    const row = {
      id,
      name,
      icon: '📦',
      enabled: true,
      path: p.path ? String(p.path) : undefined,
    };
    const next = apps.concat([row]);
    setApps(next);
    await persistPrivacy(next, sites);
    toast(`除外リストに「${name}」を追加しました`, 'success');
  }, [apps, sites, persistPrivacy, run, toast]);

  const removeAppRow = React.useCallback(
    async (id) => {
      const next = apps.filter((a) => a.id !== id);
      setApps(next);
      await persistPrivacy(next, sites);
    },
    [apps, sites, persistPrivacy],
  );

  const addSiteRow = React.useCallback(async () => {
    let host = siteDraft.trim().toLowerCase();
    host = host.replace(/^https?:\/\//i, '').split('/')[0].trim();
    if (!host) {
      toast('ホスト名を入力してください', 'warn');
      return;
    }
    if (!/^[a-z0-9.-]+$/i.test(host)) {
      toast('有効なホスト名を入力してください', 'warn');
      return;
    }
    if (sites.some((s) => s.host === host)) {
      toast('そのサイトは既にあります', 'info');
      return;
    }
    const row = { id: `site:${host}`, host, label: host, enabled: true };
    const next = sites.concat([row]);
    setSites(next);
    setSiteDraft('');
    await persistPrivacy(apps, next);
  }, [apps, siteDraft, sites, persistPrivacy, toast]);

  const removeSiteRow = React.useCallback(
    async (id) => {
      const next = sites.filter((s) => s.id !== id);
      setSites(next);
      await persistPrivacy(apps, next);
    },
    [apps, sites, persistPrivacy],
  );

  const toggleApp = React.useCallback(
    async (id, enabled) => {
      const nextApps = apps.map((a) => (a.id === id ? { ...a, enabled } : a));
      setApps(nextApps);
      await persistPrivacy(nextApps, sites);
    },
    [apps, sites, persistPrivacy],
  );

  const toggleSite = React.useCallback(
    async (id, enabled) => {
      const nextSites = sites.map((s) => (s.id === id ? { ...s, enabled } : s));
      setSites(nextSites);
      await persistPrivacy(apps, nextSites);
    },
    [apps, sites, persistPrivacy],
  );

  return (
    <Pane
      title="Privacy Controls"
      jp="守秘"
      subtitle={
        <span>
          Control what SHOGUN can see. Excluded content won&apos;t appear in your context.{' '}
          <button
            type="button"
            className="s-link"
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              font: 'inherit',
              cursor: 'pointer',
              color: 'inherit',
            }}
            onClick={() => void learnMore()}
          >
            Learn more <Icon name="arrowUpRight" size={10} />
          </button>
        </span>
      }
    >
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
      <div className="s-card" style={{ marginBottom: 14 }}>
        <Row
          title={
            <span>
              <span className="en-only">Allow Memory assembly in Chat</span>
              <span className="jp">チャットでサーバ側の Memory 組み立てを許可</span>
            </span>
          }
          desc="When enabled, sending a chat message can trigger a local memory search on this Mac and attach hits as extra context (memoryAssembly). Text stays local; turn off if you want only pasted memoryContext or no automatic assembly."
          last
        >
          <Toggle
            on={allowServerMemoryAssembly}
            onClick={async () => {
              const next = !allowServerMemoryAssembly;
              setAllowServerMemoryAssembly(next);
              const r = await run(
                'settings.save',
                {
                  section: 'privacy',
                  allowChatServerMemoryAssembly: next,
                  excludedApps: apps,
                  excludedSites: sites,
                },
                {
                  silentError: true,
                  successMessage: next
                    ? 'チャットでの Memory 組み立てを許可しました'
                    : 'チャットでの Memory 組み立てをオフにしました',
                },
              );
              if (r && r.ok && refreshSections) await refreshSections();
              if (r && r.ok) notifyPrivacySettingsChanged({ allowChatServerMemoryAssembly: next });
            }}
          />
        </Row>
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
                const d = unwrapExecutePayload(st);
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
                {
                  section: 'security',
                  biometricLockEnabled: next,
                },
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
      <div className="s-field-hint" style={{ marginBottom: 10, fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.45 }}>
        <span className="en-only">
          App / site rules are saved locally. On macOS, the capture sampler skips ingests when the frontmost app matches an excluded app, or when an AX snapshot / URL references an excluded site.
        </span>
        <span className="jp" style={{ display: 'block', marginTop: 4 }}>
          アプリ・サイトの除外はローカルに保存されます。macOS ではキャプチャ取り込みが、除外アプリが最前面のとき、または AX テキスト／URL が除外サイトに該当するときにスキップされます。
        </span>
      </div>
      <div className="row" style={{gap:4, background:'var(--surface)', border:'1px solid var(--border)', padding:3, borderRadius:'var(--radius-md)', width:'fit-content', marginBottom:14}}>
        <button
          type="button"
          className="btn btn-sm"
          style={{background:tab==='apps'?'var(--surface-2)':'transparent', borderColor:'transparent'}}
          onClick={()=>setTab('apps')}
        >
          Exclude Apps <span style={{color:'var(--text-dim)', marginLeft:4}}>{apps.length}</span>
        </button>
        <button
          type="button"
          className="btn btn-sm"
          style={{background:tab==='websites'?'var(--surface-2)':'transparent', borderColor:tab==='websites'?'transparent':undefined}}
          onClick={()=>setTab('websites')}
        >
          Exclude Websites <span style={{color:'var(--text-dim)', marginLeft:4}}>{sites.length}</span>
        </button>
      </div>
      <div className="row" style={{gap:10, marginBottom:10}}>
        <input
          className="s-input"
          placeholder={tab === 'apps' ? 'Search applications…' : 'Search sites…'}
          style={{flex:1}}
          value={tab === 'apps' ? appSearch : siteSearch}
          onChange={(e) => (tab === 'apps' ? setAppSearch(e.target.value) : setSiteSearch(e.target.value))}
        />
        <select
          className="s-select"
          value={tab === 'apps' ? appFilter : siteFilter}
          onChange={(e) => (tab === 'apps' ? setAppFilter(e.target.value) : setSiteFilter(e.target.value))}
        >
          <option value="all">All</option>
          <option value="on">Excluded (on)</option>
          <option value="off">Included (off)</option>
        </select>
      </div>
      {tab === 'apps' ? (
        <div className="s-card">
          {filteredApps.length === 0 ? (
            <div className="s-field-hint" style={{ padding: 16 }}>No applications match this search.</div>
          ) : (
            filteredApps.map((a, i, arr) => (
              <div key={a.id} className={'s-row'+(i===arr.length-1?' last':'')}>
                <div style={{width:24, height:24, borderRadius:6, background:'var(--surface-2)', border:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, marginRight:12}}>{a.icon}</div>
                <div style={{flex:1, fontSize:13}}>
                  {a.name}
                  {a.path ? (
                    <div className="s-field-hint" style={{ fontSize: 10, marginTop: 2 }}>{a.path}</div>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  style={{ marginRight: 8 }}
                  title="Remove from list"
                  onClick={() => void removeAppRow(a.id)}
                >
                  ×
                </button>
                <Toggle
                  on={a.enabled}
                  onClick={() => void toggleApp(a.id, !a.enabled)}
                />
              </div>
            ))
          )}
        </div>
      ) : (
        <>
          <div className="s-card">
            {filteredSites.length === 0 ? (
              <div className="s-field-hint" style={{ padding: 16 }}>No sites match this search.</div>
            ) : (
              filteredSites.map((s, i, arr) => (
                <div key={s.id} className={'s-row'+(i===arr.length-1?' last':'')}>
                  <div style={{ flex: 1, fontSize: 13 }}>
                    <div style={{ fontWeight: 500 }}>{s.host}</div>
                    {s.label && s.label !== s.host ? (
                      <div className="s-field-hint" style={{ fontSize: 11 }}>{s.label}</div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    style={{ marginRight: 8 }}
                    title="Remove from list"
                    onClick={() => void removeSiteRow(s.id)}
                  >
                    ×
                  </button>
                  <Toggle on={s.enabled} onClick={() => void toggleSite(s.id, !s.enabled)} />
                </div>
              ))
            )}
          </div>
          <div className="row" style={{ gap: 8, marginTop: 12 }}>
            <input
              className="s-input"
              style={{ flex: 1 }}
              placeholder="e.g. bank.example.com"
              value={siteDraft}
              onChange={(e) => setSiteDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void addSiteRow();
                }
              }}
            />
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => void addSiteRow()}>
              Add site
            </button>
          </div>
        </>
      )}
      {tab === 'apps' ? (
        <div className="s-field-hint" style={{marginTop:14, textAlign:'center'}}>
          Can&apos;t find your app?{' '}
          <button
            type="button"
            className="s-link"
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              font: 'inherit',
              cursor: 'pointer',
              color: 'inherit',
            }}
            onClick={() => void onPickApp()}
          >
            Select .app manually…
          </button>
          <span className="jp" style={{ display: 'block', fontSize: 10, color: 'var(--text-dim)', marginTop: 6 }}>
            macOS アプリではフォルダから .app を選べます（ブラウザではキャンセル扱い）。
          </span>
        </div>
      ) : null}
    </Pane>
  );
}

function PaneData() {
  const { run, confirmWrite, toast } = useRuntimeActions();
  const [deadLetter, setDeadLetter] = useStateS({ total: 0, bySource: {}, busy: false });
  // { open, items, sourceFilter, loading, busyId } when the detail modal is open.
  const [dlDetail, setDlDetail] = useStateS(null);
  const refreshDeadLetter = React.useCallback(async () => {
    const res = await run('dead_letter.list', { limit: 1 }, { silentError: true });
    if (res && res.ok && res.data && res.data.counts) {
      const c = res.data.counts;
      setDeadLetter((prev) => ({
        ...prev,
        total: Number(c.total) || 0,
        bySource: c.bySource && typeof c.bySource === 'object' ? c.bySource : {},
      }));
    }
  }, [run]);
  React.useEffect(() => { void refreshDeadLetter(); }, [refreshDeadLetter]);
  const onRetryDeadLetter = React.useCallback(async () => {
    setDeadLetter((prev) => ({ ...prev, busy: true }));
    const res = await run('dead_letter.retry', { limit: 500 }, { silentError: true });
    if (res && res.ok && res.data) {
      const ok = Number(res.data.succeeded) || 0;
      const bad = Number(res.data.failed) || 0;
      toast(
        bad > 0
          ? `Retried: ${ok} succeeded, ${bad} still failing`
          : `Retried ${ok} item(s) successfully`,
        bad > 0 ? 'warn' : 'success',
      );
    } else {
      toast((res && res.error && res.error.message) || 'Retry failed', 'error');
    }
    await refreshDeadLetter();
    setDeadLetter((prev) => ({ ...prev, busy: false }));
  }, [run, toast, refreshDeadLetter]);
  const openDeadLetterDetail = React.useCallback(async (sourceFilter) => {
    setDlDetail({ open: true, items: [], sourceFilter: sourceFilter || '', loading: true, busyId: null });
    const res = await run(
      'dead_letter.list',
      sourceFilter ? { limit: 200, source: sourceFilter } : { limit: 200 },
      { silentError: true },
    );
    const items = res && res.ok && Array.isArray(res.data && res.data.items) ? res.data.items : [];
    setDlDetail((prev) => (prev ? { ...prev, items, loading: false } : prev));
  }, [run]);
  const reloadDeadLetterDetail = React.useCallback(async () => {
    setDlDetail((prev) => (prev ? { ...prev, loading: true } : prev));
    const filter = (dlDetail && dlDetail.sourceFilter) || '';
    const res = await run(
      'dead_letter.list',
      filter ? { limit: 200, source: filter } : { limit: 200 },
      { silentError: true },
    );
    const items = res && res.ok && Array.isArray(res.data && res.data.items) ? res.data.items : [];
    setDlDetail((prev) => (prev ? { ...prev, items, loading: false } : prev));
    await refreshDeadLetter();
  }, [dlDetail, run, refreshDeadLetter]);
  const retryDeadLetterRow = React.useCallback(async (id) => {
    setDlDetail((prev) => (prev ? { ...prev, busyId: id } : prev));
    const res = await run('dead_letter.retry_one', { id }, { silentError: true });
    if (res && res.ok && res.data && res.data.succeeded) {
      toast('Item retried successfully', 'success');
    } else {
      const msg = (res && res.data && res.data.error)
        || (res && res.error && res.error.message)
        || 'Retry failed';
      toast(msg, 'warn');
    }
    await reloadDeadLetterDetail();
    setDlDetail((prev) => (prev ? { ...prev, busyId: null } : prev));
  }, [run, toast, reloadDeadLetterDetail]);
  const deleteDeadLetterRow = React.useCallback(async (id) => {
    setDlDetail((prev) => (prev ? { ...prev, busyId: id } : prev));
    const res = await run('dead_letter.delete', { id }, { silentError: true });
    if (res && res.ok) {
      toast('Item removed', 'success');
    } else {
      toast((res && res.error && res.error.message) || 'Delete failed', 'error');
    }
    await reloadDeadLetterDetail();
    setDlDetail((prev) => (prev ? { ...prev, busyId: null } : prev));
  }, [run, toast, reloadDeadLetterDetail]);
  const onClearDeadLetter = React.useCallback(async () => {
    if (!(typeof window.confirm === 'function' && window.confirm('Clear the failed-ingest queue? Items cannot be recovered.'))) return;
    setDeadLetter((prev) => ({ ...prev, busy: true }));
    const res = await run('dead_letter.clear', {}, { silentError: true });
    if (res && res.ok) {
      const n = (res.data && res.data.removed) || 0;
      toast(`Cleared ${n} item(s)`, 'success');
    } else {
      toast((res && res.error && res.error.message) || 'Clear failed', 'error');
    }
    await refreshDeadLetter();
    setDeadLetter((prev) => ({ ...prev, busy: false }));
  }, [run, toast, refreshDeadLetter]);
  const onExport = React.useCallback(async () => {
    const res = await run('settings.export', {}, { silentError: true });
    if (res && res.ok) {
      if (res.data && res.data.cancelled) return;
      const p = (res.data && res.data.path) || '';
      toast(p ? `Exported to ${p}` : 'Settings exported', 'success');
    } else {
      const msg = (res && res.error && res.error.message) || 'Export failed';
      toast(msg, 'error');
    }
  }, [run, toast]);
  const onImport = React.useCallback(async () => {
    const ok = typeof window.confirm === 'function'
      ? window.confirm('Import settings from file? Existing sections in the backup will be replaced.')
      : true;
    if (!ok) return;
    const res = await run('settings.import', {}, { silentError: true });
    if (res && res.ok) {
      if (res.data && res.data.cancelled) return;
      const n = (res.data && res.data.sections) || 0;
      toast(`Imported ${n} section(s). Reload the app to see all changes.`, 'success');
    } else {
      const msg = (res && res.error && res.error.message) || 'Import failed';
      toast(msg, 'error');
    }
  }, [run, toast]);
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
      <div className="s-field-label">Backup & Restore</div>
      <div className="s-card">
        <Row
          title="Export settings"
          desc="Save all app settings (integrations toggles, workspaces, preferences) as a JSON file. Credentials and memory data are NOT included."
        >
          <button className="btn btn-sm btn-secondary" onClick={onExport}>Export…</button>
        </Row>
        <Row
          title="Import settings"
          desc="Restore settings from a previously exported JSON file. Existing sections in the backup will replace current values."
          last
        >
          <button className="btn btn-sm btn-secondary" onClick={onImport}>Import…</button>
        </Row>
      </div>

      <div className="s-field-label" style={{marginTop:22}}>Failed Ingests</div>
      <div className="s-card">
        <Row
          title={
            <span>
              {deadLetter.total > 0
                ? `${deadLetter.total} item${deadLetter.total === 1 ? '' : 's'} pending retry`
                : 'No failed ingests'}
              {deadLetter.total > 0 && (
                <span style={{display:'block', fontSize:11, color:'var(--text-dim)', marginTop:4, fontWeight:400}}>
                  By source:{' '}
                  {Object.entries(deadLetter.bySource || {})
                    .map(([s, n]) => `${s} ${n}`)
                    .join(' · ')}
                </span>
              )}
            </span>
          }
          desc="Items that failed to ingest during a connector sync. Retry replays each through the normal ingest path; succeeded rows are removed from the queue."
          last
        >
          <button
            className="btn btn-sm btn-secondary"
            onClick={() => openDeadLetterDetail('')}
            disabled={deadLetter.busy || deadLetter.total === 0}
            style={(deadLetter.busy || deadLetter.total === 0) ? {opacity:0.5, cursor:'not-allowed'} : undefined}
          >
            Details…
          </button>
          <button
            className="btn btn-sm btn-secondary"
            onClick={onRetryDeadLetter}
            disabled={deadLetter.busy || deadLetter.total === 0}
            style={(deadLetter.busy || deadLetter.total === 0) ? {opacity:0.5, cursor:'not-allowed', marginLeft:6} : {marginLeft:6}}
          >
            {deadLetter.busy ? 'Retrying…' : 'Retry all'}
          </button>
          <button
            className="btn btn-sm btn-ghost"
            onClick={onClearDeadLetter}
            disabled={deadLetter.busy || deadLetter.total === 0}
            style={(deadLetter.busy || deadLetter.total === 0) ? {opacity:0.5, cursor:'not-allowed', marginLeft:6} : {marginLeft:6}}
          >
            Clear
          </button>
        </Row>
      </div>

      {dlDetail && dlDetail.open && ReactDOM.createPortal(
        (() => {
          const sources = ['', ...Object.keys(deadLetter.bySource || {})];
          const fmtTime = (ms) => {
            try { return new Date(Number(ms) || 0).toLocaleString(); } catch (_) { return ''; }
          };
          const close = () => setDlDetail(null);
          return (
            <div
              style={{
                position:'fixed', inset:0, zIndex:1097,
                background:'color-mix(in srgb, var(--bg) 78%, transparent)',
                backdropFilter:'blur(4px)',
                display:'flex', alignItems:'center', justifyContent:'center',
                padding:20,
              }}
              onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
            >
              <div
                role="dialog"
                aria-modal="true"
                style={{
                  width:'min(820px, 100%)',
                  maxHeight:'min(82vh, 760px)',
                  background:'var(--surface)',
                  border:'1px solid var(--border-hi)',
                  borderRadius:16,
                  boxShadow:'0 30px 60px -16px rgba(0,0,0,0.6)',
                  display:'flex', flexDirection:'column',
                }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <div style={{padding:'18px 22px 12px', borderBottom:'1px solid var(--border)'}}>
                  <div className="row" style={{gap:10, alignItems:'center', marginBottom:8}}>
                    <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)', letterSpacing:'0.12em'}}>FAILED INGESTS</span>
                    <span style={{flex:1}}/>
                    <button
                      type="button"
                      aria-label="Close"
                      onClick={close}
                      style={{width:24, height:24, borderRadius:6, border:0, background:'transparent', color:'var(--text-mute)', cursor:'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center'}}
                    >
                      <Icon name="x" size={14}/>
                    </button>
                  </div>
                  <div className="row" style={{gap:6, flexWrap:'wrap'}}>
                    {sources.map((s) => {
                      const active = (dlDetail.sourceFilter || '') === s;
                      const label = s || `All${deadLetter.total ? ` (${deadLetter.total})` : ''}`;
                      const n = s ? (deadLetter.bySource && deadLetter.bySource[s]) || 0 : 0;
                      return (
                        <button
                          key={s || '__all'}
                          type="button"
                          onClick={() => openDeadLetterDetail(s)}
                          style={{
                            padding:'4px 10px', borderRadius:999,
                            border:'1px solid ' + (active ? 'var(--gold-dim)' : 'var(--border)'),
                            background: active ? 'color-mix(in srgb, var(--gold) 10%, var(--surface))' : 'var(--surface)',
                            color: active ? 'var(--gold)' : 'var(--text-mute)',
                            fontSize:11, cursor:'pointer', fontFamily:'inherit',
                          }}
                        >
                          {s ? `${s} · ${n}` : label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div style={{flex:1, overflowY:'auto', padding:'10px 18px 18px'}}>
                  {dlDetail.loading ? (
                    <div style={{padding:24, color:'var(--text-dim)', fontSize:13, textAlign:'center'}}>Loading…</div>
                  ) : dlDetail.items.length === 0 ? (
                    <div style={{padding:24, color:'var(--text-dim)', fontSize:13, textAlign:'center'}}>
                      No failed items{dlDetail.sourceFilter ? ` for ${dlDetail.sourceFilter}` : ''}.
                    </div>
                  ) : (
                    <div style={{display:'flex', flexDirection:'column', gap:10}}>
                      {dlDetail.items.map((it) => {
                        const id = Number(it.id);
                        const busy = dlDetail.busyId === id;
                        const title = (it.payload && it.payload.title) || '(untitled)';
                        return (
                          <div
                            key={id}
                            className="card"
                            style={{padding:14, display:'flex', flexDirection:'column', gap:6}}
                          >
                            <div className="row" style={{gap:10, alignItems:'center', flexWrap:'wrap'}}>
                              <span className="t-mono" style={{fontSize:10, color:'var(--gold)', letterSpacing:'0.1em'}}>{String(it.source || '').toUpperCase()}</span>
                              <span style={{fontSize:13, fontWeight:500, flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}} title={title}>{title}</span>
                              <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)'}}>{it.attempts || 1}× · {fmtTime(it.lastFailedAt)}</span>
                            </div>
                            {it.entityId && (
                              <div className="t-mono" style={{fontSize:10, color:'var(--text-dim)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}} title={String(it.entityId)}>
                                id: {String(it.entityId)}
                              </div>
                            )}
                            <div style={{fontSize:12, color:'var(--danger)', lineHeight:1.45, whiteSpace:'pre-wrap', wordBreak:'break-word'}}>
                              {String(it.errorMessage || '').slice(0, 600)}
                            </div>
                            <div className="row" style={{gap:6, justifyContent:'flex-end', marginTop:2}}>
                              <button
                                type="button"
                                className="btn btn-sm btn-secondary"
                                disabled={busy}
                                onClick={() => retryDeadLetterRow(id)}
                                style={busy ? {opacity:0.55, cursor:'default'} : undefined}
                              >
                                {busy ? 'Working…' : 'Retry'}
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                disabled={busy}
                                onClick={() => deleteDeadLetterRow(id)}
                                style={busy ? {opacity:0.55, cursor:'default'} : undefined}
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })(),
        document.body,
      )}
      <div className="s-field-label" style={{marginTop:22}}>Manage Context Collected</div>
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
          <button className="btn btn-sm btn-danger-ghost" onClick={()=>confirmWrite('data.delete_all', {}, 'Delete all context', 'This deletes all locally stored events and embeddings.')}>Delete</button>
        </Row>
      </div>
      <div className="s-field-label" style={{marginTop:22}}>Manage your Account</div>
      <div className="s-card">
        <Row title="Delete Your Account" desc="Permanently delete your account and all associated data" last>
          <button className="btn btn-sm btn-danger-ghost" onClick={()=>confirmWrite('account.delete', {}, 'Delete account', 'This action removes the account identity and local mappings.')}>Delete</button>
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
            <div style={{margin:'0 16px 16px', border:'1px solid var(--border)', borderRadius:'var(--radius-md)', background:'var(--surface-2)', padding:'40px 30px', fontFamily:'var(--font-en)', color:'var(--text)', position:'relative', minHeight:180}}>
              <div style={{fontSize:22, fontWeight:500, marginBottom:8}}>Creativity Is a Process, Not an Event</div>
              <div style={{fontSize:10, letterSpacing:'0.15em', color:'var(--text-dim)', marginBottom:20}}>WRITTEN BY JAMES CLEAR · CREATIVITY</div>
              <div style={{fontSize:13, lineHeight:1.7, color:'var(--text-mute)'}}>In 1666, one of the most influential scientists in history was strolling through a garden when he was struck with a flash of creative brilliance that would change the world.</div>
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
  const [keyProvider, setKeyProvider] = useStateS(null);
  const [keyPreview, setKeyPreview] = useStateS(null);
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
      setKeyProvider(typeof r.data.provider === 'string' ? r.data.provider : null);
      setKeyPreview(typeof r.data.keyPreview === 'string' ? r.data.keyPreview : null);
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
        <Field label="Base URL" hint="HTTPS only (localhost HTTP is accepted for local gateways). If the path has no /v1, it is appended automatically.">
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
          {keyConfigured && keyProvider && (
            <div className="s-field-hint" style={{marginTop:6, fontSize:11}}>
              Provider: {
                keyProvider === 'openai' ? 'OpenAI' :
                keyProvider === 'anthropic' ? 'Anthropic (Claude)' :
                keyProvider === 'gemini' ? 'Google Gemini' :
                'Custom / Local'
              }{keyPreview ? ` — ${keyPreview}` : ''}
            </div>
          )}
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
  const { setPane } = React.useContext(SettingsHydrationContext);
  const [googleCalCred, setGoogleCalCred] = useStateS(false);
  const [googleCalRefresh, setGoogleCalRefresh] = useStateS(false);
  const [gmailCred, setGmailCred] = useStateS(false);
  const [gmailRefresh, setGmailRefresh] = useStateS(false);
  const [calAutoSync, setCalAutoSync] = useStateS(false);
  const [calSyncMins, setCalSyncMins] = useStateS(15);
  const [auditRows, setAuditRows] = useStateS([]);
  const [auditFilter, setAuditFilter] = useStateS('all');
  const [auditProviderFilter, setAuditProviderFilter] = useStateS('all');
  const [oauthBusy, setOauthBusy] = React.useState(null); // null | 'gmail' | 'google_calendar'
  const [oauthNotConfigured, setOauthNotConfigured] = React.useState(false);

  const refreshGoogleCalStatus = React.useCallback(async () => {
    const r = await run('integrations.credentials_status', { provider: 'google_calendar' }, { silentError: true });
    if (r.ok && r.data && typeof r.data.configured === 'boolean') {
      setGoogleCalCred(r.data.configured);
      setGoogleCalRefresh(!!r.data.tokenRefreshReady);
    }
  }, [run]);

  const refreshGmailStatus = React.useCallback(async () => {
    const r = await run('integrations.credentials_status', { provider: 'gmail' }, { silentError: true });
    if (r.ok && r.data && typeof r.data.configured === 'boolean') {
      setGmailCred(r.data.configured);
      setGmailRefresh(!!r.data.tokenRefreshReady);
    }
  }, [run]);

  React.useEffect(() => {
    void refreshGoogleCalStatus();
    void refreshGmailStatus();
  }, [refreshGoogleCalStatus, refreshGmailStatus]);

  React.useEffect(() => {
    void (async () => {
      const r = await run('settings.load', {}, { silentError: true });
      const sections = r.ok && r.data?.settings?.sections;
      const integ = sections && sections.integrations;
      if (!integ || typeof integ !== 'object') return;
      setCalAutoSync(!!integ.googleCalendarAutoSync);
      const m = Number(integ.googleCalendarSyncIntervalMins);
      if (Number.isFinite(m)) setCalSyncMins(Math.min(1440, Math.max(5, m)));
    })();
  }, [run]);

  React.useEffect(() => {
    const onCred = () => {
      void refreshGoogleCalStatus();
      void refreshGmailStatus();
    };
    window.addEventListener('shogun-credentials-updated', onCred);
    return () => window.removeEventListener('shogun-credentials-updated', onCred);
  }, [refreshGoogleCalStatus, refreshGmailStatus]);

  React.useEffect(() => {
    const key = 'shogun.integration.audit.v1';
    try {
      const raw = localStorage.getItem(key);
      const arr = raw ? JSON.parse(raw) : [];
      setAuditRows(Array.isArray(arr) ? arr.slice(0, 20) : []);
    } catch (_) {
      setAuditRows([]);
    }
    const onAudit = (ev) => {
      const d = ev && ev.detail ? ev.detail : null;
      if (!d || typeof d !== 'object') return;
      setAuditRows((prev) => [d].concat(Array.isArray(prev) ? prev : []).slice(0, 20));
    };
    window.addEventListener('shogun-integration-security-audit', onAudit);
    return () => window.removeEventListener('shogun-integration-security-audit', onAudit);
  }, []);

  const fmtAuditTime = (t) => {
    const n = Number(t);
    if (!Number.isFinite(n) || n <= 0) return '—';
    try {
      return new Date(n).toLocaleString();
    } catch (_) {
      return '—';
    }
  };
  const auditEventLabel = (event) => {
    switch (String(event || '')) {
      case 'integration_import_attempt':
        return '取り込み試行';
      case 'integration_import_success':
        return '取り込み成功';
      case 'integration_import_rejected':
        return '取り込み拒否';
      default:
        return String(event || 'unknown');
    }
  };
  const auditReasonLabel = (reason) => {
    switch (String(reason || '')) {
      case 'raw_token_query':
        return 'URLに生トークンが含まれていたため拒否';
      case 'invalid_or_expired_code':
        return 'ワンタイムコードが無効または期限切れ';
      case 'provider_code_mismatch':
        return 'provider と code が不一致';
      case 'code_state_error':
        return 'コード状態の読み取りエラー';
      case 'persist_failed':
        return '資格情報保存に失敗';
      default:
        return String(reason || '');
    }
  };
  const auditViaLabel = (via) => {
    switch (String(via || '')) {
      case 'invoke':
        return '直接API';
      case 'deep-link':
        return 'ディープリンク';
      default:
        return String(via || 'unknown');
    }
  };
  const filteredAuditRows = React.useMemo(() => {
    let rows = auditRows;
    if (auditFilter === 'success') {
      rows = rows.filter((r) => String(r && r.event) === 'integration_import_success');
    } else if (auditFilter === 'rejected') {
      rows = rows.filter((r) => String(r && r.event) === 'integration_import_rejected');
    }
    if (auditProviderFilter !== 'all') {
      rows = rows.filter((r) => String((r && r.provider) || '') === auditProviderFilter);
    }
    return rows;
  }, [auditRows, auditFilter, auditProviderFilter]);
  const auditProviderOptions = React.useMemo(() => {
    const set = new Set();
    auditRows.forEach((r) => {
      const p = String((r && r.provider) || '').trim();
      if (p) set.add(p);
    });
    return ['all'].concat(Array.from(set).sort());
  }, [auditRows]);
  const exportAuditJson = React.useCallback(() => {
    try {
      const now = new Date();
      const stamp = now
        .toISOString()
        .replace(/[:]/g, '-')
        .replace(/\..+$/, 'Z');
      const payload = {
        exportedAt: now.toISOString(),
        count: auditRows.length,
        rows: auditRows,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `shogun-integration-audit-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (_) {
      /* ignore */
    }
  }, [auditRows]);

  const handleOauthConnect = async (provider) => {
    setOauthBusy(provider);
    try {
      const res = await runRuntimeActionA('oauth.google.start', { provider }, { silentError: true });
      if (!res?.ok) {
        const msg = String(res?.error || '');
        if (msg.startsWith('oauth_credentials_not_configured')) {
          setOauthNotConfigured(true);
        } else {
          const friendly = mapOauthError(msg);
          window.SHOGUN_RUNTIME?.pushToast?.(friendly, 'warn');
        }
        return;
      }
      const label = provider === 'gmail' ? 'Gmail' : 'Google Calendar';
      window.SHOGUN_RUNTIME?.pushToast?.(`Connected to ${label}`, 'success');
      // Refresh both statuses (a single OAuth grants both providers).
      await Promise.all([
        runRuntimeActionA('integrations.credentials_status', { provider: 'gmail' }, { silentError: true }),
        runRuntimeActionA('integrations.credentials_status', { provider: 'google_calendar' }, { silentError: true }),
      ]);
    } finally {
      setOauthBusy(null);
    }
  };

  const mapOauthError = (raw) => {
    if (raw.startsWith('oauth_token_exchange_failed:')) {
      const parts = raw.split(':');
      const status = parts[1] || '?';
      const code = parts[2] || '?';
      return `Token exchange failed [${status} ${code}]. Check CLIENT_SECRET.`;
    }
    if (raw === 'oauth_user_cancelled') return 'OAuth was cancelled';
    if (raw === 'oauth_state_mismatch') return 'Security check failed; please try again';
    if (raw === 'oauth_timeout') return 'OAuth timed out. Try again.';
    if (raw === 'oauth_port_busy') return 'Already connecting — please wait or restart';
    if (raw === 'oauth_already_in_progress') return 'Already connecting';
    if (raw === 'oauth_network_error') return 'Network error during token exchange';
    if (raw === 'oauth_invalid_provider') return 'Invalid provider';
    if (raw.startsWith('oauth_internal:')) {
      // Strip the prefix and "provider error:" if present, leave the rest.
      const detail = raw.replace(/^oauth_internal:\s*/, '').replace(/^provider error:\s*/, '');
      return `OAuth flow error: ${detail}`;
    }
    return `OAuth failed: ${raw}`;
  };

  return (
    <Pane title="All Integrations" jp="連携" subtitle="In-app OAuth: Click Connect on Gmail / Google Calendar to start the consent flow. CLIENT_ID/SECRET are read from scripts/.env.google-oauth (dev). For other providers, agent-based import is still supported (see legacy notes below).">
      <div className="s-field-hint" style={{marginBottom:14, padding:12, background:'var(--surface-2)', border:'1px solid var(--border)', borderRadius:'var(--radius-sm)'}}>
        Workspace Integrations screen has the same agent contract. Preferred path: Tauri invoke <code style={{fontSize:11}}>app_integration_import_credentials</code> with <code style={{fontSize:11}}>provider: &quot;google_calendar&quot;</code> or <code style={{fontSize:11}}>&quot;gmail&quot;</code>, <code style={{fontSize:11}}>accessToken</code>, optional <code style={{fontSize:11}}>refreshToken</code>, <code style={{fontSize:11}}>expiresAt</code>, <code style={{fontSize:11}}>oauthClientId</code> (for automatic token refresh). Deep-link alternative: <code style={{fontSize:11}}>shogun-ai://credentials/import?provider=...</code> — prefer invoke for secrets (URLs leak to logs / history). Gmail needs scope <code style={{fontSize:11}}>gmail.readonly</code> or broader.
      </div>
      <div className="s-card" style={{marginBottom:10}}>
        <Row title={<div className="row" style={{gap:10}}><IntegrationLogo slug="apple_calendar" size={30} title="Apple Calendar" /><div><div style={{fontSize:13, fontWeight:500}}>Apple Calendar <span className="label label-gold" style={{marginLeft:4}}>Beta</span></div><div className="s-field-hint">See your events in Apple Calendar</div></div></div>} last>
          <button className="btn btn-sm btn-secondary" type="button" onClick={()=>run('integrations.connect', { provider:'apple_calendar' }, { silentError:true })}>Connect</button>
        </Row>
      </div>
      <div className="s-card" style={{marginBottom:10}}>
        <div className="row" style={{padding:'12px 16px', borderBottom:'1px solid var(--border)'}}>
          <div style={{fontSize:13, fontWeight:600}}>Integration Security Audit</div>
          <span className="spacer"/>
          <button
            type="button"
            className="btn btn-xs btn-ghost"
            style={{ marginRight: 8, padding: '2px 8px' }}
            onClick={exportAuditJson}
          >
            Export audit (JSON)
          </button>
          <select
            className="s-select"
            style={{ minWidth: 120, marginRight: 8 }}
            value={auditFilter}
            onChange={(e) => setAuditFilter(String(e.target.value || 'all'))}
          >
            <option value="all">全件</option>
            <option value="success">成功のみ</option>
            <option value="rejected">拒否のみ</option>
          </select>
          <select
            className="s-select"
            style={{ minWidth: 140, marginRight: 8 }}
            value={auditProviderFilter}
            onChange={(e) => setAuditProviderFilter(String(e.target.value || 'all'))}
          >
            {auditProviderOptions.map((p) => (
              <option key={p} value={p}>
                {p === 'all' ? 'プロバイダ: 全て' : `プロバイダ: ${p}`}
              </option>
            ))}
          </select>
          <span className="s-field-hint" style={{margin:0}}>Last 20 events</span>
        </div>
        {filteredAuditRows.length === 0 ? (
          <div className="s-field-hint" style={{padding:'12px 16px'}}>
            No audit events yet.
          </div>
        ) : (
          <div style={{maxHeight:220, overflow:'auto'}}>
            {filteredAuditRows.map((r, i) => (
              <div
                key={`${r.ts || 'na'}-${r.event || 'evt'}-${i}`}
                className={'s-row' + (i === filteredAuditRows.length - 1 ? ' last' : '')}
                style={{fontSize:12}}
              >
                <div style={{width:130, color:'var(--text-dim)'}}>{fmtAuditTime(r.ts)}</div>
                <div style={{width:160}} title={String(r.event || '')}>{auditEventLabel(r.event)}</div>
                <div style={{width:120, color:'var(--text-dim)'}}>{r.provider || 'unknown'}</div>
                <div style={{width:90, color:'var(--text-dim)'}} title={String(r.via || '')}>
                  {auditViaLabel(r.via)}
                </div>
                <div style={{flex:1, color:'var(--text-dim)'}} title={String(r.reason || '')}>
                  {auditReasonLabel(r.reason)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="s-card" style={{marginBottom:10}}>
        <Row title={<div className="row" style={{gap:10}}><IntegrationLogo slug="apple_reminders" size={30} title="Apple Reminders" /><div><div style={{fontSize:13, fontWeight:500}}>Apple Reminders <span className="label label-gold" style={{marginLeft:4}}>Beta</span></div><div className="s-field-hint">See your reminders and tasks in Apple Reminders</div></div></div>} last>
          <button className="btn btn-sm btn-secondary" type="button" onClick={()=>run('integrations.connect', { provider:'apple_reminders' }, { silentError:true })}>Connect</button>
        </Row>
      </div>
      <div className="s-card" style={{marginBottom:10}}>
        <div className="row" style={{padding:'14px 16px'}}>
          <IntegrationLogo slug="gmail" size={30} title="Gmail" />
          <div style={{marginLeft:10}}>
            <div style={{fontSize:13, fontWeight:500}}>Gmail</div>
            <div className="s-field-hint">Inbox list → Memory ingest (<code style={{fontSize:10}}>provenance: connector</code>, source <code style={{fontSize:10}}>gmail</code>).</div>
          </div>
          <span className="spacer"/>
          <Icon name="chevronDown" size={12} className="dim"/>
        </div>
        <div style={{borderTop:'1px solid var(--border)', padding:'12px 16px', display:'flex', flexWrap:'wrap', alignItems:'center', gap:10}}>
          <span style={{fontSize:12, color:'var(--text-mute)'}}>Agent-imported token</span>
          <span className={'label ' + (gmailCred ? 'label-success' : '')} style={{borderColor:'var(--border)'}}>
            {gmailCred ? 'Keychain · configured' : 'No token · import via agent'}
          </span>
          {gmailCred ? (
            <span className={'label ' + (gmailRefresh ? 'label-success' : '')} style={{borderColor:'var(--border)', fontSize:11}}>
              {gmailRefresh ? 'Refresh: client+refresh token' : 'Refresh: add oauthClientId + refreshToken'}
            </span>
          ) : null}
          <span className="spacer"/>
          <button className="btn btn-sm btn-secondary" type="button" onClick={() => { void refreshGmailStatus(); }}>Refresh status</button>
          <button
            className="btn btn-sm btn-secondary"
            type="button"
            disabled={oauthBusy}
            onClick={() => handleOauthConnect('gmail')}
          >
            {oauthBusy === 'gmail' ? (
              <>
                <span className="en-only">Connecting…</span>
                <span className="jp">接続中…</span>
              </>
            ) : (
              <>
                <span className="en-only">Connect</span>
                <span className="jp">接続</span>
              </>
            )}
          </button>
          <button className="btn btn-sm btn-primary" type="button" onClick={() => run('gmail.sync', { maxResults:20 }, { successMessage:'Gmail synced to Memory' })}>Sync to Memory</button>
          <button className="btn btn-sm btn-ghost" type="button" style={{padding:'0 6px'}} onClick={()=>run('integrations.toggle', { provider:'gmail', action:'edit' }, { silentError:true })}><Icon name="edit" size={12}/></button>
          <button className="btn btn-sm btn-ghost" type="button" style={{padding:'0 6px'}} onClick={()=>run('integrations.toggle', { provider:'gmail', action:'settings' }, { silentError:true })}><Icon name="settings" size={12}/></button>
        </div>
        {!gmailCred ? (
          <div style={{borderTop:'1px solid var(--border)', padding:'10px 16px', fontSize:12, color:'var(--text-dim)', lineHeight:1.55}}>
            <div style={{fontWeight:600, marginBottom:6}}>How to import Gmail token</div>
            <div className="s-field-hint" style={{ marginBottom: 8 }}>
              <span className="en-only">In-app: click Connect above. This drawer is for the agent-based fallback (production / multi-user, when scripts/.env.google-oauth is unavailable).</span>
              <span className="jp">アプリ内: 上の Connect を押す。このドロワは agent 経由の代替手順 (本番 / 複数ユーザ、scripts/.env.google-oauth が使えない場合)。</span>
            </div>
            <div>1) Get OAuth access token (+ optional refresh token / client id) with Gmail scope <code style={{fontSize:10}}>gmail.readonly</code>.</div>
            <div>2) Call <code style={{fontSize:10}}>app_integration_import_credentials</code> with <code style={{fontSize:10}}>provider: "gmail"</code>.</div>
            <div style={{marginTop:8, display:'flex', gap:12, flexWrap:'wrap'}}>
              <a
                className="s-link"
                href="https://developers.google.com/workspace/gmail/api/auth/scopes"
                target="_blank"
                rel="noopener noreferrer"
              >
                Gmail scopes guide <Icon name="arrowUpRight" size={10} />
              </a>
              <button
                type="button"
                className="s-link"
                style={{background:'none', border:'none', padding:0, font: 'inherit', cursor:'pointer'}}
                onClick={() => run('integrations.connect', { provider:'gmail' }, { silentError:true })}
              >
                Re-check token status
              </button>
            </div>
          </div>
        ) : null}
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
          <button
            className="btn btn-sm btn-secondary"
            type="button"
            disabled={oauthBusy}
            onClick={() => handleOauthConnect('google_calendar')}
          >
            {oauthBusy === 'google_calendar' ? (
              <>
                <span className="en-only">Connecting…</span>
                <span className="jp">接続中…</span>
              </>
            ) : (
              <>
                <span className="en-only">Connect</span>
                <span className="jp">接続</span>
              </>
            )}
          </button>
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
      {oauthNotConfigured && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}
          onClick={() => setOauthNotConfigured(false)}
        >
          <div
            style={{
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 8, padding: 24, maxWidth: 520, color: 'var(--text)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>
              <span className="en-only">OAuth credentials not configured</span>
              <span className="jp">OAuth 認証情報が未設定</span>
            </h3>
            <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-mute)' }}>
              <span className="en-only">
                The file <code>scripts/.env.google-oauth</code> is missing or empty. To enable in-app OAuth:
              </span>
              <span className="jp">
                <code>scripts/.env.google-oauth</code> が見つかりません。アプリ内 OAuth を有効にするには:
              </span>
            </p>
            <pre style={{
              background: 'var(--surface-mute)', padding: 12, borderRadius: 4,
              fontSize: 12, fontFamily: 'var(--font-mono)', overflowX: 'auto',
            }}>
{`cp scripts/.env.google-oauth.example scripts/.env.google-oauth
# Then fill CLIENT_ID and CLIENT_SECRET from Google Cloud Console.`}
            </pre>
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() => {
                  navigator.clipboard?.writeText('cp scripts/.env.google-oauth.example scripts/.env.google-oauth');
                  window.SHOGUN_RUNTIME?.pushToast?.('Command copied', 'success');
                }}
              >
                <span className="en-only">Copy command</span>
                <span className="jp">コマンドをコピー</span>
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setOauthNotConfigured(false)}
              >
                <span className="en-only">Close</span>
                <span className="jp">閉じる</span>
              </button>
            </div>
          </div>
        </div>
      )}
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

  if (!Kbd || !merged) {
    return (
      <Pane title="Keyboard Shortcuts" jp="捷径">
        <div className="s-field-hint">Shortcut module not loaded. Ensure keyboard-shortcuts.js is included before app.jsx.</div>
      </Pane>
    );
  }

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
    </Pane>
  );
}

function PaneTeam() {
  const { toast } = useRuntimeActions();
  const [size, setSize] = useStateS('');
  const [purpose, setPurpose] = useStateS('');
  const [email, setEmail] = useStateS('');
  const [sending, setSending] = useStateS(false);

  const canSend = size.trim().length > 0 && purpose.trim().length > 0;

  const sendFeedback = React.useCallback(() => {
    if (!canSend || sending) return;
    setSending(true);
    try {
      const recipient = (PRODUCT.supportMailto || '').replace(/^mailto:/, '').split('?')[0] || 'support@yourcompany.com';
      const subject = 'SHOGUN for Teams — Feedback / フィードバック';
      const bodyLines = [
        'Team size / チーム規模:',
        size.trim(),
        '',
        'What you would use it for / 用途:',
        purpose.trim(),
      ];
      if (email.trim()) {
        bodyLines.push('', 'Reply to / 返信先:', email.trim());
      }
      const href = `mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyLines.join('\n'))}`;
      if (typeof window !== 'undefined') {
        window.location.href = href;
      }
      toast('Thanks! / ありがとうございます', 'info');
      setSize('');
      setPurpose('');
      setEmail('');
    } finally {
      setSending(false);
    }
  }, [canSend, sending, size, purpose, email, toast, setSize, setPurpose, setEmail, setSending]);

  return (
    <Pane title="Team" jp="組">
      <div className="s-card" style={{padding:20}}>
        <div className="row" style={{gap:10, alignItems:'center', marginBottom:10}}>
          <span style={{
            display:'inline-flex', alignItems:'center', gap:6,
            padding:'4px 10px', borderRadius:999,
            border:'1px solid var(--gold-dim)', color:'var(--gold)',
            fontSize:11, fontWeight:500, letterSpacing:'0.04em', textTransform:'uppercase',
          }}>
            <span className="en-only">Coming Soon</span>
            <span className="jp">近日公開</span>
          </span>
        </div>
        <div style={{fontSize:16, fontWeight:500}}>
          SHOGUN for Teams
          <span className="jp dim" style={{fontSize:11, marginLeft:6}}>組織版</span>
        </div>
        <div className="s-field-hint" style={{marginTop:6}}>
          <span className="en-only">Team features are in development. Tell us what you need and we&apos;ll prioritize.</span>
          <span className="jp">チーム機能は開発中です。必要な内容を教えていただけると優先度を決める参考になります。</span>
        </div>
        <div className="s-field-hint" style={{marginTop:12, fontSize:11, textTransform:'uppercase', letterSpacing:'0.06em'}}>
          <span className="en-only">Planned</span>
          <span className="jp">予定機能</span>
        </div>
        <ul style={{margin:'6px 0 0', padding:0, listStyle:'none', fontSize:13, lineHeight:2}}>
          {[
            'Centralized billing for your company',
            'Invite and manage team members',
            'Mix Plus and Pro seats in one team',
          ].map(f => (
            <li key={f}><Icon name="check" size={11} className="gold" style={{marginRight:8}}/>{f}</li>
          ))}
        </ul>
      </div>

      <div className="s-card" style={{padding:20, marginTop:14}}>
        <div style={{fontSize:14, fontWeight:500}}>
          <span className="en-only">Send us feedback</span>
          <span className="jp">フィードバックを送る</span>
        </div>
        <div className="s-field-hint" style={{marginTop:4}}>
          <span className="en-only">Two quick questions — this helps us ship the right thing first.</span>
          <span className="jp">2問だけ。優先順位付けに役立てます。</span>
        </div>

        <div style={{marginTop:14}}>
          <label className="s-field-hint" style={{display:'block', fontSize:11, marginBottom:4}}>
            <span className="en-only">Team size (e.g. 5, 20, 100+)</span>
            <span className="jp">チーム規模（例: 5人 / 20人 / 100人以上）</span>
          </label>
          <input
            className="s-input"
            type="text"
            value={size}
            onChange={(e)=>setSize(e.target.value)}
            placeholder="e.g. 20 / 20人"
            style={{width:'100%'}}
          />
        </div>

        <div style={{marginTop:12}}>
          <label className="s-field-hint" style={{display:'block', fontSize:11, marginBottom:4}}>
            <span className="en-only">What would you use SHOGUN for Teams for?</span>
            <span className="jp">どんな用途で使いたいですか？</span>
          </label>
          <textarea
            className="s-input"
            value={purpose}
            onChange={(e)=>setPurpose(e.target.value)}
            rows={4}
            placeholder="e.g. Share prompts across our sales org / 営業部門でプロンプトを共有したい"
            style={{width:'100%', resize:'vertical', minHeight:90, fontFamily:'inherit'}}
          />
        </div>

        <div style={{marginTop:12}}>
          <label className="s-field-hint" style={{display:'block', fontSize:11, marginBottom:4}}>
            <span className="en-only">Email (optional — for replies)</span>
            <span className="jp">メール（任意・返信希望の場合）</span>
          </label>
          <input
            className="s-input"
            type="email"
            value={email}
            onChange={(e)=>setEmail(e.target.value)}
            placeholder="you@company.com"
            style={{width:'100%'}}
          />
        </div>

        <div className="row" style={{marginTop:16, gap:12, alignItems:'center'}}>
          <button
            className="btn btn-secondary"
            onClick={sendFeedback}
            disabled={!canSend || sending}
            style={!canSend || sending ? {opacity:0.5, cursor:'not-allowed'} : undefined}
          >
            <span className="en-only">Send feedback</span>
            <span className="jp">送信</span>
          </button>
          <span className="s-field-hint" style={{fontSize:11}}>
            <span className="en-only">Opens your mail app to deliver the message.</span>
            <span className="jp">メールアプリが起動して送信されます。</span>
          </span>
        </div>
      </div>
    </Pane>
  );
}

function PaneSupport() {
  const { run, toast } = useRuntimeActions();
  const onCheckUpdates = React.useCallback(async () => {
    const r = await run('updates.check', {}, { silentError: true });
    if (!r || !r.ok) {
      toast((r && r.error && r.error.message) || 'Update check failed', 'error');
      return;
    }
    const d = r.data;
    if (!d || !d.available) {
      toast('You are on the latest version. / 最新です', 'info');
      return;
    }
    const ver = d.version != null ? String(d.version) : '';
    const msg =
      (d.body && String(d.body).trim()) ||
      `Version ${ver} is available. Install now? The app will restart.`;
    if (typeof window.confirm === 'function' && window.confirm(msg)) {
      const inst = await run('updates.download_install', {}, { silentError: true });
      if (!inst || !inst.ok) {
        toast((inst && inst.error && inst.error.message) || 'Update install failed', 'error');
      }
    }
  }, [run, toast]);
  return (
    <Pane title="Support" jp="支援">
      <div className="s-field-hint" style={{ marginBottom: 14, padding: 12, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: 12, lineHeight: 1.55 }}>
        <span className="en-only">Primary channel:</span>
        <span className="jp">主な連絡先:</span>{' '}
        <a className="s-link" href={PRODUCT.supportMailto}>
          Email support（サポート）
        </a>
        （<code style={{ fontSize: 10 }}>PRODUCT.supportMailto</code> を販売用アドレスに差し替えてください）。Discord 等は準備中の場合があります。
        <div className="en-only" style={{ marginTop: 10, fontSize: 11, color: 'var(--text-dim)' }}>
          Desktop: uncaught UI errors are also written to the app process log (stderr / system log). Mention the time of the issue when contacting support. Optional Sentry: set{' '}
          <code style={{ fontSize: 10 }}>&lt;meta name=&quot;shogun-sentry-dsn&quot; content=&quot;…&quot; /&gt;</code> in the HTML shell.
        </div>
        <div className="jp" style={{ marginTop: 10, fontSize: 11, color: 'var(--text-dim)' }}>
          デスクトップ版では、捕捉されなかった UI エラーがアプリのプロセスログ（stderr / システムログ）にも残ります。問い合わせ時は発生時刻を併記してください。任意で Sentry を使う場合は HTML に{' '}
          <code style={{ fontSize: 10 }}>&lt;meta name=&quot;shogun-sentry-dsn&quot; content=&quot;…&quot; /&gt;</code> を追加します。
        </div>
      </div>
      <div className="s-card">
        <Row title="Email support" desc="Bug reports, licensing, and setup — use the address configured for your product build.">
          <a className="btn btn-sm btn-secondary" href={PRODUCT.supportMailto}>
            Open mail
          </a>
        </Row>
        <Row title="Community" desc="Discord is not guaranteed in v1 — email us to request an invite or discuss licensing.">
          <a
            className="btn btn-sm btn-secondary"
            href={`${PRODUCT.supportMailto}?subject=${encodeURIComponent('SHOGUN — community / Discord')}`}
          >
            Email community
          </a>
        </Row>
        <Row
          title="Check for updates / 更新を確認"
          desc="Desktop: Tauri updater (see tauri.conf.json — endpoints + pubkey). Replace YOUR_ORG/YOUR_REPO before shipping. Browser mock: no update."
        >
          <button className="btn btn-sm btn-secondary" type="button" onClick={() => void onCheckUpdates()}>
            Check / 確認
          </button>
        </Row>
        <Row title="Report Performance Issues" desc="Experiencing slowdowns or high resource usage? Create a 5-second diagnostic snapshot to help us troubleshoot the issue." last>
          <button className="btn btn-sm btn-secondary" onClick={()=>run('diagnostics.report', { source:'settings.support' }, { successMessage:'Diagnostics report started' })}>Report</button>
        </Row>
      </div>
    </Pane>
  );
}

function PaneKiokuGraph() {
  const { run } = useRuntimeActions();
  const { sections, refreshSections } = React.useContext(SettingsHydrationContext);

  // kioku_graph section
  const [readPath, setReadPath] = useStateS('legacy');
  const [workerEnabled, setWorkerEnabled] = useStateS(false);
  const [captureFlag, setCaptureFlag] = useStateS(false);
  const [pollSecs, setPollSecs] = useStateS('30');
  const [maxJobs, setMaxJobs] = useStateS('5');

  // kioku_cost section
  const [monthlyCap, setMonthlyCap] = useStateS('10');
  const [capAction, setCapAction] = useStateS('pause_extraction');
  const [fallbackModel, setFallbackModel] = useStateS('claude-haiku-4-5');

  // llm.extractionModel
  const [extractionModel, setExtractionModel] = useStateS('claude-haiku-4-5');

  // observability.sliThresholds
  const [sliBadSuccessLt, setSliBadSuccessLt] = useStateS('95');
  const [sliBadP95Gt, setSliBadP95Gt] = useStateS('3000');
  const [sliBadBacklogGt, setSliBadBacklogGt] = useStateS('40');
  const [sliWarnSuccessLt, setSliWarnSuccessLt] = useStateS('99');
  const [sliWarnP95Gt, setSliWarnP95Gt] = useStateS('1500');
  const [sliWarnBacklogGt, setSliWarnBacklogGt] = useStateS('15');

  // kioku_rules — text area editing of raw JSON
  const [rulesText, setRulesText] = useStateS('[]');
  const [rulesError, setRulesError] = useStateS('');

  // edge_type review section state
  const [proposals, setProposals] = useStateS([]);
  const [proposalsBusy, setProposalsBusy] = useStateS(false);
  const [proposalsErr, setProposalsErr] = useStateS(null);
  const [reviewNotes, setReviewNotes] = useStateS({}); // edge_type -> draft note
  const [reviewBusy, setReviewBusy] = useStateS(null);  // edge_type currently being reviewed
  const [showAllProposals, setShowAllProposals] = useStateS(false);

  const refreshProposals = React.useCallback(async () => {
    setProposalsBusy(true);
    setProposalsErr(null);
    const r = await run(
      'kioku.edge_type_proposals',
      { only_unreviewed: !showAllProposals, limit: 50 },
      { silentError: true },
    );
    setProposalsBusy(false);
    if (r.ok && r.data && Array.isArray(r.data.proposals)) {
      setProposals(r.data.proposals);
    } else {
      setProposalsErr((r && (r.message || r.error)) || 'Failed to load proposals.');
    }
  }, [run, showAllProposals]);

  React.useEffect(() => { void refreshProposals(); }, [refreshProposals]);

  const reviewProposal = async (edge_type, status) => {
    setReviewBusy(edge_type);
    const note = (reviewNotes[edge_type] || '').trim();
    const payload = { edge_type, status };
    if (note) payload.note = note;
    const r = await run('kioku.edge_type_review', payload, { silentError: true });
    setReviewBusy(null);
    if (r.ok) {
      setReviewNotes((prev) => {
        const next = { ...prev };
        delete next[edge_type];
        return next;
      });
      await refreshProposals();
    }
  };

  // Backup section state
  const [backupLabel, setBackupLabel] = useStateS('');
  const [backupBusy, setBackupBusy] = useStateS(false);
  const [backupResult, setBackupResult] = useStateS(null);
  const [backupError, setBackupError] = useStateS(null);

  const runBackup = async () => {
    setBackupBusy(true);
    setBackupResult(null);
    setBackupError(null);
    const payload = {};
    const trimmed = backupLabel.trim();
    if (trimmed) payload.label = trimmed;
    const r = await run('kioku.backup_db', payload, { silentError: true });
    setBackupBusy(false);
    if (r.ok && r.data) {
      setBackupResult(r.data);
    } else {
      setBackupError((r && (r.message || r.error)) || 'Backup failed; check logs.');
    }
  };

  React.useEffect(() => {
    const g = sections.kioku_graph || {};
    if (typeof g.read_path === 'string') setReadPath(g.read_path);
    if (typeof g.worker_enabled === 'boolean') setWorkerEnabled(g.worker_enabled);
    if (typeof g.capture_to_mem_captures === 'boolean') setCaptureFlag(g.capture_to_mem_captures);
    if (g.poll_interval_secs != null) setPollSecs(String(g.poll_interval_secs));
    if (g.max_jobs_per_tick != null) setMaxJobs(String(g.max_jobs_per_tick));

    const c = sections.kioku_cost || {};
    if (c.monthly_cap_usd != null) setMonthlyCap(String(c.monthly_cap_usd));
    if (typeof c.cap_action === 'string') setCapAction(c.cap_action);
    if (typeof c.fallback_model === 'string') setFallbackModel(c.fallback_model);

    const l = sections.llm || {};
    if (typeof l.extractionModel === 'string') setExtractionModel(l.extractionModel);

    const o = sections.observability || {};
    const t = o.sliThresholds || {};
    if (t.bad && typeof t.bad === 'object') {
      if (t.bad.successLt != null) setSliBadSuccessLt(String(t.bad.successLt));
      if (t.bad.p95Gt != null) setSliBadP95Gt(String(t.bad.p95Gt));
      if (t.bad.backlogGt != null) setSliBadBacklogGt(String(t.bad.backlogGt));
    }
    if (t.warn && typeof t.warn === 'object') {
      if (t.warn.successLt != null) setSliWarnSuccessLt(String(t.warn.successLt));
      if (t.warn.p95Gt != null) setSliWarnP95Gt(String(t.warn.p95Gt));
      if (t.warn.backlogGt != null) setSliWarnBacklogGt(String(t.warn.backlogGt));
    }

    const arr = Array.isArray(sections.kioku_rules) ? sections.kioku_rules : [];
    try {
      setRulesText(JSON.stringify(arr, null, 2));
    } catch (_) {
      setRulesText('[]');
    }
  }, [sections]);

  const persistGraph = (patch) => run(
    'settings.save',
    {
      section: 'kioku_graph',
      read_path: readPath,
      worker_enabled: workerEnabled,
      capture_to_mem_captures: captureFlag,
      poll_interval_secs: Number(pollSecs) || 30,
      max_jobs_per_tick: Number(maxJobs) || 5,
      ...patch,
    },
    { silentError: true },
  ).then(() => refreshSections && refreshSections());

  const persistCost = (patch) => run(
    'settings.save',
    {
      section: 'kioku_cost',
      monthly_cap_usd: Number(monthlyCap) || 10,
      cap_action: capAction,
      fallback_model: fallbackModel,
      ...patch,
    },
    { silentError: true },
  ).then(() => refreshSections && refreshSections());

  const persistLLMModel = (val) => run(
    'settings.save',
    { section: 'llm', extractionModel: val },
    { silentError: true },
  ).then(() => refreshSections && refreshSections());

  const persistObservability = (patch) => run(
    'settings.save',
    {
      section: 'observability',
      sliThresholds: {
        bad: {
          successLt: Number(sliBadSuccessLt) || 95,
          p95Gt: Number(sliBadP95Gt) || 3000,
          backlogGt: Number(sliBadBacklogGt) || 40,
        },
        warn: {
          successLt: Number(sliWarnSuccessLt) || 99,
          p95Gt: Number(sliWarnP95Gt) || 1500,
          backlogGt: Number(sliWarnBacklogGt) || 15,
        },
      },
      ...patch,
    },
    { silentError: true },
  ).then(() => refreshSections && refreshSections());

  const saveRules = async () => {
    setRulesError('');
    let parsed;
    try {
      parsed = JSON.parse(rulesText);
    } catch (e) {
      setRulesError(`Invalid JSON: ${e.message}`);
      return;
    }
    if (!Array.isArray(parsed)) {
      setRulesError('kioku_rules must be a JSON array.');
      return;
    }
    // settings.save expects an object payload under `section`. We replace
    // the entire section with the array so editing is round-trippable.
    await run(
      'settings.save',
      { section: 'kioku_rules', value: parsed },
      { silentError: true },
    );
    if (refreshSections) await refreshSections();
  };

  return (
    <Pane
      title="KIOKU Graph"
      jp="記憶グラフ"
      subtitle="Phase 2 graph layer flags, BYOK extraction worker, monthly cost cap, and user-defined rules. All toggles default OFF — Phase 1 behavior is preserved until you opt in."
    >
      <div className="s-card" style={{padding:20, marginBottom:16}}>
        <Row title="Retrieval read path" desc="Switch context_assembly between legacy FTS+semantic and the KIOKU graph traversal (recursive CTE + decay).">
          <select
            className="s-select"
            value={readPath}
            onChange={(e) => { const v = e.target.value; setReadPath(v); persistGraph({ read_path: v }); }}
          >
            <option value="legacy">legacy</option>
            <option value="graph">graph</option>
          </select>
        </Row>
        <Row title="Capture → mem_captures" desc="When ON, capture_sampler / macos_ax route raw captures into mem_captures + extraction_jobs instead of mem_items.">
          <Toggle on={captureFlag} onClick={() => { const next = !captureFlag; setCaptureFlag(next); persistGraph({ capture_to_mem_captures: next }); }} />
        </Row>
        <Row title="Worker enabled" desc="Background thread polls extraction_jobs and calls the BYOK extraction model. Disabled = jobs queue but never run.">
          <Toggle on={workerEnabled} onClick={() => { const next = !workerEnabled; setWorkerEnabled(next); persistGraph({ worker_enabled: next }); }} />
        </Row>
        <Row title="Worker poll interval (sec)" desc="Clamped 5–600 server-side. Lower values check the queue more often at the cost of CPU wake-ups.">
          <input
            className="s-input"
            type="number"
            min="5"
            max="600"
            value={pollSecs}
            onChange={(e) => setPollSecs(e.target.value)}
            onBlur={() => persistGraph({ poll_interval_secs: Number(pollSecs) || 30 })}
            style={{width:90}}
          />
        </Row>
        <Row title="Max jobs per tick" desc="Bounds tick latency. Clamped 1–50 server-side." last>
          <input
            className="s-input"
            type="number"
            min="1"
            max="50"
            value={maxJobs}
            onChange={(e) => setMaxJobs(e.target.value)}
            onBlur={() => persistGraph({ max_jobs_per_tick: Number(maxJobs) || 5 })}
            style={{width:90}}
          />
        </Row>
      </div>

      <div className="s-card" style={{padding:20, marginBottom:16}}>
        <h3 style={{marginTop:0}}>BYOK extraction cost</h3>
        <Row title="Extraction model" desc="Anthropic ID used by AnthropicExtractionClient. Sonnet / Opus increase quality + cost (3x / 15x).">
          <select
            className="s-select"
            value={extractionModel}
            onChange={(e) => { const v = e.target.value; setExtractionModel(v); persistLLMModel(v); }}
          >
            <option value="claude-haiku-4-5">claude-haiku-4-5 (default, ~$9/mo median)</option>
            <option value="claude-sonnet-4-6">claude-sonnet-4-6 (3x cost)</option>
            <option value="claude-opus-4-7">claude-opus-4-7 (15x cost)</option>
          </select>
        </Row>
        <Row title="Monthly cap (USD)" desc="When this month's cost_ledger total reaches the cap, cap_action below decides what happens.">
          <input
            className="s-input"
            type="number"
            step="1"
            min="0"
            value={monthlyCap}
            onChange={(e) => setMonthlyCap(e.target.value)}
            onBlur={() => persistCost({ monthly_cap_usd: Number(monthlyCap) || 10 })}
            style={{width:90}}
          />
        </Row>
        <Row title="Cap action" desc="pause_extraction = capture continues, jobs sit until next month. pause_capture = capture also stops. fallback_to_lighter = swap to fallback model.">
          <select
            className="s-select"
            value={capAction}
            onChange={(e) => { const v = e.target.value; setCapAction(v); persistCost({ cap_action: v }); }}
          >
            <option value="pause_extraction">pause_extraction (recommended)</option>
            <option value="pause_capture">pause_capture (hard cap)</option>
            <option value="fallback_to_lighter">fallback_to_lighter</option>
          </select>
        </Row>
        <Row title="Fallback model" desc="Used when cap_action = fallback_to_lighter and the cap is reached." last>
          <select
            className="s-select"
            value={fallbackModel}
            onChange={(e) => { const v = e.target.value; setFallbackModel(v); persistCost({ fallback_model: v }); }}
          >
            <option value="claude-haiku-4-5">claude-haiku-4-5</option>
            <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
          </select>
        </Row>
      </div>

      <div className="s-card" style={{padding:20, marginBottom:16}}>
        <h3 style={{marginTop:0}}>SLI severity thresholds</h3>
        <div className="s-field-hint" style={{marginBottom:12}}>
          Home の SLI バッジ色（good / warn / bad）と Memory Debug の SLI 警戒色に使います。
        </div>
        <Row title="Bad: success < (%)" desc="この値を下回る成功率は bad 扱い。">
          <input className="s-input" type="number" min="1" max="100" value={sliBadSuccessLt} onChange={(e)=>setSliBadSuccessLt(e.target.value)} onBlur={()=>persistObservability({})} style={{width:90}} />
        </Row>
        <Row title="Bad: p95 > (ms)" desc="この値を上回る p95 は bad 扱い。">
          <input className="s-input" type="number" min="1" value={sliBadP95Gt} onChange={(e)=>setSliBadP95Gt(e.target.value)} onBlur={()=>persistObservability({})} style={{width:110}} />
        </Row>
        <Row title="Bad: backlog >" desc="この値を上回る backlog は bad 扱い。">
          <input className="s-input" type="number" min="0" value={sliBadBacklogGt} onChange={(e)=>setSliBadBacklogGt(e.target.value)} onBlur={()=>persistObservability({})} style={{width:90}} />
        </Row>
        <Row title="Warn: success < (%)" desc="bad 条件を満たさない場合に warn 判定で使用。">
          <input className="s-input" type="number" min="1" max="100" value={sliWarnSuccessLt} onChange={(e)=>setSliWarnSuccessLt(e.target.value)} onBlur={()=>persistObservability({})} style={{width:90}} />
        </Row>
        <Row title="Warn: p95 > (ms)" desc="bad 条件を満たさない場合に warn 判定で使用。">
          <input className="s-input" type="number" min="1" value={sliWarnP95Gt} onChange={(e)=>setSliWarnP95Gt(e.target.value)} onBlur={()=>persistObservability({})} style={{width:110}} />
        </Row>
        <Row title="Warn: backlog >" desc="bad 条件を満たさない場合に warn 判定で使用。" last>
          <input className="s-input" type="number" min="0" value={sliWarnBacklogGt} onChange={(e)=>setSliWarnBacklogGt(e.target.value)} onBlur={()=>persistObservability({})} style={{width:90}} />
        </Row>
      </div>

      <div className="s-card" style={{padding:20}}>
        <h3 style={{marginTop:0}}>User-defined rules (kioku_rules)</h3>
        <p style={{color:'#aaa', fontSize:12, marginTop:0}}>
          A JSON array of rule objects. Each object has <code>id</code>, optional <code>yaml</code> (frontmatter
          with <code>title:</code>), and <code>body</code>. Rules are injected at the top of every chat / brief /
          draft / pack system prompt. Saved to <code>settings.json</code>; the cache reloads on save.
        </p>
        <textarea
          className="s-input"
          value={rulesText}
          onChange={(e) => setRulesText(e.target.value)}
          rows={12}
          spellCheck={false}
          style={{fontFamily:'monospace', fontSize:12, width:'100%'}}
        />
        {rulesError && <div style={{color:'#e57373', marginTop:8, fontSize:12}}>{rulesError}</div>}
        <div style={{marginTop:12, display:'flex', gap:8}}>
          <button className="btn btn-sm btn-primary" onClick={() => void saveRules()}>
            Save rules
          </button>
          <button
            className="btn btn-sm btn-secondary"
            onClick={() => setRulesText(JSON.stringify(Array.isArray(sections.kioku_rules) ? sections.kioku_rules : [], null, 2))}
          >
            Discard changes
          </button>
        </div>
      </div>

      <div className="s-card" style={{padding:20, marginTop:16}}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8}}>
          <h3 style={{margin:0}}>edge_type review queue</h3>
          <div style={{display:'flex', gap:8}}>
            <label style={{fontSize:12, color:'#aaa'}}>
              <input
                type="checkbox"
                checked={showAllProposals}
                onChange={(e) => setShowAllProposals(e.target.checked)}
                style={{marginRight:4}}
              />
              Show reviewed
            </label>
            <button
              className="btn btn-sm btn-secondary"
              onClick={() => void refreshProposals()}
              disabled={proposalsBusy}
            >
              {proposalsBusy ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </div>
        <p style={{color:'#aaa', fontSize:12, marginTop:0}}>
          Each edge the extraction worker writes records its <code>edge_type</code> here. Mark
          new types as <strong>Accept</strong> to feed them into Stage 4's CHECK constraint
          candidate set, or <strong>Reject</strong> to flag them for soft-retire. Canonical
          types (<code>mentions</code> / <code>follows_up</code> / ...) are pre-accepted.
        </p>
        {proposalsErr && <div style={{color:'#e57373', marginBottom:8, fontSize:12}}>{proposalsErr}</div>}
        {proposals.length === 0 ? (
          <div style={{color:'#888', fontStyle:'italic', padding:'8px 0'}}>
            {showAllProposals
              ? 'No proposals yet. Once the extraction worker runs, it logs every edge_type here.'
              : 'No unreviewed proposals. Toggle "Show reviewed" to see canonical and previously-judged types.'}
          </div>
        ) : (
          <table className="mdbg-table" style={{marginTop:8}}>
            <thead>
              <tr>
                <th style={{textAlign:'left'}}>edge_type</th>
                <th style={{textAlign:'right'}}>seen</th>
                <th style={{textAlign:'left'}}>status</th>
                <th style={{textAlign:'left'}}>note (optional)</th>
                <th style={{textAlign:'right'}}>actions</th>
              </tr>
            </thead>
            <tbody>
              {proposals.map((p) => {
                const status =
                  p.reviewed === 1 ? 'accepted' :
                  p.reviewed === 2 ? 'rejected' :
                  'unreviewed';
                const statusColor =
                  p.reviewed === 1 ? '#8fdc8f' :
                  p.reviewed === 2 ? '#e57373' :
                  '#aaa';
                return (
                  <tr key={p.edge_type}>
                    <td>
                      <code>{p.edge_type}</code>
                      {p.canonical && (
                        <span style={{
                          marginLeft:6, fontSize:10, padding:'2px 6px', borderRadius:8,
                          background:'#1f3a1f', color:'#8fdc8f', border:'1px solid #2f5a2f',
                        }}>canonical</span>
                      )}
                    </td>
                    <td style={{textAlign:'right'}}>{p.seen_count}</td>
                    <td style={{color:statusColor}}>{status}</td>
                    <td>
                      {p.reviewer_note ? (
                        <span style={{color:'#aaa', fontSize:11}}>{p.reviewer_note}</span>
                      ) : (
                        <input
                          className="s-input"
                          placeholder="why accept/reject?"
                          value={reviewNotes[p.edge_type] || ''}
                          onChange={(e) => setReviewNotes((prev) => ({
                            ...prev, [p.edge_type]: e.target.value,
                          }))}
                          style={{fontSize:11, padding:'2px 6px', width:200}}
                        />
                      )}
                    </td>
                    <td style={{textAlign:'right'}}>
                      <button
                        className="btn btn-sm btn-secondary"
                        onClick={() => void reviewProposal(p.edge_type, 1)}
                        disabled={reviewBusy === p.edge_type || p.reviewed === 1}
                        style={{marginRight:4}}
                      >
                        Accept
                      </button>
                      <button
                        className="btn btn-sm btn-secondary"
                        onClick={() => void reviewProposal(p.edge_type, 2)}
                        disabled={reviewBusy === p.edge_type || p.reviewed === 2}
                      >
                        Reject
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="s-card" style={{padding:20, marginTop:16}}>
        <h3 style={{marginTop:0}}>Backup</h3>
        <p style={{color:'#aaa', fontSize:12, marginTop:0}}>
          Run <code>VACUUM INTO</code> on the live <code>memory.db</code> to produce a consistent
          compacted copy. Recommended before flipping <code>kioku_graph.stage5_apply</code> on, or
          anytime you want a snapshot. The Tauri app can stay running.
        </p>
        <Row title="Label" desc='Inserted into the default filename ("memory.db.<label>-YYYY-MM-DD-HHMMSS"). Leave blank for "backup".'>
          <input
            className="s-input"
            value={backupLabel}
            onChange={(e) => setBackupLabel(e.target.value)}
            placeholder="pre-stage5"
            style={{width:200}}
          />
        </Row>
        <Row title="Create backup now" desc="Writes to the same directory as memory.db. Refuses to overwrite existing files." last>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => void runBackup()}
            disabled={backupBusy}
          >
            {backupBusy ? 'Backing up…' : 'Create backup'}
          </button>
        </Row>
        {backupError && (
          <div style={{color:'#e57373', marginTop:8, fontSize:12}}>{backupError}</div>
        )}
        {backupResult && !backupError && (
          <div style={{marginTop:12, fontSize:12, color:'#aaa', lineHeight:1.6}}>
            <div>✓ Backup complete</div>
            <div>dest: <code>{backupResult.dest_path}</code></div>
            <div>size: {formatBytes(backupResult.bytes)}</div>
            <div>at: {new Date(backupResult.completed_at_ms).toLocaleString()}</div>
          </div>
        )}
      </div>
    </Pane>
  );
}

function formatBytes(n) {
  if (!n || n < 1024) return `${n || 0} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function PaneKiokuPatterns() {
  const { run, toast } = useRuntimeActions();
  const [items, setItems] = useStateS([]);
  const [loaded, setLoaded] = useStateS(false);
  const [busyId, setBusyId] = useStateS(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await run('patterns.list', {}, { silentError: true });
      if (cancelled) return;
      if (r.ok && Array.isArray(r.data?.items)) setItems(r.data.items);
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [run]);

  const invalidate = async (id) => {
    setBusyId(id);
    const prev = items;
    setItems(items.filter((p) => p.id !== id));
    const r = await run('patterns.invalidate', { id }, { silentError: true });
    setBusyId(null);
    if (!r.ok) {
      setItems(prev);
      toast('Could not remove — try again.', 'error');
    }
  };

  return (
    <Pane title="KIOKU Patterns">
      <div className="t-sm" style={{color:'var(--text-mute)', marginBottom:'var(--space-4)'}}>
        Things SHOGUN noticed about your routine.
      </div>
      <div className="card" style={{padding:'var(--space-4) var(--space-5)'}}>
        {!loaded ? (
          <div className="t-sm" style={{color:'var(--text-mute)'}}>Loading…</div>
        ) : items.length === 0 ? (
          <div className="t-sm" style={{color:'var(--text-mute)'}}>
            Nothing yet — patterns appear after a few days of usage.
          </div>
        ) : (
          <div style={{display:'flex', flexDirection:'column', gap:'var(--space-2)'}}>
            {items.map((p) => (
              <div key={p.id} style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'var(--space-3)'}}>
                <div className="t-sm" style={{color:'var(--text)'}}>• {p.label}</div>
                <button
                  className="btn btn-sm btn-secondary"
                  disabled={busyId === p.id}
                  onClick={() => invalidate(p.id)}
                >これ違う</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Pane>
  );
}

function PaneKiokuLessons() {
  const { run, toast } = useRuntimeActions();
  const [items, setItems] = useStateS([]);
  const [stats, setStats] = useStateS({ total_active: 0, applied_total: 0, prevented_total: 0 });
  const [statsLoaded, setStatsLoaded] = useStateS(false);
  const [loaded, setLoaded] = useStateS(false);
  const [busyId, setBusyId] = useStateS(null);

  const fetchStats = React.useCallback(async () => {
    const r = await run('lessons.stats', {}, { silentError: true });
    if (r.ok && r.data && typeof r.data === 'object') {
      setStats({
        total_active: Number(r.data.total_active || 0),
        applied_total: Number(r.data.applied_total || 0),
        prevented_total: Number(r.data.prevented_total || 0),
      });
    }
    setStatsLoaded(true);
  }, [run]);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      await fetchStats();
      if (cancelled) return;
      const r = await run('lessons.list', {}, { silentError: true });
      if (cancelled) return;
      if (r.ok && Array.isArray(r.data?.items)) setItems(r.data.items);
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [run, fetchStats]);

  const archive = async (id) => {
    setBusyId(id);
    const prev = items;
    const prevStats = stats;
    setItems(items.filter((l) => l.id !== id));
    setStats({
      total_active: Math.max(0, stats.total_active - 1),
      applied_total: stats.applied_total,
      prevented_total: stats.prevented_total,
    });
    const r = await run('lessons.archive', { id }, { silentError: true });
    setBusyId(null);
    if (!r.ok) {
      setItems(prev);
      setStats(prevStats);
      toast('Could not remove — try again.', 'error');
    } else {
      // Re-sync stats (applied_total may have ticked, total_active is authoritative now)
      void fetchStats();
    }
  };

  return (
    <Pane title="KIOKU Lessons">
      <div className="t-sm" style={{color:'var(--text-mute)', marginBottom:'var(--space-4)'}}>
        Things SHOGUN learned from your feedback.
      </div>
      <div className="card" style={{padding:'var(--space-4) var(--space-5)', marginBottom:'var(--space-4)'}}>
        <div className="t-sm" style={{color:'var(--text)'}}>
          {statsLoaded ? `${stats.total_active} lessons learned` : '— lessons learned'}
        </div>
        <div className="t-sm" style={{color:'var(--text-mute)', marginTop:'var(--space-1)'}}>
          {statsLoaded ? `Applied ${stats.applied_total} times total` : 'Applied — times total'}
        </div>
        {statsLoaded && stats.prevented_total > 0 && (
          <div className="t-sm" style={{color:'var(--text-mute)', marginTop:'var(--space-1)'}}>
            Prevented {stats.prevented_total} failures
          </div>
        )}
      </div>
      <div className="card" style={{padding:'var(--space-4) var(--space-5)'}}>
        {!loaded ? (
          <div className="t-sm" style={{color:'var(--text-mute)'}}>Loading…</div>
        ) : items.length === 0 ? (
          <div className="t-sm" style={{color:'var(--text-mute)'}}>
            No lessons yet — they grow as you give feedback.
          </div>
        ) : (
          <div style={{display:'flex', flexDirection:'column', gap:'var(--space-2)'}}>
            {items.map((l) => (
              <div key={l.id} style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'var(--space-3)'}}>
                <div className="t-sm" style={{color:'var(--text)'}}>• {l.rule}</div>
                <button
                  className="btn btn-sm btn-secondary"
                  disabled={busyId === l.id}
                  onClick={() => archive(l.id)}
                >忘れて</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Pane>
  );
}

const PANES = {
  general: PaneGeneral, system: PaneSystem, appearance: PaneAppearance,
  privacy: PanePrivacy, data: PaneData, hummingbird: PaneHummingbird,
  meetings: PaneMeetings, chat: PaneChat, llm: PaneLLM, integrations: PaneIntegrations,
  shortcuts: PaneShortcuts,
  team: PaneTeam, support: PaneSupport,
  kioku_graph: PaneKiokuGraph,
  kioku_patterns: PaneKiokuPatterns,
  kioku_lessons: PaneKiokuLessons,
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
  /** Re-hydrate all settings panes when the macOS tray toggles capture state.
   *  ipc-client.js dispatches shogun-settings-refresh on shogun-capture-state-changed. */
  React.useEffect(() => {
    const onRefresh = () => { void refreshSections(); };
    window.addEventListener('shogun-settings-refresh', onRefresh);
    return () => window.removeEventListener('shogun-settings-refresh', onRefresh);
  }, [refreshSections]);
  const hydrationCtxValue = React.useMemo(
    () => ({ sections: hydratedSections, refreshSections, setPane }),
    [hydratedSections, refreshSections, setPane],
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

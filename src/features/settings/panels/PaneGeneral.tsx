import React, { useState } from 'react';
import { Icon } from '@/shared/icons';
import { Pane } from '../components/Pane';
import { Field } from '../components/Field';
import { ProductLegalLinks } from '../components/ProductLegalLinks';
import { useRuntimeActions } from '../lib/hooks';
import { isProfilePhotoDataUrlSetting, imageFileToAvatarDataUrl } from '../lib/utils';
import { MAX_PROFILE_PHOTO_BYTES } from '../lib/defaults';
import { SettingsHydrationContext } from '../types';

export function PaneGeneral() {
  const { run, toast } = useRuntimeActions();
  const { sections, refreshSections } = React.useContext(SettingsHydrationContext);
  const [name, setName] = useState('');
  const [avatarGlyph, setAvatarGlyph] = useState('');
  const [avatarImageDataUrl, setAvatarImageDataUrl] = useState('');
  const [aliases, setAliases] = useState('');
  const [email, setEmail] = useState('');
  const [clerkState, setClerkState] = useState({ enabled: false, signedIn: false, label: '' });
  const photoInputRef = React.useRef<HTMLInputElement>(null);
  const saveProfile = React.useCallback(
    async (opts?: { quiet?: boolean }) => {
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
      const exec = (window as any).SHOGUN_RUNTIME && (window as any).SHOGUN_RUNTIME.executeAction;
      const r = exec ? await exec('auth.status', {}, { silentError: true }) : { ok: false };
      const enabled = !!(r.ok && r.data && r.data.clerk && r.data.clerk.enabled);
      const snap = r.ok && r.data && r.data.snapshot && typeof r.data.snapshot === 'object' ? r.data.snapshot : null;
      const auth = (window as any).ShogunClerkAuth;
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
        hint="Free tier: sign in with email, Google, etc. (in-app overlay). Add your dev URL and shogun-ai:// under Clerk → Redirect URLs if OAuth redirects fail; the app may fall back to the system browser. For Touch ID / Face ID on this device without a paid Clerk plan, use Privacy → Biometric app lock. When Clerk is enabled, Clerk's own Terms of Service and Privacy Policy (clerk.com) apply to authentication and account data processed by Clerk, in addition to SHOGUN's documents."
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
              const res = await imageFileToAvatarDataUrl(f, MAX_PROFILE_PHOTO_BYTES);
              if (res.error) {
                toast(res.error, 'warn');
                return;
              }
              setAvatarImageDataUrl(res.dataUrl!);
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
                  const c = Array.from(n)[0] as string;
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
        <div className="row" style={{ gap: 8 }}>
          <input
            className="s-input"
            placeholder="you@example.com"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ flex: 1 }}
            onBlur={() => void saveProfile({ quiet: true })}
          />
          <button className="btn btn-sm btn-secondary" type="button" onClick={() => void saveProfile()}>
            <Icon name="edit" size={12} />
          </button>
        </div>
      </Field>
      <div className="s-meta">
        <div style={{ fontSize: 13, color: 'var(--text)' }}>SHOGUN v0.4.1 <span className="label label-gold" style={{ marginLeft: 6 }}>Stable</span></div>
        <div className="s-field-hint" style={{ marginTop: 4 }}>You are on the latest version · Channel: Stable</div>
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

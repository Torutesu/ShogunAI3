import React, { useState } from 'react';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';

interface OAuthNotConfiguredModalProps {
  onClose: () => void;
  /** Called after credentials are saved to Keychain, so the caller can retry the connect. */
  onSaved?: () => void;
}

/**
 * Production credential entry for in-app Google OAuth.
 *
 * The DMG build has no `scripts/.env.google-oauth` file, so `oauth.google.start`
 * dead-ends with `oauth_credentials_not_configured`. This modal writes the user's
 * own Google Cloud OAuth client id/secret to the macOS Keychain via the
 * `oauth.google.app_set` command, which `load_oauth_credentials()` reads before
 * the dev file. We never see the secret beyond passing it to the local command.
 */
export function OAuthNotConfiguredModal({ onClose, onSaved }: OAuthNotConfiguredModalProps) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = clientId.trim().length > 0 && clientSecret.trim().length > 0 && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const res = await runRuntimeAction(
        'oauth.google.app_set',
        { clientId: clientId.trim(), clientSecret: clientSecret.trim() },
        { silentError: true },
      );
      if (!res?.ok) {
        setError(String(res?.error || 'Failed to save credentials'));
        return;
      }
      (window as any).SHOGUN_RUNTIME?.pushToast?.('Google OAuth app credentials saved', 'success');
      try {
        window.dispatchEvent(new CustomEvent('shogun-credentials-updated', { detail: { provider: 'google_oauth_app' } }));
      } catch (_) {
        /* ignore */
      }
      onSaved?.();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onMouseDown={onClose}
    >
      <div
        style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 8, padding: 24, maxWidth: 540, width: '92%', color: 'var(--text)',
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>
          <span className="en-only">Connect your Google OAuth app</span>
          <span className="jp">Google OAuth アプリを接続</span>
        </h3>
        <p style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-mute)', margin: '0 0 14px' }}>
          <span className="en-only">
            In-app Google sign-in needs an OAuth client from your own Google Cloud project.
            Paste its Client ID and Client Secret below — they are stored only in your macOS Keychain on this device.
          </span>
          <span className="jp">
            アプリ内 Google 連携には、あなた自身の Google Cloud プロジェクトの OAuth クライアントが必要です。
            Client ID と Client Secret を下に貼り付けてください。値はこの端末の macOS Keychain にのみ保存されます。
          </span>
        </p>

        <label htmlFor="oauth-client-id" style={{ display: 'block', fontSize: 12, color: 'var(--text-mute)', marginBottom: 4 }}>Client ID</label>
        <input
          id="oauth-client-id"
          className="s-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="1234567890-abcdef.apps.googleusercontent.com"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          style={{ width: '100%', marginBottom: 12 }}
        />

        <label htmlFor="oauth-client-secret" style={{ display: 'block', fontSize: 12, color: 'var(--text-mute)', marginBottom: 4 }}>Client Secret</label>
        <input
          id="oauth-client-secret"
          className="s-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="GOCSPX-…"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          style={{ width: '100%', marginBottom: 4 }}
        />

        <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5, margin: '8px 0 4px' }}>
          <span className="en-only">
            Create these in Google Cloud Console → APIs &amp; Services → Credentials → OAuth client ID
            (type: Desktop app). Add the Gmail &amp; Calendar read scopes on the OAuth consent screen.
          </span>
          <span className="jp">
            Google Cloud Console → API とサービス → 認証情報 → OAuth クライアント ID（種類: デスクトップ アプリ）で作成し、
            OAuth 同意画面で Gmail・Calendar の読み取りスコープを追加してください。
          </span>
        </div>
        <a
          className="s-link"
          href="https://console.cloud.google.com/apis/credentials"
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 12 }}
        >
          <span className="en-only">Open Google Cloud Credentials</span>
          <span className="jp">Google Cloud 認証情報を開く</span>
        </a>

        {error && (
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--warn, #d88)' }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose} disabled={busy}>
            <span className="en-only">Cancel</span>
            <span className="jp">キャンセル</span>
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void save()} disabled={!canSave}>
            {busy ? (
              <><span className="en-only">Saving…</span><span className="jp">保存中…</span></>
            ) : (
              <><span className="en-only">Save &amp; connect</span><span className="jp">保存して接続</span></>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

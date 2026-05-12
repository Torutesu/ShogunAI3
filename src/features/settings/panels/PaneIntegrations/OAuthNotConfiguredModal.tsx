interface OAuthNotConfiguredModalProps {
  onClose: () => void;
}

export function OAuthNotConfiguredModal({ onClose }: OAuthNotConfiguredModalProps) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={onClose}
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
              (window as any).SHOGUN_RUNTIME?.pushToast?.('Command copied', 'success');
            }}
          >
            <span className="en-only">Copy command</span>
            <span className="jp">コマンドをコピー</span>
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onClose}
          >
            <span className="en-only">Close</span>
            <span className="jp">閉じる</span>
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, type ReactNode } from 'react';
import * as ReactDOM from 'react-dom';

export interface PasteTokenModalProps {
  pasteTokenModal: { provider: string; token: string; busy: boolean } | null;
  onClose: () => void;
  onTokenChange: (token: string) => void;
  onSave: () => void;
}

/**
 * Per-provider title + token help. Data-driven so adding a provider is one entry
 * (the old nested ternary fell through to "Connect GitHub" for anything unknown,
 * which mislabeled the dialog).
 *
 * Only list providers whose connector actually ingests something real — see
 * `integrations::supports_token_import` for the backend set.
 */
const PROVIDER_TOKEN_HELP: Record<string, { title: string; help: ReactNode }> = {
  slack: {
    title: 'Connect Slack',
    help: <>Paste a Slack Bot token (<code>xoxb-…</code>) or User token (<code>xoxp-…</code>). Required scopes: <code>channels:history</code>, <code>groups:history</code>, <code>im:history</code>, <code>channels:read</code>.</>,
  },
  notion: {
    title: 'Connect Notion',
    help: <>Paste a Notion <em>Internal Integration Token</em> (<code>ntn_…</code> / <code>secret_…</code>). Share each page/database with the integration from Notion.</>,
  },
  github: {
    title: 'Connect GitHub',
    help: <>Paste a GitHub Personal Access Token. Recommended scopes: <code>repo</code>, <code>read:user</code>. Fine-grained PATs work too with read permissions on your repos.</>,
  },
  linear: {
    title: 'Connect Linear',
    help: <>Paste a Linear <em>Personal API Key</em> (starts with <code>lin_api_…</code>) from Linear → Settings → API, or a Linear OAuth access token.</>,
  },
  zoom: {
    title: 'Connect Zoom',
    help: <>Paste a Zoom OAuth access token. Required scope: <code>cloud_recording:read</code> (User OAuth) or the Server-to-Server equivalent. Only cloud-recorded meetings are accessible.</>,
  },
  outlook: {
    title: 'Connect Outlook',
    help: <>Paste a Microsoft Graph access token. Required scope: <code>Mail.Read</code> (add <code>offline_access</code> for refresh). Create one from an Azure app registration; your recent mail is read into Memory.</>,
  },
};

export function PasteTokenModal(props: PasteTokenModalProps) {
  const tokenInputRef = useRef<HTMLInputElement>(null);
  const isOpen = !!props.pasteTokenModal;

  useEffect(() => {
    if (isOpen) tokenInputRef.current?.focus();
  }, [isOpen]);

  if (!props.pasteTokenModal) return null;
  const { pasteTokenModal } = props;
  const meta = PROVIDER_TOKEN_HELP[pasteTokenModal.provider];
  if (!meta) return null;
  return ReactDOM.createPortal(
    <div
      style={{
        position:'fixed', inset:0, zIndex:1091,
        background:'color-mix(in srgb, var(--bg) 78%, transparent)',
        backdropFilter:'blur(4px)',
        display:'flex', alignItems:'center', justifyContent:'center',
        padding:20,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !pasteTokenModal.busy) props.onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width:'min(480px, 100%)',
          background:'var(--surface)',
          border:'1px solid var(--border-hi)',
          borderRadius:16,
          boxShadow:'0 30px 60px -16px rgba(0,0,0,0.6)',
          padding:22,
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={{fontSize:16, fontWeight:500, marginBottom:6}}>{meta.title}</div>
        <div style={{fontSize:12, color:'var(--text-mute)', lineHeight:1.55, marginBottom:14}}>
          {meta.help}
        </div>

        <label htmlFor="paste-token-input" style={{display:'block', fontSize:11, color:'var(--text-dim)', marginBottom:4}}>Token</label>
        <input
          id="paste-token-input"
          ref={tokenInputRef}
          type="password"
          value={pasteTokenModal.token}
          onChange={(e) => props.onTokenChange(e.target.value)}
          placeholder="Paste token here"
          style={{
            width:'100%',
            padding:'10px 12px',
            borderRadius:8,
            border:'1px solid var(--border-hi)',
            background:'var(--bg)',
            color:'var(--text)',
            fontSize:13,
            fontFamily:'var(--font-mono)',
          }}
          disabled={pasteTokenModal.busy}
        />

        <div className="row" style={{marginTop:18, gap:8, justifyContent:'flex-end'}}>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={pasteTokenModal.busy}
            onClick={props.onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={pasteTokenModal.busy || !pasteTokenModal.token.trim()}
            style={(pasteTokenModal.busy || !pasteTokenModal.token.trim()) ? {opacity:0.5, cursor:'not-allowed'} : undefined}
            onClick={props.onSave}
          >
            {pasteTokenModal.busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

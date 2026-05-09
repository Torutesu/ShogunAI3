import * as ReactDOM from 'react-dom';
import { Icon } from '@/shared/icons';

export function ConfirmWriteModal(props: any) {
  const open = Boolean(props && props.open);
  if (!open) return null;

  const title = props.title || 'Confirm action';
  const description = props.description || 'This action changes local state or external services.';
  const actionName = props.actionName || 'write_action';
  const payload = props.payload || {};
  const onCancel = props.onCancel || function noop() {};
  const onConfirm = props.onConfirm || function noop() {};
  const pending = Boolean(props.pending);

  const tree = (
    <>
      <div
        className="swm-backdrop"
        role="presentation"
        onMouseDown={pending ? undefined : function (e) { e.preventDefault(); onCancel(); }}
      />
      <div className="swm-modal" role="dialog" aria-modal="true" onMouseDown={function (e) { e.stopPropagation(); }}>
        <div className="swm-header">
          <div className="row" style={{ gap: 8 }}>
            <Icon name="shield" size={14}/>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 6 }}>{description}</div>
        </div>
        <div className="swm-body">
          <div className="swm-row">
            <span className="t-mono">ACTION</span>
            <span>{actionName}</span>
          </div>
          <div className="swm-preview">
            <pre>{JSON.stringify(payload, null, 2)}</pre>
          </div>
        </div>
        <div className="swm-footer">
          <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel} disabled={pending}>Cancel</button>
          <button type="button" className="btn btn-sm btn-secondary" onClick={onConfirm} disabled={pending}>
            {pending ? 'Running...' : 'Confirm'}
          </button>
        </div>
      </div>
      <style>{`
        .swm-backdrop {
          position: fixed; inset: 0; z-index: 1150;
          background: rgba(10, 9, 8, 0.55);
        }
        .swm-modal {
          position: fixed; z-index: 1151;
          top: 50%; left: 50%; transform: translate(-50%, -50%);
          box-sizing: border-box;
          width: min(560px, calc(100vw - 32px));
          max-width: calc(100vw - 32px);
          max-height: calc(100vh - 32px);
          max-height: calc(100dvh - 32px);
          overflow: auto;
          background: var(--surface); border: 1px solid var(--border-hi);
          border-radius: var(--radius-lg);
          box-shadow: 0 24px 48px -12px rgba(0,0,0,0.6);
        }
        .swm-header { padding: 16px 18px; border-bottom: 1px solid var(--border); }
        .swm-body { padding: 16px 18px; }
        .swm-row {
          display: flex; align-items: center; justify-content: space-between;
          font-size: 12px; margin-bottom: 12px;
        }
        .swm-preview {
          max-height: 220px; overflow: auto; border: 1px solid var(--border);
          border-radius: var(--radius-sm); background: var(--bg);
        }
        .swm-preview pre {
          margin: 0; padding: 10px 12px; font-size: 11px;
          font-family: var(--font-mono); color: var(--text-mute);
        }
        .swm-footer {
          padding: 12px 18px 16px; border-top: 1px solid var(--border);
          display: flex; justify-content: flex-end; gap: 8px;
        }
      `}</style>
    </>
  );
  return ReactDOM.createPortal(tree, document.body);
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).ConfirmWriteModal = ConfirmWriteModal;
}

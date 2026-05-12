import React from 'react';
import * as ReactDOM from 'react-dom';

interface FallbackWriteModalProps {
  open: boolean;
  title?: string;
  description?: string;
  payload?: any;
  pending?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  /** Unused but accepted so the interface matches ConfirmWriteModal */
  actionName?: string;
}

/** Fallback modal rendered when ConfirmWriteModal from @/shared/modals is unavailable. */
export function FallbackWriteModal(props: FallbackWriteModalProps): React.ReactElement | null {
  if (!props.open) return null;
  return ReactDOM.createPortal(
    <>
      <div
        role="presentation"
        style={{ position: 'fixed', inset: 0, zIndex: 1150, background: 'rgba(10,9,8,0.55)' }}
        onMouseDown={(e) => {
          if (props.pending) return;
          e.preventDefault();
          props.onCancel();
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%,-50%)',
          zIndex: 1151,
          boxSizing: 'border-box',
          width: 'min(520px, calc(100vw - 32px))',
          maxHeight: 'calc(100vh - 32px)',
          overflow: 'auto',
          background: 'var(--surface)',
          border: '1px solid var(--border-hi)',
          borderRadius: 'var(--radius-lg)',
          padding: 16,
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>{props.title || 'Confirm action'}</div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 10 }}>{props.description || 'This action may change local state.'}</div>
        <pre style={{ maxHeight: 180, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 10, margin: 0, fontSize: 11, fontFamily: 'var(--font-mono)' }}>{JSON.stringify(props.payload || {}, null, 2)}</pre>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button type="button" className="btn btn-sm btn-ghost" onClick={props.onCancel}>Cancel</button>
          <button type="button" className="btn btn-sm btn-secondary" onClick={props.onConfirm}>{props.pending ? 'Running...' : 'Confirm'}</button>
        </div>
      </div>
    </>,
    document.body,
  );
}

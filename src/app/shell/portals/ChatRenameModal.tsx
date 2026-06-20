import { useEffect, useRef } from 'react';
import * as ReactDOM from 'react-dom';

export interface ChatRenameModalProps {
  open: boolean;
  value: string;
  onClose: () => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
}

export function ChatRenameModal(props: ChatRenameModalProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const isOpen = props.open;

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  if (!props.open) return null;
  return ReactDOM.createPortal(
    <div className="chat-modal-backdrop" role="presentation" onMouseDown={props.onClose}>
      <div className="chat-dialog rename" role="dialog" aria-modal="true" aria-label="チャット名変更" onMouseDown={(e) => e.stopPropagation()}>
        <div className="chat-dialog-title small">チャットの名前を変更</div>
        <input
          ref={inputRef}
          type="text"
          className="chat-dialog-input"
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') props.onSubmit();
            if (e.key === 'Escape') props.onClose();
          }}
        />
        <div className="chat-dialog-actions">
          <button type="button" className="chat-dialog-btn ghost" onClick={props.onClose}>キャンセル</button>
          <button type="button" className="chat-dialog-btn solid" onClick={props.onSubmit}>保存</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

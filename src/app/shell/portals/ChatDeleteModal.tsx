import * as ReactDOM from 'react-dom';

export interface ChatDeleteModalProps {
  open: boolean;
  chatDeleteTarget: { title: string } | null;
  onClose: () => void;
  onConfirm: () => void;
}

export function ChatDeleteModal(props: ChatDeleteModalProps) {
  if (!props.open) return null;
  return ReactDOM.createPortal(
    <div className="chat-modal-backdrop" role="presentation" onMouseDown={props.onClose}>
      <div className="chat-dialog" role="dialog" aria-modal="true" aria-label="チャット削除確認" onMouseDown={(e) => e.stopPropagation()}>
        <div className="chat-dialog-title">チャットを削除</div>
        <div className="chat-dialog-desc">
          {props.chatDeleteTarget ? `「${props.chatDeleteTarget.title}」を削除してもよろしいですか？` : 'このチャットを削除してもよろしいですか？'}
        </div>
        <div className="chat-dialog-actions">
          <button type="button" className="chat-dialog-btn ghost" onClick={props.onClose}>Cancel</button>
          <button type="button" className="chat-dialog-btn danger" onClick={props.onConfirm}>削除</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

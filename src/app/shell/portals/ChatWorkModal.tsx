import * as ReactDOM from 'react-dom';
import { Icon } from '@/shared/icons';

export interface ChatWorkModalProps {
  open: boolean;
  query: string;
  filteredWorkProjects: Array<{ id: any; name: string }>;
  onClose: () => void;
  onQueryChange: (query: string) => void;
  onAssignToWork: (id: any, name: string) => void;
  onCreateAndAssign: () => void;
}

export function ChatWorkModal(props: ChatWorkModalProps) {
  if (!props.open) return null;
  return ReactDOM.createPortal(
    <div className="chat-modal-backdrop" role="presentation" onMouseDown={props.onClose}>
      <div className="chat-dialog work" role="dialog" aria-modal="true" aria-label="Workに追加" onMouseDown={(e) => e.stopPropagation()}>
        <button type="button" className="chat-dialog-close" onClick={props.onClose} aria-label="閉じる">
          <Icon name="x" size={16}/>
        </button>
        <div className="chat-dialog-title">チャットを移動</div>
        <div className="chat-dialog-desc">このチャットを移動するプロジェクトを選択してください。</div>
        <div className="work-search-wrap">
          <Icon name="search" size={16}/>
          <input
            type="text"
            className="work-search-input"
            placeholder="プロジェクトを検索または作成"
            value={props.query}
            autoFocus
            onChange={(e) => props.onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (props.filteredWorkProjects[0]) props.onAssignToWork(props.filteredWorkProjects[0].id, props.filteredWorkProjects[0].name);
                else props.onCreateAndAssign();
              }
            }}
          />
        </div>
        {props.filteredWorkProjects.length > 0 ? (
          <div className="work-list">
            {props.filteredWorkProjects.map((p) => (
              <button key={p.id} type="button" className="work-list-item" onClick={() => props.onAssignToWork(p.id, p.name)}>
                <Icon name="folder" size={14}/>
                <span>{p.name}</span>
              </button>
            ))}
          </div>
        ) : props.query.trim() ? (
          <button type="button" className="work-list-item create" style={{ marginTop: 8, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }} onClick={props.onCreateAndAssign}>
            <Icon name="plus" size={14}/>
            <span>「{props.query.trim()}」を作成して追加</span>
          </button>
        ) : (
          <div className="work-list-empty">プロジェクトはまだありません。名前を入力して作成してください。</div>
        )}
      </div>
    </div>,
    document.body,
  );
}

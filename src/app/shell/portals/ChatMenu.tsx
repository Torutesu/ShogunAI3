import * as ReactDOM from 'react-dom';
import { Icon } from '@/shared/icons';

export interface ChatMenuProps {
  open: boolean;
  chatId: any;
  x: number;
  y: number;
  width: number;
  chatMenuTarget: { favorite?: boolean } | null;
  chatMenuTargetWork: { archived?: boolean } | null;
  onClose: () => void;
  onAction: (action: string, chatId: any) => void;
}

export function ChatMenu(props: ChatMenuProps) {
  if (!props.open) return null;
  return ReactDOM.createPortal(
    <>
      <div
        role="presentation"
        style={{ position:'fixed', inset:0, zIndex:1090 }}
        onMouseDown={props.onClose}
      />
      <div
        className="chat-row-menu"
        style={{ left: props.x, top: props.y, width: props.width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button type="button" className="chat-row-menu-item" onClick={() => props.onAction('pin', props.chatId)}>
          <Icon name="pin" size={16}/>
          <span>{props.chatMenuTarget?.favorite ? 'Favoriteから外す' : 'Favoriteに追加'}</span>
        </button>
        <button type="button" className="chat-row-menu-item" onClick={() => props.onAction('rename', props.chatId)}>
          <Icon name="edit" size={16}/>
          <span>名前を変更</span>
        </button>
        <button type="button" className="chat-row-menu-item" onClick={() => props.onAction('work', props.chatId)}>
          <Icon name="folder" size={16}/>
          <span>Workに追加</span>
        </button>
        {props.chatMenuTargetWork && (
          <button type="button" className="chat-row-menu-item" onClick={() => props.onAction('workArchive', props.chatId)}>
            <Icon name={props.chatMenuTargetWork.archived === true ? 'eye' : 'folder'} size={16}/>
            <span>{props.chatMenuTargetWork.archived === true ? 'Workを復元' : 'Workをアーカイブ'}</span>
          </button>
        )}
        <div className="chat-row-menu-sep"/>
        <button type="button" className="chat-row-menu-item danger" onClick={() => props.onAction('delete', props.chatId)}>
          <Icon name="trash" size={16}/>
          <span>削除</span>
        </button>
      </div>
    </>,
    document.body,
  );
}

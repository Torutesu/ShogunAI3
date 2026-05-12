import * as ReactDOM from 'react-dom';
import { Icon } from '@/shared/icons';
import { isProfilePhotoDataUrl, shellAvatarChar } from '../../lib/helpers';

export interface UserFloatMenuProps {
  open: boolean;
  anchor: { left: number; bottom: number; width: number; maxHeight: number };
  profileDisplayName: string;
  profileAvatarGlyph: string;
  profileAvatarImageDataUrl: string;
  onClose: () => void;
  onOpenSettings: (pane: string) => void;
}

export function UserFloatMenu(props: UserFloatMenuProps) {
  if (!props.open) return null;
  return ReactDOM.createPortal(
    <>
      <div
        role="presentation"
        style={{ position: 'fixed', inset: 0, zIndex: 1080 }}
        onMouseDown={props.onClose}
      />
      <div
        className="user-float"
        style={{
          left: props.anchor.left,
          bottom: props.anchor.bottom,
          width: props.anchor.width,
          maxHeight: props.anchor.maxHeight,
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="user-float-head">
          <div style={{fontSize:13, color:'var(--text-dim)'}}>
            {props.profileDisplayName.trim() || 'You'}
          </div>
        </div>
        <div className="user-float-section">
          <div className="user-float-row" onClick={() => { props.onOpenSettings('general'); props.onClose(); }}>
            <Icon name="settings" size={16}/><span className="en-only">Settings</span><span className="jp">設定</span>
            <span className="spacer"/><span className="kbd-mini">⌘,</span>
          </div>
          <div className="user-float-row" onClick={() => { props.onOpenSettings('download'); props.onClose(); }}>
            <Icon name="download" size={16}/><span className="en-only">Download Mobile App</span><span className="jp">モバイルアプリ</span>
          </div>
        </div>
        <div className="user-float-section" style={{borderTop:'1px solid var(--border)'}}>
          <div className="user-float-row" onClick={() => { props.onOpenSettings('feedback'); props.onClose(); }}>
            <Icon name="chat" size={16}/><span className="en-only">Give Feedback</span><span className="jp">フィードバック</span>
          </div>
          <div className="user-float-row" onClick={() => { props.onOpenSettings('support'); props.onClose(); }}>
            <Icon name="info" size={16}/><span className="en-only">Help Center</span><span className="jp">ヘルプ</span>
          </div>
          <div className="user-float-row" onClick={() => { props.onOpenSettings('changelog'); props.onClose(); }}>
            <Icon name="clock" size={16}/><span className="en-only">Changelog</span><span className="jp">更新履歴</span>
          </div>
          <div className="user-float-row gold" onClick={() => { props.onOpenSettings('referral'); props.onClose(); }}>
            <Icon name="gift" size={16}/><span className="en-only">Get 2 Months Free</span><span className="jp">2か月無料</span>
          </div>
        </div>
        <div className="user-float-section" style={{borderTop:'1px solid var(--border)'}}>
          <div className="user-float-row" style={{color:'var(--text-mute)'}}>
            <Icon name="logout" size={16}/><span className="en-only">Logout</span><span className="jp">ログアウト</span>
          </div>
        </div>
        {/* Profile chip at bottom, like reference */}
        <div className="user-float-profile">
          <div
            className="avatar"
            style={{ overflow: 'hidden', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            {isProfilePhotoDataUrl(props.profileAvatarImageDataUrl) ? (
              <img
                src={props.profileAvatarImageDataUrl}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              shellAvatarChar(props.profileAvatarGlyph, props.profileDisplayName)
            )}
          </div>
          <div style={{flex:1, minWidth:0}}>
            <div style={{fontSize:12, fontWeight:500}}>{props.profileDisplayName.trim() || 'You'}</div>
            <div style={{fontSize:10, color:'var(--text-dim)'}}>Pro · Local</div>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}

import React from 'react';
import { Icon, Kamon } from '@/shared/icons';

interface TopBarProps {
  active: string;
  setActive: (v: string) => void;
  shareTip: any;
  setShareTip: (v: any) => void;
  requestWriteAction: (actionKey: any, payload: any, title: any, description: any) => void;
  favorited: boolean;
  setFavorited: (v: boolean | ((prev: boolean) => boolean)) => void;
  setHummingbirdOpen: (v: boolean) => void;
  shareOpen: boolean;
  setShareOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
}

export function TopBar({
  active,
  setActive,
  shareTip,
  setShareTip,
  requestWriteAction,
  favorited,
  setFavorited,
  setHummingbirdOpen,
  shareOpen,
  setShareOpen,
}: TopBarProps): React.ReactElement {
  return (
    <div className="topbar">
      <button type="button" className="brand" onClick={()=>setActive('home')} title="Shogun AI · Home">
        <Kamon size={26} color="var(--text)"/>
        <div>
          <div className="brand-title en-only">Shogun AI</div>
          <div className="brand-jp jp">Shogun AI</div>
        </div>
      </button>
      <div
        className="cmdk"
        role="button"
        tabIndex={0}
        style={{ cursor: 'pointer' }}
        onClick={() => setActive('chat')}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setActive('chat');
          }
        }}
      >
        <Icon name="search" size={14}/>
        <span className="cmdk-label">Open Chat…</span>
        <span className="kbd">⌘K</span>
      </div>
      <div className="right">
        {/* Hummingbird · favorite · share — chat screen only */}
        {active === 'chat' && (
        <div className="page-actions">
          <button
            type="button"
            className="page-action"
            title="Open in Hummingbird"
            aria-label="Open in Hummingbird"
            onMouseEnter={()=>setShareTip('popout')}
            onMouseLeave={()=>setShareTip(null)}
            onClick={() => requestWriteAction(
              'app.open_hummingbird',
              { source:'topbar', activeScreen:active },
              'Open Hummingbird',
              'This triggers a native app-level action.'
            )}
          >
            <Icon name="popout" size={15}/>
            {shareTip==='popout' && <span className="tip">Open in Hummingbird</span>}
          </button>
          <button
            type="button"
            className={'page-action'+(favorited?' on':'')}
            title="Open Hummingbird"
            aria-label="Open Hummingbird"
            onMouseEnter={()=>setShareTip('star')}
            onMouseLeave={()=>setShareTip(null)}
            onClick={(e) => {
              if (e.shiftKey) {
                setFavorited((v) => !v);
                return;
              }
              setHummingbirdOpen(true);
            }}
          >
            <Icon name="star" size={15}/>
            {shareTip==='star' && (
              <span className="tip">
                <span className="en-only">Hummingbird · Shift+click to favorite</span>
                <span className="jp">Hummingbird（Shift+お気に入り）</span>
              </span>
            )}
          </button>
          <button
            type="button"
            className={'page-action'+(shareOpen?' active':'')}
            title="Share chat"
            aria-label="Share chat"
            onMouseEnter={()=>setShareTip('share')}
            onMouseLeave={()=>setShareTip(null)}
            onClick={()=>setShareOpen(v=>!v)}
          >
            <Icon name="upload" size={15}/>
            {shareTip==='share' && !shareOpen && <span className="tip">Share chat</span>}
          </button>
        </div>
        )}
      </div>
    </div>
  );
}

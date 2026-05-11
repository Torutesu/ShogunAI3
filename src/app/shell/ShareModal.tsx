import React from 'react';
import * as ReactDOM from 'react-dom';
import { Icon } from '@/shared/icons';

interface ShareModalProps {
  shareOpen: boolean;
  setShareOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  shareMode: string;
  setShareMode: (v: string) => void;
  chats: any[];
  activeChat: any;
  executeAction: (actionKey: any, payload: any, options?: any) => Promise<any>;
}

export function ShareModal({
  shareOpen,
  setShareOpen,
  shareMode,
  setShareMode,
  chats,
  activeChat,
  executeAction,
}: ShareModalProps): React.ReactElement | null {
  if (!shareOpen) return null;
  return ReactDOM.createPortal(
    <>
      <div
        role="presentation"
        style={{ position: 'fixed', inset: 0, zIndex: 1120 }}
        onMouseDown={(e) => {
          e.preventDefault();
          setShareOpen(false);
        }}
      />
      <div className="share-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div style={{fontSize:18, fontWeight:600, marginBottom:4}}>
          <span className="en-only">Share chat</span>
          <span className="jp" style={{marginLeft:8, fontSize:14, color:'var(--text-mute)'}}>共有</span>
        </div>
        <div style={{fontSize:13, color:'var(--text-mute)', marginBottom:18}}>Only messages up until now will be shared</div>
        <div className="share-choices">
          <div className={'share-choice '+(shareMode==='private'?'on':'')} onClick={()=>setShareMode('private')}>
            <Icon name="lock" size={18} className={shareMode==='private'?'gold':'dim'}/>
            <div style={{flex:1}}>
              <div style={{fontSize:14, fontWeight:500}}>
                Private
                <span className="jp" style={{marginLeft:8, fontSize:11, color:'var(--text-dim)'}}>非公開</span>
              </div>
              <div style={{fontSize:12, color:'var(--text-mute)', marginTop:2}}>Only you have access</div>
            </div>
            {shareMode==='private' && <Icon name="check" size={16} className="gold"/>}
          </div>
          <div className={'share-choice '+(shareMode==='public'?'on':'')} onClick={()=>setShareMode('public')}>
            <Icon name="globe" size={18} className={shareMode==='public'?'gold':'dim'}/>
            <div style={{flex:1}}>
              <div style={{fontSize:14, fontWeight:500}}>
                Public access
                <span className="jp" style={{marginLeft:8, fontSize:11, color:'var(--text-dim)'}}>公開</span>
              </div>
              <div style={{fontSize:12, color:'var(--text-mute)', marginTop:2}}>Anyone with the link can view</div>
            </div>
            {shareMode==='public' && <Icon name="check" size={16} className="gold"/>}
          </div>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          style={{width:'100%', marginTop:18, height:'var(--control-lg)', fontSize:'var(--text-md)'}}
          onClick={async () => {
            const chatTitle = chats.find(c => c.id === activeChat)?.title || 'Untitled chat';
            const res = await executeAction('app.create_share_link', {
              mode: shareMode,
              chatId: activeChat,
              title: chatTitle,
              markdown: `Shared chat: **${chatTitle}**\n\n(Transcript is not attached in this export; use Chat on desktop for full history.)`,
            }, { successMessage:'Chat exported to file' });
            if (res.ok && !res.data?.cancelled) setShareOpen(false);
          }}
        >
          <Icon name="link" size={14}/> Export to file…
        </button>
      </div>
    </>,
    document.body,
  ) as React.ReactElement;
}

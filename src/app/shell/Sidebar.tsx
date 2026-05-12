import React from 'react';
import { Icon } from '@/shared/icons';
import { isProfilePhotoDataUrl, shellAvatarChar } from '../lib/helpers';

interface SidebarProps {
  sections: any[];
  effectiveNav: any[];
  active: string;
  setActive: (v: string) => void;
  createNewChat: () => void;
  dragOver: any;
  toggleChatGroup: (groupKey: any) => void;
  chatGroupsOpen: any;
  favChats: any[];
  restChats: any[];
  onChatRowPointerDown: (id: any) => (e: any) => void;
  openChatMenuAt: (chatId: any, x: any, y: any) => void;
  activeChat: any;
  suppressChatRowClickRef: React.MutableRefObject<boolean>;
  setActiveChat: (id: any) => void;
  dragId: any;
  contextBtnRef: React.RefObject<any>;
  contextPanelOpen: boolean;
  openContextPanel: () => void;
  userBtnRef: React.RefObject<any>;
  openUser: () => void;
  profileAvatarImageDataUrl: string;
  profileAvatarGlyph: string;
  profileDisplayName: string;
  userOpen: boolean;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean | ((prev: boolean) => boolean)) => void;
  sidebarWidth: number;
  sidebarResizeHint: boolean;
  setSidebarResizeHint: (v: boolean) => void;
  resizeStateRef: React.MutableRefObject<any>;
  beginSidebarResize: (e: any) => void;
}

export function Sidebar({
  sections,
  effectiveNav,
  active,
  setActive,
  createNewChat,
  dragOver,
  toggleChatGroup,
  chatGroupsOpen,
  favChats,
  restChats,
  onChatRowPointerDown,
  openChatMenuAt,
  activeChat,
  suppressChatRowClickRef,
  setActiveChat,
  dragId,
  contextBtnRef,
  contextPanelOpen,
  openContextPanel,
  userBtnRef,
  openUser,
  profileAvatarImageDataUrl,
  profileAvatarGlyph,
  profileDisplayName,
  userOpen,
  sidebarCollapsed,
  setSidebarCollapsed,
  sidebarWidth,
  sidebarResizeHint,
  setSidebarResizeHint,
  resizeStateRef,
  beginSidebarResize,
}: SidebarProps): React.ReactElement {
  return (
    <>
      <div className="sidebar" data-screen-label="sidebar">
        {sections.map(sec => (
          <div key={sec.id}>
            {(sec.label || sec.jp) && (
              <div className="section-label"><span className="en-only">{sec.label}</span><span className="en-only"> · </span><span className="jp">{sec.jp}</span></div>
            )}
            {effectiveNav.filter(n => n.section === sec.id).map(n => (
              <React.Fragment key={n.id}>
                <div className={'nav-item '+(active===n.id?'active':'')} onClick={() => setActive(n.id)}>
                  <Icon name={n.icon} size={16}/>
                  <span className="nav-label en-only">{n.label}</span>
                  {n.star && <span className="gold" style={{fontSize:8, marginLeft:-4}}>★</span>}
                  <span className="jp">{n.jp}</span>
                  {n.count && <span className="count">{n.count}</span>}
                </div>
                {/* Chat history sub-nav */}
                {n.id==='chat' && active==='chat' && (
                  <div className="chat-subnav">
                    <button
                      className="btn btn-sm btn-secondary"
                      style={{width:'calc(100% - 14px)', margin:'6px 7px 10px', justifyContent:'flex-start'}}
                      onClick={createNewChat}
                    ><Icon name="plus" size={12}/>New Chat</button>

                    {/* Favorites bucket */}
                    <div
                      className={'chat-bucket '+(dragOver?.pos==='fav'?'drop':'')}
                      data-chat-bucket="fav"
                    >
                      <button
                        type="button"
                        className="chat-subgroup chat-subgroup-header"
                        onClick={() => toggleChatGroup('favorite')}
                        aria-expanded={chatGroupsOpen.favorite}
                        aria-label="Toggle Favorite"
                      >
                        <span className="chat-subgroup-toggle" aria-hidden="true">
                          {React.createElement(Icon as any, { name: "chevronDown", size: 12, style: { transform: chatGroupsOpen.favorite ? 'rotate(0deg)' : 'rotate(-90deg)' } })}
                        </span>
                        <span className="en-only">Favorite</span>
                        <span className="jp" style={{marginLeft:6}}>お気に入り</span>
                        <span className="spacer"/>
                        <span style={{fontSize:9, color:'var(--text-dim)'}}>{favChats.length}</span>
                      </button>
                      {chatGroupsOpen.favorite && favChats.length===0 && (
                        <div className="chat-empty">
                          <span className="en-only">Drop a chat here</span>
                          <span className="jp">ここへ</span>
                        </div>
                      )}
                      {chatGroupsOpen.favorite && favChats.map(it => (
                        <div
                          key={it.id}
                          data-chat-row={it.id}
                          onPointerDown={onChatRowPointerDown(it.id)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            openChatMenuAt(it.id, e.clientX, e.clientY);
                          }}
                          className={'chat-sub-item '+(activeChat===it.id?'active':'')+(dragId===it.id?' dragging':'')+(dragOver?.id===it.id?(' dz-'+dragOver.pos):'')}
                          onClick={() => {
                            if (suppressChatRowClickRef.current) {
                              suppressChatRowClickRef.current = false;
                              return;
                            }
                            setActiveChat(it.id);
                          }}
                          title={it.title}
                        >
                          <Icon name="grip" size={10} className="grip"/>
                          <span className="chat-sub-title">{it.title}</span>
                          <button
                            type="button"
                            draggable={false}
                            className="chat-row-menu-btn"
                            onClick={(e)=>{
                              e.stopPropagation();
                              const r = e.currentTarget.getBoundingClientRect();
                              openChatMenuAt(it.id, r.right - 6, r.bottom + 6);
                            }}
                            title="Chat options"
                            aria-label="Chat options"
                          >
                            <span className="chat-row-menu-dots" aria-hidden="true">⋮</span>
                          </button>
                        </div>
                      ))}
                    </div>

                    {/* All chats bucket */}
                    <div
                      className={'chat-bucket '+(dragOver?.pos==='chats'?'drop':'')}
                      data-chat-bucket="chats"
                    >
                      <button
                        type="button"
                        className="chat-subgroup chat-subgroup-header"
                        onClick={() => toggleChatGroup('chats')}
                        aria-expanded={chatGroupsOpen.chats}
                        aria-label="Toggle Chats"
                      >
                        <span className="chat-subgroup-toggle" aria-hidden="true">
                          {React.createElement(Icon as any, { name: "chevronDown", size: 12, style: { transform: chatGroupsOpen.chats ? 'rotate(0deg)' : 'rotate(-90deg)' } })}
                        </span>
                        <span className="en-only">Chats</span>
                        <span className="jp" style={{marginLeft:6}}>対話</span>
                        <span className="spacer"/>
                        <span style={{fontSize:9, color:'var(--text-dim)'}}>{restChats.length}</span>
                      </button>
                      {chatGroupsOpen.chats && restChats.length === 0 && (
                        <div className="chat-empty" style={{padding:'6px 10px 10px'}}>
                          <span className="en-only">New Chat to start</span>
                          <span className="jp">新しい対話</span>
                        </div>
                      )}
                      {chatGroupsOpen.chats && restChats.map(it => (
                        <div
                          key={it.id}
                          data-chat-row={it.id}
                          onPointerDown={onChatRowPointerDown(it.id)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            openChatMenuAt(it.id, e.clientX, e.clientY);
                          }}
                          className={'chat-sub-item '+(activeChat===it.id?'active':'')+(dragId===it.id?' dragging':'')+(dragOver?.id===it.id?(' dz-'+dragOver.pos):'')}
                          onClick={() => {
                            if (suppressChatRowClickRef.current) {
                              suppressChatRowClickRef.current = false;
                              return;
                            }
                            setActiveChat(it.id);
                          }}
                          title={it.title}
                        >
                          <Icon name="grip" size={10} className="grip"/>
                          <span className="chat-sub-title">{it.title}</span>
                          <button
                            type="button"
                            draggable={false}
                            className="chat-row-menu-btn"
                            onClick={(e)=>{
                              e.stopPropagation();
                              const r = e.currentTarget.getBoundingClientRect();
                              openChatMenuAt(it.id, r.right - 6, r.bottom + 6);
                            }}
                            title="Chat options"
                            aria-label="Chat options"
                          >
                            <span className="chat-row-menu-dots" aria-hidden="true">⋮</span>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </React.Fragment>
            ))}
          </div>
        ))}

        {/* System section removed — items live under Workspace */}
        <div className="spacer" style={{flex:1}}/>

        {/* User cluster */}
        <div className="user-cluster">
          <button
            type="button"
            ref={contextBtnRef}
            className="context-enabled-pill"
            aria-live="polite"
            aria-expanded={contextPanelOpen}
            onClick={openContextPanel}
          >
            <span className="en-only">Context enabled</span>
            <span className="jp">コンテキスト有効</span>
            <span className="context-enabled-dot" aria-hidden="true" />
          </button>
          <div className="user-row local-preview-row">
            <span className="s-field-hint local-preview-label" style={{fontSize:10}}><span className="en-only">Local preview</span><span className="jp">ローカルプレビュー</span></span>
          </div>
          <div ref={userBtnRef} className="user-row user-pill" onClick={openUser}>
            <div
              className="avatar"
              style={{
                width: 26,
                height: 26,
                fontSize: 11,
                overflow: 'hidden',
                padding: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {isProfilePhotoDataUrl(profileAvatarImageDataUrl) ? (
                <img
                  src={profileAvatarImageDataUrl}
                  alt=""
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : (
                shellAvatarChar(profileAvatarGlyph, profileDisplayName)
              )}
            </div>
            <div style={{flex:1, minWidth:0}}>
              <div style={{fontSize:12, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                {profileDisplayName.trim() || 'You'}
              </div>
              <div className="t-mono" style={{fontSize:9, color:'var(--text-dim)'}}>LOCAL</div>
            </div>
            <Icon name={userOpen?'chevronDown':'chevronRight'} size={11} className="dim"/>
          </div>
        </div>
      </div>
      <button
        type="button"
        className={'sidebar-toggle-btn' + (sidebarCollapsed ? ' collapsed' : '')}
        onClick={() => setSidebarCollapsed((v) => !v)}
        aria-label={sidebarCollapsed ? 'サイドバーを開く' : 'サイドバーを折りたたむ'}
        title={sidebarCollapsed ? 'サイドバーを開く' : 'サイドバーを折りたたむ'}
      >
        <span className="sidebar-toggle-glyph" aria-hidden="true">
          <span className="pane" />
          <span className="divider" />
        </span>
      </button>
      <button
        type="button"
        className={'sidebar-resizer' + (sidebarResizeHint ? ' show-hint' : '')}
        aria-label="Sidebar width resizer"
        style={{ left: (sidebarCollapsed ? 0 : sidebarWidth) - 3 }}
        onMouseEnter={() => setSidebarResizeHint(true)}
        onMouseLeave={() => {
          if (!resizeStateRef.current.active) setSidebarResizeHint(false);
        }}
        onPointerDown={(e) => {
          e.preventDefault();
          beginSidebarResize(e);
        }}
      >
        <span className="sidebar-resizer-hit" />
        {sidebarResizeHint && (
          <span className="sidebar-resizer-tip">
            クリックして折りたたむ <span className="sidebar-resizer-kbd">⌘B</span>
            <br />
            ドラッグしてサイズ変更
          </span>
        )}
      </button>
    </>
  );
}

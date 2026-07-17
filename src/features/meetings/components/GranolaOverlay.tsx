import { Icon } from '@/shared/icons';
import { t } from '@/shared/lib/i18n';
import { GranolaPillMenu } from './GranolaOverlay/GranolaPillMenu';
import { GranolaTopPanels } from './GranolaOverlay/GranolaTopPanels';
import { MeetingPermissionBanner } from './MeetingPermissionBanner';
import { MeetingContextTimeline, MeetingContextTimelineHeader } from './MeetingContextTimeline';
import { MEETINGS_DOCK_SLASH_CATALOG } from '../lib/runtime';
import { toastM, GRANOLA_CLASSES } from '../lib/runtime';
import { useGranolaOverlay } from '../context/GranolaOverlayContext';

export function GranolaOverlay() {
  const p = useGranolaOverlay();
  const {
    granola, closeGranola,
    granolaPane, setGranolaPane,
    granolaDraft, setGranolaDraft,
    granolaMenuOpen, setGranolaMenuOpen,
    granolaOutline, setGranolaOutline,
    granolaAsk, setGranolaAsk,
    granolaTodos, setGranolaTodos,
    granolaEnhanceMenuOpen, setGranolaEnhanceMenuOpen,
    granolaAttendees,
    granolaAttendeesQuery, setGranolaAttendeesQuery,
    granolaFolder,
    granolaFolderQuery, setGranolaFolderQuery,
    granolaFolderList,
    granolaPillMenu,
    cmdBarMin, setCmdBarMin,
    postRecBarActive, postRecWaveMenuOpen, setPostRecWaveMenuOpen,
    mtgTopShareOpen, setMtgTopShareOpen,
    mtgEnhanceBusy,
    mtgLinkAccess, setMtgLinkAccess,
    mtgShareSearch, setMtgShareSearch,
    mtgShareOwner, mtgLinkBusy,
    mtgLinkAccessMenuOpen, setMtgLinkAccessMenuOpen,
    audioRecSession,
    closeGranolaPillMenu,
    addFolderTag, addCalendarEvent,
    showGranolaDateInfo, showGranolaAuthorInfo,
    granolaDateFull, toggleAttendee, pickFolder, addNewFolder,
    applyStubTranscript, refreshSummary, refreshMinutes,
    runMtgEnhance, ingestNoteToMemory, copyMtgShareLink,
    mtgDraftEmail, mtgCopyAllText, moveGranolaToTrash,
    runLocalAsk, listLocalTodos,
    startNoteRecording, stopNoteRecording,
    showPermissionBanner,
    recordingWithoutRemote,
    permissionActionBusy,
    onOpenScreenCaptureSettings,
    onRequestScreenCaptureAccess,
    onMicOnlyRecording,
    contextTimelineItems, contextTimelineLoading,
    injectRecipeIntoMemo, runPostRecSlashItem,
    runRuntimeAction,
  } = p;

  if (!granola) return null;

  return (
    <div
      className="granola-shell"
      style={{ fontFamily:'var(--font-sans, system-ui, sans-serif)' }}
    >
      <button
        type="button"
        className="granola-back-btn"
        onClick={closeGranola}
        aria-label="Close note"
        style={{
          display:'flex',
          alignItems:'center',
          justifyContent:'center',
          width:40,
          height:40,
          borderRadius:999,
          border:'1px solid var(--border-hi)',
          background:'var(--surface)',
          color:'var(--text-mute)',
          cursor:'pointer',
          top: 20,
        }}
      >
        <Icon name="arrowLeft" size={18}/>
      </button>

      <div
        className="granola-float mtg-top-chrome"
        style={{
          top: 18,
          right: 18,
          zIndex: 8,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexWrap: 'wrap',
          justifyContent: 'flex-end',
          maxWidth: 'calc(100% - 88px)',
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            borderRadius: 999,
            padding: 2,
            gap: 2,
            border: '1px solid color-mix(in srgb, var(--border-hi) 70%, transparent)',
            background: 'color-mix(in srgb, var(--surface-2) 88%, var(--bg))',
          }}
        >
          <button
            type="button"
            aria-label="More"
            title="More"
            onClick={function () {
              setGranolaMenuOpen(function (v: any) { return !v; });
              setMtgTopShareOpen(function () { return false; });
              setMtgLinkAccessMenuOpen(function () { return false; });
              setPostRecWaveMenuOpen(function () { return false; });
            }}
            aria-expanded={granolaMenuOpen}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: 999,
              border: 'none',
              background: granolaMenuOpen
                ? 'color-mix(in srgb, var(--gold) 14%, transparent)'
                : 'transparent',
              color: 'var(--text-mute)',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <Icon name="more" size={15} />
          </button>
          <button
            type="button"
            aria-label="Section outline"
            title="Outline"
            onClick={function () {
              setGranolaOutline(function (v: any) { return !v; });
              setGranolaMenuOpen(function () { return false; });
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: 999,
              border: 'none',
              background: granolaOutline
                ? 'color-mix(in srgb, var(--gold) 18%, transparent)'
                : 'transparent',
              color: 'var(--text-mute)',
              cursor: 'pointer',
            }}
          >
            <Icon name="menu" size={15} />
          </button>
          <div style={{ position: 'relative', display: 'inline-flex' }}>
            <button
              type="button"
              aria-label="Enhanced notes"
              title="Enhanced notes"
              aria-expanded={granolaEnhanceMenuOpen}
              disabled={mtgEnhanceBusy}
              onClick={function () {
                setGranolaEnhanceMenuOpen(function (v: boolean) { return !v; });
                setGranolaMenuOpen(function () { return false; });
                setMtgTopShareOpen(function () { return false; });
                setMtgLinkAccessMenuOpen(function () { return false; });
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 2,
                height: 32,
                padding: '0 6px 0 8px',
                borderRadius: 999,
                border: 'none',
                background: mtgEnhanceBusy || granolaEnhanceMenuOpen
                  ? 'color-mix(in srgb, var(--gold) 14%, transparent)'
                  : 'transparent',
                color: 'var(--text-mute)',
                cursor: mtgEnhanceBusy ? 'wait' : 'pointer',
              }}
            >
              {mtgEnhanceBusy ? (
                <span className="granola-share-spin" />
              ) : (
                <Icon name="sparkles" size={15} />
              )}
              <Icon name="chevronDown" size={10} />
            </button>
            {granolaEnhanceMenuOpen && (
              <>
                <div
                  role="presentation"
                  style={{ position: 'fixed', inset: 0, zIndex: 20 }}
                  onMouseDown={function () { setGranolaEnhanceMenuOpen(false); }}
                />
                <div
                  role="menu"
                  aria-label="Enhanced notes"
                  tabIndex={-1}
                  onMouseDown={function (e) { e.stopPropagation(); }}
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 6px)',
                    right: 0,
                    zIndex: 21,
                    minWidth: 240,
                    padding: 6,
                    borderRadius: 14,
                    border: '1px solid var(--border-hi)',
                    background: 'color-mix(in srgb, var(--surface-2) 96%, var(--bg))',
                    boxShadow: 'var(--shadow-md, 0 10px 30px rgba(0,0,0,0.25))',
                    fontSize: 13,
                    color: 'var(--text)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 8px 8px 10px',
                      borderRadius: 10,
                    }}
                  >
                    <Icon name="sparkles" size={15} />
                    <span style={{ flex: 1 }}>
                      <span className="en-only">Enhanced notes</span>
                      <span className="jp">AI強化メモ</span>
                    </span>
                    <button
                      type="button"
                      title="Re-run enhancement"
                      aria-label="Re-run enhancement"
                      disabled={mtgEnhanceBusy}
                      onClick={function () {
                        setGranolaEnhanceMenuOpen(false);
                        void runMtgEnhance();
                      }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 26,
                        height: 26,
                        borderRadius: 999,
                        border: 'none',
                        background: 'color-mix(in srgb, var(--surface) 60%, transparent)',
                        color: 'var(--text-mute)',
                        cursor: mtgEnhanceBusy ? 'wait' : 'pointer',
                      }}
                    >
                      {mtgEnhanceBusy ? (
                        <span className="granola-share-spin" />
                      ) : (
                        <Icon name="refresh" size={13} />
                      )}
                    </button>
                    <Icon name="check" size={14} />
                  </div>
                  <div style={{ height: 1, margin: '4px 6px', background: 'var(--border)' }} />
                  <div
                    style={{
                      padding: '4px 10px 6px',
                      fontSize: 11,
                      letterSpacing: '0.04em',
                      textTransform: 'uppercase',
                      color: 'var(--text-dim)',
                    }}
                  >
                    <span className="en-only">Templates</span>
                    <span className="jp">テンプレート</span>
                  </div>
                  {[
                    { id: '1to1', en: '1 to 1', jp: '1on1', emoji: '👥' },
                    { id: 'discovery', en: 'Customer: Discovery', jp: '顧客ディスカバリー', emoji: '💵' },
                    { id: 'hiring', en: 'Hiring', jp: '採用', emoji: '💼' },
                    { id: 'standup', en: 'Stand-Up', jp: 'スタンドアップ', emoji: '🧍' },
                    { id: 'weekly', en: 'Weekly Team Meeting', jp: '週次ミーティング', emoji: '📆' },
                  ].map(function (tpl) {
                    return (
                      <button
                        key={tpl.id}
                        type="button"
                        role="menuitem"
                        onClick={function () {
                          setGranolaEnhanceMenuOpen(false);
                          toastM((tpl.en) + t(' — generated from template (mock)', ' テンプレートで生成（モック）'), 'info');
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          width: '100%',
                          padding: '8px 10px',
                          borderRadius: 10,
                          border: 'none',
                          background: 'transparent',
                          color: 'inherit',
                          cursor: 'pointer',
                          textAlign: 'left',
                          fontFamily: 'inherit',
                          fontSize: 13,
                        }}
                        onMouseEnter={function (e) { e.currentTarget.style.background = 'color-mix(in srgb, var(--surface) 70%, transparent)'; }}
                        onMouseLeave={function (e) { e.currentTarget.style.background = 'transparent'; }}
                      >
                        <span style={{ fontSize: 16, lineHeight: 1 }}>{tpl.emoji}</span>
                        <span className="en-only">{tpl.en}</span>
                        <span className="jp">{tpl.jp}</span>
                      </button>
                    );
                  })}
                  <div style={{ height: 1, margin: '4px 6px', background: 'var(--border)' }} />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={function () {
                      setGranolaEnhanceMenuOpen(false);
                      toastM(t('Template list (mock)', 'テンプレート一覧（モック）'), 'info');
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      width: '100%',
                      padding: '8px 10px',
                      borderRadius: 10,
                      border: 'none',
                      background: 'transparent',
                      color: 'inherit',
                      cursor: 'pointer',
                      textAlign: 'left',
                      fontFamily: 'inherit',
                      fontSize: 13,
                    }}
                  >
                    <Icon name="grid" size={14} />
                    <span className="en-only">All templates…</span>
                    <span className="jp">すべてのテンプレート…</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={function () {
                      setGranolaEnhanceMenuOpen(false);
                      toastM(t('Create a new template (mock)', '新規テンプレートの作成（モック）'), 'info');
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      width: '100%',
                      padding: '8px 10px',
                      borderRadius: 10,
                      border: 'none',
                      background: 'transparent',
                      color: 'inherit',
                      cursor: 'pointer',
                      textAlign: 'left',
                      fontFamily: 'inherit',
                      fontSize: 13,
                    }}
                  >
                    <Icon name="plus" size={14} />
                    <span className="en-only">New template</span>
                    <span className="jp">新規テンプレート</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        <div
          style={{
            display: 'inline-flex',
            borderRadius: 999,
            overflow: 'hidden',
            border: '1px solid color-mix(in srgb, #e4e2dc 45%, var(--border))',
          }}
        >
          <button
            type="button"
            onClick={function () {
              setMtgTopShareOpen(function (v: any) { return !v; });
              setGranolaMenuOpen(function () { return false; });
              setMtgLinkAccessMenuOpen(function () { return false; });
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 14px',
              border: 'none',
              background: '#f3f1ec',
              color: '#1a1a1a',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            <Icon name="lock" size={15} />
            <span className="en-only">Share</span>
            <span className="jp" style={{ fontSize: 12 }}>共有</span>
          </button>
          <span
            style={{
              width: 1,
              alignSelf: 'stretch',
              background: 'color-mix(in srgb, #000 12%, transparent)',
            }}
            aria-hidden="true"
          />
          <button
            type="button"
            aria-label="Copy link"
            title="Copy link"
            disabled={mtgLinkBusy}
            onClick={function () { void copyMtgShareLink(); }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 44,
              padding: '8px 0',
              border: 'none',
              background: '#f3f1ec',
              color: '#1a1a1a',
              cursor: mtgLinkBusy ? 'default' : 'pointer',
            }}
          >
            {mtgLinkBusy ? (
              <span className="granola-share-spin" />
            ) : (
              <Icon name="link" size={15} />
            )}
          </button>
        </div>
      </div>

      {showPermissionBanner && onOpenScreenCaptureSettings && onRequestScreenCaptureAccess && onMicOnlyRecording && (
        <div
          style={{
            position: 'absolute',
            top: 72,
            left: 0,
            right: 0,
            pointerEvents: 'auto',
          }}
        >
          <MeetingPermissionBanner
            recordingWithoutRemote={recordingWithoutRemote}
            busy={permissionActionBusy}
            onOpenSettings={onOpenScreenCaptureSettings}
            onRequestAccess={onRequestScreenCaptureAccess}
            onMicOnly={onMicOnlyRecording}
          />
        </div>
      )}

      <GranolaTopPanels
        granola={granola}
        mtgTopShareOpen={mtgTopShareOpen}
        mtgShareSearch={mtgShareSearch}
        setMtgShareSearch={setMtgShareSearch}
        mtgShareOwner={mtgShareOwner}
        mtgLinkAccess={mtgLinkAccess}
        setMtgLinkAccess={setMtgLinkAccess}
        mtgLinkBusy={mtgLinkBusy}
        mtgLinkAccessMenuOpen={mtgLinkAccessMenuOpen}
        setMtgLinkAccessMenuOpen={setMtgLinkAccessMenuOpen}
        copyMtgShareLink={copyMtgShareLink}
        granolaMenuOpen={granolaMenuOpen}
        setGranolaMenuOpen={setGranolaMenuOpen}
        mtgDraftEmail={mtgDraftEmail}
        mtgCopyAllText={mtgCopyAllText}
        runRuntimeAction={runRuntimeAction}
        applyStubTranscript={applyStubTranscript}
        refreshSummary={refreshSummary}
        refreshMinutes={refreshMinutes}
        ingestNoteToMemory={ingestNoteToMemory}
        moveGranolaToTrash={moveGranolaToTrash}
      />

      {granolaOutline && (
        <div className="granola-float" style={{top:100, right:16, display:'flex', flexDirection:'column', gap:6, padding:10, borderRadius:12, background:'var(--surface)', border:'1px solid var(--border-hi)', maxWidth:140}}>
          {['memo','transcript','context','summary','minutes'].map(function (pid) {
            const labels: Record<string,string> = { memo:'メモ', transcript:'文字起こし', context:'文脈', summary:'要約', minutes:'議事録' };
            return (
              <button key={pid} type="button" onClick={function () { setGranolaPane(pid); }} style={{fontSize:11, padding:'6px 8px', borderRadius:8, border:'1px solid var(--border-hi)', background:granolaPane===pid?'color-mix(in srgb, var(--gold) 16%, transparent)':'transparent', color:'var(--text)', cursor:'pointer', fontFamily:'inherit'}}>
                {labels[pid]}
              </button>
            );
          })}
        </div>
      )}

      {granolaTodos !== null && (
        <div className="granola-float" style={{bottom:cmdBarMin?96:(postRecBarActive?128:158), left:'50%', transform:'translateX(-50%)', width:'min(420px, calc(100% - 40px))', maxHeight:200, overflow:'auto', padding:14, borderRadius:14, background:'var(--surface)', border:'1px solid var(--border-hi)'}}>
          <div style={{fontSize:11, color:'var(--text-mute)', marginBottom:8}}>ToDo (ローカル抽出)</div>
          {granolaTodos.length === 0 ? (
            <div style={{fontSize:13, color:'var(--text-mute)'}}>見つかりませんでした（[ ]や TODO:行を追加してください）</div>
          ) : (
            <ul style={{margin:0, paddingLeft:18, fontSize:13}}>
              {granolaTodos.map(function (t: any, i: any) { return <li key={i} style={{marginBottom:4}}>{t}</li>; })}
            </ul>
          )}
          <button type="button" onClick={function () { setGranolaTodos(null); }} style={{marginTop:10, fontSize:12, border:'1px solid var(--border-hi)', borderRadius:8, padding:'4px 10px', background:'transparent', color:'var(--text-mute)', cursor:'pointer'}}>Close</button>
        </div>
      )}

      <div style={{flex:1, overflow:'auto', padding:'56px 32px ' + (cmdBarMin ? '100px' : (postRecBarActive ? '160px' : '140px')), maxWidth:720, width:'100%', margin:'0 auto', boxSizing:'border-box'}}>
        <h1 style={{
          margin:0,
          fontSize:32,
          fontWeight:500,
          letterSpacing:'-0.03em',
          lineHeight:1.15,
          fontFamily:'var(--font-serif, Georgia, "Times New Roman", serif)',
          color:'var(--text)',
        }}>
          <span className="en-only">{granola.title}</span>
          {granola.titleJp && <span className="jp">{granola.titleJp}</span>}
        </h1>

        <div style={{display:'flex', flexWrap:'wrap', gap:8, marginTop:18}}>
          <button type="button" onClick={function (ev) { showGranolaDateInfo(ev); }} className={GRANOLA_CLASSES.pillBtn} aria-expanded={granolaPillMenu && granolaPillMenu.kind === 'date' ? true : false}>
            <Icon name="calendar" size={13}/>
            <span className="en-only">{granola.dateLabel}</span>
            <span className="jp" style={{fontSize:12}}>{granola.dateLabelJp}</span>
            {granola.time && <span style={{opacity:0.7, marginLeft:4}} className="t-mono">{granola.time}</span>}
          </button>
          <button type="button" onClick={function (ev) { showGranolaAuthorInfo(ev); }} className={GRANOLA_CLASSES.pillBtn} aria-expanded={granolaPillMenu && granolaPillMenu.kind === 'attendees' ? true : false}>
            <Icon name="users" size={13}/>
            <span className="en-only">{granolaAttendees.length === 1 ? 'Me' : granolaAttendees.length + ' people'}</span>
            <span className="jp" style={{fontSize:12}}>{granolaAttendees.length === 1 ? '自分のみ' : granolaAttendees.length + '名'}</span>
          </button>
          <button type="button" onClick={function (ev) { addFolderTag(ev); }} className={GRANOLA_CLASSES.pillBtn} aria-expanded={granolaPillMenu && granolaPillMenu.kind === 'folder' ? true : false}>
            <Icon name="folder" size={13}/>
            <span className="en-only">{granolaFolder}</span>
            <span className="jp" style={{fontSize:12}}>フォルダ</span>
          </button>
          {granola.tag && (
            <span className={GRANOLA_CLASSES.pillGold}>
              {granola.tag}
            </span>
          )}
        </div>

        {/* Pill popovers — date / attendees / folder */}
        <GranolaPillMenu
          granolaPillMenu={granolaPillMenu}
          closeGranolaPillMenu={closeGranolaPillMenu}
          granolaDateFull={granolaDateFull}
          addCalendarEvent={addCalendarEvent}
          granolaAttendeesQuery={granolaAttendeesQuery}
          setGranolaAttendeesQuery={setGranolaAttendeesQuery}
          granolaAttendees={granolaAttendees}
          toggleAttendee={toggleAttendee}
          granolaFolderQuery={granolaFolderQuery}
          setGranolaFolderQuery={setGranolaFolderQuery}
          granolaFolderList={granolaFolderList}
          granolaFolder={granolaFolder}
          pickFolder={pickFolder}
          addNewFolder={addNewFolder}
        />


        <div
          role="group"
          aria-label="Calendar event"
          style={{
            marginTop:14,
            display:'flex',
            alignItems:'center',
            gap:14,
            padding:'14px 16px',
            borderRadius:14,
            border:'1px solid var(--border-hi)',
            background:'color-mix(in srgb, var(--surface) 92%, var(--bg))',
          }}
        >
          <div
            aria-hidden="true"
            style={{
              display:'flex',
              alignItems:'center',
              justifyContent:'center',
              width:34,
              height:34,
              borderRadius:10,
              color:'var(--text-mute)',
              background:'color-mix(in srgb, var(--surface-2) 70%, transparent)',
              flexShrink:0,
            }}
          >
            <Icon name="calendar" size={16}/>
          </div>
          <div style={{display:'flex', flexDirection:'column', gap:2, minWidth:0, flex:1}}>
            <div style={{fontSize:14, fontWeight:500, color:'var(--text)'}}>
              <span className="en-only">No calendar event</span>
              <span className="jp">カレンダーイベントなし</span>
            </div>
            <div className="t-mono" style={{fontSize:12, color:'var(--text-mute)'}}>
              {granola.dateLabel || 'Today'}
              {granola.time && <span style={{marginLeft:6}}>· {granola.time}</span>}
            </div>
          </div>
          <button
            type="button"
            onClick={addCalendarEvent}
            title="Link a calendar event"
            aria-label="Link a calendar event"
            style={{
              display:'inline-flex',
              alignItems:'center',
              justifyContent:'center',
              width:32,
              height:32,
              borderRadius:999,
              border:'1px solid var(--border-hi)',
              background:'transparent',
              color:'var(--text-mute)',
              cursor:'pointer',
              flexShrink:0,
            }}
          >
            <Icon name="plus" size={15}/>
          </button>
        </div>

        <div style={{display:'flex', flexWrap:'wrap', gap:8, marginTop:20, alignItems:'center'}}>
          {[
            { id:'memo', en:'Notes', jp:'メモ' },
            { id:'transcript', en:'Transcript', jp:'文字起こし' },
            { id:'context', en:'Context', jp:'文脈' },
            { id:'summary', en:'Summary', jp:'要約' },
            { id:'minutes', en:'Minutes', jp:'議事録' },
          ].map(function (t: any) {
            const on = granolaPane === t.id;
            return (
              <button key={t.id} type="button" onClick={function () { setGranolaPane(t.id); }} style={{padding:'8px 14px', borderRadius:999, border:'1px solid ' + (on ? 'var(--gold)' : 'var(--border-hi)'), background:on ? 'color-mix(in srgb, var(--gold) 14%, transparent)' : 'transparent', color:on ? 'var(--gold)' : 'var(--text-mute)', cursor:'pointer', fontSize:12, fontFamily:'inherit'}}>
                <span className="en-only">{t.en}</span>
                <span className="jp" style={{fontSize:11}}>{t.jp}</span>
              </button>
            );
          })}
        </div>

        {granolaPane === 'transcript' && (
          <div style={{display:'flex', flexWrap:'wrap', gap:8, marginTop:12, alignItems:'center'}}>
            <button type="button" onClick={applyStubTranscript} className={GRANOLA_CLASSES.miniBtn}>+ テンプ</button>
          </div>
        )}
        {granolaPane === 'summary' && (
          <div style={{marginTop:12}}>
            <button type="button" onClick={refreshSummary} className={GRANOLA_CLASSES.miniBtnGold}>要約を更新（ルール）</button>
          </div>
        )}
        {granolaPane === 'minutes' && (
          <div style={{marginTop:12}}>
            <button type="button" onClick={refreshMinutes} className={GRANOLA_CLASSES.miniBtnGold}>議事録を生成</button>
          </div>
        )}

        {granolaPane === 'memo' && (
          <textarea
            value={granolaDraft.body}
            onChange={function (e) { setGranolaDraft(function (d: any) { return { ...d, body: e.target.value }; }); }}
            placeholder="Write your notes here… メモをここに入力…"
            className="granola-body granola-pane granola-textarea"
          />
        )}
        {granolaPane === 'transcript' && (
          <textarea
            value={granolaDraft.transcript}
            onChange={function (e) { setGranolaDraft(function (d: any) { return { ...d, transcript: e.target.value }; }); }}
            placeholder="Transcript (paste or type locally)… 貼り付けまたは入力…"
            className="granola-body granola-pane granola-textarea"
          />
        )}
        {granolaPane === 'summary' && (
          <textarea
            value={granolaDraft.summary}
            onChange={function (e) { setGranolaDraft(function (d: any) { return { ...d, summary: e.target.value }; }); }}
            placeholder="Rule-based summary appears here…"
            className="granola-body granola-pane granola-textarea"
          />
        )}
        {granolaPane === 'context' && (
          <div style={{ marginTop: 16 }}>
            <MeetingContextTimelineHeader />
            <MeetingContextTimeline
              items={contextTimelineItems || []}
              loading={!!contextTimelineLoading}
            />
          </div>
        )}
        {granolaPane === 'minutes' && (
          <textarea
            value={granolaDraft.minutes}
            onChange={function (e) { setGranolaDraft(function (d: any) { return { ...d, minutes: e.target.value }; }); }}
            placeholder="Markdown minutes…"
            className="granola-body granola-pane granola-textarea"
          />
        )}
      </div>

      {!cmdBarMin && postRecBarActive && (
        <div
          className="granola-float"
          style={{
            left:'50%',
            bottom:20,
            transform:'translateX(-50%)',
            width:'min(760px, calc(100% - 28px))',
            zIndex:3,
          }}
        >
          <div style={{position:'relative', width:'100%', display:'flex', alignItems:'flex-end', justifyContent:'flex-start', gap:12, flexWrap:'wrap'}}>
          {postRecWaveMenuOpen && (
            <div
              style={{
                position:'absolute',
                bottom:'100%',
                left:0,
                marginBottom:10,
                width:'min(320px, calc(100vw - 48px))',
                padding:10,
                borderRadius:14,
                background:'var(--surface)',
                border:'1px solid var(--border-hi)',
                boxShadow:'var(--shadow-lg)',
                maxHeight:280,
                overflow:'auto',
                zIndex:4,
              }}
            >
              {MEETINGS_DOCK_SLASH_CATALOG.map(function (row) {
                var acc = row.accent || 'mint';
                return (
                  <button
                    key={row.id}
                    type="button"
                    onClick={function () { runPostRecSlashItem(row); }}
                    style={{
                      display:'flex',
                      alignItems:'flex-start',
                      gap:10,
                      width:'100%',
                      textAlign:'left',
                      padding:'8px 6px',
                      marginBottom:4,
                      border:'none',
                      borderRadius:8,
                      background:'transparent',
                      color:'var(--text)',
                      cursor:'pointer',
                      fontFamily:'inherit',
                      fontSize:13,
                    }}
                  >
                    <span className={'mtg-recipe-icon mtg-recipe-icon--' + acc}>/</span>
                    <div style={{minWidth:0}}>
                      <div style={{fontWeight:500}}>{row.label}</div>
                      {row.jpHint && <div className="jp" style={{fontSize:11, color:'var(--text-mute)'}}>{row.jpHint}</div>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          <div style={{display:'flex', alignItems:'flex-end', gap:10, flex:1, minWidth:'min(100%, 420px)'}}>
            <button
              type="button"
              onClick={function () { setPostRecWaveMenuOpen(function (v: any) { return !v; }); setGranolaMenuOpen(function () { return false; }); }}
              aria-expanded={postRecWaveMenuOpen}
              aria-label="Commands"
              style={{
                display:'flex',
                alignItems:'center',
                justifyContent:'center',
                gap:3,
                width:50,
                height:50,
                flexShrink:0,
                borderRadius:999,
                border:'1px solid color-mix(in srgb, var(--border-hi) 75%, transparent)',
                background:'color-mix(in srgb, #141416 88%, var(--surface))',
                color:'#f0f0f0',
                cursor:'pointer',
                boxShadow:'0 6px 28px rgba(0,0,0,0.45)',
              }}
            >
              <Icon name="audioBars" size={19}/>
              <Icon name="chevronUp" size={13}/>
            </button>

            <div
              style={{
                position:'relative',
                flex:1,
                minWidth:0,
                borderRadius:999,
                border:'1px solid color-mix(in srgb, var(--border-hi) 55%, transparent)',
                background:'color-mix(in srgb, #141416 92%, var(--surface))',
                boxShadow:'0 6px 32px rgba(0,0,0,0.42)',
                padding:'11px 14px 15px 16px',
              }}
            >
              <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:10, minWidth:0}}>
                <button
                  type="button"
                  onClick={function () { injectRecipeIntoMemo('Coach me: Matt 1:1'); }}
                  title="Coach template"
                  style={{
                    border:'none',
                    background:'transparent',
                    color:'#fafafa',
                    fontSize:14,
                    fontFamily:'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
                    cursor:'pointer',
                    textAlign:'left',
                    flex:1,
                    minWidth:0,
                    overflow:'hidden',
                    textOverflow:'ellipsis',
                    whiteSpace:'nowrap',
                    padding:0,
                  }}
                >
                  /coach-me-Matt
                </button>
                <button
                  type="button"
                  onClick={function () { injectRecipeIntoMemo('Draft follow-ups'); }}
                  style={{
                    display:'inline-flex',
                    alignItems:'center',
                    gap:7,
                    padding:'6px 11px 6px 7px',
                    borderRadius:999,
                    border:'1px solid color-mix(in srgb, var(--border-hi) 45%, transparent)',
                    background:'color-mix(in srgb, #1a1a1f 94%, transparent)',
                    color:'#fafafa',
                    fontSize:12,
                    fontWeight:500,
                    cursor:'pointer',
                    flexShrink:0,
                    fontFamily:'inherit',
                    whiteSpace:'nowrap',
                  }}
                >
                  <span
                    style={{
                      display:'inline-flex',
                      alignItems:'center',
                      justifyContent:'center',
                      width:22,
                      height:22,
                      borderRadius:6,
                      background:'linear-gradient(135deg, #7ec8ff 0%, #a78bfa 100%)',
                      color:'#fff',
                      lineHeight:0,
                    }}
                  >
                    <Icon name="slash" size={12}/>
                  </span>
                  <span className="en-only">Write follow up email</span>
                  <span className="jp" style={{fontSize:11}}>フォローアップ</span>
                </button>
              </div>
              <button
                type="button"
                aria-label="Minimize bar"
                onClick={function () { setCmdBarMin(true); setGranolaMenuOpen(function () { return false; }); setPostRecWaveMenuOpen(function () { return false; }); }}
                style={{
                  position:'absolute',
                  left:'50%',
                  bottom:5,
                  transform:'translateX(-50%)',
                  width:32,
                  height:5,
                  borderRadius:5,
                  border:'none',
                  padding:0,
                  background:'color-mix(in srgb, var(--text-mute) 42%, transparent)',
                  opacity:0.65,
                  cursor:'pointer',
                }}
              />
            </div>
          </div>
          </div>
        </div>
      )}

      {!cmdBarMin && !postRecBarActive && (
      <div className="granola-float"
        style={{
          left:'50%',
          bottom:28,
          transform:'translateX(-50%)',
          width:'min(640px, calc(100% - 48px))',
          display:'flex',
          alignItems:'stretch',
          gap:6,
          padding:6,
          borderRadius:999,
          background:'var(--surface)',
          border:'1px solid var(--border-hi)',
          boxShadow:'var(--shadow-lg)',
        }}
      >
        <div style={{display:'flex', alignItems:'center', gap:4, padding:'0 6px 0 10px'}}>
          <button type="button" className={GRANOLA_CLASSES.iconBtn} onClick={function () { setGranolaMenuOpen(function (v: any) { return !v; }); }} aria-expanded={granolaMenuOpen}><Icon name="more" size={16}/></button>
          <button
            type="button"
            onClick={function () { if (audioRecSession) stopNoteRecording(); else startNoteRecording(); }}
            aria-label={audioRecSession ? 'Stop recording' : 'Start recording'}
            title={audioRecSession ? '録音を終了' : '録音を開始'}
            style={{
              display:'flex',
              alignItems:'center',
              justifyContent:'center',
              width:40,
              height:34,
              borderRadius:10,
              flexShrink:0,
              border:'1px solid ' + (audioRecSession
                ? 'color-mix(in srgb, var(--gold) 50%, var(--border-hi))'
                : 'color-mix(in srgb, var(--gold) 38%, var(--border-hi))'),
              background: audioRecSession
                ? 'color-mix(in srgb, var(--gold) 26%, var(--surface))'
                : 'color-mix(in srgb, var(--gold) 14%, var(--surface))',
              color:'var(--gold)',
              cursor:'pointer',
              boxShadow: audioRecSession ? '0 0 0 1px color-mix(in srgb, var(--gold) 20%, transparent)' : 'none',
              animation: audioRecSession ? ('shogun-rec-pulse 1.35s ease-in-out infinite' as any) : undefined,
            }}
          >
            <Icon name={audioRecSession ? 'stop' : 'play'} size={audioRecSession ? 15 : 16}/>
          </button>
          <button type="button" className={GRANOLA_CLASSES.iconBtn} onClick={function () { setCmdBarMin(true); setGranolaMenuOpen(function () { return false; }); }} aria-label="Minimize bar"><Icon name="chevronUp" size={16}/></button>
          <button type="button" className={GRANOLA_CLASSES.iconBtn} onClick={function () { setGranolaOutline(function (v: any) { return !v; }); }} aria-label="Section outline" title="セクション一覧"><Icon name="grid" size={15}/></button>
        </div>
        <input
          type="text"
          placeholder="Search in this note (local)"
          className="granola-ask"
          value={granolaAsk}
          onChange={function (e) { setGranolaAsk(e.target.value); }}
          style={{
            flex:1,
            minWidth:0,
            border:'none',
            borderRadius:999,
            padding:'10px 16px',
            fontSize:14,
            background:'var(--surface-2)',
            color:'var(--text)',
            outline:'none',
          }}
          onKeyDown={function (e) { if (e.key === 'Enter') { e.preventDefault(); runLocalAsk(); } }}
        />
        <button
          type="button"
          onClick={listLocalTodos}
          style={{
            display:'inline-flex',
            alignItems:'center',
            gap:8,
            padding:'8px 14px',
            borderRadius:999,
            border:'1px solid var(--border-hi)',
            background:'color-mix(in srgb, var(--surface-2) 85%, transparent)',
            color:'var(--text)',
            fontSize:13,
            fontWeight:500,
            cursor:'pointer',
            whiteSpace:'nowrap',
            fontFamily:'inherit',
          }}
        >
          <span style={{color:'var(--gold)', display:'inline-flex', lineHeight:0}}><Icon name="note" size={15}/></span>
          <span className="en-only">List recent todos</span>
          <span className="jp" style={{fontSize:12}}>直近のToDo</span>
        </button>
      </div>
      )}
      {cmdBarMin && postRecBarActive && !audioRecSession && (
        <div className="granola-float" style={{left:'50%', bottom:28, transform:'translateX(-50%)', display:'flex', alignItems:'center', gap:10}}>
          <button
            type="button"
            onClick={function () { setCmdBarMin(false); setPostRecWaveMenuOpen(function () { return false; }); }}
            style={{
              display:'flex',
              alignItems:'center',
              justifyContent:'center',
              gap:3,
              width:46,
              height:46,
              flexShrink:0,
              borderRadius:999,
              border:'1px solid color-mix(in srgb, var(--border-hi) 70%, transparent)',
              background:'color-mix(in srgb, #141416 88%, var(--surface))',
              color:'#f0f0f0',
              cursor:'pointer',
              boxShadow:'0 4px 20px rgba(0,0,0,0.35)',
            }}
          >
            <Icon name="audioBars" size={18}/>
            <Icon name="chevronDown" size={12}/>
          </button>
          <button
            type="button"
            onClick={function () { setCmdBarMin(false); }}
            style={{
              display:'flex',
              alignItems:'center',
              gap:8,
              padding:'10px 18px',
              borderRadius:999,
              border:'1px solid var(--border-hi)',
              background:'color-mix(in srgb, #141416 75%, var(--surface))',
              color:'var(--text-mute)',
              cursor:'pointer',
              fontFamily:'inherit',
              fontSize:13,
            }}
          >
            <Icon name="chevronDown" size={16}/>
            <span className="en-only">Meeting tab</span>
            <span className="jp" style={{fontSize:12}}>ミーティングタブ</span>
          </button>
        </div>
      )}
      {cmdBarMin && (!postRecBarActive || audioRecSession) && (
        <div className="granola-float" style={{left:'50%', bottom:28, transform:'translateX(-50%)', display:'flex', alignItems:'center', gap:8}}>
          {audioRecSession && (
            <button
              type="button"
              onClick={function (e) { e.preventDefault(); stopNoteRecording(); }}
              aria-label="Stop recording"
              title="録音を終了"
              style={{
                display:'flex',
                alignItems:'center',
                justifyContent:'center',
                width:44,
                height:44,
                borderRadius:999,
                border:'1px solid color-mix(in srgb, var(--gold) 45%, var(--border-hi))',
                background:'color-mix(in srgb, var(--gold) 22%, var(--surface))',
                color:'var(--gold)',
                cursor:'pointer',
                flexShrink:0,
              }}
            >
              <Icon name="stop" size={16}/>
            </button>
          )}
          <button type="button" onClick={function () { setCmdBarMin(false); }} style={{display:'flex', alignItems:'center', gap:8, padding:'10px 18px', borderRadius:999, border:'1px solid var(--border-hi)', background:'var(--surface)', color:'var(--text-mute)', cursor:'pointer', fontFamily:'inherit'}}>
            <Icon name="chevronDown" size={16}/> Command bar
          </button>
        </div>
      )}

      <style>{`
        .granola-pane::placeholder { color: var(--text-mute); opacity: 1; }
        .granola-ask::placeholder { color: var(--text-mute); }
        @keyframes granola-share-spin { to { transform: rotate(360deg); } }
        .granola-share-spin {
          width: 14px;
          height: 14px;
          border: 2px solid #c0c0c0;
          border-top-color: var(--gold);
          border-radius: 50%;
          animation: granola-share-spin 0.7s linear infinite;
          flex-shrink: 0;
          display: inline-block;
          vertical-align: middle;
          box-sizing: border-box;
        }
      `}</style>
    </div>
  );
}

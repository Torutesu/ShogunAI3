import * as ReactDOM from 'react-dom';
import { Icon } from '@/shared/icons';

export interface GranolaPillMenuProps {
  granolaPillMenu: any;
  closeGranolaPillMenu: () => void;
  granolaDateFull: { en: string; jp: string; t: string };
  addCalendarEvent: () => void;
  granolaAttendeesQuery: string;
  setGranolaAttendeesQuery: (v: string) => void;
  granolaAttendees: string[];
  toggleAttendee: (name: string) => void;
  granolaFolderQuery: string;
  setGranolaFolderQuery: (v: string) => void;
  granolaFolderList: string[];
  granolaFolder: string;
  pickFolder: (name: string) => void;
  addNewFolder: () => void;
}

export function GranolaPillMenu(p: GranolaPillMenuProps) {
  const {
    granolaPillMenu,
    closeGranolaPillMenu,
    granolaDateFull,
    addCalendarEvent,
    granolaAttendeesQuery, setGranolaAttendeesQuery,
    granolaAttendees,
    toggleAttendee,
    granolaFolderQuery, setGranolaFolderQuery,
    granolaFolderList,
    granolaFolder,
    pickFolder,
    addNewFolder,
  } = p;

  if (!granolaPillMenu) return null;

  return ReactDOM.createPortal(
    <>
      <div role="presentation" style={{position:'fixed', inset:0, zIndex:1300}} onMouseDown={closeGranolaPillMenu}/>
      <div
        role="menu"
        onMouseDown={function (e) { e.stopPropagation(); }}
        style={{
          position:'fixed',
          left: granolaPillMenu.anchor.left,
          top: granolaPillMenu.anchor.top,
          zIndex:1301,
          minWidth: Math.max(280, granolaPillMenu.anchor.width + 40),
          maxWidth: 380,
          padding:6,
          borderRadius:14,
          border:'1px solid var(--border-hi)',
          background:'color-mix(in srgb, var(--surface-2) 96%, var(--bg))',
          boxShadow:'0 26px 54px -16px rgba(0,0,0,0.65), 0 4px 12px rgba(0,0,0,0.36)',
        }}
      >
        {granolaPillMenu.kind === 'date' && (
          <div style={{display:'flex', alignItems:'center', gap:12, padding:'10px 10px 10px 12px', borderRadius:10}}>
            <Icon name="calendar" size={16} className="dim"/>
            <div style={{flex:1, minWidth:0}}>
              <div style={{fontSize:13, color:'var(--text)'}}>
                <span className="en-only">No calendar event</span>
                <span className="jp">カレンダーイベントなし</span>
              </div>
              <div className="t-mono" style={{fontSize:11, color:'var(--text-dim)', marginTop:2, letterSpacing:'0.04em'}}>
                {granolaDateFull.jp} · {granolaDateFull.t}
              </div>
            </div>
            <button
              type="button"
              onClick={function () { addCalendarEvent(); closeGranolaPillMenu(); }}
              aria-label="Link to a calendar event"
              style={{all:'unset', cursor:'pointer', width:28, height:28, borderRadius:999, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', display:'inline-flex', alignItems:'center', justifyContent:'center', flexShrink:0}}
            >
              <Icon name="plus" size={13}/>
            </button>
          </div>
        )}

        {granolaPillMenu.kind === 'attendees' && (
          <div style={{padding:4}}>
            <div style={{padding:'4px 6px 8px'}}>
              <input
                type="text"
                autoFocus
                value={granolaAttendeesQuery}
                onChange={function (e) { setGranolaAttendeesQuery(e.target.value); }}
                placeholder="Add attendees…"
                style={{
                  width:'100%', boxSizing:'border-box',
                  padding:'8px 10px',
                  background:'transparent',
                  border:'none',
                  borderBottom:'1px solid var(--border)',
                  color:'var(--text)', fontSize:13, fontFamily:'inherit',
                  outline:'none',
                }}
              />
            </div>
            <div style={{padding:'6px 10px 2px', fontSize:11, color:'var(--text-dim)'}}>Work-ai</div>
            {[
              { name: 'Toru Tano', note: '(me)' },
              { name: 'Matt Reynolds', note: '' },
              { name: 'Kenshin Takeda', note: '' },
            ].filter(function (person) {
              var q = (granolaAttendeesQuery || '').toLowerCase();
              return !q || person.name.toLowerCase().indexOf(q) >= 0;
            }).map(function (person) {
              var selected = granolaAttendees.indexOf(person.name) >= 0;
              return (
                <button
                  key={person.name}
                  type="button"
                  onClick={function () { toggleAttendee(person.name); }}
                  style={{
                    all:'unset', cursor:'pointer',
                    display:'flex', alignItems:'center', gap:10,
                    width:'100%', boxSizing:'border-box',
                    padding:'8px 10px', borderRadius:10,
                    color:'var(--text)', fontSize:13,
                  }}
                  onMouseEnter={function (e) { e.currentTarget.style.background = 'color-mix(in srgb, var(--surface) 70%, var(--bg))'; }}
                  onMouseLeave={function (e) { e.currentTarget.style.background = 'transparent'; }}
                >
                  <span style={{
                    width:22, height:22, borderRadius:999,
                    background:'var(--surface)', border:'1px solid var(--border)',
                    display:'inline-flex', alignItems:'center', justifyContent:'center',
                    fontSize:11, color:'var(--text-mute)', fontFamily:'var(--font-mono, ui-monospace, monospace)',
                    flexShrink:0,
                  }}>{person.name.charAt(0)}</span>
                  <span style={{flex:1}}>{person.name}{person.note ? <span style={{color:'var(--text-dim)', marginLeft:6, fontSize:12}}>{person.note}</span> : null}</span>
                  {selected && <Icon name="check" size={13} className="gold"/>}
                </button>
              );
            })}
          </div>
        )}

        {granolaPillMenu.kind === 'folder' && (
          <div style={{padding:4}}>
            <div style={{padding:'4px 6px 8px', display:'flex', alignItems:'center', gap:8}}>
              <input
                type="text"
                autoFocus
                value={granolaFolderQuery}
                onChange={function (e) { setGranolaFolderQuery(e.target.value); }}
                placeholder="Search"
                style={{
                  flex:1,
                  padding:'8px 10px',
                  background:'transparent',
                  border:'none',
                  borderBottom:'1px solid var(--border)',
                  color:'var(--text)', fontSize:13, fontFamily:'inherit',
                  outline:'none',
                }}
              />
              <Icon name="search" size={13} className="dim"/>
            </div>
            {granolaFolderList.filter(function (name) {
              var q = (granolaFolderQuery || '').toLowerCase();
              return !q || name.toLowerCase().indexOf(q) >= 0;
            }).map(function (name) {
              var selected = name === granolaFolder;
              var avatar = name === 'My notes'
                ? <Icon name="lock" size={13} className="dim"/>
                : <span style={{
                    width:24, height:24, borderRadius:6,
                    background:'var(--surface)', border:'1px solid var(--border)',
                    display:'inline-flex', alignItems:'center', justifyContent:'center',
                    fontSize:11, color:'var(--text-mute)', fontFamily:'var(--font-mono, ui-monospace, monospace)',
                  }}>{name.charAt(0).toUpperCase()}</span>;
              return (
                <button
                  key={name}
                  type="button"
                  onClick={function () { pickFolder(name); }}
                  style={{
                    all:'unset', cursor:'pointer',
                    display:'flex', alignItems:'center', gap:10,
                    width:'100%', boxSizing:'border-box',
                    padding:'8px 10px', borderRadius:10,
                    color:'var(--text)', fontSize:13,
                  }}
                  onMouseEnter={function (e) { e.currentTarget.style.background = 'color-mix(in srgb, var(--surface) 70%, var(--bg))'; }}
                  onMouseLeave={function (e) { e.currentTarget.style.background = 'transparent'; }}
                >
                  {avatar}
                  <span style={{flex:1}}>{name}</span>
                  {selected && <Icon name="check" size={13} className="gold"/>}
                </button>
              );
            })}
            <div style={{height:1, margin:'4px 6px', background:'var(--border)'}}/>
            <button
              type="button"
              onClick={addNewFolder}
              style={{
                all:'unset', cursor:'pointer',
                display:'flex', alignItems:'center', gap:10,
                width:'100%', boxSizing:'border-box',
                padding:'8px 10px', borderRadius:10,
                color:'var(--gold)', fontSize:13,
              }}
              onMouseEnter={function (e) { e.currentTarget.style.background = 'color-mix(in srgb, var(--gold) 10%, transparent)'; }}
              onMouseLeave={function (e) { e.currentTarget.style.background = 'transparent'; }}
            >
              <Icon name="folder" size={13} className="gold"/>
              <span>New folder</span>
              <span style={{flex:1}}/>
              <Icon name="plus" size={13}/>
            </button>
          </div>
        )}
      </div>
    </>,
    document.body,
  );
}

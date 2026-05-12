import { Icon } from '@/shared/icons';
import { renderHighlighted, openMemoryEntryInChat } from '../lib/runtime';

export interface MemoryKakejikuViewProps {
  selectedDate: Date;
  events: any[];
  timelineLoading: boolean;
  fmtFullDate: (d: Date) => string;
  fmtFullDateJp: (d: Date) => string;
  srcIcon: (s: any) => string;
  srcLabel: (s: any) => string;
  allowServerMemoryAssembly: boolean;
}

export function MemoryKakejikuView({
  selectedDate,
  events,
  timelineLoading,
  fmtFullDate,
  fmtFullDateJp,
  srcIcon,
  srcLabel,
  allowServerMemoryAssembly,
}: MemoryKakejikuViewProps) {
  const dayStart = new Date(selectedDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = dayStart.getTime() + 24 * 60 * 60 * 1000;
  const dayEvents = events.filter((e) => Number.isFinite(e.ts) && e.ts >= dayStart.getTime() && e.ts < dayEnd);

  return (
    <div style={{flex:1, padding:'24px 40px 40px', minHeight:0, overflowY:'auto'}}>
      <div style={{maxWidth:820, margin:'0 auto'}}>
        {timelineLoading ? (
          <div className="muted" style={{padding:'40px 0', textAlign:'center', fontSize:13}}>
            <span className="en-only">Loading timeline…</span>
            <span className="jp" style={{display:'block', marginTop:6}}>読み込み中…</span>
          </div>
        ) : dayEvents.length === 0 ? (
          <div style={{padding:'60px 0', textAlign:'center', color:'var(--text-dim)', fontSize:13, display:'flex', flexDirection:'column', alignItems:'center', gap:10}}>
            <Icon name="memory" size={28}/>
            <span className="en-only">No memories for {fmtFullDate(selectedDate)}.</span>
            <span className="jp" style={{fontSize:12}}>{fmtFullDateJp(selectedDate)} のメモリはまだありません。</span>
          </div>
        ) : dayEvents.map((e, i) => {
          const solid = e.src === 'agent' || e.src === 'meet';
          return (
            <button
              key={e.memoryId || `${e.ts}-${i}`}
              type="button"
              disabled={!e.memoryId}
              onClick={() => {
                if (!e.memoryId) return;
                openMemoryEntryInChat(
                  { title: e.title, snippet: e.snippet },
                  { memoryAssemblyQuery: e.title, memoryAssemblyLimit: 14, allowServerMemoryAssembly },
                );
              }}
              className="memory-scrub-stage"
              style={{
                all: 'unset',
                display:'grid',
                gridTemplateColumns:'76px 1px 1fr',
                columnGap:24,
                padding:'22px 0',
                borderBottom:'1px solid var(--border)',
                width:'100%',
                boxSizing:'border-box',
                cursor: e.memoryId ? 'pointer' : 'default',
                fontFamily:'inherit',
              }}
            >
              <div style={{textAlign:'right', paddingTop:4}}>
                <span className="t-mono" style={{fontSize:12, color:'var(--text)', letterSpacing:'0.06em'}}>{e.t}</span>
              </div>
              <div style={{background:'var(--border)', alignSelf:'stretch', position:'relative'}}>
                <span style={{
                  position:'absolute', left:-4, top:8, width:9, height:9, borderRadius:'50%',
                  background: solid ? 'var(--gold)' : 'transparent',
                  border: solid ? 'none' : '1.5px solid var(--text-mute)',
                  boxShadow:'0 0 0 3px var(--bg)',
                }}/>
              </div>
              <div style={{minWidth:0, display:'flex', flexDirection:'column', gap:6}}>
                <div style={{display:'flex', alignItems:'center', gap:8}}>
                  <Icon name={srcIcon(e.src)} size={13} className="dim"/>
                  <span className="t-mono" style={{fontSize:11, color:'var(--text-dim)', letterSpacing:'0.14em'}}>{srcLabel(e.src)}</span>
                </div>
                <div style={{fontSize:15, fontWeight:500, color:'var(--text)', lineHeight:1.45, wordBreak:'break-word'}}>
                  {renderHighlighted(e.titleHighlight || e.title)}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

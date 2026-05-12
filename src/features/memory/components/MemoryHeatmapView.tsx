export interface MemoryHeatmapViewProps {
  weekDays: Date[];
  events: any[];
  selectedDayOffset: number;
  setSelectedDayOffset: (v: number) => void;
  timelineLoading: boolean;
}

export function MemoryHeatmapView({
  weekDays,
  events,
  selectedDayOffset,
  setSelectedDayOffset,
  timelineLoading,
}: MemoryHeatmapViewProps) {
  const grid = weekDays.map((d) => {
    const start = new Date(d);
    start.setHours(0, 0, 0, 0);
    const startMs = start.getTime();
    const endMs = startMs + 24 * 60 * 60 * 1000;
    const hours = new Array(24).fill(0);
    events.forEach((e) => {
      if (!Number.isFinite(e.ts) || e.ts < startMs || e.ts >= endMs) return;
      const hh = Math.max(0, Math.min(23, Math.floor(Number(e.h))));
      hours[hh] += 1;
    });
    return hours;
  });
  const max = Math.max(1, ...grid.flat());
  const fmtWk = (d: Date) => d.toLocaleString('en-US', { weekday: 'short' }).toUpperCase();

  return (
    <div style={{flex:1, padding:'24px 40px 40px', minHeight:0, overflowY:'auto'}}>
      <div style={{maxWidth:900, margin:'0 auto'}}>
        <div style={{display:'flex', flexDirection:'column', gap:6}}>
          <div style={{display:'grid', gridTemplateColumns:'44px repeat(24, minmax(0, 1fr))', columnGap:3, alignItems:'end', paddingBottom:4}}>
            <span/>
            {[...Array(24)].map((_, h) => (
              <span key={h} className="t-mono" style={{fontSize:9, color:'var(--text-dim)', textAlign:'center'}}>{String(h).padStart(2,'0')}</span>
            ))}
          </div>
          {grid.map((row, i) => {
            const offset = 6 - i;
            const isActiveDay = offset === selectedDayOffset;
            return (
              <div key={i} style={{display:'grid', gridTemplateColumns:'44px repeat(24, minmax(0, 1fr))', columnGap:3, alignItems:'stretch'}}>
                <button
                  type="button"
                  onClick={() => setSelectedDayOffset(offset)}
                  className="t-mono"
                  style={{
                    all:'unset',
                    fontSize:10,
                    color: isActiveDay ? 'var(--gold)' : 'var(--text-dim)',
                    letterSpacing:'0.14em',
                    cursor:'pointer',
                    paddingRight:8,
                    textAlign:'right',
                    alignSelf:'center',
                  }}
                  title={weekDays[i]?.toDateString()}
                >
                  {weekDays[i] ? fmtWk(weekDays[i]!) : ''}
                </button>
                {row.map((v, h) => {
                  const intensity = v / max;
                  const bg = v === 0
                    ? 'var(--border)'
                    : `color-mix(in srgb, var(--gold) ${Math.round(15 + intensity * 75)}%, var(--surface))`;
                  return (
                    <span
                      key={h}
                      title={`${weekDays[i] ? fmtWk(weekDays[i]!) : ''} ${String(h).padStart(2,'0')}:00 · ${v} ${v === 1 ? 'memory' : 'memories'}`}
                      style={{
                        height:24,
                        borderRadius:4,
                        background: bg,
                        outline: isActiveDay ? '1px solid color-mix(in srgb, var(--gold) 35%, transparent)' : 'none',
                        opacity: v === 0 ? 0.35 : 1,
                      }}
                    />
                  );
                })}
              </div>
            );
          })}
          <div style={{marginTop:18, display:'flex', alignItems:'center', gap:10, justifyContent:'flex-end'}}>
            <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)', letterSpacing:'0.12em'}}>LESS</span>
            {[0, 0.25, 0.5, 0.75, 1].map((p, idx) => (
              <span key={idx} style={{
                width:18, height:10, borderRadius:3,
                background: p === 0 ? 'var(--border)' : `color-mix(in srgb, var(--gold) ${Math.round(15 + p * 75)}%, var(--surface))`,
              }}/>
            ))}
            <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)', letterSpacing:'0.12em'}}>MORE</span>
          </div>
          {events.length === 0 && !timelineLoading && (
            <div style={{marginTop:20, color:'var(--text-dim)', fontSize:13, textAlign:'center'}}>
              <span className="en-only">No memories indexed yet — ingest or sync to populate the grid.</span>
              <span className="jp" style={{display:'block', fontSize:12, marginTop:4}}>まだインデックス化されたメモリがありません。</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useCallback } from 'react';
import { runRuntimeActionA } from '@/shared/ipc/runtime-actions';

function startOfDayMs(d: Date): number {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

function startOfWeekMs(d: Date): number {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const offset = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - offset);
  return x.getTime();
}

export interface MemoryDigestViewState {
  week: any;
  day: any;
  loading: boolean;
  error: string | null;
  generatingWeek: boolean;
  generatingDay: boolean;
}

export interface MemoryDigestViewProps {
  state: MemoryDigestViewState;
  setState: (s: any) => void;
}

export function MemoryDigestView({ state, setState }: MemoryDigestViewProps) {
  const now = new Date();
  const weekStartMs = useMemo(() => startOfWeekMs(now), [now.getDate()]); // eslint-disable-line react-hooks/exhaustive-deps
  const dayStartMs = useMemo(() => startOfDayMs(now), [now.getDate()]); // eslint-disable-line react-hooks/exhaustive-deps
  const lang = 'en';

  const loadRollups = useCallback(async (regenerate: boolean) => {
    setState((prev: any) => ({
      ...prev,
      loading: !regenerate,
      generatingWeek: !!regenerate,
      generatingDay: !!regenerate,
      error: null,
    }));
    const [weekRes, dayRes] = await Promise.all([
      runRuntimeActionA(
        'memory.rollup.get',
        { weekStartMs, lang, regenerate: !!regenerate },
        { silentError: true },
      ),
      runRuntimeActionA(
        'memory.rollup.day.get',
        { dayStartMs, lang, regenerate: !!regenerate },
        { silentError: true },
      ),
    ]);
    const weekRollup = weekRes && weekRes.ok && weekRes.data ? weekRes.data.rollup : null;
    const dayRollup = dayRes && dayRes.ok && dayRes.data ? dayRes.data.rollup : null;
    const errMsg = (!weekRes || !weekRes.ok) && (!dayRes || !dayRes.ok)
      ? ((weekRes && weekRes.error && weekRes.error.message)
         || (dayRes && dayRes.error && dayRes.error.message)
         || 'Rollup failed')
      : null;
    setState({
      week: weekRollup,
      day: dayRollup,
      loading: false,
      generatingWeek: false,
      generatingDay: false,
      error: errMsg,
    });
  }, [setState, weekStartMs, dayStartMs]);

  useEffect(() => {
    if (state.week == null && state.day == null && !state.loading) {
      void loadRollups(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fmtRange = (startMs: number, endMs: number) => {
    try {
      const s = new Date(startMs);
      const e = new Date(endMs);
      const opts: any = { month: 'short', day: 'numeric' };
      if (s.getFullYear() !== e.getFullYear()) {
        opts.year = 'numeric';
      }
      return `${s.toLocaleDateString('en-US', opts)} – ${e.toLocaleDateString('en-US', opts)}`;
    } catch (_e) {
      return '';
    }
  };

  const renderCard = (rollup: any, label: string, onRegen: () => Promise<void>, generating: boolean) => {
    const priority = rollup && typeof rollup === 'object'
      ? String(rollup.userPriority || rollup.priority || '').toLowerCase()
      : '';
    const priColor = priority === 'high'
      ? 'var(--danger)'
      : priority === 'medium'
        ? 'var(--gold)'
        : 'var(--text-dim)';
    return (
      <div className="card" style={{padding:22, display:'flex', flexDirection:'column', gap:14}}>
        <div className="row" style={{gap:10, alignItems:'center'}}>
          <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)', letterSpacing:'0.14em'}}>{label.toUpperCase()}</span>
          {rollup && priority && (
            <span className="label" style={{fontSize:10, borderColor:priColor, color:priColor, textTransform:'uppercase'}}>
              {priority}
            </span>
          )}
          <span style={{flex:1}}/>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={generating}
            onClick={() => void onRegen()}
            style={generating ? {opacity:0.55, cursor:'default'} : undefined}
          >
            {generating ? 'Regenerating…' : 'Regenerate'}
          </button>
        </div>
        {!rollup ? (
          <div style={{color:'var(--text-dim)', fontSize:13, lineHeight:1.5}}>
            No summary yet. Run Regenerate to build one from your indexed memory.
          </div>
        ) : (
          <>
            <div style={{fontSize:18, fontWeight:500, lineHeight:1.35}}>
              {rollup.title || 'Untitled digest'}
            </div>
            {Array.isArray(rollup.keyPoints) && rollup.keyPoints.length > 0 && (
              <ul style={{margin:0, paddingLeft:20, fontSize:13, lineHeight:1.6, color:'var(--text)'}}>
                {rollup.keyPoints.map((p: any, i: number) => (
                  <li key={i} style={{marginBottom:4}}>{p}</li>
                ))}
              </ul>
            )}
            {rollup.reason && (
              <div style={{fontSize:11, color:'var(--text-dim)', lineHeight:1.5}}>
                <span className="t-mono" style={{fontSize:9, letterSpacing:'0.1em'}}>WHY</span>{' '}{rollup.reason}
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <div style={{flex:1, padding:'24px 40px 40px', minHeight:0, overflowY:'auto'}}>
      <div style={{maxWidth:820, margin:'0 auto', display:'flex', flexDirection:'column', gap:18}}>
        {state.loading ? (
          <div style={{padding:32, color:'var(--text-dim)', fontSize:13, textAlign:'center'}}>Loading digest…</div>
        ) : state.error ? (
          <div className="card" style={{padding:18, color:'var(--danger)', fontSize:13}}>
            {state.error}
          </div>
        ) : null}

        <div className="t-mono" style={{fontSize:10, color:'var(--text-dim)', letterSpacing:'0.14em'}}>
          WEEK · {fmtRange(weekStartMs, weekStartMs + 6 * 86_400_000)}
        </div>
        {renderCard(
          state.week,
          'Weekly digest',
          async () => {
            setState((prev: any) => ({ ...prev, generatingWeek: true }));
            const res = await runRuntimeActionA(
              'memory.rollup.get',
              { weekStartMs, lang, regenerate: true },
              { silentError: true },
            );
            setState((prev: any) => ({
              ...prev,
              week: res && res.ok && res.data ? res.data.rollup : prev.week,
              generatingWeek: false,
              error: res && res.ok ? null : ((res && res.error && res.error.message) || 'Regenerate failed'),
            }));
          },
          state.generatingWeek,
        )}

        <div className="t-mono" style={{fontSize:10, color:'var(--text-dim)', letterSpacing:'0.14em', marginTop:8}}>
          DAY · {(() => { try { return new Date(dayStartMs).toLocaleDateString('en-US', { weekday:'long', month:'short', day:'numeric' }); } catch (_) { return ''; } })()}
        </div>
        {renderCard(
          state.day,
          'Daily digest',
          async () => {
            setState((prev: any) => ({ ...prev, generatingDay: true }));
            const res = await runRuntimeActionA(
              'memory.rollup.day.get',
              { dayStartMs, lang, regenerate: true },
              { silentError: true },
            );
            setState((prev: any) => ({
              ...prev,
              day: res && res.ok && res.data ? res.data.rollup : prev.day,
              generatingDay: false,
              error: res && res.ok ? null : ((res && res.error && res.error.message) || 'Regenerate failed'),
            }));
          },
          state.generatingDay,
        )}
      </div>
    </div>
  );
}

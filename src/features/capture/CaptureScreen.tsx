// Phase 2 Step 7.2: CaptureScreen split from _legacy/screens-c.tsx.
import React from 'react';
import { Icon } from '@/shared/icons';
import { runRuntimeAction } from './lib/runtime';

export function CaptureScreen() {
  const [isPaused, setIsPaused] = React.useState(false);
  const [axRich, setAxRich] = React.useState(false);
  const [sampleIv, setSampleIv] = React.useState(8);
  const [axMinIv, setAxMinIv] = React.useState(0);
  const [captureStats, setCaptureStats] = React.useState({ events:'1,248', memories:'23', appCoverage:[] as any[] });
  const refreshCaptureSettings = React.useCallback(() => {
    return runRuntimeAction('settings.load', {}, { silentError:true } as any).then((res) => {
      const cap = res.ok && res.data?.settings?.sections?.capture;
      if (!cap || typeof cap !== 'object') return res;
      setAxRich(!!cap.axRichCapture);
      const s = Number(cap.sampleIntervalSecs);
      setSampleIv(Number.isFinite(s) ? Math.min(600, Math.max(4, s)) : 8);
      const a = Number(cap.axMinIntervalSecs);
      setAxMinIv(Number.isFinite(a) ? Math.min(600, Math.max(0, a)) : 0);
      return res;
    });
  }, []);
  React.useEffect(() => {
    let mounted = true;
    runRuntimeAction('stats.get', { stage:'capture' } as any, { silentError:true } as any).then((res) => {
      if (!mounted || !res.ok || !res.data) return;
      const data = res.data;
      setCaptureStats({
        events: data.eventsToday || '1,248',
        memories: data.memoriesToday || '23',
        appCoverage: data.appCoverage || [],
      });
      const cap = data.settings?.sections?.capture;
      if (cap && typeof cap === 'object') {
        setAxRich(!!cap.axRichCapture);
        const s = Number(cap.sampleIntervalSecs);
        if (Number.isFinite(s)) setSampleIv(Math.min(600, Math.max(4, s)));
        const a = Number(cap.axMinIntervalSecs);
        if (Number.isFinite(a)) setAxMinIv(Math.min(600, Math.max(0, a)));
      }
    });
    refreshCaptureSettings();
    return () => { mounted = false; };
  }, [refreshCaptureSettings]);
  return (
    <div className="content-inner">
      <div className="page-head">
        <div>
          <div className="t-mono" style={{marginBottom:8}}>INGEST LAYER</div>
          <h1>Capture <span className="jp">捕捉</span></h1>
          <div className="sub">macOS: 再開中は設定した間隔でフォーカス情報を Memory に取り込みます（スクリーンショットなし）。既定は最前面アプリ名のみ。アクセシビリティ許可と「AX リッチ取得」でフォーカス要素の短いスナップショットを試みます。AX 最小間隔で取り込みレートを抑えられます。</div>
        </div>
        <div className="row">
          <span className="label" style={{background:'var(--surface-2)', borderColor:'var(--border)', color:'var(--text-mute)'}}><span style={{width:6, height:6, borderRadius:'50%', background:'var(--text-dim)', marginRight:6}}/>PREVIEW · v1</span>
          <button
            type="button"
            className={'btn btn-sm ' + (axRich ? 'btn-secondary' : 'btn-ghost')}
            onClick={async () => {
              const next = !axRich;
              const res = await runRuntimeAction(
                'settings.save',
                { section:'capture', axRichCapture: next } as any,
                { silentError:true, successMessage: next ? 'AX rich capture enabled' : 'Switched to app-name only sampling' } as any,
              );
              if (res.ok) setAxRich(next);
            }}
          ><Icon name="capture" size={14}/>{axRich ? 'AX rich ON' : 'AX rich OFF'}</button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={async () => {
              const next = !isPaused;
              const action = next ? 'capture.pause' : 'capture.resume';
              const res = await runRuntimeAction(action, { source:'capture_screen' } as any, { silentError:true } as any);
              if (res.ok) setIsPaused(next);
            }}
          ><Icon name="pause" size={14}/>{isPaused ? 'Resume' : 'Pause'}</button>
        </div>
      </div>

      {/* Live stream */}
      <div className="shogun-grid-split-wide">
        <div className="card" style={{padding:0, overflow:'hidden'}}>
          <div style={{padding:'16px 20px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center'}}>
            <div style={{fontSize:13, fontWeight:500}}>Live capture</div>
            <span className="label label-gold" style={{marginLeft:10}}>TAIL -F</span>
            <span className="spacer"/>
            <span className="t-mono" style={{fontSize:10}}>24 EVENTS / MIN</span>
          </div>
          <div style={{padding:'4px 0', fontFamily:'var(--font-mono)', fontSize:12, maxHeight:280, overflowY:'auto'}}>
            {[
              ['14:32:08', 'chrome', 'url: notion.so/100x-user-framework'],
              ['14:31:54', 'claude', 'msg_in · 142 tokens'],
              ['14:31:41', 'claude', 'msg_out · 518 tokens'],
              ['14:30:22', 'slack', 'dm from Matt · 3 lines'],
              ['14:28:10', 'vscode', 'file: shogun/app.tsx · 42 edits'],
              ['14:25:00', 'chrome', 'url: revenuecat.com/pricing'],
              ['14:22:17', 'claude', 'new conversation: rev-cat pricing'],
              ['14:18:00', 'terminal', 'cmd: git commit -m "ia v2"'],
            ].map((l,i)=>(
              <div key={i} className="row" style={{padding:'6px 20px', gap:14, borderBottom:'1px dashed var(--border)'}}>
                <span style={{color:'var(--text-dim)'}}>{l[0]}</span>
                <span className="gold" style={{minWidth:70}}>{l[1]}</span>
                <span style={{color:'var(--text-mute)'}}>{l[2]}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Stats */}
        <div className="stack-4">
          <div className="card" style={{padding:20}}>
            <div className="t-mono" style={{marginBottom:12}}>TODAY · CAPTURED</div>
            <div className="shogun-grid-2">
              <div><div style={{fontSize:32, fontWeight:600}}>{captureStats.events}</div><div style={{fontSize:11, color:'var(--text-dim)'}}>events</div></div>
              <div><div style={{fontSize:32, fontWeight:600}}>{captureStats.memories}</div><div style={{fontSize:11, color:'var(--text-dim)'}}>memories</div></div>
            </div>
            <div style={{height:1, background:'var(--border)', margin:'16px 0'}}/>
            <div style={{fontSize:12, color:'var(--text-mute)', lineHeight:1.6}}>
              Captured via Accessibility API · <span className="gold">0 screenshots taken</span> · <span className="gold">0 OCR runs</span>
            </div>
          </div>

          <div className="card" style={{padding:20}}>
            <div className="t-mono" style={{marginBottom:12}}>APP COVERAGE</div>
            {(captureStats.appCoverage.length ? captureStats.appCoverage : [
              ['Claude', 542, 94],
              ['Chrome', 318, 72],
              ['Slack', 142, 68],
              ['VSCode', 98, 40],
              ['Gmail', 76, 52],
            ]).map(([n,c,w],i)=>(
              <div key={i} style={{marginBottom:10}}>
                <div className="row" style={{marginBottom:4}}>
                  <span style={{fontSize:12}}>{n}</span>
                  <span className="spacer"/>
                  <span className="t-mono" style={{fontSize:10}}>{c}</span>
                </div>
                <div style={{height:3, background:'var(--surface-2)', borderRadius:2, overflow:'hidden'}}>
                  <div style={{height:'100%', width:w+'%', background:'var(--gold)'}}/>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card" style={{padding:20, marginBottom:20, borderColor:'var(--border-hi)'}}>
        <div className="t-mono" style={{marginBottom:10}}>SAMPLER · INTERVALS</div>
        <div style={{fontSize:12, color:'var(--text-mute)', marginBottom:14, lineHeight:1.5}}>
          サンプル間隔（秒・4–600）はバックグラウンドのウェイク間隔です。AX 最小間隔（0–600、0 で無効）は、内容が変わった AX 取り込みの最短間隔です（同一内容はハッシュで抑止）。
        </div>
        <div className="row" style={{flexWrap:'wrap', gap:14, alignItems:'center'}}>
          <label style={{fontSize:12, display:'flex', alignItems:'center', gap:8}}>
            Sample every
            <input className="s-input" type="number" min={4} max={600} style={{width:72}} value={sampleIv} onChange={(e)=>setSampleIv(Number(e.target.value))}/>
 sec
          </label>
          <label style={{fontSize:12, display:'flex', alignItems:'center', gap:8}}>
            AX min gap
            <input className="s-input" type="number" min={0} max={600} style={{width:72}} value={axMinIv} onChange={(e)=>setAxMinIv(Number(e.target.value))}/>
            sec
          </label>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={async () => {
              const s = Math.min(600, Math.max(4, Math.round(sampleIv) || 8));
              const a = Math.min(600, Math.max(0, Math.round(axMinIv) || 0));
              const res = await runRuntimeAction(
                'settings.save',
                { section:'capture', sampleIntervalSecs: s, axMinIntervalSecs: a } as any,
                { silentError:true, successMessage:'Capture sampler settings saved' } as any,
              );
              if (res.ok) {
                setSampleIv(s);
                setAxMinIv(a);
              }
            }}
          >Apply</button>
        </div>
      </div>

      {/* Permissions card */}
      <div className="card" style={{padding:20, background:'var(--surface-2)', borderColor:'var(--border-hi)'}}>
        <div className="row" style={{marginBottom:12, flexWrap:'wrap', gap:8}}>
          <Icon name="shield" size={16} className="gold"/>
          <div style={{fontSize:14, fontWeight:500}}>What SHOGUN can see</div>
          <span className="spacer"/>
          <button type="button" className="btn btn-sm btn-ghost" onClick={()=>runRuntimeAction('permissions.manage', { target:'accessibility', source:'capture.permissions' } as any, { successMessage:'Opened Accessibility privacy settings' } as any)}>Accessibility <Icon name="arrowUpRight" size={12}/></button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={()=>runRuntimeAction('permissions.manage', { target:'screen_capture', source:'capture.permissions' } as any, { successMessage:'Opened Screen Recording privacy settings' } as any)}>Screen Recording <Icon name="arrowUpRight" size={12}/></button>
        </div>
        <div className="shogun-grid-4">
          {[
            ['Accessibility','Granted','on'],
            ['Calendar','Granted','on'],
            ['Contacts','Not granted','off'],
            ['Screen recording','Not requested','off'],
          ].map(([n,s,o],i)=>(
            <div key={i} style={{padding:12, border:'1px solid var(--border)', borderRadius:'var(--radius-md)', background:'var(--bg)'}}>
              <div className="row" style={{marginBottom:6}}>
                <span style={{fontSize:12}}>{n}</span>
                <span className="spacer"/>
                <div className={'switch '+(o==='on'?'on':'')} style={{transform:'scale(0.8)', transformOrigin:'right'}}/>
              </div>
              <div className="t-mono" style={{fontSize:9, color: o==='on'?'var(--success)':'var(--text-dim)'}}>{(s as string).toUpperCase()}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).ScreenCapture = CaptureScreen;
}

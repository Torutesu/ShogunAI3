// Phase 2 Step 7.4: SettingsScreen split from _legacy/screens-c.tsx.
// Note: this is the sidebar Settings screen, NOT settings-modal (Step 10).
import React from 'react';
import { Icon } from '@/shared/icons';
import { runRuntimeAction } from './lib/runtime';

export function SettingsScreen() {
  const [storage, setStorage] = React.useState({ memories:'12,408', disk:'3.4 GB', days:'68 days', usagePercent:22 });
  React.useEffect(() => {
    let mounted = true;
    runRuntimeAction('stats.get', { section:'storage' } as any, { silentError:true } as any).then((res) => {
      if (!mounted || !res.ok || !res.data) return;
      const data = res.data;
      setStorage({
        memories: data.memories || '12,408',
        disk: data.disk || '3.4 GB',
        days: data.historyDays || '68 days',
        usagePercent: Number.isFinite(data.usagePercent) ? data.usagePercent : 22,
      });
    });
    return () => { mounted = false; };
  }, []);
  return (
    <div className="content-inner">
      <div className="page-head">
        <div>
          <div className="t-mono" style={{marginBottom:8}}>SYSTEM LAYER</div>
          <h1>Settings <span className="jp">設定</span></h1>
          <div className="sub">Your keys. Your machine. Your data.</div>
        </div>
      </div>

      <div className="shogun-settings-2col">
        <div className="stack-2">
          {['Profile','BYOK · Keys','Storage','Privacy','Dream cycle','Billing','Danger zone'].map((s,i)=>(
            <div key={i} className="nav-item" style={{background: i===1?'var(--surface-2)':'transparent', borderColor: i===1?'var(--border)':'transparent', color: i===1?'var(--text)':'var(--text-mute)'}}>
              <span>{s}</span>
            </div>
          ))}
        </div>

        <div className="stack-6 shogun-settings-body">
          {/* BYOK */}
          <div className="card" style={{padding:24}}>
            <div className="row" style={{marginBottom:6}}>
              <Icon name="key" size={16} className="gold"/>
              <div style={{fontSize:16, fontWeight:500}}>Bring your own key</div>
            </div>
            <div style={{fontSize:13, color:'var(--text-mute)', lineHeight:1.6, marginBottom:20}}>
              SHOGUN does not proxy your LLM calls. Your keys, your billing, your rate limits. We never see prompts or responses.
            </div>
            <div className="stack-4">
              {[
                ['Anthropic', 'sk-ant-•••••••••••••••••••••••w72A', true],
                ['OpenAI', 'sk-proj-•••••••••••••••••••••jR8k', true],
                ['Google AI', 'not configured', false],
              ].map(([p,k,ok],i)=>(
                <div key={i} className="row" style={{padding:'12px 16px', background:'var(--surface-2)', border:'1px solid var(--border)', borderRadius:'var(--radius-md)', gap:12}}>
                  <div style={{width:28, height:28, background:'var(--bg)', border:'1px solid var(--border)', borderRadius:'var(--radius-sm)', display:'flex', alignItems:'center', justifyContent:'center'}}>
                    <Icon name="key" size={12} className={ok?'gold':'dim'}/>
                  </div>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13, fontWeight:500}}>{p}</div>
                    <div style={{fontSize:11, color: ok?'var(--text-dim)':'var(--text-dim)', fontFamily:ok?'var(--font-mono)':'inherit', marginTop:2}}>{k}</div>
                  </div>
                  {ok ? <span className="label label-success">ACTIVE</span> : <button className="btn btn-sm btn-secondary" onClick={()=>runRuntimeAction('settings.save', { section:'keys', provider:p } as any, { successMessage:'Key setup flow opened' } as any)}>Add</button>}
                </div>
              ))}
            </div>
          </div>

          {/* Privacy */}
          <div className="card" style={{padding:24}}>
            <div className="row" style={{marginBottom:20}}>
              <Icon name="shield" size={16} className="gold"/>
              <div style={{fontSize:16, fontWeight:500}}>Privacy posture</div>
              <span className="spacer"/>
              <span className="label label-success">AUDITED</span>
            </div>
            {[
              ['Local storage', 'Memory index: SQLite + FTS5 on this Mac (memory.db)', true],
              ['No SHOGUN Memory sync', 'Memory index stays on this Mac; not uploaded to SHOGUN cloud in this build', true],
              ['No screenshots', 'SHOGUN reads via Accessibility API only', true],
              ['No telemetry', 'Anonymous usage metrics: opt-in', false],
            ].map(([l,d,on],i)=>(
              <div key={i} className="row" style={{padding:'14px 0', borderBottom:i<3?'1px solid var(--border)':'none', gap:14}}>
                <div style={{flex:1}}>
                  <div style={{fontSize:13, fontWeight:500}}>{l}</div>
                  <div style={{fontSize:12, color:'var(--text-dim)', marginTop:2}}>{d}</div>
                </div>
                <div className={'switch '+(on?'on':'')}/>
              </div>
            ))}
          </div>

          {/* Storage */}
          <div className="card" style={{padding:24}}>
            <div className="row" style={{marginBottom:16}}>
              <Icon name="database" size={16} className="gold"/>
              <div style={{fontSize:16, fontWeight:500}}>Storage</div>
              <span className="spacer"/>
              <span className="t-mono">~/Library/SHOGUN</span>
            </div>
            <div className="shogun-grid-3" style={{marginBottom:16}}>
              <div><div style={{fontSize:24, fontWeight:600}}>{storage.memories}</div><div style={{fontSize:11, color:'var(--text-dim)'}}>memories</div></div>
              <div><div style={{fontSize:24, fontWeight:600}}>{storage.disk}</div><div style={{fontSize:11, color:'var(--text-dim)'}}>on disk</div></div>
              <div><div style={{fontSize:24, fontWeight:600}}>{storage.days}</div><div style={{fontSize:11, color:'var(--text-dim)'}}>history</div></div>
            </div>
            <div style={{height:6, background:'var(--surface-2)', borderRadius:3, overflow:'hidden', marginBottom:8}}>
              <div style={{width:storage.usagePercent+'%', height:'100%', background:'var(--gold)'}}/>
            </div>
            <div style={{fontSize:11, color:'var(--text-dim)'}}>{storage.disk} of 15 GB allocated</div>
          </div>
        </div>
      </div>
    </div>
  );
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).ScreenSettings = SettingsScreen;
}

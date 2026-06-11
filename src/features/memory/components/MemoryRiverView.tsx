import type * as React from 'react';
import { Icon } from '@/shared/icons';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';
import {
  memoryProviderKey,
  MEMORY_PROVIDER_META,
  memoryProvenanceLabel,
  renderHighlighted,
  openMemoryEntryInChat,
} from '../lib/runtime';

export interface MemoryRiverViewProps {
  timelineLoading: boolean;
  events: any[];
  rawEvents: any[];
  scrubIdx: number;
  setScrubIdx: (fn: (i: number) => number) => void;
  scrubbed: any;
  scrubSummary: any;
  scrubSummaryLoading: boolean;
  setScrubSummary: (v: any) => void;
  setScrubSummaryLoading: (v: boolean) => void;
  showRaw: boolean;
  setShowRaw: (v: boolean) => void;
  setSummaryByMemId: (fn: (prev: Record<string, any>) => Record<string, any>) => void;
  batchSummarizing: number;
  timelineScrollRef: React.RefObject<any>;
  scrollTimeline: (dir: number) => void;
  hourIndexFromEvents: { counts: number[]; firstIdx: (number | undefined)[]; maxC: number; topPriority: any[] };
  timeSpanLabel: string;
  srcIcon: (s: any) => string;
  srcLabel: (s: any) => string;
  workProjects: any[];
  workspaceAssignments: Record<string, string>;
  assignMenuOpen: boolean;
  setAssignMenuOpen: (fn: (v: boolean) => boolean) => void;
  newWorkspaceDraft: string;
  setNewWorkspaceDraft: (v: string) => void;
  assignMemoryToWorkspace: (memoryId: string, workspaceId: string | null) => Promise<void>;
  allowServerMemoryAssembly: boolean;
}

export function MemoryRiverView({
  timelineLoading,
  events,
  rawEvents,
  scrubIdx,
  setScrubIdx,
  scrubbed,
  scrubSummary,
  scrubSummaryLoading,
  setScrubSummary,
  setScrubSummaryLoading,
  showRaw,
  setShowRaw,
  setSummaryByMemId,
  batchSummarizing,
  timelineScrollRef,
  scrollTimeline,
  hourIndexFromEvents,
  timeSpanLabel,
  srcIcon,
  srcLabel,
  workProjects,
  workspaceAssignments,
  assignMenuOpen,
  setAssignMenuOpen,
  newWorkspaceDraft,
  setNewWorkspaceDraft,
  assignMemoryToWorkspace,
  allowServerMemoryAssembly,
}: MemoryRiverViewProps) {
  return (
    <>
    <div className="memory-scrub-stage" style={{padding:'24px 40px 24px', display:'grid', gridTemplateColumns:'minmax(0, 1fr) minmax(0, 1fr)', gap:20, minHeight:420}}>
      {/* Left: the scrubbed memory */}
      <div style={{
        padding:'24px 26px',
        borderRadius:18,
        border:'1px solid var(--border)',
        background:'color-mix(in srgb, var(--surface) 94%, var(--bg))',
        display:'flex', flexDirection:'column',
      }}>
        <div style={{display:'flex', alignItems:'center', gap:10, marginBottom:14}}>
          <div style={{width:32, height:32, borderRadius:8, background:'color-mix(in srgb, var(--gold) 14%, var(--surface-2))', display:'flex', alignItems:'center', justifyContent:'center', color:'var(--gold)'}}>
            <Icon name={srcIcon(scrubbed.src)} size={15}/>
          </div>
          <div className="t-mono" style={{fontSize:10, color:'var(--text-dim)', letterSpacing:'0.14em'}}>
            {srcLabel(scrubbed.src).toUpperCase()} · {scrubbed.t}
          </div>
          {(() => {
            const pk = memoryProviderKey(scrubbed.sourceRaw);
            const meta = MEMORY_PROVIDER_META[pk];
            if (!meta) return null;
            return (
              <span style={{
                display:'inline-flex', alignItems:'center', gap:5,
                padding:'2px 7px', borderRadius:4,
                border:`1px solid color-mix(in srgb, ${meta.color} 50%, var(--border))`,
                background:`color-mix(in srgb, ${meta.color} 10%, transparent)`,
                color: meta.color,
                fontSize:10, letterSpacing:'0.06em',
                fontFamily:'var(--font-mono)',
              }}>
                <span style={{width:6, height:6, borderRadius:'50%', background: meta.color}} aria-hidden="true"/>
                {meta.en}
              </span>
            );
          })()}
          {events.length > 0 && !timelineLoading && (
            <div style={{marginLeft:'auto', display:'flex', alignItems:'center', gap:4}}>
              <button
                type="button"
                aria-label="Previous memory"
                onClick={() => setScrubIdx((i) => Math.max(0, i - 1))}
                disabled={scrubIdx === 0}
                style={{width:22, height:22, borderRadius:6, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', cursor: scrubIdx === 0 ? 'default' : 'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center', opacity: scrubIdx === 0 ? 0.35 : 1}}
              ><Icon name="chevronLeft" size={11}/></button>
              <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)', padding:'0 2px'}}>
                {Math.min(scrubIdx + 1, events.length)} / {events.length}
                {rawEvents.length > events.length && (
                  <span style={{marginLeft:6, color:'var(--text-mute)'}} title="Low-priority items hidden. Toggle in Filters to show.">
                    (+{rawEvents.length - events.length})
                  </span>
                )}
                {batchSummarizing > 0 && (
                  <span style={{marginLeft:8, color:'var(--gold)'}} title={`Summarizing ${batchSummarizing} item(s)…`}>
                    · summarizing {batchSummarizing}
                  </span>
                )}
              </span>
              <button
                type="button"
                aria-label="Next memory"
                onClick={() => setScrubIdx((i) => Math.min(events.length - 1, i + 1))}
                disabled={scrubIdx >= events.length - 1}
                style={{width:22, height:22, borderRadius:6, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', cursor: scrubIdx >= events.length - 1 ? 'default' : 'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center', opacity: scrubIdx >= events.length - 1 ? 0.35 : 1}}
              ><Icon name="chevronRight" size={11}/></button>
            </div>
          )}
        </div>
        {timelineLoading && (
          <>
            <h2 style={{margin:'0 0 14px', fontSize:22, fontWeight:600, letterSpacing:'-0.01em', wordBreak:'break-word'}}>
              <span className="muted" style={{fontWeight:400, fontSize:16}}>
                <span className="en-only">Loading timeline…</span>
                <span className="jp">読み込み中…</span>
              </span>
            </h2>
            <p style={{margin:'0 0 16px', fontSize:14, lineHeight:1.6, color:'var(--text)', whiteSpace:'pre-wrap'}}>
              <span className="muted">
                <span className="en-only">Applying Memory search preferences before the first fetch.</span>
                <span className="jp" style={{display:'block', marginTop:4}}>初回取得の前に設定を適用しています。</span>
              </span>
            </p>
          </>
        )}
        {!timelineLoading && (
          <div style={{display:'flex', gap:6, flexWrap:'wrap', marginBottom:12}}>
            {scrubbed.memoryId && (
              <span className="label">index</span>
            )}
            {scrubbed.provenance && (
              <span className="label" style={{borderColor:'var(--gold-dim)', color:'var(--gold)'}} title={scrubbed.sourceRaw || ''}>
                <span className="en-only">{memoryProvenanceLabel(scrubbed.provenance).en}</span>
                <span className="jp" style={{fontSize:10}}>{memoryProvenanceLabel(scrubbed.provenance).jp}</span>
              </span>
            )}
            {scrubbed.entityId && (
              <span className="label t-mono" style={{fontSize:9, maxWidth:140, overflow:'hidden', textOverflow:'ellipsis'}} title={scrubbed.entityId}>
                id · {scrubbed.entityId.slice(0, 24)}{scrubbed.entityId.length > 24 ? '…' : ''}
              </span>
            )}
          </div>
        )}
        {!timelineLoading && scrubSummary && !showRaw && (() => {
          const effPriority = scrubSummary.userPriority || scrubSummary.priority;
          const pinned = !!scrubSummary.userPriority;
          const setPinPriority = async (tier: any) => {
            if (!scrubbed?.memoryId) return;
            const targetId = scrubbed.memoryId;
            const nextValue = tier === scrubSummary.userPriority ? null : tier;
            const nextSummary = { ...scrubSummary, userPriority: nextValue };
            setScrubSummary(nextSummary);
            setSummaryByMemId((prev) => ({ ...prev, [targetId]: nextSummary }));
            await runRuntimeAction('memory.summary.set_priority', {
              targetId, targetKind: 'item', priority: nextValue,
            }, { silentError: true });
          };
          return (
          <div className="memory-summary-card" style={{
            display:'flex', flexDirection:'column', gap:10,
            marginBottom:14,
            borderLeft: effPriority === 'high'
              ? '2px solid var(--gold)'
              : '2px solid var(--border)',
            paddingLeft:14,
          }}>
            <div style={{display:'flex', alignItems:'baseline', gap:10, flexWrap:'wrap'}}>
              <div style={{fontSize:18, fontWeight:600, lineHeight:1.3, wordBreak:'break-word', flex:1, minWidth:0}}>{scrubSummary.title}</div>
              {pinned && (
                <span className="t-mono" style={{fontSize:9, color:'var(--gold)', letterSpacing:'0.12em', padding:'2px 6px', border:'1px solid var(--gold-dim)', borderRadius:4}}>
                  <span className="en-only">PINNED</span>
                  <span className="jp">手動</span>
                </span>
              )}
            </div>
            {Array.isArray(scrubSummary.keyPoints) && scrubSummary.keyPoints.length > 0 && (
              <ul style={{margin:0, paddingLeft:16, display:'flex', flexDirection:'column', gap:4}}>
                {scrubSummary.keyPoints.slice(0, 4).map((k: any, i: number) => (
                  <li key={i} style={{fontSize:13, color: i === 0 ? 'var(--text)' : 'var(--text-mute)', lineHeight:1.5}}>{k}</li>
                ))}
              </ul>
            )}
            <div style={{display:'flex', gap:14, marginTop:2, alignItems:'center', flexWrap:'wrap'}}>
              <div style={{display:'flex', gap:4, alignItems:'center'}} title="Set the priority for this item. Click the active tier to clear the override.">
                <span className="t-mono" style={{fontSize:9, color:'var(--text-dim)', letterSpacing:'0.1em', marginRight:2}}>PIN</span>
                {[{k:'high', label:'H'}, {k:'medium', label:'M'}, {k:'low', label:'L'}].map(({k, label}) => {
                  const active = effPriority === k;
                  const isOverride = scrubSummary.userPriority === k;
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setPinPriority(k)}
                      style={{
                        width:18, height:18, padding:0,
                        border:'1px solid ' + (active ? (k === 'high' ? 'var(--gold)' : 'var(--border-hi)') : 'var(--border)'),
                        background: active ? (k === 'high' ? 'var(--gold)' : 'var(--border-hi)') : 'transparent',
                        color: active ? 'var(--bg)' : 'var(--text-dim)',
                        fontFamily: 'inherit', fontSize: 10, fontWeight: isOverride ? 700 : 500,
                        borderRadius: 3, cursor: 'pointer',
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      }}
                    >{label}</button>
                  );
                })}
              </div>
              <button type="button" onClick={() => setShowRaw(true)} style={{
                padding:'4px 0', borderRadius:0, border:'none',
                background:'transparent', color:'var(--text-dim)', fontSize:11, cursor:'pointer', fontFamily:'inherit', textDecoration:'underline',
              }}>Show raw</button>
              <button
                type="button"
                disabled={scrubSummaryLoading}
                onClick={async () => {
                  if (!scrubbed?.memoryId) return;
                  const targetId = scrubbed.memoryId;
                  setScrubSummaryLoading(true);
                  setScrubSummary(null);
                  setSummaryByMemId((prev) => {
                    const next = { ...prev };
                    delete next[targetId];
                    return next;
                  });
                  await runRuntimeAction('memory.summary.invalidate', {
                    targetId, targetKind: 'item',
                  }, { silentError: true });
                  const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
                  const res = await runRuntimeAction('memory.summary.get', {
                    targetId, targetKind: 'item', lang,
                    item: {
                      id: targetId,
                      title: scrubbed.title || '',
                      snippet: scrubbed.snippet || '',
                      source: scrubbed.sourceRaw || '',
                    },
                  }, { silentError: true });
                  if (res?.ok && res.data?.summary) {
                    setScrubSummary(res.data.summary);
                    setSummaryByMemId((prev) => ({ ...prev, [targetId]: res.data.summary }));
                  }
                  setScrubSummaryLoading(false);
                }}
                style={{
                  padding:'4px 0', borderRadius:0, border:'none',
                  background:'transparent',
                  color: scrubSummaryLoading ? 'var(--text-mute)' : 'var(--text-dim)',
                  fontSize:11,
                  cursor: scrubSummaryLoading ? 'default' : 'pointer',
                  fontFamily:'inherit', textDecoration:'underline',
                  opacity: scrubSummaryLoading ? 0.5 : 1,
                }}
                title="Regenerate this summary (clears cache)"
              >
                {scrubSummaryLoading ? 'Regenerating…' : 'Regenerate'}
              </button>
            </div>
          </div>
          );
        })()}
        {!timelineLoading && scrubSummaryLoading && !scrubSummary && (
          <div style={{padding:'20px 18px', marginBottom:16, color:'var(--text-dim)', fontSize:13, textAlign:'center', border:'1px solid var(--border)', borderRadius:12, background:'var(--surface)'}}>
            <span className="en-only">Generating summary…</span>
            <span className="jp">要約を生成中…</span>
          </div>
        )}
        {!timelineLoading && (showRaw || (!scrubSummary && !scrubSummaryLoading)) && (
          <>
            <h2 style={{margin:'0 0 14px', fontSize:22, fontWeight:600, letterSpacing:'-0.01em', wordBreak:'break-word'}}>
              {renderHighlighted(scrubbed.titleHighlight || scrubbed.title)}
            </h2>
            {scrubbed.clusterCount > 1 && (
              <div className="t-mono" style={{margin:'-8px 0 14px', fontSize:11, color:'var(--text-dim)', letterSpacing:'0.06em'}}>
                {scrubbed.clusterCount} captures · {new Date(scrubbed.clusterStart).toTimeString().slice(0,5)}
                {' – '}
                {new Date(scrubbed.clusterEnd).toTimeString().slice(0,5)}
              </div>
            )}
            <div style={{margin:'0 0 16px', fontSize:14, lineHeight:1.6, color:'var(--text)', whiteSpace:'pre-wrap', maxHeight:320, overflowY:'auto', wordBreak:'break-word'}}>
              {scrubbed.snippetHighlight
                ? renderHighlighted(scrubbed.snippetHighlight)
                : scrubbed.snippet || (events.length ? 'No snippet text for this entry.' : 'No memories in the index yet.')}
            </div>
            {scrubSummary && (
              <div style={{marginBottom:16}}>
                <button type="button" onClick={() => setShowRaw(false)} style={{
                  padding:'6px 12px', borderRadius:8, border:'1px solid var(--border)',
                  background:'transparent', color:'var(--text-mute)', fontSize:12, cursor:'pointer', fontFamily:'inherit',
                }}>Show summary</button>
              </div>
            )}
          </>
        )}
        <span style={{flex:1}}/>
        <div style={{display:'flex', gap:8, marginTop:18, paddingTop:14, borderTop:'1px solid var(--border)', flexWrap:'wrap', alignItems:'center', position:'relative'}}>
          {scrubbed.memoryId && !timelineLoading && (
            <button
              type="button"
              onClick={() => {
                openMemoryEntryInChat(
                  { title: scrubbed.title, snippet: scrubbed.snippet },
                  {
                    memoryAssemblyQuery: scrubbed.title,
                    memoryAssemblyLimit: 14,
                    allowServerMemoryAssembly,
                    newChat: true,
                  },
                );
              }}
              style={{display:'inline-flex', alignItems:'center', gap:6, padding:'7px 12px', borderRadius:10, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', fontSize:12, cursor:'pointer', fontFamily:'inherit'}}
            >
              <Icon name="chat" size={13}/>
              <span className="en-only">Open in Chat</span>
              <span className="jp" style={{fontSize:11}}>チャットへ</span>
            </button>
          )}
          {scrubbed.memoryId && !timelineLoading && (() => {
            const assignedId = workspaceAssignments[scrubbed.memoryId];
            const assignedProject = assignedId
              ? workProjects.find((p) => p.id === assignedId)
              : null;
            const label = assignedProject ? assignedProject.name : 'Assign to workspace';
            return (
              <>
                <button
                  type="button"
                  onClick={() => setAssignMenuOpen((v) => !v)}
                  style={{
                    display:'inline-flex', alignItems:'center', gap:6,
                    padding:'7px 12px', borderRadius:10,
                    border:'1px solid ' + (assignedProject ? 'var(--gold-dim)' : 'var(--border)'),
                    background: assignedProject ? 'color-mix(in srgb, var(--gold) 10%, var(--surface))' : 'var(--surface)',
                    color: assignedProject ? 'var(--gold)' : 'var(--text-mute)',
                    fontSize:12, cursor:'pointer', fontFamily:'inherit', maxWidth:240,
                    overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                  }}
                >
                  <Icon name="work" size={13}/>
                  <span style={{overflow:'hidden', textOverflow:'ellipsis'}}>{label}</span>
                </button>
                {assignMenuOpen && (
                  <>
                    <div role="presentation" onMouseDown={()=>setAssignMenuOpen(() => false)} style={{position:'fixed', inset:0, zIndex:40}}/>
                    <div
                      role="menu"
                      onMouseDown={(e)=>e.stopPropagation()}
                      style={{
                        position:'absolute', top:'calc(100% + 6px)', left:0, zIndex:41,
                        minWidth:240, padding:6, borderRadius:10,
                        border:'1px solid var(--border-hi)', background:'var(--surface-2)',
                        boxShadow:'0 10px 30px rgba(0,0,0,0.35)',
                        display:'flex', flexDirection:'column', gap:2,
                        maxHeight:280, overflowY:'auto',
                      }}
                    >
                      {workProjects.length === 0 && (
                        <div style={{padding:'8px 10px', fontSize:12, color:'var(--text-dim)'}}>
                          No workspaces yet.
                        </div>
                      )}
                      {workProjects
                        .filter((p) => !p.archived)
                        .map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={async () => {
                              await assignMemoryToWorkspace(scrubbed.memoryId, p.id);
                              setAssignMenuOpen(() => false);
                            }}
                            style={{
                              textAlign:'left', padding:'8px 10px', borderRadius:6,
                              border:0, background: p.id === assignedId ? 'color-mix(in srgb, var(--gold) 12%, transparent)' : 'transparent',
                              color: 'var(--text)', fontSize:13, cursor:'pointer',
                              display:'flex', alignItems:'center', gap:8, fontFamily:'inherit',
                            }}
                          >
                            <Icon name="work" size={12} className={p.id === assignedId ? 'gold' : 'dim'}/>
                            <span style={{flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{p.name}</span>
                            {p.id === assignedId && <Icon name="check" size={11} className="gold"/>}
                          </button>
                        ))}
                      {assignedId && (
                        <button
                          type="button"
                          onClick={async () => {
                            await assignMemoryToWorkspace(scrubbed.memoryId, null);
                            setAssignMenuOpen(() => false);
                          }}
                          style={{
                            textAlign:'left', padding:'8px 10px', borderRadius:6,
                            border:0, background:'transparent', color:'var(--text-mute)', fontSize:12, cursor:'pointer',
                            borderTop:'1px solid var(--border)', marginTop:2, fontFamily:'inherit',
                          }}
                        >
                          Unassign
                        </button>
                      )}
                      <div style={{borderTop:'1px solid var(--border)', marginTop:4, paddingTop:6, display:'flex', gap:6}}>
                        <input
                          type="text"
                          value={newWorkspaceDraft}
                          onChange={(e) => setNewWorkspaceDraft(e.target.value)}
                          onKeyDown={async (e) => {
                            if (e.key !== 'Enter') return;
                            const name = newWorkspaceDraft.trim();
                            if (!name) return;
                            const create = (window as any).SHOGUN_RUNTIME && (window as any).SHOGUN_RUNTIME.createWorkProject;
                            const newId = typeof create === 'function' ? create(name) : null;
                            if (newId) {
                              setNewWorkspaceDraft('');
                              await assignMemoryToWorkspace(scrubbed.memoryId, newId);
                              setAssignMenuOpen(() => false);
                            }
                          }}
                          placeholder="New workspace…"
                          style={{
                            flex:1, padding:'6px 8px', borderRadius:6,
                            border:'1px solid var(--border)', background:'var(--bg)', color:'var(--text)',
                            fontSize:12, fontFamily:'inherit',
                          }}
                        />
                        <button
                          type="button"
                          onClick={async () => {
                            const name = newWorkspaceDraft.trim();
                            if (!name) return;
                            const create = (window as any).SHOGUN_RUNTIME && (window as any).SHOGUN_RUNTIME.createWorkProject;
                            const newId = typeof create === 'function' ? create(name) : null;
                            if (newId) {
                              setNewWorkspaceDraft('');
                              await assignMemoryToWorkspace(scrubbed.memoryId, newId);
                              setAssignMenuOpen(() => false);
                            }
                          }}
                          disabled={!newWorkspaceDraft.trim()}
                          style={{
                            padding:'6px 10px', borderRadius:6,
                            border:'1px solid var(--border-hi)',
                            background:'var(--surface)', color:'var(--text)',
                            fontSize:12, cursor: newWorkspaceDraft.trim() ? 'pointer' : 'default',
                            opacity: newWorkspaceDraft.trim() ? 1 : 0.5,
                            fontFamily:'inherit',
                          }}
                        >
                          Add
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </>
            );
          })()}
          <span style={{flex:1}}/>
        </div>
      </div>

      {/* Right: details panel */}
      <div style={{
        borderRadius:18,
        border:'1px solid var(--border)',
        background:'color-mix(in srgb, var(--bg) 60%, var(--surface))',
        overflow:'hidden',
        display:'flex', flexDirection:'column',
      }}>
        <div style={{padding:'14px 18px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:10}}>
          <Icon name="memory" size={14} className="gold"/>
          <span className="t-mono" style={{fontSize:11, color:'var(--text-mute)', letterSpacing:'0.12em'}}>
            <span className="en-only">Memory details</span>
            <span className="jp" style={{marginLeft:6, fontSize:10}}>メモリ詳細</span>
          </span>
        </div>
        <div style={{flex:1, padding:'18px 22px', display:'flex', flexDirection:'column', gap:14, minHeight:280, overflowY:'auto'}}>
          {scrubbed.memoryId ? (
            <>
              <div style={{display:'grid', gridTemplateColumns:'110px 1fr', rowGap:10, columnGap:12, fontSize:12}}>
                <span className="t-mono" style={{color:'var(--text-dim)'}}>Source</span>
                <span style={{color:'var(--text)', wordBreak:'break-word'}}>{scrubbed.sourceRaw || srcLabel(scrubbed.src)}</span>
                <span className="t-mono" style={{color:'var(--text-dim)'}}>Captured</span>
                <span style={{color:'var(--text)'}}>{scrubbed.t}</span>
                {scrubSummary && scrubSummary.priority && (
                  <>
                    <span className="t-mono" style={{color:'var(--text-dim)'}}>Priority</span>
                    <span style={{color:'var(--text)'}}>{String(scrubSummary.priority).toUpperCase()}</span>
                  </>
                )}
                {scrubSummary && scrubSummary.reason && (
                  <>
                    <span className="t-mono" style={{color:'var(--text-dim)'}}>Reason</span>
                    <span style={{color:'var(--text-mute)', wordBreak:'break-word', fontSize:12}}>{scrubSummary.reason}</span>
                  </>
                )}
                {scrubbed.entityId && (
                  <>
                    <span className="t-mono" style={{color:'var(--text-dim)'}}>Entity</span>
                    <span className="t-mono" style={{color:'var(--text-mute)', wordBreak:'break-all', fontSize:11}}>{scrubbed.entityId}</span>
                  </>
                )}
              </div>
            </>
          ) : (
            <div style={{flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:8, color:'var(--text-dim)', fontSize:13, textAlign:'center', padding:'0 20px'}}>
              <Icon name="memory" size={22}/>
              <span className="en-only">Select a memory to see its details.</span>
              <span className="jp" style={{fontSize:12}}>メモリを選ぶと詳細が表示されます。</span>
            </div>
          )}
        </div>
      </div>
    </div>

    {/* Timeline scrubber */}
    <div style={{marginTop:'auto', padding:'18px 40px 28px', borderTop:'1px solid var(--border)'}}>
      <div style={{display:'flex', alignItems:'center', gap:14, marginBottom:12}}>
        <span style={{fontSize:11, color:'var(--text-mute)', letterSpacing:'0.08em', fontFamily:'inherit'}}>Timeline</span>
        <span style={{flex:1}}/>
        <button type="button" onClick={()=>scrollTimeline(-1)} aria-label="Scroll timeline left" style={{width:26, height:26, borderRadius:999, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', cursor:'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center'}}><Icon name="chevronLeft" size={12}/></button>
        <button type="button" onClick={()=>scrollTimeline(1)} aria-label="Scroll timeline right" style={{width:26, height:26, borderRadius:999, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', cursor:'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center'}}><Icon name="chevronRight" size={12}/></button>
        <span className="t-mono" style={{fontSize:11, color:'var(--text-mute)'}}>{events.length} events · {timeSpanLabel}</span>
      </div>
      <div
        ref={timelineScrollRef}
        role="group"
        aria-label="Event timeline"
        style={{
          overflowX:'auto',
          overflowY:'hidden',
          paddingBottom:2,
          scrollbarWidth:'thin',
          WebkitOverflowScrolling:'touch',
          width:'100%',
          maxWidth:'100%',
          minWidth:0,
        }}
      >
        <div style={{position:'relative', width: 24 * 96, height:72, flexShrink:0}}>
          <div style={{position:'absolute', inset:'0 0 26px 0', display:'grid', gridTemplateColumns:'repeat(24, minmax(0, 1fr))', alignItems:'end', gap:3}}>
            {[...Array(24)].map((_,h)=>{
              const count = hourIndexFromEvents.counts[h] || 0;
              const firstIdx = hourIndexFromEvents.firstIdx[h] ?? -1;
              const height = count > 0 ? Math.round((count / hourIndexFromEvents.maxC) * 42) + 6 : 4;
              const active = firstIdx >= 0 && scrubIdx >= firstIdx && scrubIdx < firstIdx + count;
              const clickable = firstIdx >= 0;
              const topTier = hourIndexFromEvents.topPriority[h];
              const inactiveBg = topTier === 'high'
                ? 'var(--gold)'
                : topTier === 'medium'
                  ? 'var(--border-hi)'
                  : 'var(--border)';
              const inactiveOpacity = topTier === 'high'
                ? 0.9
                : topTier === 'medium'
                  ? 0.6
                  : (clickable ? 0.4 : 0.3);
              return (
                <button
                  key={h}
                  type="button"
                  disabled={!clickable}
                  onClick={() => { if (clickable) setScrubIdx(() => firstIdx); }}
                  aria-label={`${count} memories at ${String(h).padStart(2,'0')}:00${topTier ? ` (top priority: ${topTier})` : ''}`}
                  style={{
                    height,
                    padding:0,
                    border:'none',
                    background: active ? 'var(--gold)' : inactiveBg,
                    opacity: clickable ? (active ? 0.95 : inactiveOpacity) : 0.3,
                    borderRadius:2,
                    cursor: clickable ? 'pointer' : 'default',
                    transition: 'opacity 120ms, background 120ms',
                  }}
                />
              );
            })}
          </div>
          <div className="t-mono" style={{position:'absolute', left:0, bottom:0, right:0, display:'grid', gridTemplateColumns:'repeat(24, minmax(0, 1fr))', fontSize:10, color:'var(--text-dim)'}}>
            {[...Array(24)].map((_,h)=>(
              <span key={h} style={{textAlign:'center'}}>{String(h).padStart(2,'0')}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
    </>
  );
}

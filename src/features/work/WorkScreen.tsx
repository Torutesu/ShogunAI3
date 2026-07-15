// Phase 2 Step 7.1: WorkScreen split from _legacy/screens-c.tsx.
import React from 'react';
import * as ReactDOM from 'react-dom';
import { Icon } from '@/shared/icons';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';
import {
  clearPendingWorkspaceDetailId,
  takePendingWorkspaceDetailId,
} from '@/shared/context/native-detail-events';
import { Toggle } from '@/features/settings/components/Toggle';
import { WorkAiFieldPanel } from './components/WorkAiFieldPanel';

function useWorkProjects() {
  const [projects, setProjects] = React.useState(() => {
    const get = (window as any).SHOGUN_RUNTIME && (window as any).SHOGUN_RUNTIME.getWorkProjects;
    return typeof get === 'function' ? get() : [];
  });
  React.useEffect(() => {
    const sync = () => {
      const get = (window as any).SHOGUN_RUNTIME && (window as any).SHOGUN_RUNTIME.getWorkProjects;
      if (typeof get === 'function') setProjects(get());
    };
    sync();
    window.addEventListener('shogun-work-projects-changed', sync);
    return () => window.removeEventListener('shogun-work-projects-changed', sync);
  }, []);
  return projects;
}

export function WorkScreen() {
  const projects = useWorkProjects();
  const [showArchived, setShowArchived] = React.useState(false);
  const [newName, setNewName] = React.useState('');
  const [renaming, setRenaming] = React.useState<{ id: any; value: string }>({ id: null, value: '' });
  const [menuFor, setMenuFor] = React.useState<any>(null);
  const [memberships, setMemberships] = React.useState<Record<string, any>>({});
  const [membershipsReady, setMembershipsReady] = React.useState(false);
  // { project, memories, loading, busyId } when the detail modal is open.
  const [detail, setDetail] = React.useState<any>(null);
  const [pendingWorkspaceDetailId, setPendingWorkspaceDetailId] = React.useState('');
  const renameInputRef = React.useRef<HTMLInputElement>(null);
  const detailRef = React.useRef<any>(null);

  const applyMembershipMap = React.useCallback((map: Record<string, any> | null | undefined) => {
    const next = map && typeof map === 'object' ? map : {};
    setMemberships(next);
    setMembershipsReady(true);
    const openProject = detailRef.current?.project;
    if (openProject) {
      void openDetailRef.current?.(openProject, next, true);
    }
  }, []);
  const openDetailRef = React.useRef<any>(null);

  React.useEffect(() => {
    detailRef.current = detail;
  }, [detail]);

  React.useEffect(() => {
    if (renaming.id == null) return;
    renameInputRef.current?.focus();
  }, [renaming.id]);

  const visible = React.useMemo(
    () => projects.filter((p: any) => !!p.archived === showArchived),
    [projects, showArchived],
  );

  const openDetail = React.useCallback(async (
    project: any,
    overrideMemberships?: Record<string, any> | null,
    overrideMembershipsReady?: boolean,
  ) => {
    setPendingWorkspaceDetailId('');
    setDetail({ project, memories: [], loading: true, busyId: null });
    const membershipMap = overrideMemberships && typeof overrideMemberships === 'object'
      ? overrideMemberships
      : memberships;
    const loadedMemberships = typeof overrideMembershipsReady === 'boolean'
      ? overrideMembershipsReady
      : membershipsReady;
    const ids = Object.entries(membershipMap)
      .filter(([, w]) => w === project.id)
      .map(([m]) => m);
    if (ids.length === 0) {
      if (!loadedMemberships) {
        setPendingWorkspaceDetailId(project.id);
        return;
      }
      setDetail({ project, memories: [], loading: false, busyId: null });
      return;
    }
    const r = await runRuntimeAction('memory.fetch', { ids } as any, { silentError: true } as any);
    const items = r && r.ok && Array.isArray(r.data?.items) ? r.data.items : [];
    setDetail({ project, memories: items, loading: false, busyId: null });
  }, [memberships, membershipsReady]);

  React.useEffect(() => {
    openDetailRef.current = openDetail;
  }, [openDetail]);

  // Assignment map written by the Memory screen lives in
  // settings.sections.workspace_memberships.memberships.
  React.useEffect(() => {
    let cancelled = false;
    const load = () => {
      runRuntimeAction('settings.load', {}, { silentError: true } as any).then((r) => {
        if (cancelled) return;
        const map = r && r.ok
          && r.data && r.data.settings && r.data.settings.sections
          && r.data.settings.sections.workspace_memberships
          && r.data.settings.sections.workspace_memberships.memberships;
        applyMembershipMap(map);
      }).catch(() => {
        if (cancelled) return;
        applyMembershipMap({});
      });
    };
    load();
    const onChanged = (ev: any) => {
      // Fast path: assignment events carry the new map directly.
      const m = ev && ev.detail && ev.detail.memberships;
      if (m && typeof m === 'object') {
        applyMembershipMap(m);
      } else {
        load();
      }
    };
    const onSettingsRefresh = () => {
      load();
    };
    window.addEventListener('shogun-workspace-memberships-changed', onChanged);
    window.addEventListener('shogun-settings-refresh', onSettingsRefresh);
    return () => {
      cancelled = true;
      window.removeEventListener('shogun-workspace-memberships-changed', onChanged);
      window.removeEventListener('shogun-settings-refresh', onSettingsRefresh);
    };
  }, [applyMembershipMap]);

  const countByProject = React.useMemo(() => {
    const out: Record<string, number> = {};
    for (const v of Object.values(memberships)) {
      if (!v) continue;
      out[v as string] = (out[v as string] || 0) + 1;
    }
    return out;
  }, [memberships]);

  // Provider color metadata mirrors hifi/screens-a.jsx so detail rows look the
  // same as Memory search / scrubbed cards. Keep in sync if either changes.
  const PROVIDER_META = React.useMemo(() => ({
    screen:          { en: 'Screen',   color: 'var(--text-mute)' },
    meeting:         { en: 'Meeting',  color: 'var(--success)' },
    gmail:           { en: 'Gmail',    color: '#D93025' },
    google_calendar: { en: 'Calendar', color: '#1A73E8' },
    google_drive:    { en: 'Drive',    color: '#0F9D58' },
    slack:           { en: 'Slack',    color: '#4A154B' },
    notion:          { en: 'Notion',   color: 'var(--text)' },
    github:          { en: 'GitHub',   color: 'var(--text-mute)' },
    linear:          { en: 'Linear',   color: '#5E6AD2' },
    zoom:            { en: 'Zoom',     color: '#2D8CFF' },
    manual:          { en: 'Manual',   color: 'var(--text-dim)' },
  }), []);
  const providerKey = React.useCallback((source: any) => {
    const s = String(source || '').toLowerCase();
    if (s === 'capture_sampler' || s === 'capture_ax') return 'screen';
    if (s === 'gmail') return 'gmail';
    if (s === 'google_calendar') return 'google_calendar';
    if (s === 'google_drive') return 'google_drive';
    if (s === 'slack') return 'slack';
    if (s === 'notion') return 'notion';
    if (s === 'github') return 'github';
    if (s === 'linear') return 'linear';
    if (s === 'zoom') return 'zoom';
    if (s === 'meeting' || s.startsWith('meetings')) return 'meeting';
    return 'manual';
  }, []);

  React.useEffect(() => {
    const onOpenWorkspaceDetail = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId?: string }>).detail || {};
      const workspaceId = String(detail.workspaceId || '').trim();
      if (!workspaceId) return;
      clearPendingWorkspaceDetailId(workspaceId);
      const project = projects.find((item: any) => String(item?.id || '').trim() === workspaceId);
      if (!project) {
        setPendingWorkspaceDetailId(workspaceId);
        return;
      }
      void openDetail(project);
    };
    window.addEventListener('shogun-open-workspace-detail', onOpenWorkspaceDetail as EventListener);
    return () => {
      window.removeEventListener('shogun-open-workspace-detail', onOpenWorkspaceDetail as EventListener);
    };
  }, [openDetail, projects]);

  React.useEffect(() => {
    if (!pendingWorkspaceDetailId) return;
    const project = projects.find((item: any) => String(item?.id || '').trim() === pendingWorkspaceDetailId);
    if (!project) return;
    void openDetail(project);
  }, [openDetail, pendingWorkspaceDetailId, projects]);

  React.useEffect(() => {
    const pendingWorkspaceId = takePendingWorkspaceDetailId();
    if (!pendingWorkspaceId) return;
    const project = projects.find((item: any) => String(item?.id || '').trim() === pendingWorkspaceId);
    if (!project) {
      setPendingWorkspaceDetailId(pendingWorkspaceId);
      return;
    }
    void openDetail(project);
  }, [openDetail, projects]);

  const removeFromWorkspace = React.useCallback(async (memoryId: string) => {
    if (!detail) return;
    setDetail((prev: any) => (prev ? { ...prev, busyId: memoryId } : prev));
    const next = { ...memberships };
    delete next[memoryId];
    setMemberships(next);
    await runRuntimeAction(
      'settings.save',
      { section: 'workspace_memberships', memberships: next } as any,
      { silentError: true } as any,
    );
    try {
      window.dispatchEvent(new CustomEvent('shogun-workspace-memberships-changed', { detail: { memberships: next } }));
    } catch (_) { /* ignore */ }
    setDetail((prev: any) => prev
      ? { ...prev, memories: prev.memories.filter((m: any) => m.id !== memoryId), busyId: null }
      : prev);
  }, [detail, memberships]);

  const createProject = React.useCallback(() => {
    const name = newName.trim();
    if (!name) return;
    const create = (window as any).SHOGUN_RUNTIME && (window as any).SHOGUN_RUNTIME.createWorkProject;
    if (typeof create === 'function') create(name);
    setNewName('');
  }, [newName]);

  const confirmRename = React.useCallback(() => {
    const id = renaming.id;
    const name = renaming.value.trim();
    if (!id || !name) {
      setRenaming({ id: null, value: '' });
      return;
    }
    const fn = (window as any).SHOGUN_RUNTIME && (window as any).SHOGUN_RUNTIME.renameWorkProject;
    if (typeof fn === 'function') fn(id, name);
    setRenaming({ id: null, value: '' });
  }, [renaming]);

  const archiveProject = React.useCallback((id: any, archived: boolean) => {
    const fn = (window as any).SHOGUN_RUNTIME && (window as any).SHOGUN_RUNTIME.archiveWorkProject;
    if (typeof fn === 'function') fn(id, !!archived);
    setMenuFor(null);
  }, []);

  const deleteProject = React.useCallback((id: any, name: any) => {
    const label = String(name || 'このWorkspace');
    const ok = typeof window.confirm === 'function'
      ? window.confirm(`「${label}」を削除しますか？\n関連するチャットは残ります。`)
      : true;
    if (!ok) return;
    const fn = (window as any).SHOGUN_RUNTIME && (window as any).SHOGUN_RUNTIME.deleteWorkProject;
    if (typeof fn === 'function') fn(id);
    setMenuFor(null);
  }, []);

  React.useEffect(() => {
    if (menuFor == null) return undefined;
    const onDocClick = () => setMenuFor(null);
    window.addEventListener('click', onDocClick);
    return () => window.removeEventListener('click', onDocClick);
  }, [menuFor]);

  return (
    <div className="content-inner">
      <div className="page-head">
        <div>
          <div className="t-mono" style={{marginBottom:8}}>OPERATIONS LAYER</div>
          <h1>Work <span className="jp">任務</span></h1>
          <div className="sub">
            <span className="en-only">Workspaces group your memory context by project or job.</span>
            <span className="jp">Workspace はメモリのコンテキストをプロジェクト / 仕事単位にまとめる器です。</span>
          </div>
        </div>
        <div className="row" style={{flexWrap:'wrap', gap:8, alignItems:'center'}}>
          <Toggle on={showArchived} onClick={() => setShowArchived((v) => !v)} />
          <span className="row" style={{gap:6, alignItems:'center', fontSize:12, color:'var(--text-dim)', userSelect:'none'}}>
            <span>
              <span className="en-only">Show archived</span>
              <span className="jp">アーカイブを表示</span>
            </span>
          </span>
        </div>
      </div>

      <div className="card" style={{padding:16, marginBottom:18, display:'flex', gap:10, alignItems:'center', flexWrap:'wrap'}}>
        <Icon name="plus" size={14} className="gold"/>
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') createProject(); }}
          placeholder="New workspace name / 新規Workspace名"
          style={{
            flex:1, minWidth:200,
            padding:'8px 12px',
            borderRadius:8,
            border:'1px solid var(--border)',
            background:'var(--surface)',
            color:'var(--text)',
            fontSize:13,
            fontFamily:'inherit',
          }}
        />
        <button
          type="button"
          data-testid="work-create-workspace"
          className="btn btn-primary btn-sm"
          onClick={createProject}
          disabled={!newName.trim()}
          style={!newName.trim() ? {opacity:0.5, cursor:'not-allowed'} : undefined}
        >
          <span className="en-only">Create</span>
          <span className="jp">作成</span>
        </button>
      </div>

      {visible.length === 0 ? (
        <div className="card" style={{padding:28, textAlign:'center'}}>
          <p style={{fontSize:14, color:'var(--text-mute)', margin:0, lineHeight:1.6}}>
            {showArchived ? (
              <>
                <span className="en-only">No archived workspaces.</span>
                <span className="jp">アーカイブ済みのWorkspaceはありません。</span>
              </>
            ) : (
              <>
                <span className="en-only">No workspaces yet. Create one above to start grouping memory context by project.</span>
                <span className="jp">Workspaceがまだありません。上のフォームから作成して、プロジェクト単位でコンテキストをまとめましょう。</span>
              </>
            )}
          </p>
        </div>
      ) : (
        <div className="shogun-grid-cards">
          {visible.map((p: any) => (
            <div
              key={p.id}
              className="card card-interactive"
              style={{padding:18, position:'relative', cursor: renaming.id === p.id ? 'default' : 'pointer'}}
              onClick={(e) => {
                // Ignore clicks bubbling from the menu / rename input / kebab
                // button so they don't open the modal.
                if (renaming.id === p.id || menuFor === p.id) return;
                if ((e.target as HTMLElement).closest('button, input, [role="menu"]')) return;
                openDetail(p);
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (renaming.id === p.id || menuFor === p.id) return;
                  openDetail(p);
                }
              }}
            >
              <div className="row" style={{gap:8, marginBottom:10, flexWrap:'wrap', alignItems:'center'}}>
                <Icon name="work" size={14} className="gold"/>
                <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)'}}>WORKSPACE</span>
                {p.archived && (
                  <span className="label" style={{fontSize:10, borderColor:'var(--border-hi)', color:'var(--text-mute)'}}>
                    <span className="en-only">Archived</span>
                    <span className="jp">アーカイブ済み</span>
                  </span>
                )}
                <span style={{flex:1}}/>
                <button
                  type="button"
                  aria-label="More actions"
                  onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === p.id ? null : p.id); }}
                  style={{
                    display:'inline-flex', alignItems:'center', justifyContent:'center',
                    width:26, height:26, padding:0,
                    border:'1px solid transparent', borderRadius:8,
                    background:'transparent', color:'var(--text-mute)', cursor:'pointer',
                  }}
                >
                  <Icon name="more" size={14}/>
                </button>
                {menuFor === p.id && (
                  <div
                    style={{
                      position:'absolute', top:44, right:14, zIndex:5,
                      minWidth:180,
                      background:'var(--surface)',
                      border:'1px solid var(--border-hi)',
                      borderRadius:10,
                      boxShadow:'0 10px 30px -8px rgba(0,0,0,0.5)',
                      padding:4,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => { setRenaming({ id: p.id, value: p.name || '' }); setMenuFor(null); }}
                      style={{display:'block', width:'100%', textAlign:'left', padding:'8px 10px', border:0, background:'transparent', color:'var(--text)', fontSize:12, cursor:'pointer', borderRadius:6}}
                    >
                      <span className="en-only">Rename</span>
                      <span className="jp">名前を変更</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => archiveProject(p.id, !p.archived)}
                      style={{display:'block', width:'100%', textAlign:'left', padding:'8px 10px', border:0, background:'transparent', color:'var(--text)', fontSize:12, cursor:'pointer', borderRadius:6}}
                    >
                      {p.archived ? (
                        <>
                          <span className="en-only">Unarchive</span>
                          <span className="jp">復元</span>
                        </>
                      ) : (
                        <>
                          <span className="en-only">Archive</span>
                          <span className="jp">アーカイブ</span>
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteProject(p.id, p.name)}
                      style={{display:'block', width:'100%', textAlign:'left', padding:'8px 10px', border:0, background:'transparent', color:'var(--danger)', fontSize:12, cursor:'pointer', borderRadius:6}}
                    >
                      <span className="en-only">Delete</span>
                      <span className="jp">削除</span>
                    </button>
                  </div>
                )}
              </div>

                {renaming.id === p.id ? (
                <div className="row" style={{gap:8, alignItems:'center'}}>
                  <input
                    ref={renameInputRef}
                    type="text"
                    value={renaming.value}
                    onChange={(e) => setRenaming({ id: p.id, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') confirmRename();
                      else if (e.key === 'Escape') setRenaming({ id: null, value: '' });
                    }}
                    style={{
                      flex:1,
                      padding:'6px 10px',
                      borderRadius:8,
                      border:'1px solid var(--border-hi)',
                      background:'var(--bg)',
                      color:'var(--text)',
                      fontSize:15,
                      fontFamily:'inherit',
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    onClick={confirmRename}
                  >
                    OK
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => setRenaming({ id: null, value: '' })}
                  >
                    <Icon name="x" size={12}/>
                  </button>
                </div>
              ) : (
                <div style={{fontSize:16, fontWeight:500, lineHeight:1.3}}>
                  {p.name || <span style={{color:'var(--text-dim)'}}>Untitled</span>}
                </div>
              )}

              <div style={{fontSize:11, color:'var(--text-dim)', marginTop:10, lineHeight:1.5}}>
                {(() => {
                  const n = countByProject[p.id] || 0;
                  return n > 0
                    ? `${n} memor${n === 1 ? 'y' : 'ies'} assigned · click to view`
                    : 'No memories assigned yet — use "Assign to workspace" on a memory.';
                })()}
              </div>
            </div>
          ))}
        </div>
      )}

      {detail && ReactDOM.createPortal(
        (() => {
          const close = () => setDetail(null);
          const items = detail.memories || [];
          const fmtDate = (ms: any) => {
            try { return new Date(Number(ms) || 0).toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' }); } catch (_) { return ''; }
          };
          return (
            <div
              style={{
                position:'fixed', inset:0, zIndex:1098,
                background:'color-mix(in srgb, var(--bg) 78%, transparent)',
                backdropFilter:'blur(4px)',
                display:'flex', alignItems:'center', justifyContent:'center',
                padding:20,
              }}
              onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
            >
              <div
                role="dialog"
                aria-modal="true"
                style={{
                  width:'min(860px, 100%)',
                  maxHeight:'min(82vh, 760px)',
                  background:'var(--surface)',
                  border:'1px solid var(--border-hi)',
                  borderRadius:16,
                  boxShadow:'0 30px 60px -16px rgba(0,0,0,0.6)',
                  display:'flex', flexDirection:'column',
                }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <div style={{padding:'18px 22px 14px', borderBottom:'1px solid var(--border)'}}>
                  <div className="row" style={{gap:10, alignItems:'center', marginBottom:6}}>
                    <Icon name="work" size={14} className="gold"/>
                    <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)', letterSpacing:'0.12em'}}>WORKSPACE</span>
                    <span style={{flex:1}}/>
                    <button
                      type="button"
                      aria-label="Close"
                      onClick={close}
                      style={{width:24, height:24, borderRadius:6, border:0, background:'transparent', color:'var(--text-mute)', cursor:'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center'}}
                    >
                      <Icon name="x" size={14}/>
                    </button>
                  </div>
                  <div style={{fontSize:18, fontWeight:500, lineHeight:1.3}}>
                    {detail.project?.name || 'Untitled workspace'}
                  </div>
                  <div className="t-mono" style={{fontSize:10, color:'var(--text-dim)', marginTop:6, letterSpacing:'0.06em'}}>
                    {items.length} {items.length === 1 ? 'memory' : 'memories'} assigned
                  </div>
                </div>
                <div style={{flex:1, overflowY:'auto', padding:'14px 22px 20px'}}>
                  {detail.loading ? (
                    <div style={{padding:24, color:'var(--text-dim)', fontSize:13, textAlign:'center'}}>Loading…</div>
                  ) : items.length === 0 ? (
                    <div style={{padding:24, color:'var(--text-dim)', fontSize:13, textAlign:'center', lineHeight:1.55}}>
                      No memories yet. Use Memory → Search to bulk-assign, or click a memory&apos;s &quot;Assign to workspace&quot; chip.
                    </div>
                  ) : (
                    <div style={{display:'flex', flexDirection:'column', gap:10}}>
                      <WorkAiFieldPanel project={detail.project} memories={items} onNavigateAway={close} />
                      {items.map((m: any) => {
                        const id = m.id;
                        const busy = detail.busyId === id;
                        const provKey = providerKey(m.source);
                        const meta = (PROVIDER_META as any)[provKey];
                        const created = Number(m.created_at) || 0;
                        return (
                          <div
                            key={id}
                            className="card"
                            style={{padding:14, display:'flex', flexDirection:'column', gap:6}}
                          >
                            <div className="row" style={{gap:8, alignItems:'center', flexWrap:'wrap'}}>
                              {meta && (
                                <span style={{
                                  display:'inline-flex', alignItems:'center', gap:5,
                                  padding:'2px 7px', borderRadius:4,
                                  border:`1px solid color-mix(in srgb, ${meta.color} 50%, var(--border))`,
                                  background:`color-mix(in srgb, ${meta.color} 10%, transparent)`,
                                  color: meta.color,
                                  fontSize:9, letterSpacing:'0.06em', fontFamily:'var(--font-mono)',
                                }}>
                                  <span style={{width:5, height:5, borderRadius:'50%', background: meta.color}} aria-hidden="true"/>
                                  {meta.en}
                                </span>
                              )}
                              <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)'}}>{fmtDate(created)}</span>
                              <span style={{flex:1}}/>
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                disabled={busy}
                                onClick={() => removeFromWorkspace(id)}
                                style={busy ? {opacity:0.55, cursor:'default'} : undefined}
                              >
                                {busy ? 'Removing…' : 'Remove'}
                              </button>
                            </div>
                            <div style={{fontSize:14, fontWeight:500, lineHeight:1.35}}>
                              {m.title || 'Untitled'}
                            </div>
                            {m.snippet && (
                              <div style={{fontSize:12, color:'var(--text-dim)', lineHeight:1.55, overflow:'hidden', display:'-webkit-box', WebkitLineClamp:3, WebkitBoxOrient:'vertical'}}>
                                {m.snippet}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })(),
        document.body,
      )}
    </div>
  );
}

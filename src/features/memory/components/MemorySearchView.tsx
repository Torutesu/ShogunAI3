import { useState, useEffect, useCallback, useRef } from 'react';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';
import { ACTION_LAYER_REFRESH_EVENT } from '@/shared/context/action-layer-events';
import { normalizeContextActionType } from '@/shared/context/action-types';
import {
  nativeDetailDescriptorForEntityId,
  openContextTarget,
  openNativeDetailForEntityId,
} from '@/shared/context/context-target-navigation';
import {
  queueArtifactNativeDetailState,
  queueArtifactOwnerEntityId,
  queueArtifactSourceActionId,
} from '@/shared/context/queue-artifact-meta';
import { focusActionTrace } from '@/shared/context/action-trace-focus';
import { openQueueArtifactInActions } from '@/shared/context/open-queue-artifact';
import { memoryProviderKey, MEMORY_PROVIDER_META, openMemoryEntryInChat } from '../lib/runtime';
import { ShogunHighlight } from '@/shared/lib/highlight';
import type { OwnerContextSummaryRecord } from '@/shared/domain/context-layer';

function normalizeOwnerSummary(summary: OwnerContextSummaryRecord): OwnerContextSummaryRecord {
  return {
    ...summary,
    entityContext: summary.entityContext
      ? {
          ...summary.entityContext,
          actions: (summary.entityContext.actions || []).map((item) => ({
            ...item,
            actionType: normalizeContextActionType(item.actionType),
          })),
        }
      : summary.entityContext,
    actions: {
      items: (summary.actions?.items || []).map((item) => ({
        ...item,
        actionType: normalizeContextActionType(item.actionType),
      })),
      total: summary.actions?.total || 0,
    },
  };
}

export interface MemorySearchViewProps {
  workProjects: any[];
  assignments: Record<string, string>;
  setAssignments: (a: Record<string, string>) => void;
  seedQuery?: string;
  allowServerMemoryAssembly?: boolean;
}

export function MemorySearchView({
  workProjects,
  assignments,
  setAssignments,
  seedQuery = '',
  allowServerMemoryAssembly = true,
}: MemorySearchViewProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [targetWorkspace, setTargetWorkspace] = useState('');
  const [busy, setBusy] = useState(false);
  const [newDraft, setNewDraft] = useState('');
  const [openSummaryEntityId, setOpenSummaryEntityId] = useState('');
  const [summaryByEntityId, setSummaryByEntityId] = useState<Record<string, OwnerContextSummaryRecord | null>>({});
  const [summaryLoadingEntityId, setSummaryLoadingEntityId] = useState('');
  const [refreshNonce, setRefreshNonce] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setSearching(true);
    runRuntimeAction('memory.timelineSearch', { query: '', limit: 60 }, { silentError: true })
      .then((r: any) => {
        if (cancelled) return;
        setSearching(false);
        const arr = r && r.ok && Array.isArray(r.data?.hits) ? r.data.hits : [];
        setHits(arr);
      });
    return () => { cancelled = true; };
  }, [refreshNonce]);

  useEffect(() => {
    if (query === '') return undefined;
    const t = setTimeout(() => {
      setSearching(true);
      runRuntimeAction('memory.timelineSearch', { query, limit: 60 }, { silentError: true })
        .then((r: any) => {
          setSearching(false);
          const arr = r && r.ok && Array.isArray(r.data?.hits) ? r.data.hits : [];
          setHits(arr);
        });
    }, 220);
    return () => clearTimeout(t);
  }, [query, refreshNonce]);

  useEffect(() => {
    const onRefresh = () => {
      setSummaryByEntityId({});
      setSummaryLoadingEntityId('');
      setRefreshNonce((prev) => prev + 1);
    };
    window.addEventListener(ACTION_LAYER_REFRESH_EVENT, onRefresh);
    return () => {
      window.removeEventListener(ACTION_LAYER_REFRESH_EVENT, onRefresh);
    };
  }, []);

  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  useEffect(() => {
    const next = String(seedQuery || '');
    setQuery(next);
  }, [seedQuery]);

  const toggleOne = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const selectAllVisible = useCallback(() => {
    setSelected(new Set(hits.map((h) => h.id).filter(Boolean)));
  }, [hits]);
  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const applyAssign = useCallback(async () => {
    if (selected.size === 0 || !targetWorkspace) return;
    setBusy(true);
    const next = { ...assignments };
    let resolvedTarget = targetWorkspace;
    if (targetWorkspace === '__new__') {
      const name = newDraft.trim();
      if (!name) { setBusy(false); return; }
      const create = (window as any).SHOGUN_RUNTIME && (window as any).SHOGUN_RUNTIME.createWorkProject;
      const id = typeof create === 'function' ? create(name) : null;
      if (!id) { setBusy(false); return; }
      resolvedTarget = id;
      setNewDraft('');
    } else if (targetWorkspace === '__unassign__') {
      resolvedTarget = '';
    }
    selected.forEach((id) => {
      if (resolvedTarget) next[id] = resolvedTarget;
      else delete next[id];
    });
    setAssignments(next);
    await runRuntimeAction(
      'settings.save',
      { section: 'workspace_memberships', memberships: next },
      { silentError: true },
    );
    try {
      window.dispatchEvent(new CustomEvent('shogun-workspace-memberships-changed', { detail: { memberships: next } }));
    } catch (_) { /* ignore */ }
    (window as any).SHOGUN_RUNTIME?.pushToast?.(
      resolvedTarget
        ? `Assigned ${selected.size} memor${selected.size === 1 ? 'y' : 'ies'}`
        : `Unassigned ${selected.size} memor${selected.size === 1 ? 'y' : 'ies'}`,
      'success',
    );
    setSelected(new Set());
    if (targetWorkspace !== '__new__') setTargetWorkspace('');
    setBusy(false);
  }, [assignments, selected, targetWorkspace, newDraft, setAssignments]);

  const visibleProjects = workProjects.filter((p) => !p.archived);
  const renderHL = ShogunHighlight && ShogunHighlight.renderHighlighted
    ? ShogunHighlight.renderHighlighted
    : ((t: any) => t);
  const openEntityContext = useCallback((entityId: string) => {
    const id = String(entityId || '').trim();
    if (!id) return;
    openContextTarget({ targetId: id });
  }, []);
  const openHitInChat = useCallback((hit: any) => {
    openMemoryEntryInChat(
      { title: hit?.title, snippet: hit?.snippet },
      {
        userLead: 'この memory hit を shared context とあわせて整理してください。',
        memoryAssemblyQuery: hit?.entity_id || hit?.title,
        memoryAssemblyLimit: 14,
        allowServerMemoryAssembly,
        newChat: true,
      },
    );
  }, [allowServerMemoryAssembly]);
  const loadOwnerSummary = useCallback(async (entityId: string) => {
    const id = String(entityId || '').trim();
    if (!id) return;
    setSummaryLoadingEntityId(id);
    const res = await runRuntimeAction(
      'context.owner_summary.get',
      { ownerEntityId: id, limit: 4 },
      { silentError: true },
    );
    setSummaryByEntityId((prev) => ({
      ...prev,
      [id]: res?.ok && res.data ? normalizeOwnerSummary(res.data as OwnerContextSummaryRecord) : null,
    }));
    setSummaryLoadingEntityId((prev) => (prev === id ? '' : prev));
  }, []);

  const toggleOwnerSummary = useCallback(async (entityId: string) => {
    const id = String(entityId || '').trim();
    if (!id) return;
    if (openSummaryEntityId === id) {
      setOpenSummaryEntityId('');
      return;
    }
    setOpenSummaryEntityId(id);
    if (summaryByEntityId[id] !== undefined) return;
    await loadOwnerSummary(id);
  }, [loadOwnerSummary, openSummaryEntityId, summaryByEntityId]);

  useEffect(() => {
    const id = String(openSummaryEntityId || '').trim();
    if (!id) return;
    if (summaryByEntityId[id] !== undefined || summaryLoadingEntityId === id) return;
    void loadOwnerSummary(id);
  }, [loadOwnerSummary, openSummaryEntityId, refreshNonce, summaryByEntityId, summaryLoadingEntityId]);

  return (
    <div style={{flex:1, padding:'24px 40px 40px', minHeight:0, display:'flex', flexDirection:'column', gap:14}}>
      <div className="row" style={{gap:10, alignItems:'center'}}>
        <input
          ref={searchInputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search indexed memory…"
          style={{
            flex:1, padding:'10px 14px', borderRadius:10,
            border:'1px solid var(--border-hi)', background:'var(--bg)',
            color:'var(--text)', fontSize:14, fontFamily:'inherit',
          }}
        />
        <span className="t-mono" style={{fontSize:11, color:'var(--text-dim)'}}>
          {searching ? 'Searching…' : `${hits.length} hits`}
        </span>
        {hits.length > 0 && (
          selected.size === hits.length ? (
            <button
              type="button" className="btn btn-sm btn-ghost"
              onClick={clearSelection}
            >Clear</button>
          ) : (
            <button
              type="button" className="btn btn-sm btn-secondary"
              onClick={selectAllVisible}
            >Select all</button>
          )
        )}
      </div>

      <div style={{flex:1, minHeight:0, overflowY:'auto', display:'flex', flexDirection:'column', gap:8, paddingRight:4}}>
        {hits.length === 0 ? (
          <div style={{padding:32, color:'var(--text-dim)', fontSize:13, textAlign:'center'}}>
            {searching ? 'Loading…' : 'No matches.'}
          </div>
        ) : (
          hits.map((h) => {
            const id = h.id;
            const isOn = !!id && selected.has(id);
            const titleSrc = h.title_highlight || h.title || 'Untitled';
            const snippetSrc = h.snippet_highlight || h.snippet || '';
            const provider = memoryProviderKey(h.source);
            const meta = MEMORY_PROVIDER_META[provider];
            const assignedId = id ? assignments[id] : null;
            const assignedProj = assignedId ? workProjects.find((p) => p.id === assignedId) : null;
            const entityId = String(h.entity_id || '').trim();
            const nativeDetailDescriptor = nativeDetailDescriptorForEntityId(entityId);
            const inlineSummary = entityId ? summaryByEntityId[entityId] : null;
            const summaryOpen = entityId && openSummaryEntityId === entityId;
            const summaryLoading = entityId && summaryLoadingEntityId === entityId;
            const latestAction = inlineSummary?.actions.items?.[0] || null;
            const latestQueue = inlineSummary?.queueArtifacts.items?.[0] || null;
            const latestAudit = inlineSummary?.latestAudits.find((item) => item.latestAudit)?.latestAudit || null;
            const latestQueueActionId = queueArtifactSourceActionId(latestQueue);
            const latestQueueAiFieldId = String(
              inlineSummary?.actions.items.find((item) => item.id === latestQueueActionId)?.sourceAiFieldId
                || latestAction?.sourceAiFieldId
                || inlineSummary?.aiFields.items?.[0]?.id
                || '',
            ).trim() || null;
            const {
              ownerEntityId: latestQueueOwnerEntityId,
              nativeDetailDescriptor: latestQueueNativeDetailDescriptor,
              showNativeDetail: showLatestQueueNativeDetail,
            } = queueArtifactNativeDetailState(latestQueue, {
              currentEntityId: entityId,
            });
            return (
              <label
                key={id || h.title}
                style={{
                  display:'grid', gridTemplateColumns:'24px 1fr', columnGap:12,
                  padding:'12px 14px', borderRadius:12,
                  border:'1px solid ' + (isOn ? 'color-mix(in srgb, var(--gold) 65%, var(--border))' : 'var(--border)'),
                  background: isOn ? 'color-mix(in srgb, var(--gold) 6%, var(--surface))' : 'var(--surface)',
                  cursor: id ? 'pointer' : 'default',
                  alignItems:'flex-start',
                }}
              >
                <input
                  type="checkbox"
                  checked={isOn}
                  disabled={!id}
                  onChange={() => id && toggleOne(id)}
                  style={{marginTop:3}}
                />
                <div style={{minWidth:0}}>
                  <div className="row" style={{gap:8, alignItems:'center', flexWrap:'wrap', marginBottom:4}}>
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
                    {assignedProj && (
                      <span className="label" style={{fontSize:10, borderColor:'var(--gold-dim)', color:'var(--gold)'}}>
                        ▣ {assignedProj.name}
                      </span>
                    )}
                  </div>
                  <div style={{fontSize:14, fontWeight:500, lineHeight:1.35, marginBottom:4}}>
                    {renderHL(titleSrc)}
                  </div>
                  {snippetSrc && (
                    <div style={{fontSize:12, color:'var(--text-dim)', lineHeight:1.55, overflow:'hidden', display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical'}}>
                      {renderHL(snippetSrc)}
                    </div>
                  )}
                  <div style={{display:'flex', gap:8, flexWrap:'wrap', marginTop:8}}>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        openHitInChat(h);
                      }}
                    >
                      Ask Chat
                    </button>
                    {String(h.entity_id || '').trim() ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void toggleOwnerSummary(entityId);
                        }}
                      >
                        {summaryOpen ? 'Hide Summary' : 'Load Summary'}
                      </button>
                    ) : null}
                    {String(h.entity_id || '').trim() ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          openEntityContext(String(h.entity_id || ''));
                        }}
                      >
                        Entity Context
                      </button>
                    ) : null}
                    {nativeDetailDescriptor ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          openNativeDetailForEntityId(entityId);
                        }}
                      >
                        {nativeDetailDescriptor.label}
                      </button>
                    ) : null}
                  </div>
                  {summaryOpen ? (
                    <div
                      style={{
                        marginTop: 10,
                        padding: '10px 11px',
                        borderRadius: 10,
                        border: '1px solid var(--border)',
                        background: 'color-mix(in srgb, var(--surface-2) 70%, transparent)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                      }}
                    >
                      <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                        OWNER SUMMARY · {entityId}
                      </div>
                      {summaryLoading ? (
                        <div style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
                          Loading owner summary…
                        </div>
                      ) : inlineSummary ? (
                        <>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <span className="pill t-mono" style={{ fontSize: 10 }}>
                              fields {inlineSummary.summary.aiFieldCount}
                            </span>
                            <span className="pill t-mono" style={{ fontSize: 10 }}>
                              actions {inlineSummary.summary.actionCount}
                            </span>
                            <span className="pill t-mono" style={{ fontSize: 10 }}>
                              queue {inlineSummary.summary.queueArtifactCount}
                            </span>
                          </div>
                          {latestAction ? (
                            <div style={{ fontSize: 11.5, color: 'var(--text)', lineHeight: 1.5 }}>
                              Latest action: {latestAction.title} [{latestAction.status}]
                            </div>
                          ) : null}
                          {latestQueue ? (
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                              <div style={{ fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                                Latest queue: {String(latestQueue.payload?.title || latestQueue.id || 'Queued artifact')}
                              </div>
                                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                {latestQueue ? (
                                  <button
                                    type="button"
                                    className="btn btn-sm btn-ghost"
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      openQueueArtifactInActions({
                                        queueId: String(latestQueue.id || '').trim(),
                                        sourceActionId: latestQueueActionId || null,
                                        sourceAiFieldId: latestQueueAiFieldId,
                                        ownerEntityId: queueArtifactOwnerEntityId(latestQueue),
                                      });
                                    }}
                                  >
                                    Open queue item
                                  </button>
                                ) : null}
                                {latestQueueActionId ? (
                                  <button
                                    type="button"
                                    className="btn btn-sm btn-ghost"
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      focusActionTrace({ actionId: latestQueueActionId, aiFieldId: latestQueueAiFieldId, openAudit: false });
                                      (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('actions');
                                    }}
                                  >
                                    Open queued action
                                  </button>
                                ) : null}
                                {showLatestQueueNativeDetail && latestQueueNativeDetailDescriptor ? (
                                  <button
                                    type="button"
                                    className="btn btn-sm btn-ghost"
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      openNativeDetailForEntityId(latestQueueOwnerEntityId);
                                    }}
                                  >
                                    {latestQueueNativeDetailDescriptor.label}
                                  </button>
                                ) : null}
                              </div>
                            </div>
                          ) : null}
                          {latestAudit ? (
                            <div style={{ fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                              Latest audit: {latestAudit.detail || latestAudit.eventType || 'audit recorded'}
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <div style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
                          No owner summary available.
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              </label>
            );
          })
        )}
      </div>

      {selected.size > 0 && (
        <div className="card" style={{padding:14, display:'flex', gap:10, alignItems:'center', flexWrap:'wrap', borderColor:'var(--gold-dim)'}}>
          <span style={{fontSize:13, fontWeight:500}}>
            {selected.size} selected
          </span>
          <span style={{flex:1}}/>
          <select
            value={targetWorkspace}
            onChange={(e) => setTargetWorkspace(e.target.value)}
            disabled={busy}
            style={{
              padding:'6px 10px', borderRadius:8,
              border:'1px solid var(--border-hi)', background:'var(--surface)', color:'var(--text)',
              fontSize:12, fontFamily:'inherit',
            }}
          >
            <option value="">Choose workspace…</option>
            {visibleProjects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
            <option value="__new__">+ New workspace…</option>
            <option value="__unassign__">Unassign</option>
          </select>
          {targetWorkspace === '__new__' && (
            <input
              type="text"
              value={newDraft}
              onChange={(e) => setNewDraft(e.target.value)}
              placeholder="New workspace name"
              disabled={busy}
              style={{
                padding:'6px 10px', borderRadius:8,
                border:'1px solid var(--border-hi)', background:'var(--bg)', color:'var(--text)',
                fontSize:12, fontFamily:'inherit', width:180,
              }}
            />
          )}
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy || !targetWorkspace || (targetWorkspace === '__new__' && !newDraft.trim())}
            onClick={applyAssign}
            style={(busy || !targetWorkspace || (targetWorkspace === '__new__' && !newDraft.trim())) ? {opacity:0.55, cursor:'not-allowed'} : undefined}
          >
            {busy ? 'Applying…' : 'Apply'}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={busy}
            onClick={clearSelection}
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

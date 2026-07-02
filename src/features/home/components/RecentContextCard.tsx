import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/shared/icons';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';
import { ACTION_LAYER_REFRESH_EVENT } from '@/shared/context/action-layer-events';
import { focusEntity } from '@/shared/context/entity-focus';
import { focusAiField } from '@/shared/context/ai-field-focus';
import { focusActionTrace } from '@/shared/context/action-trace-focus';
import { openQueueArtifactInActions } from '@/shared/context/open-queue-artifact';
import {
  nativeDetailDescriptorForEntityId,
  openContextTarget,
  openNativeDetailForEntityId,
} from '@/shared/context/context-target-navigation';
import {
  queueArtifactDetail,
  queueArtifactNativeDetailState,
  queueArtifactOwnerEntityId,
  queueArtifactSourceActionId,
  queueArtifactTitle,
} from '@/shared/context/queue-artifact-meta';
import {
  buildActionChatSeed,
  buildEntityChatSeed,
  buildFieldChatSeed,
  openChatWithSeed,
} from '@/shared/context/chat-composer-seed';
import { normalizeContextActionType } from '@/shared/context/action-types';
import type { AiFieldRecord, ContextActionRecord, QueueArtifactRecord } from '@/shared/domain/context-layer';

interface RecentContextPayload {
  ownerEntityId?: string | null;
  recentAiFields?: { items?: AiFieldRecord[] | null; total?: number | null } | null;
  recentActions?: { items?: ContextActionRecord[] | null; total?: number | null } | null;
  recentQueueArtifacts?: { items?: QueueArtifactRecord[] | null; total?: number | null } | null;
  recentMeetings?: Array<Record<string, unknown>> | null;
}

interface ContextSearchPayload {
  timeline?: { hits?: Array<Record<string, unknown>> | null; total?: number | null } | null;
  aiFields?: { items?: AiFieldRecord[] | null; total?: number | null } | null;
  actions?: { items?: ContextActionRecord[] | null; total?: number | null } | null;
}

interface OwnerContextSummaryPayload {
  ownerEntityId: string;
  aiFields?: { items?: AiFieldRecord[] | null; total?: number | null } | null;
  actions?: { items?: ContextActionRecord[] | null; total?: number | null } | null;
  queueArtifacts?: { items?: Array<Record<string, unknown>> | null; total?: number | null } | null;
  latestAudits?: Array<{ actionId?: string | null; latestAudit?: Record<string, unknown> | null } | null> | null;
  summary?: {
    aiFieldCount?: number | null;
    actionCount?: number | null;
    queueArtifactCount?: number | null;
    actionStatusCounts?: Record<string, number | null> | null;
  } | null;
}

function normalizeActionRecord(item: ContextActionRecord): ContextActionRecord {
  return {
    ...item,
    actionType: normalizeContextActionType(item.actionType),
  };
}

function normalizeOwnerSummary(summary: OwnerContextSummaryPayload): OwnerContextSummaryPayload {
  return {
    ...summary,
    ...(summary.actions !== undefined
      ? {
          actions: summary.actions
            ? {
                ...summary.actions,
                items: (summary.actions.items || []).map(normalizeActionRecord),
              }
            : null,
        }
      : {}),
  };
}

function normalizeRecentContextPayload(payload: RecentContextPayload): RecentContextPayload {
  return {
    ...payload,
    ...(payload.recentActions !== undefined
      ? {
          recentActions: payload.recentActions
            ? {
                ...payload.recentActions,
                items: (payload.recentActions.items || []).map(normalizeActionRecord),
              }
            : null,
        }
      : {}),
  };
}

function normalizeContextSearchPayload(payload: ContextSearchPayload): ContextSearchPayload {
  return {
    ...payload,
    ...(payload.actions !== undefined
      ? {
          actions: payload.actions
            ? {
                ...payload.actions,
                items: (payload.actions.items || []).map(normalizeActionRecord),
              }
            : null,
        }
      : {}),
  };
}

function ownerSummaryPrimaryAiFieldId(summary: OwnerContextSummaryPayload | null | undefined): string | null {
  const id = String(summary?.aiFields?.items?.[0]?.id || '').trim();
  return id || null;
}

function recentPrimaryAiFieldId(
  entityId: string,
  aiFields: AiFieldRecord[],
  ownerSummaries: Record<string, OwnerContextSummaryPayload>,
): string | null {
  const normalized = String(entityId || '').trim();
  if (!normalized) return null;
  const summaryFieldId = ownerSummaryPrimaryAiFieldId(ownerSummaries[normalized]);
  if (summaryFieldId) return summaryFieldId;
  const direct = aiFields.find((item) => String(item.ownerEntityId || '').trim() === normalized);
  return String(direct?.id || '').trim() || null;
}

function extractEntityIds(payload: RecentContextPayload | null): string[] {
  if (!payload) return [];
  const ids = new Set<string>();
  const rootOwnerEntityId = String(payload.ownerEntityId || '').trim();
  if (rootOwnerEntityId) ids.add(rootOwnerEntityId);
  for (const item of payload.recentAiFields?.items || []) {
    const id = String(item?.ownerEntityId || '').trim();
    if (id) ids.add(id);
  }
  for (const item of payload.recentActions?.items || []) {
    const id = String(item?.ownerEntityId || '').trim();
    if (id) ids.add(id);
  }
  for (const item of payload.recentQueueArtifacts?.items || []) {
    const id = queueArtifactOwnerEntityId(item);
    if (id) ids.add(id);
  }
  for (const item of payload.recentMeetings || []) {
    const rawId = String(item?.id || '').trim();
    if (!rawId) continue;
    ids.add(rawId.startsWith('meeting:') ? rawId : `meeting:${rawId}`);
  }
  return Array.from(ids).slice(0, 6);
}

export function RecentContextCard(): JSX.Element | null {
  const [payload, setPayload] = useState<RecentContextPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<ContextSearchPayload | null>(null);
  const [ownerSummaries, setOwnerSummaries] = useState<Record<string, OwnerContextSummaryPayload>>({});
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    runRuntimeAction('context.recent.get', { limit: 6 }, { silentError: true })
      .then((res) => {
        if (cancelled) return;
        setPayload(
          res?.ok && res.data
            ? normalizeRecentContextPayload(res.data as RecentContextPayload)
            : null,
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshNonce]);

  useEffect(() => {
    const onRefresh = () => {
      setOwnerSummaries({});
      setRefreshNonce((prev) => prev + 1);
    };
    window.addEventListener(ACTION_LAYER_REFRESH_EVENT, onRefresh);
    return () => {
      window.removeEventListener(ACTION_LAYER_REFRESH_EVENT, onRefresh);
    };
  }, []);

  const entityIds = useMemo(() => extractEntityIds(payload), [payload]);
  const aiFields = payload?.recentAiFields?.items || [];
  const actions = payload?.recentActions?.items || [];
  const queueArtifacts = payload?.recentQueueArtifacts?.items || [];
  const meetings = payload?.recentMeetings || [];
  const hasSearchSession = Boolean(query.trim() || searching || searchResult);

  useEffect(() => {
    let cancelled = false;
    const targetEntityIds = entityIds.slice(0, 3);
    if (targetEntityIds.length === 0) {
      setOwnerSummaries({});
      return () => {
        cancelled = true;
      };
    }

    Promise.all(
      targetEntityIds.map(async (ownerEntityId) => {
        const res = await runRuntimeAction(
          'context.owner_summary.get',
          { ownerEntityId, limit: 4 },
          { silentError: true },
        );
        return [
          ownerEntityId,
          (res?.ok && res.data
            ? normalizeOwnerSummary(res.data as OwnerContextSummaryPayload)
            : null) as OwnerContextSummaryPayload | null,
        ] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next = entries.reduce<Record<string, OwnerContextSummaryPayload>>((acc, [ownerEntityId, summary]) => {
        if (summary) acc[ownerEntityId] = summary;
        return acc;
      }, {});
      setOwnerSummaries(next);
    });

    return () => {
      cancelled = true;
    };
  }, [entityIds, refreshNonce]);

  useEffect(() => {
    if (refreshNonce === 0) return;
    if (!query.trim()) return;
    void runSearch();
  }, [query, refreshNonce]);

  if (
    !loading &&
    !hasSearchSession &&
    entityIds.length === 0 &&
    aiFields.length === 0 &&
    actions.length === 0 &&
    queueArtifacts.length === 0 &&
    meetings.length === 0
  ) {
    return null;
  }

  const openEntityContext = (entityId: string) => {
    openContextTarget({ targetId: entityId });
  };

  const openNativeDetail = (entityId: string) => {
    openNativeDetailForEntityId(entityId);
  };

  const openScreen = (screen: 'ai_fields' | 'actions' | 'meetings') => {
    (window as any).SHOGUN_RUNTIME?.setActiveScreen?.(screen);
  };

  async function runSearch() {
    const nextQuery = query.trim();
    if (!nextQuery) {
      setSearchResult(null);
      return;
    }
    setSearching(true);
    const res = await runRuntimeAction(
      'context.search',
      { query: nextQuery, limit: 4 },
      { silentError: true },
    );
    setSearching(false);
    setSearchResult(
      res?.ok && res.data
        ? normalizeContextSearchPayload(res.data as ContextSearchPayload)
        : null,
    );
  }

  const openAiField = (fieldId: string) => {
    const id = String(fieldId || '').trim();
    if (!id) return;
    focusAiField(id);
    openScreen('ai_fields');
  };

  const openOwnerAiFields = (entityId: string, fieldId?: string | null) => {
    const ownerId = String(entityId || '').trim();
    if (ownerId) focusEntity(ownerId);
    const id = String(fieldId || '').trim();
    if (id) focusAiField(id);
    openScreen('ai_fields');
  };

  const openAction = (actionId: string, openAudit = false, aiFieldId?: string | null) => {
    const id = String(actionId || '').trim();
    if (!id) return;
    focusActionTrace({ actionId: id, aiFieldId: String(aiFieldId || '').trim() || null, openAudit });
    openScreen('actions');
  };

  const openQueueArtifact = (item: QueueArtifactRecord | Record<string, unknown> | null | undefined) => {
    const queueId = String((item as any)?.id || '').trim();
    if (!queueId) return;
    openQueueArtifactInActions({
      queueId,
      sourceActionId: queueArtifactSourceActionId(item),
      sourceAiFieldId: String((item as any)?.payload?.source_ai_field_id || '').trim() || null,
      ownerEntityId: queueArtifactOwnerEntityId(item),
    });
  };

  const openOwnerSummaryAction = (summary: OwnerContextSummaryPayload) => {
    const actionId = String(summary.actions?.items?.[0]?.id || '').trim();
    if (actionId) {
      openAction(actionId, false, summary.actions?.items?.[0]?.sourceAiFieldId || ownerSummaryPrimaryAiFieldId(summary));
      return;
    }
    openScreen('actions');
  };

  const openOwnerSummaryAudit = (summary: OwnerContextSummaryPayload) => {
    const actionId = String(summary.actions?.items?.[0]?.id || '').trim();
    if (actionId) {
      openAction(actionId, true, summary.actions?.items?.[0]?.sourceAiFieldId || ownerSummaryPrimaryAiFieldId(summary));
      return;
    }
    openScreen('actions');
  };

  const askChatAboutEntity = (entityId: string) => {
    const summary = ownerSummaries[entityId];
    const field =
      aiFields.find((item) => item.ownerEntityId === entityId)
      || searchedAiFields.find((item) => item.ownerEntityId === entityId)
      || summary?.aiFields?.items?.[0]
      || null;
    const action =
      actions.find((item) => item.ownerEntityId === entityId)
      || searchedActions.find((item) => item.ownerEntityId === entityId)
      || summary?.actions?.items?.[0]
      || null;
    const queueTitle = summary?.queueArtifacts?.items?.[0]
      ? String((summary.queueArtifacts.items[0] as any)?.payload?.title || (summary.queueArtifacts.items[0] as any)?.id || '').trim()
      : '';
    openChatWithSeed(buildEntityChatSeed({
      entityId,
      entityLabel: entityId,
      fieldLabel: field ? `${field.fieldName} = ${field.currentValue || '(empty)'}` : null,
      actionLabel: action ? `${action.title} [${action.status}]` : (queueTitle || null),
    }));
  };

  const askChatAboutField = (item: AiFieldRecord) => {
    openChatWithSeed(buildFieldChatSeed({
      ownerEntityId: item.ownerEntityId,
      fieldName: item.fieldName,
      currentValue: item.currentValue,
      instruction: item.instruction,
      evidenceIds: item.evidenceEventIds,
    }));
  };

  const askChatAboutAction = (item: ContextActionRecord) => {
    openChatWithSeed(buildActionChatSeed({
      ownerEntityId: item.ownerEntityId,
      title: item.title,
      actionType: item.actionType,
      status: item.status,
      riskLevel: item.riskLevel,
      detail: item.detail,
    }));
  };

  const askChatAboutQueueArtifact = (item: QueueArtifactRecord) => {
    const entityId = queueArtifactOwnerEntityId(item);
    if (!entityId) return;
    openChatWithSeed(buildEntityChatSeed({
      entityId,
      entityLabel: entityId,
      fieldLabel: null,
      actionLabel: queueArtifactTitle(item),
    }));
  };

  const meetingIdFor = (item: Record<string, unknown> | null | undefined): string => {
    const rawId = String(item?.id || '').trim();
    if (rawId.startsWith('meeting:')) return rawId.slice('meeting:'.length);
    return rawId;
  };

  const meetingEntityIdFor = (item: Record<string, unknown> | null | undefined): string => {
    const meetingId = meetingIdFor(item);
    return meetingId ? `meeting:${meetingId}` : '';
  };

  const askChatAboutMeeting = (item: Record<string, unknown> | null | undefined) => {
    const meetingEntityId = meetingEntityIdFor(item);
    if (!meetingEntityId) return;
    const title = String(item?.title || item?.meeting_title || meetingEntityId).trim();
    openChatWithSeed(buildEntityChatSeed({
      entityId: meetingEntityId,
      entityLabel: title || meetingEntityId,
      fieldLabel: null,
      actionLabel: null,
    }));
  };

  const askChatAboutSearch = () => {
    const nextQuery = query.trim();
    if (!nextQuery) return;
    openChatWithSeed({
      text: `${nextQuery} に関する shared context を整理してください。必要なら次の一手も提案してください。`,
      assembleMemory: true,
      memoryAssemblyQuery: nextQuery,
      memoryAssemblyLimit: 14,
      memoryAssemblySemantic: true,
    });
  };

  const timelineHits = searchResult?.timeline?.hits || [];
  const searchedAiFields = searchResult?.aiFields?.items || [];
  const searchedActions = searchResult?.actions?.items || [];
  const hasSearchResults =
    timelineHits.length > 0 || searchedAiFields.length > 0 || searchedActions.length > 0;

  return (
    <div className="card" style={{ width: '100%', maxWidth: 760, marginInline: 'auto', padding: 24, marginTop: 18, background: 'var(--surface)', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="row" style={{ alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div className="t-mono gold" style={{ textTransform: 'none', letterSpacing: '0.02em' }}>
          <span className="en-only">Recent shared context</span>
          <span className="jp">最近の共有コンテキスト</span>
        </div>
        <span className="pill t-mono" style={{ fontSize: 10 }}>
          Home / Context Platform
        </span>
        <span className="spacer" />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => openScreen('ai_fields')}>
            AI Fields
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => openScreen('actions')}>
            Actions
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => openScreen('meetings')}>
            Meetings
          </button>
        </div>
      </div>

      <div style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.6 }}>
        CRM や Meeting 専用の別データではなく、shared core から最近の entity / field / action / meeting を横断的に見ています。
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-mute)', letterSpacing: '0.12em' }}>
          SEARCH CONTEXT
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void runSearch();
              }
            }}
            placeholder="budget / blocker / Apollo / investor concern"
            className="s-input"
            style={{ flex: 1 }}
          />
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => void runSearch()}>
            Search
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={askChatAboutSearch} disabled={!query.trim()}>
            Ask Chat
          </button>
        </div>
        {searching ? (
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Searching shared context…</div>
        ) : null}
        {!searching && query.trim() && searchResult && !hasSearchResults ? (
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>No shared context matched this query.</div>
        ) : null}
        {hasSearchResults ? (
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-mute)', letterSpacing: '0.12em' }}>
                TIMELINE
              </div>
              {timelineHits.slice(0, 3).map((item: any, index) => (
                (() => {
                  const targetId = String(item?.targetId || '').trim();
                  const nativeDetailDescriptor = nativeDetailDescriptorForEntityId(targetId);
                  return (
                    <div key={String(item?.targetId || item?.id || index)} style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface-2)' }}>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>
                        {String(item?.title || item?.targetId || item?.id || 'Timeline hit')}
                      </div>
                      {Array.isArray(item?.keyPoints) && item.keyPoints[0] ? (
                        <div style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 6, lineHeight: 1.5 }}>
                          {String(item.keyPoints[0])}
                        </div>
                      ) : null}
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => {
                            openContextTarget({
                              targetId: item?.targetId,
                              targetKind: item?.targetKind,
                              title: item?.title,
                            });
                          }}
                        >
                          Open
                        </button>
                        {targetId ? (
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => openEntityContext(targetId)}
                          >
                            Entity Context
                          </button>
                        ) : null}
                        {targetId && nativeDetailDescriptor ? (
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => openNativeDetail(targetId)}
                          >
                            {nativeDetailDescriptor.label}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => {
                            if (targetId) askChatAboutEntity(targetId);
                          }}
                          disabled={!targetId}
                        >
                          Ask Chat
                        </button>
                      </div>
                    </div>
                  );
                })()
              ))}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-mute)', letterSpacing: '0.12em' }}>
                MATCHED FIELDS
              </div>
              {searchedAiFields.slice(0, 3).map((item) => (
                <div
                  key={item.id}
                  style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface-2)', textAlign: 'left', color: 'var(--text)' }}
                >
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{item.fieldName}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 3 }}>{item.ownerEntityId}</div>
                  {item.currentValue ? (
                    <div style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 6, lineHeight: 1.5 }}>
                      {item.currentValue}
                    </div>
                  ) : null}
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => openAiField(item.id)}>
                      Open
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => askChatAboutField(item)}>
                      Ask Chat
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-mute)', letterSpacing: '0.12em' }}>
                MATCHED ACTIONS
              </div>
              {searchedActions.slice(0, 3).map((item) => (
                <div
                  key={item.id}
                  style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface-2)', textAlign: 'left', color: 'var(--text)' }}
                >
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{item.title}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 3 }}>
                    {item.status} · {item.ownerEntityId}
                  </div>
                  {item.detail ? (
                    <div style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 6, lineHeight: 1.5 }}>
                      {item.detail}
                    </div>
                  ) : null}
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => openAction(item.id, false, item.sourceAiFieldId || ownerSummaryPrimaryAiFieldId(ownerSummaries[item.ownerEntityId]))}
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => openAction(item.id, true, item.sourceAiFieldId || ownerSummaryPrimaryAiFieldId(ownerSummaries[item.ownerEntityId]))}
                    >
                      Audit
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => askChatAboutAction(item)}>
                      Ask Chat
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {loading ? (
        <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Loading recent context…</div>
      ) : null}

      {entityIds.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-mute)', letterSpacing: '0.12em' }}>
            ENTITIES
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {entityIds.map((entityId) => (
              <div
                key={entityId}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <button
                  type="button"
                  onClick={() => openEntityContext(entityId)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    height: 30,
                    padding: '0 10px',
                    borderRadius: 999,
                    border: '1px solid var(--border-hi)',
                    background: 'var(--surface-2)',
                    color: 'var(--text)',
                    fontSize: 11.5,
                  }}
                >
                  <Icon name="memory" size={12} />
                  {entityId}
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => askChatAboutEntity(entityId)}>
                  Ask Chat
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {Object.keys(ownerSummaries).length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-mute)', letterSpacing: '0.12em' }}>
            OWNER SUMMARIES
          </div>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            {entityIds.slice(0, 3).map((entityId) => {
              const summary = ownerSummaries[entityId];
              if (!summary) return null;
              const latestAction = summary.actions?.items?.[0] || null;
              const latestQueue = summary.queueArtifacts?.items?.[0] as Record<string, unknown> | null | undefined;
              const latestAudit = summary.latestAudits?.find((item) => item?.latestAudit)?.latestAudit || null;
              const latestQueueActionId = queueArtifactSourceActionId(latestQueue);
              const {
                ownerEntityId: latestQueueOwnerEntityId,
                nativeDetailDescriptor: latestQueueNativeDetailDescriptor,
                showNativeDetail: showLatestQueueNativeDetail,
              } = queueArtifactNativeDetailState(latestQueue, {
                currentEntityId: entityId,
              });
              const actionCounts = summary.summary?.actionStatusCounts || {};
              const executedCount = Number(actionCounts.executed || 0);
              const approvedCount = Number(actionCounts.approved || 0);
              const proposedCount = Number(actionCounts.proposed || 0);
              const nativeDetailDescriptor = nativeDetailDescriptorForEntityId(entityId);

              return (
                <div
                  key={entityId}
                  style={{ padding: '14px 14px 12px', border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface-2)', display: 'flex', flexDirection: 'column', gap: 10 }}
                >
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700 }}>{entityId}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4, lineHeight: 1.5 }}>
                      Fields {Number(summary.summary?.aiFieldCount || 0)} · Actions {Number(summary.summary?.actionCount || 0)} · Queue {Number(summary.summary?.queueArtifactCount || 0)}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 4, lineHeight: 1.5 }}>
                      Proposed {proposedCount} · Approved {approvedCount} · Executed {executedCount}
                    </div>
                  </div>

                  {latestAction ? (
                    <div style={{ fontSize: 11, color: 'var(--text)', lineHeight: 1.5 }}>
                      Latest action: {latestAction.title} [{latestAction.status}]
                    </div>
                  ) : null}
                  {latestQueue ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                      <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                        Latest queue: {String((latestQueue.payload as any)?.title || latestQueue.id || 'Queued item')}
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {latestQueue ? (
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => openQueueArtifact(latestQueue)}
                          >
                            Open queue item
                          </button>
                        ) : null}
                        {latestQueueActionId ? (
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => openAction(latestQueueActionId, false)}
                          >
                            Open queued action
                          </button>
                        ) : null}
                        {showLatestQueueNativeDetail && latestQueueNativeDetailDescriptor ? (
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => openNativeDetail(latestQueueOwnerEntityId)}
                          >
                            {latestQueueNativeDetailDescriptor.label}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                  {latestAudit ? (
                    <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                      Latest audit: {String(latestAudit.detail || latestAudit.eventType || 'audit recorded')}
                    </div>
                  ) : null}

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => openEntityContext(entityId)}>
                      Entity Context
                    </button>
                    {nativeDetailDescriptor ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => openNativeDetail(entityId)}
                      >
                        {nativeDetailDescriptor.label}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => openOwnerAiFields(entityId, summary.aiFields?.items?.[0]?.id)}
                    >
                      AI Fields
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => openOwnerSummaryAction(summary)}>
                      Actions
                    </button>
                    {latestAudit ? (
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => openOwnerSummaryAudit(summary)}>
                        Open Audit
                      </button>
                    ) : null}
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => askChatAboutEntity(entityId)}>
                      Ask Chat
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-mute)', letterSpacing: '0.12em' }}>
            AI FIELDS
          </div>
          {aiFields.slice(0, 3).map((item) => (
            <div key={item.id} style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface-2)' }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{item.fieldName}</div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 3 }}>{item.ownerEntityId}</div>
              {item.currentValue ? (
                <div style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 6, lineHeight: 1.5 }}>
                  {item.currentValue}
                </div>
              ) : null}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => openAiField(item.id)}>
                  Open
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => askChatAboutField(item)}>
                  Ask Chat
                </button>
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-mute)', letterSpacing: '0.12em' }}>
            ACTIONS
          </div>
          {actions.slice(0, 3).map((item) => (
            <div key={item.id} style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface-2)' }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{item.title}</div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 3 }}>
                {item.status} · {item.ownerEntityId}
              </div>
              {item.detail ? (
                <div style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 6, lineHeight: 1.5 }}>
                  {item.detail}
                </div>
              ) : null}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => openAction(item.id, false)}>
                  Open
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => openAction(item.id, true)}>
                  Audit
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => askChatAboutAction(item)}>
                  Ask Chat
                </button>
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-mute)', letterSpacing: '0.12em' }}>
            QUEUE ARTIFACTS
          </div>
          {queueArtifacts.slice(0, 3).map((item) => {
            const ownerEntityId = queueArtifactOwnerEntityId(item);
            const sourceActionId = queueArtifactSourceActionId(item);
            const nativeDetailDescriptor = nativeDetailDescriptorForEntityId(ownerEntityId);
            return (
              <div key={item.id} style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface-2)' }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>{queueArtifactTitle(item)}</div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 3 }}>
                  {ownerEntityId || item.id}
                </div>
                {queueArtifactDetail(item) ? (
                  <div style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 6, lineHeight: 1.5 }}>
                    {queueArtifactDetail(item)}
                  </div>
                ) : null}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  {sourceActionId ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => openAction(sourceActionId, false, recentPrimaryAiFieldId(ownerEntityId, aiFields, ownerSummaries))}
                    >
                      Open Action
                    </button>
                  ) : null}
                  {ownerEntityId ? (
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => openEntityContext(ownerEntityId)}>
                      Context
                    </button>
                  ) : null}
                  {ownerEntityId && nativeDetailDescriptor ? (
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => openNativeDetail(ownerEntityId)}>
                      {nativeDetailDescriptor.label}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => askChatAboutQueueArtifact(item)}
                    disabled={!ownerEntityId}
                  >
                    Ask Chat
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-mute)', letterSpacing: '0.12em' }}>
            MEETINGS
          </div>
          {meetings.slice(0, 3).map((item: any, index) => (
            <div key={String(item?.id || index)} style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface-2)' }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{String(item?.title || item?.meeting_title || item?.id || 'Meeting')}</div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 3 }}>
                {String(item?.started_at || item?.created_at || item?.updated_at || '').slice(0, 19) || 'recent'}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => openNativeDetail(meetingEntityIdFor(item))}
                  disabled={!meetingEntityIdFor(item)}
                >
                  Open
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => openEntityContext(meetingEntityIdFor(item))}
                  disabled={!meetingEntityIdFor(item)}
                >
                  Context
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => askChatAboutMeeting(item)}
                  disabled={!meetingEntityIdFor(item)}
                >
                  Ask Chat
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

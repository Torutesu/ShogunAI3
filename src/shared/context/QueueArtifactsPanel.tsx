import { useEffect, useRef, useState } from 'react';
import { ACTION_LAYER_REFRESH_EVENT } from '@/shared/context/action-layer-events';
import { dispatchActionLayerRefresh } from '@/shared/context/action-layer-events';
import { buildEntityChatSeed, openChatWithSeed } from '@/shared/context/chat-composer-seed';
import { Icon } from '@/shared/icons';
import {
  nativeDetailDescriptorForEntityId,
  openEvidenceReference,
  openContextTarget,
  openNativeDetailForEntityId,
} from '@/shared/context/context-target-navigation';
import {
  queueArtifactAuditDetailFromSources,
  queueArtifactDetail,
  queueArtifactOwnerEntityId,
  queueArtifactSourceActionId,
  queueArtifactTitle,
} from '@/shared/context/queue-artifact-meta';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';

interface QueueRow {
  id: string;
  createdAt: number;
  payload?: Record<string, unknown>;
}

interface QueueRowProvenance {
  sourceAction: {
    id: string;
    status: string;
    riskLevel: string;
    title: string;
    detail: string;
    sourceAiFieldId: string;
  } | null;
  latestAudit: {
    eventType: string;
    detail: string;
  } | null;
}

function normalizeEvidenceIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
}

function formatWhen(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'unknown';
  return new Date(value).toLocaleString();
}

function nativeDetailLabelForEvidenceId(evidenceId: string): string | null {
  return nativeDetailDescriptorForEntityId(evidenceId)?.label || null;
}

function queueKindLabel(title: string): 'task' | 'CRM update' {
  return title.toLowerCase().includes('crm') ? 'CRM update' : 'task';
}

function matchesFocus(
  item: QueueRow,
  focusQueueId?: string | null | undefined,
  focusSourceActionId?: string | null | undefined,
  focusOwnerEntityId?: string | null | undefined,
): boolean {
  const queueId = String(focusQueueId || '').trim();
  const sourceActionId = String(focusSourceActionId || '').trim();
  const ownerEntityId = String(focusOwnerEntityId || '').trim();
  return Boolean(
    (queueId && item.id === queueId)
      || (sourceActionId && queueArtifactSourceActionId(item) === sourceActionId)
      || (ownerEntityId && queueArtifactOwnerEntityId(item) === ownerEntityId),
  );
}

function QueueList({
  title,
  items,
  provenanceByRowId,
  empty,
  accent,
  removeAction,
  retryAction,
  onRemove,
  onInspectAction,
  onInspectActionAudit,
  onInspectAiField,
  focusQueueId,
  focusSourceActionId,
  focusOwnerEntityId,
}: {
  title: string;
  items: QueueRow[];
  provenanceByRowId: Record<string, QueueRowProvenance | undefined>;
  empty: string;
  accent: string;
  removeAction: string;
  retryAction: string;
  onRemove: () => Promise<void>;
  onInspectAction: ((actionId: string, aiFieldId?: string | null) => void) | undefined;
  onInspectActionAudit: ((actionId: string, aiFieldId?: string | null) => void) | undefined;
  onInspectAiField: ((aiFieldId: string) => void) | undefined;
  focusQueueId?: string | null | undefined;
  focusSourceActionId?: string | null | undefined;
  focusOwnerEntityId?: string | null | undefined;
}): JSX.Element {
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const kindLabel = queueKindLabel(title);

  useEffect(() => {
    const queueId = String(focusQueueId || '').trim();
    const sourceActionId = String(focusSourceActionId || '').trim();
    const ownerEntityId = String(focusOwnerEntityId || '').trim();
    if (!queueId && !sourceActionId && !ownerEntityId) return;
    const target = items.find((item) => (
      (queueId && item.id === queueId)
      || (sourceActionId && queueArtifactSourceActionId(item) === sourceActionId)
      || (ownerEntityId && queueArtifactOwnerEntityId(item) === ownerEntityId)
    ));
    if (!target) return;
    const node = itemRefs.current[target.id];
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [focusOwnerEntityId, focusQueueId, focusSourceActionId, items]);

  const openEntityContext = (entityId: string) => {
    const id = String(entityId || '').trim();
    if (!id) return;
    openContextTarget({ targetId: id });
  };

  const openNativeOwnerDetail = (entityId: string) => {
    const id = String(entityId || '').trim();
    if (!id) return;
    openNativeDetailForEntityId(id);
  };

  const askChatAboutQueueItem = (item: QueueRow) => {
    const entityId = queueArtifactOwnerEntityId(item);
    if (!entityId) return;
    openChatWithSeed(buildEntityChatSeed({
      entityId,
      entityLabel: entityId,
      actionLabel: queueArtifactTitle(item) || null,
    }));
  };

  const removeItem = async (id: string) => {
    const res = await runRuntimeAction(removeAction, { id }, { silentError: true });
    if (!res?.ok) {
      (window as any).SHOGUN_RUNTIME?.pushToast?.(res?.error?.message || `${kindLabel} queue item を削除できませんでした`, 'error');
      return;
    }
    (window as any).SHOGUN_RUNTIME?.pushToast?.(`${kindLabel} queue item を削除しました`, 'success');
    dispatchActionLayerRefresh(removeAction);
    await onRemove();
  };

  const retryItem = async (id: string) => {
    const res = await runRuntimeAction(retryAction, { id }, { silentError: true });
    if (!res?.ok) {
      (window as any).SHOGUN_RUNTIME?.pushToast?.(res?.error?.message || `${kindLabel} queue item を再投入できませんでした`, 'error');
      return;
    }
    (window as any).SHOGUN_RUNTIME?.pushToast?.(`${kindLabel} queue item を再投入しました`, 'success');
    dispatchActionLayerRefresh(retryAction);
    await onRemove();
  };

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 18,
        padding: 14,
        background: 'color-mix(in srgb, var(--surface-2) 68%, transparent)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
        <div className="t-mono" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
          {items.length} loaded
        </div>
      </div>
      {items.length === 0 ? (
        <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--text-dim)' }}>
          {empty}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((item) => (
            (() => {
              const provenance = provenanceByRowId[item.id];
              const ownerEntityId = queueArtifactOwnerEntityId(item);
              const sourceActionId = queueArtifactSourceActionId(item);
              const focusedAiFieldId = String(
                item.payload?.source_ai_field_id
                || provenance?.sourceAction?.sourceAiFieldId
                || '',
              ).trim();
              const isFocused = matchesFocus(item, focusQueueId, focusSourceActionId, focusOwnerEntityId);
              const ownerNativeDetailLabel = ownerEntityId
                ? nativeDetailDescriptorForEntityId(ownerEntityId)?.label || null
                : null;
              return (
                <div
                  key={item.id}
                  ref={(node) => {
                    itemRefs.current[item.id] = node;
                  }}
                  style={{
                    borderRadius: 12,
                    padding: '10px 11px',
                    background: 'var(--surface)',
                    border: isFocused
                      ? '1px solid color-mix(in srgb, var(--gold) 72%, var(--border-hi))'
                      : `1px solid ${accent}`,
                    boxShadow: isFocused
                      ? '0 0 0 1px color-mix(in srgb, var(--gold) 18%, transparent)'
                      : 'none',
                  }}
                >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <div className="t-mono" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>{item.id}</div>
                <div className="t-mono" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>{formatWhen(item.createdAt)}</div>
              </div>
              <div style={{ marginTop: 6, fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>
                {queueArtifactTitle(item)}
              </div>
              {queueArtifactDetail(item) ? (
                <div style={{ marginTop: 4, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-dim)' }}>
                  {queueArtifactDetail(item)}
                </div>
              ) : null}
              {ownerEntityId ? (
                <div className="t-mono" style={{ marginTop: 6, fontSize: 10.5, color: 'var(--text-dim)' }}>
                  {ownerEntityId}
                </div>
              ) : null}
              {sourceActionId ? (
                <div style={{ marginTop: 6 }}>
                  <button
                    type="button"
                    onClick={() => onInspectAction?.(sourceActionId, focusedAiFieldId || null)}
                    style={{
                      padding: 0,
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--text-dim)',
                      fontSize: 10.5,
                      fontFamily: 'inherit',
                      cursor: 'pointer',
                    }}
                    className="t-mono"
                  >
                    action {sourceActionId}
                  </button>
                  {provenance?.sourceAction ? (
                    <div style={{ marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span className="pill t-mono" style={{ fontSize: 10 }}>
                        {provenance.sourceAction.status}
                      </span>
                      <span className="t-mono" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
                        risk {provenance.sourceAction.riskLevel}
                      </span>
                    </div>
                  ) : null}
                  {queueArtifactAuditDetailFromSources(item, provenance) ? (
                    <div style={{ marginTop: 4, fontSize: 11, lineHeight: 1.45, color: 'var(--text-dim)' }}>
                      {queueArtifactAuditDetailFromSources(item, provenance)}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {isFocused && (provenance?.sourceAction || provenance?.latestAudit) ? (
                <div
                  style={{
                    marginTop: 8,
                    padding: '9px 10px',
                    borderRadius: 10,
                    border: '1px solid color-mix(in srgb, var(--gold) 36%, var(--border-hi))',
                    background: 'color-mix(in srgb, var(--gold) 8%, var(--surface-2))',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-dim)', letterSpacing: '0.08em' }}>
                    FOCUSED PROVENANCE
                  </div>
                  {provenance?.sourceAction ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>
                        Source action: {provenance.sourceAction.title || provenance.sourceAction.id}
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        <span className="pill t-mono" style={{ fontSize: 10 }}>
                          {provenance.sourceAction.status}
                        </span>
                        <span className="t-mono" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
                          risk {provenance.sourceAction.riskLevel}
                        </span>
                      </div>
                      {provenance.sourceAction.detail ? (
                        <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-dim)' }}>
                          {provenance.sourceAction.detail}
                        </div>
                      ) : null}
                      {focusedAiFieldId ? (
                        <div>
                          <button
                            type="button"
                            onClick={() => onInspectAiField?.(focusedAiFieldId)}
                            style={{
                              padding: 0,
                              border: 'none',
                              background: 'transparent',
                              color: 'var(--text-dim)',
                              fontSize: 10.5,
                              fontFamily: 'inherit',
                              cursor: 'pointer',
                            }}
                            className="t-mono"
                          >
                            ai_field {focusedAiFieldId}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {provenance?.latestAudit ? (
                    <div style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-dim)' }}>
                      Latest audit: {provenance.latestAudit.detail || provenance.latestAudit.eventType}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {item.payload?.source_ai_field_id ? (
                <div style={{ marginTop: 4 }}>
                  <button
                    type="button"
                    onClick={() => onInspectAiField?.(String(item.payload?.source_ai_field_id || ''))}
                    style={{
                      padding: 0,
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--text-dim)',
                      fontSize: 10.5,
                      fontFamily: 'inherit',
                      cursor: 'pointer',
                    }}
                    className="t-mono"
                  >
                    ai_field {String(item.payload.source_ai_field_id)}
                  </button>
                </div>
              ) : null}
              {item.payload?.retried_from ? (
                <div className="t-mono" style={{ marginTop: 4, fontSize: 10.5, color: 'var(--text-dim)' }}>
                  retried from {String(item.payload.retried_from)}
                </div>
              ) : null}
              {normalizeEvidenceIds(item.payload?.evidence_event_ids).length ? (
                <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {normalizeEvidenceIds(item.payload?.evidence_event_ids).map((evidenceId) => (
                    <div key={evidenceId} style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        onClick={() => {
                          openEvidenceReference({
                            id: evidenceId,
                            title: String(item.payload?.title || ''),
                          });
                        }}
                        style={{
                          padding: '3px 8px',
                          borderRadius: 999,
                          border: '1px solid var(--border-hi)',
                          background: 'color-mix(in srgb, var(--surface-2) 76%, transparent)',
                          color: 'var(--text-dim)',
                          fontSize: 10.5,
                          fontFamily: 'inherit',
                          cursor: 'pointer',
                        }}
                        className="t-mono"
                      >
                        evidence {evidenceId}
                      </button>
                      {nativeDetailLabelForEvidenceId(evidenceId) ? (
                        <button
                          type="button"
                          onClick={() => {
                            openNativeDetailForEntityId(evidenceId);
                          }}
                          style={{
                            padding: '3px 8px',
                            borderRadius: 999,
                            border: '1px solid var(--border-hi)',
                            background: 'color-mix(in srgb, var(--gold) 10%, var(--surface-2))',
                            color: 'var(--text)',
                            fontSize: 10.5,
                            fontFamily: 'inherit',
                            cursor: 'pointer',
                          }}
                        >
                          {nativeDetailLabelForEvidenceId(evidenceId)}
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                {ownerEntityId ? (
                  <button
                    type="button"
                    onClick={() => openEntityContext(ownerEntityId)}
                    style={{
                      height: 26,
                      padding: '0 8px',
                      borderRadius: 8,
                      border: '1px solid var(--border-hi)',
                      background: 'var(--surface-2)',
                      color: 'var(--text)',
                      fontSize: 11,
                    }}
                  >
                    Entity
                  </button>
                ) : null}
                {ownerNativeDetailLabel ? (
                  <button
                    type="button"
                    onClick={() => openNativeOwnerDetail(ownerEntityId)}
                    style={{
                      height: 26,
                      padding: '0 8px',
                      borderRadius: 8,
                      border: '1px solid color-mix(in srgb, var(--gold) 45%, var(--border-hi))',
                      background: 'color-mix(in srgb, var(--gold) 10%, var(--surface-2))',
                      color: 'var(--text)',
                      fontSize: 11,
                    }}
                  >
                    {ownerNativeDetailLabel}
                  </button>
                ) : null}
                {ownerEntityId ? (
                  <button
                    type="button"
                    onClick={() => askChatAboutQueueItem(item)}
                    style={{
                      height: 26,
                      padding: '0 8px',
                      borderRadius: 8,
                      border: '1px solid var(--border-hi)',
                      background: 'var(--surface-2)',
                      color: 'var(--text)',
                      fontSize: 11,
                    }}
                  >
                    Ask Chat
                  </button>
                ) : null}
                {sourceActionId ? (
                  <button
                    type="button"
                    onClick={() => onInspectActionAudit?.(sourceActionId, focusedAiFieldId || null)}
                    style={{
                      height: 26,
                      padding: '0 8px',
                      borderRadius: 8,
                      border: '1px solid var(--border-hi)',
                      background: 'var(--surface-2)',
                      color: 'var(--text)',
                      fontSize: 11,
                    }}
                  >
                    Open audit
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => { void retryItem(item.id); }}
                  style={{
                    height: 26,
                    padding: '0 8px',
                    borderRadius: 8,
                    border: '1px solid color-mix(in srgb, var(--gold) 55%, var(--border-hi))',
                    background: 'color-mix(in srgb, var(--gold) 10%, var(--surface-2))',
                    color: 'var(--text)',
                    fontSize: 11,
                  }}
                >
                  Retry
                </button>
                <button
                  type="button"
                  onClick={() => { void removeItem(item.id); }}
                  style={{
                    height: 26,
                    padding: '0 8px',
                    borderRadius: 8,
                    border: '1px solid var(--border-hi)',
                    background: 'var(--surface-2)',
                    color: 'var(--text)',
                    fontSize: 11,
                  }}
                >
                  Remove
                </button>
              </div>
                </div>
              );
            })()
          ))}
        </div>
      )}
    </div>
  );
}

export function QueueArtifactsPanel({
  onInspectAction,
  onInspectActionAudit,
  onInspectAiField,
  focusQueueId,
  focusSourceActionId,
  focusSourceAiFieldId,
  focusOwnerEntityId,
  onClearFocus,
}: {
  onInspectAction?: (actionId: string, aiFieldId?: string | null) => void;
  onInspectActionAudit?: (actionId: string, aiFieldId?: string | null) => void;
  onInspectAiField?: (aiFieldId: string) => void;
  focusQueueId?: string | null | undefined;
  focusSourceActionId?: string | null | undefined;
  focusSourceAiFieldId?: string | null | undefined;
  focusOwnerEntityId?: string | null | undefined;
  onClearFocus?: () => void;
}): JSX.Element {
  const [loading, setLoading] = useState(true);
  const [taskItems, setTaskItems] = useState<QueueRow[]>([]);
  const [crmItems, setCrmItems] = useState<QueueRow[]>([]);
  const [provenanceByRowId, setProvenanceByRowId] = useState<Record<string, QueueRowProvenance>>({});

  const load = async () => {
    setLoading(true);
    const [tasks, crm] = await Promise.all([
      runRuntimeAction('queue.tasks.list', { limit: 8 }, { silentError: true }),
      runRuntimeAction('queue.crm_updates.list', { limit: 8 }, { silentError: true }),
    ]);
    setTaskItems(tasks?.ok && Array.isArray(tasks.data?.items) ? (tasks.data.items as QueueRow[]) : []);
    setCrmItems(crm?.ok && Array.isArray(crm.data?.items) ? (crm.data.items as QueueRow[]) : []);
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    const rows = [...taskItems, ...crmItems];
    const sourceActionIds = rows
      .map((item) => ({
        rowId: item.id,
        actionId: queueArtifactSourceActionId(item),
      }))
      .filter((item) => item.actionId);
    if (sourceActionIds.length === 0) {
      setProvenanceByRowId({});
      return;
    }

    let cancelled = false;
    const loadProvenance = async () => {
      const next: Record<string, QueueRowProvenance> = {};
      await Promise.all(
        sourceActionIds.map(async ({ rowId, actionId }) => {
          const [actionRes, auditRes] = await Promise.all([
            runRuntimeAction('action.list', { id: actionId, limit: 1 }, { silentError: true }),
            runRuntimeAction('action.audit_list', { actionId, limit: 1 }, { silentError: true }),
          ]);
          const action = actionRes?.ok && Array.isArray(actionRes.data?.items) ? actionRes.data.items[0] : null;
          const audit = auditRes?.ok && Array.isArray(auditRes.data?.items) ? auditRes.data.items[0] : null;
          next[rowId] = {
                sourceAction: action
              ? {
                  id: String(action.id || actionId),
                  status: String(action.status || ''),
                  riskLevel: String(action.riskLevel || ''),
                  title: String(action.title || ''),
                  detail: String(action.detail || ''),
                  sourceAiFieldId: String(action.sourceAiFieldId || ''),
                }
              : null,
            latestAudit: audit
              ? {
                  eventType: String(audit.eventType || ''),
                  detail: String(audit.detail || ''),
                }
              : null,
          };
        }),
      );
      if (!cancelled) setProvenanceByRowId(next);
    };

    void loadProvenance();
    return () => {
      cancelled = true;
    };
  }, [crmItems, taskItems]);

  useEffect(() => {
    const onRefresh = () => {
      void load();
    };
    window.addEventListener(ACTION_LAYER_REFRESH_EVENT, onRefresh);
    return () => {
      window.removeEventListener(ACTION_LAYER_REFRESH_EVENT, onRefresh);
    };
  }, []);

  return (
    <section
      style={{
        width: '100%',
        maxWidth: 980,
        margin: '18px auto 0',
        padding: '18px 18px 16px',
        borderRadius: 22,
        border: '1px solid var(--border)',
        background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface) 94%, var(--gold) 6%), var(--surface))',
        boxShadow: 'var(--shadow-md)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 14 }}>
        <div>
          <div className="t-mono" style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>
            Action Layer / Local Queues
          </div>
          <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text)' }}>
            Pending local updates
          </div>
          <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.55, color: 'var(--text-dim)', maxWidth: 720 }}>
            承認済み Action のうち、外部実行前にローカル queue へ積まれた task / CRM update をここで確認します。
          </div>
          {focusQueueId || focusSourceActionId || focusSourceAiFieldId || focusOwnerEntityId ? (
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {focusQueueId ? (
                <span className="pill t-mono" style={{ fontSize: 10.5 }}>
                  queue {focusQueueId}
                </span>
              ) : null}
              {focusSourceActionId ? (
                <span className="pill t-mono" style={{ fontSize: 10.5 }}>
                  action {focusSourceActionId}
                </span>
              ) : null}
              {focusSourceAiFieldId ? (
                <span className="pill t-mono" style={{ fontSize: 10.5 }}>
                  ai_field {focusSourceAiFieldId}
                </span>
              ) : null}
              {focusOwnerEntityId ? (
                <span className="pill t-mono" style={{ fontSize: 10.5 }}>
                  entity {focusOwnerEntityId}
                </span>
              ) : null}
              {onClearFocus ? (
                <button
                  type="button"
                  onClick={onClearFocus}
                  style={{
                    height: 24,
                    padding: '0 8px',
                    borderRadius: 999,
                    border: '1px solid var(--border-hi)',
                    background: 'var(--surface-2)',
                    color: 'var(--text)',
                    fontSize: 11,
                  }}
                >
                  Clear
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => { void load(); }}
          style={{
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            height: 34,
            padding: '0 12px',
            borderRadius: 10,
            border: '1px solid var(--border-hi)',
            background: 'var(--surface-2)',
            color: 'var(--text)',
          }}
        >
          <Icon name="refresh" size={14} />
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <QueueList
          title="Task Queue"
          items={taskItems}
          provenanceByRowId={provenanceByRowId}
          empty="No locally queued tasks yet."
          accent="color-mix(in srgb, var(--gold) 28%, var(--border))"
          removeAction="queue.tasks.remove"
          retryAction="queue.tasks.retry"
          onRemove={load}
          onInspectAction={onInspectAction}
          onInspectActionAudit={onInspectActionAudit}
          onInspectAiField={onInspectAiField}
          focusQueueId={focusQueueId}
          focusSourceActionId={focusSourceActionId}
          focusOwnerEntityId={focusOwnerEntityId}
        />
        <QueueList
          title="CRM Update Queue"
          items={crmItems}
          provenanceByRowId={provenanceByRowId}
          empty="No locally queued CRM updates yet."
          accent="color-mix(in srgb, var(--success) 28%, var(--border))"
          removeAction="queue.crm_updates.remove"
          retryAction="queue.crm_updates.retry"
          onRemove={load}
          onInspectAction={onInspectAction}
          onInspectActionAudit={onInspectActionAudit}
          onInspectAiField={onInspectAiField}
          focusQueueId={focusQueueId}
          focusSourceActionId={focusSourceActionId}
          focusOwnerEntityId={focusOwnerEntityId}
        />
      </div>
    </section>
  );
}

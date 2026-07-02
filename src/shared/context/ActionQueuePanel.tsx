import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/shared/icons';
import { signalMatchesAction } from '@/features/entity-context/entity-kind-signals';
import { buildActionChatSeed, buildDraftChatSeed, openChatWithSeed } from '@/shared/context/chat-composer-seed';
import {
  nativeDetailDescriptorForEntityId,
  openEvidenceReference,
  openContextTarget,
  openNativeDetailForEntityId,
} from '@/shared/context/context-target-navigation';
import { ACTION_LAYER_REFRESH_EVENT, dispatchActionLayerRefresh } from '@/shared/context/action-layer-events';
import { openQueueArtifactInActions } from '@/shared/context/open-queue-artifact';
import {
  contextActionTypeMeta,
  normalizeContextActionType,
  SUPPORTED_CONTEXT_ACTION_TYPE_META,
} from '@/shared/context/action-types';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';
import type { AppNavigationDetail } from '@/app/lib/native-navigation';
import type {
  AiFieldRecord,
  ContextActionAuditEvent,
  ContextActionRecord,
} from '@/shared/domain/context-layer';

const STATUS_OPTIONS = ['proposed', 'approved', 'executed', 'rejected'] as const;
const RISK_OPTIONS = ['low', 'medium', 'high', 'critical'] as const;

interface ActionQueuePanelProps {
  seedField?: AiFieldRecord | null;
  seedDraft?: {
    ownerEntityId: string;
    actionType: string;
    title: string;
    detail?: string;
    riskLevel?: 'low' | 'medium' | 'high' | 'critical';
    sourceAiFieldId?: string | null;
    evidenceEventIds?: string[];
  } | null;
  focusActionId?: string | null;
  focusSourceAiFieldId?: string | null;
  focusOwnerEntityId?: string | null;
  focusOpenAudit?: boolean;
  focusSignalId?: string | null;
  onClearTraceFocus?: () => void;
  onClearOwnerFocus?: () => void;
  onConsumeSeedDraft?: () => void;
}

function parseEvidenceIds(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function uniqueEvidenceIds(ids: string[]): string[] {
  return Array.from(new Set(ids.map((item) => String(item || '').trim()).filter(Boolean)));
}

function statusTone(status: string): string {
  if (status === 'approved') return 'rgba(44, 160, 97, 0.16)';
  if (status === 'executed') return 'rgba(32, 123, 215, 0.16)';
  if (status === 'rejected') return 'rgba(201, 67, 67, 0.16)';
  return 'rgba(193, 148, 49, 0.16)';
}

function executionContent(item: ContextActionRecord): string {
  const result = item.executionResult as Record<string, unknown> | null;
  return typeof result?.content === 'string' ? result.content : '';
}

function normalizeActionRecord(item: ContextActionRecord): ContextActionRecord {
  return {
    ...item,
    actionType: normalizeContextActionType(item.actionType),
  };
}

function canExecute(item: ContextActionRecord): boolean {
  const actionType = normalizeContextActionType(item.actionType);
  return item.status === 'approved' && (
    actionType === 'follow_up_email_draft' || actionType === 'create_task' || actionType === 'update_crm'
  );
}

function executeLabel(item: ContextActionRecord): string {
  const actionType = normalizeContextActionType(item.actionType);
  if (actionType === 'create_task') return 'Queue task';
  if (actionType === 'update_crm') return 'Queue CRM update';
  return 'Execute draft';
}

function executionMeta(item: ContextActionRecord): string {
  const result = item.executionResult as Record<string, unknown> | null;
  const queued = result?.queued as Record<string, unknown> | undefined;
  return typeof queued?.id === 'string' ? `queued ${queued.id}` : '';
}

function executionQueuedId(item: ContextActionRecord): string | null {
  const result = item.executionResult as Record<string, unknown> | null;
  const queued = result?.queued as Record<string, unknown> | undefined;
  const id = String(queued?.id || '').trim();
  return id || null;
}

function executionOpenLabel(item: ContextActionRecord): string {
  const actionType = normalizeContextActionType(item.actionType);
  if (actionType === 'create_task') return 'Open task queue';
  if (actionType === 'update_crm') return 'Open CRM queue';
  return 'Open executed result';
}

function executionToastMessage(item: ContextActionRecord, rawResult: unknown): string {
  const result = (rawResult && typeof rawResult === 'object' ? rawResult : null) as Record<string, unknown> | null;
  const sideEffect = String(result?.sideEffect || '').trim();
  const actionType = normalizeContextActionType(item.actionType);
  if (sideEffect === 'queue_only' || actionType === 'create_task') {
    return '承認済み Action を実行し、task queue を開きました';
  }
  if (sideEffect === 'crm_queue_only' || actionType === 'update_crm') {
    return '承認済み Action を実行し、CRM queue を開きました';
  }
  if (sideEffect === 'draft_only' || Boolean(executionContent(item))) {
    return '承認済み Action を実行し、draft を Chat に開きました';
  }
  return '承認済み Action を実行しました';
}

function nativeDetailLabelForEvidenceId(evidenceId: string): string | null {
  return nativeDetailDescriptorForEntityId(evidenceId)?.label || null;
}

function auditSummary(event: ContextActionAuditEvent): string {
  if (event.eventType === 'status_changed') {
    return `${event.fromStatus || 'unknown'} -> ${event.toStatus || 'unknown'}`;
  }
  if (event.eventType === 'executed') {
    return event.toStatus ? `to ${event.toStatus}` : 'executed';
  }
  return event.toStatus ? `to ${event.toStatus}` : 'created';
}

function askChatAboutAction(item: ContextActionRecord): void {
  openChatWithSeed(buildActionChatSeed({
    ownerEntityId: item.ownerEntityId,
    title: item.title,
    actionType: item.actionType,
    status: item.status,
    riskLevel: item.riskLevel,
    detail: item.detail,
  }));
}

function openEntityContext(entityId: string): void {
  const id = String(entityId || '').trim();
  if (!id) return;
  openContextTarget({ targetId: id });
}

function openQueuedArtifact(item: ContextActionRecord): void {
  const queueId = executionQueuedId(item);
  if (!queueId) return;
  openQueueArtifactInActions({
    queueId,
    sourceActionId: item.id,
    sourceAiFieldId: item.sourceAiFieldId || null,
    ownerEntityId: item.ownerEntityId,
  });
}

function openDraftInChat(item: ContextActionRecord): void {
  const draftContent = executionContent(item);
  if (!draftContent) return;
  openChatWithSeed(buildDraftChatSeed({
    ownerEntityId: item.ownerEntityId,
    title: item.title,
    actionType: item.actionType,
    detail: item.detail,
    draftContent,
  }));
}

function normalizeExecutedAction(raw: unknown, fallback: ContextActionRecord): ContextActionRecord {
  if (!raw || typeof raw !== 'object') return fallback;
  return normalizeActionRecord({ ...fallback, ...(raw as Partial<ContextActionRecord>) });
}

function executionNavigation(rawResult: unknown): AppNavigationDetail | null {
  if (!rawResult || typeof rawResult !== 'object') return null;
  const navigation = (rawResult as { navigation?: unknown }).navigation;
  return navigation && typeof navigation === 'object'
    ? navigation as AppNavigationDetail
    : null;
}

export function ActionQueuePanel({
  seedField,
  seedDraft,
  focusActionId,
  focusSourceAiFieldId,
  focusOwnerEntityId,
  focusOpenAudit = false,
  focusSignalId,
  onClearTraceFocus,
  onClearOwnerFocus,
  onConsumeSeedDraft,
}: ActionQueuePanelProps): JSX.Element {
  const [items, setItems] = useState<ContextActionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [query, setQuery] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [ownerEntityId, setOwnerEntityId] = useState('');
  const [actionType, setActionType] = useState('follow_up_email_draft');
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [riskLevel, setRiskLevel] = useState<'low' | 'medium' | 'high' | 'critical'>('medium');
  const [evidenceIds, setEvidenceIds] = useState('');
  const [sourceAiFieldId, setSourceAiFieldId] = useState('');
  const [auditByActionId, setAuditByActionId] = useState<Record<string, ContextActionAuditEvent[]>>({});
  const [openAuditId, setOpenAuditId] = useState<string | null>(null);
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const selectedActionTypeMeta = contextActionTypeMeta(actionType);

  const load = async () => {
    setLoading(true);
    const res = await runRuntimeAction(
      'action.list',
      {
        limit: 12,
        query: query.trim(),
        ...(focusActionId ? { id: focusActionId } : {}),
        ...(focusSourceAiFieldId ? { sourceAiFieldId: focusSourceAiFieldId } : {}),
        ...((focusOwnerEntityId || ownerFilter).trim() ? { ownerEntityId: String(focusOwnerEntityId || ownerFilter).trim() } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
      },
      { silentError: true },
    );
    if (res?.ok && Array.isArray(res.data?.items)) {
      setItems((res.data.items as ContextActionRecord[]).map(normalizeActionRecord));
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => {
      void load();
    }, 180);
    return () => window.clearTimeout(id);
  }, [query, statusFilter, ownerFilter, focusActionId, focusSourceAiFieldId, focusOwnerEntityId]);

  useEffect(() => {
    const onRefresh = () => {
      void load();
    };
    window.addEventListener(ACTION_LAYER_REFRESH_EVENT, onRefresh);
    return () => {
      window.removeEventListener(ACTION_LAYER_REFRESH_EVENT, onRefresh);
    };
  }, [query, statusFilter, ownerFilter, focusActionId, focusSourceAiFieldId, focusOwnerEntityId]);

  useEffect(() => {
    if (!focusOwnerEntityId) return;
    setOwnerFilter(focusOwnerEntityId);
    setOwnerEntityId((prev) => prev || focusOwnerEntityId);
  }, [focusOwnerEntityId]);

  useEffect(() => {
    const directFocusId = String(focusActionId || '').trim();
    const signalMatch = items.find((item) => signalMatchesAction(focusSignalId ?? null, item));
    const targetId = directFocusId || signalMatch?.id || '';
    if (!targetId) return;
    const node = itemRefs.current[targetId];
    if (!node || typeof node.scrollIntoView !== 'function') return;
    node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [focusActionId, focusSignalId, items]);

  useEffect(() => {
    if (!seedField) return;
    setOwnerEntityId(seedField.ownerEntityId);
    setActionType(
      seedField.fieldName === 'next_action'
        ? 'follow_up_email_draft'
        : seedField.fieldName === 'blocker'
          ? 'create_task'
          : 'update_crm',
    );
    setTitle(
      seedField.currentValue
        ? seedField.currentValue
        : `Act on ${seedField.fieldName} for ${seedField.ownerEntityId}`,
    );
    setDetail(seedField.instruction);
    setRiskLevel(seedField.fieldName === 'blocker' ? 'high' : 'medium');
    setEvidenceIds(seedField.evidenceEventIds.join(', '));
    setSourceAiFieldId(seedField.id);
  }, [seedField]);

  useEffect(() => {
    if (!seedDraft) return;
    setOwnerEntityId(seedDraft.ownerEntityId);
    setActionType(seedDraft.actionType);
    setTitle(seedDraft.title);
    setDetail(String(seedDraft.detail || ''));
    setRiskLevel(seedDraft.riskLevel || 'medium');
    setEvidenceIds(Array.isArray(seedDraft.evidenceEventIds) ? seedDraft.evidenceEventIds.join(', ') : '');
    setSourceAiFieldId(String(seedDraft.sourceAiFieldId || ''));
    onConsumeSeedDraft?.();
  }, [onConsumeSeedDraft, seedDraft]);

  const save = async () => {
    const owner = ownerEntityId.trim();
    const kind = actionType.trim();
    const actionTitle = title.trim();
    if (!owner || !kind || !actionTitle) {
      (window as any).SHOGUN_RUNTIME?.pushToast?.('owner / action type / title を入力してください', 'warn');
      return;
    }
    setSaving(true);
    const res = await runRuntimeAction(
      'action.propose',
      {
        ownerEntityId: owner,
        actionType: kind,
        title: actionTitle,
        detail: detail.trim(),
        riskLevel,
        sourceAiFieldId: sourceAiFieldId.trim() || null,
        evidenceEventIds: parseEvidenceIds(evidenceIds),
      },
      { silentError: true },
    );
    setSaving(false);
    if (!res?.ok) {
      (window as any).SHOGUN_RUNTIME?.pushToast?.(res?.error?.message || 'Action を提案できませんでした', 'error');
      return;
    }
    (window as any).SHOGUN_RUNTIME?.pushToast?.('Action を proposed として追加しました', 'success');
    dispatchActionLayerRefresh('action-proposed');
    setOpenAuditId(null);
    await load();
  };

  const setStatus = async (id: string, nextStatus: typeof STATUS_OPTIONS[number]) => {
    const res = await runRuntimeAction(
      'action.set_status',
      { id, status: nextStatus },
      { silentError: true },
    );
    if (!res?.ok) {
      (window as any).SHOGUN_RUNTIME?.pushToast?.(res?.error?.message || 'Action status を更新できませんでした', 'error');
      return;
    }
    setAuditByActionId((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    dispatchActionLayerRefresh(`action-status-${nextStatus}`);
    await load();
  };

  const execute = async (id: string) => {
    const existingItem = items.find((item) => item.id === id) || null;
    const res = await runRuntimeAction(
      'action.execute',
      { id },
      { silentError: true },
    );
    if (!res?.ok) {
      (window as any).SHOGUN_RUNTIME?.pushToast?.(res?.error?.message || 'Action を実行できませんでした', 'error');
      return;
    }
    const executedItem = normalizeExecutedAction(res.data?.item, existingItem || {
      id,
      ownerEntityId: '',
      actionType: '',
      title: '',
      detail: '',
      status: 'executed',
      riskLevel: 'medium',
      sourceAiFieldId: null,
      evidenceEventIds: [],
      executionResult: null,
      executedAt: null,
      createdAt: 0,
      updatedAt: 0,
    });
    (window as any).SHOGUN_RUNTIME?.pushToast?.(executionToastMessage(executedItem, res.data), 'success');
    const navigation = executionNavigation(res.data);
    if (navigation) {
      try {
        window.dispatchEvent(new CustomEvent('shogun-app-navigate', { detail: navigation }));
      } catch {
        /* ignore */
      }
    } else if (executionQueuedId(executedItem)) {
      openQueuedArtifact(executedItem);
    } else if (executionContent(executedItem)) {
      openDraftInChat(executedItem);
    }
    setAuditByActionId((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    dispatchActionLayerRefresh(`action-executed-${id}`);
    await load();
  };

  const ensureAuditLoaded = async (actionId: string) => {
    if (auditByActionId[actionId]) return;
    const res = await runRuntimeAction(
      'action.audit_list',
      { actionId, limit: 12 },
      { silentError: true },
    );
    if (!res?.ok) {
      (window as any).SHOGUN_RUNTIME?.pushToast?.(res?.error?.message || 'Action audit を読み込めませんでした', 'error');
      return;
    }
    setAuditByActionId((prev) => ({
      ...prev,
      [actionId]: Array.isArray(res.data?.items) ? (res.data.items as ContextActionAuditEvent[]) : [],
    }));
  };

  const toggleAudit = async (actionId: string) => {
    if (openAuditId === actionId) {
      setOpenAuditId(null);
      return;
    }
    await ensureAuditLoaded(actionId);
    setOpenAuditId(actionId);
  };

  useEffect(() => {
    const actionId = String(focusActionId || '').trim();
    if (!actionId || focusOpenAudit !== true) return;
    void ensureAuditLoaded(actionId).then(() => {
      setOpenAuditId(actionId);
    });
  }, [auditByActionId, focusActionId, focusOpenAudit]);

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
            Context Platform / Actions
          </div>
          <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text)' }}>
            Human-approvable action queue
          </div>
          <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.55, color: 'var(--text-dim)', maxWidth: 720 }}>
            AI が提案した行動を `proposed → approved → executed / rejected` で管理します。外部書き込みをいきなり実行するのではなく、まず監査可能な提案として積みます。
          </div>
          {focusActionId || focusSourceAiFieldId || focusOwnerEntityId ? (
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {focusActionId || focusSourceAiFieldId ? (
                <span className="pill t-mono" style={{ fontSize: 10.5 }}>
                  {focusActionId ? `action ${focusActionId}` : `ai_field ${focusSourceAiFieldId}`}
                </span>
              ) : null}
              {focusOwnerEntityId ? (
                <span className="pill t-mono" style={{ fontSize: 10.5 }}>
                  entity {focusOwnerEntityId}
                </span>
              ) : null}
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                {focusActionId || focusSourceAiFieldId
                  ? 'queue artifact から trace した関連 Action を表示中'
                  : 'Entity Context から渡された owner entity で絞り込み中'}
              </span>
              {focusActionId || focusSourceAiFieldId ? (
                <button
                  type="button"
                  onClick={onClearTraceFocus}
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
              {focusOwnerEntityId && !(focusActionId || focusSourceAiFieldId) && onClearOwnerFocus ? (
                <button
                  type="button"
                  onClick={onClearOwnerFocus}
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
                  Clear entity
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
          Refresh
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.15fr) minmax(320px, 0.85fr)', gap: 16 }}>
        <div style={{ border: '1px solid var(--border)', borderRadius: 18, padding: 14, background: 'color-mix(in srgb, var(--surface-2) 65%, transparent)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 180px 140px', gap: 10, marginBottom: 12 }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search proposed actions"
              className="s-input"
            />
            <input
              value={ownerFilter}
              onChange={(e) => setOwnerFilter(e.target.value)}
              placeholder="Filter by owner entity"
              className="s-input"
              disabled={Boolean(focusOwnerEntityId)}
            />
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="s-input">
              <option value="">All statuses</option>
              {STATUS_OPTIONS.map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Recent Actions</div>
            <div className="t-mono" style={{ fontSize: 11, color: 'var(--text-dim)' }}>{items.length} loaded</div>
          </div>
          {loading ? (
            <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>Loading…</div>
          ) : items.length === 0 ? (
            <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-dim)' }}>
              No proposed actions yet. Start by converting an AI Field into a concrete, reviewable next step.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {items.map((item) => (
                <div
                  key={item.id}
                  ref={(node) => {
                    itemRefs.current[item.id] = node;
                  }}
                  style={{
                    padding: '12px 12px 10px',
                    borderRadius: 14,
                    border: signalMatchesAction(focusSignalId ?? null, item)
                      ? '1px solid color-mix(in srgb, var(--gold) 72%, var(--border-hi))'
                      : '1px solid var(--border)',
                    background: signalMatchesAction(focusSignalId ?? null, item)
                      ? 'color-mix(in srgb, var(--gold) 10%, var(--surface))'
                      : 'var(--surface)',
                    boxShadow: signalMatchesAction(focusSignalId ?? null, item)
                      ? '0 0 0 1px color-mix(in srgb, var(--gold) 18%, transparent)'
                      : 'none',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span className="pill t-mono" style={{ fontSize: 10 }}>{item.actionType}</span>
                      {contextActionTypeMeta(item.actionType)?.label ? (
                        <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
                          {contextActionTypeMeta(item.actionType)?.label}
                        </span>
                      ) : null}
                      <span className="t-mono" style={{ fontSize: 11, color: 'var(--text-dim)' }}>{item.ownerEntityId}</span>
                    </div>
                    <span
                      className="t-mono"
                      style={{
                        fontSize: 10.5,
                        color: 'var(--text)',
                        padding: '4px 7px',
                        borderRadius: 999,
                        background: statusTone(item.status),
                      }}
                    >
                      {item.status}
                    </span>
                  </div>
                  <div style={{ marginTop: 8, fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>
                    {item.title}
                  </div>
                  {item.detail ? (
                    <div style={{ marginTop: 6, fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-dim)' }}>
                      {item.detail}
                    </div>
                  ) : null}
                  <div className="t-mono" style={{ marginTop: 8, fontSize: 10.5, color: 'var(--text-dim)' }}>
                    risk {item.riskLevel} {item.sourceAiFieldId ? `· ai_field ${item.sourceAiFieldId}` : ''}
                  </div>
                  {item.evidenceEventIds.length ? (
                    <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {uniqueEvidenceIds(item.evidenceEventIds).map((evidenceId) => (
                        <div key={evidenceId} style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                          <button
                            type="button"
                            onClick={() => {
                              openEvidenceReference({
                                id: evidenceId,
                                title: item.title,
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
                  {item.executedAt ? (
                    <div className="t-mono" style={{ marginTop: 4, fontSize: 10.5, color: 'var(--text-dim)' }}>
                      executed {new Date(item.executedAt).toLocaleString()}
                    </div>
                  ) : null}
                  {executionContent(item) ? (
                    <pre
                      style={{
                        marginTop: 10,
                        padding: '10px 11px',
                        borderRadius: 10,
                        background: 'color-mix(in srgb, var(--surface-2) 72%, transparent)',
                        border: '1px solid var(--border)',
                        whiteSpace: 'pre-wrap',
                        fontSize: 11.5,
                        lineHeight: 1.5,
                        color: 'var(--text)',
                        fontFamily: 'inherit',
                      }}
                    >
                      {executionContent(item)}
                    </pre>
                  ) : null}
                  {executionMeta(item) ? (
                    <div className="t-mono" style={{ marginTop: 8, fontSize: 10.5, color: 'var(--text-dim)' }}>
                      {executionMeta(item)}
                    </div>
                  ) : null}
                  {openAuditId === item.id && auditByActionId[item.id]?.length ? (
                    <div
                      style={{
                        marginTop: 10,
                        borderRadius: 10,
                        border: '1px solid var(--border)',
                        background: 'color-mix(in srgb, var(--surface-2) 70%, transparent)',
                        padding: '10px 11px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
                    >
                      {(auditByActionId[item.id] || []).map((event) => (
                        <div key={event.id} style={{ display: 'grid', gridTemplateColumns: '88px 1fr', gap: 10 }}>
                          <div className="t-mono" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
                            {new Date(event.createdAt).toLocaleTimeString()}
                          </div>
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <span className="pill t-mono" style={{ fontSize: 10 }}>{event.eventType}</span>
                              <span className="t-mono" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
                                {auditSummary(event)}
                              </span>
                            </div>
                            <div style={{ marginTop: 4, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text)' }}>
                              {event.detail}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                    <button
                      type="button"
                      onClick={() => { openEntityContext(item.ownerEntityId); }}
                      style={{
                        height: 28,
                        padding: '0 10px',
                        borderRadius: 9,
                        border: '1px solid var(--border-hi)',
                        background: 'var(--surface-2)',
                        color: 'var(--text)',
                        fontSize: 11.5,
                      }}
                    >
                      Entity
                    </button>
                    <button
                      type="button"
                      onClick={() => { askChatAboutAction(item); }}
                      style={{
                        height: 28,
                        padding: '0 10px',
                        borderRadius: 9,
                        border: '1px solid var(--border-hi)',
                        background: 'var(--surface-2)',
                        color: 'var(--text)',
                        fontSize: 11.5,
                      }}
                    >
                      Ask Chat
                    </button>
                    <button
                      type="button"
                      onClick={() => { void toggleAudit(item.id); }}
                      style={{
                        height: 28,
                        padding: '0 10px',
                        borderRadius: 9,
                        border: '1px solid var(--border-hi)',
                        background: 'var(--surface-2)',
                        color: 'var(--text)',
                        fontSize: 11.5,
                      }}
                    >
                      {openAuditId === item.id ? 'Hide audit' : 'Show audit'}
                    </button>
                    {canExecute(item) ? (
                      <button
                        type="button"
                        onClick={() => { void execute(item.id); }}
                        style={{
                          height: 28,
                          padding: '0 10px',
                          borderRadius: 9,
                          border: '1px solid color-mix(in srgb, var(--gold) 55%, var(--border-hi))',
                          background: 'color-mix(in srgb, var(--gold) 12%, var(--surface-2))',
                          color: 'var(--text)',
                          fontSize: 11.5,
                        }}
                      >
                        {executeLabel(item)}
                      </button>
                    ) : null}
                    {executionQueuedId(item) ? (
                      <button
                        type="button"
                        onClick={() => { openQueuedArtifact(item); }}
                        style={{
                          height: 28,
                          padding: '0 10px',
                          borderRadius: 9,
                          border: '1px solid color-mix(in srgb, var(--success) 45%, var(--border-hi))',
                          background: 'color-mix(in srgb, var(--success) 10%, var(--surface-2))',
                          color: 'var(--text)',
                          fontSize: 11.5,
                        }}
                      >
                        {executionOpenLabel(item)}
                      </button>
                    ) : null}
                    {executionContent(item) ? (
                      <button
                        type="button"
                        onClick={() => { openDraftInChat(item); }}
                        style={{
                          height: 28,
                          padding: '0 10px',
                          borderRadius: 9,
                          border: '1px solid color-mix(in srgb, var(--gold) 55%, var(--border-hi))',
                          background: 'color-mix(in srgb, var(--gold) 12%, var(--surface-2))',
                          color: 'var(--text)',
                          fontSize: 11.5,
                        }}
                      >
                        Open draft in Chat
                      </button>
                    ) : null}
                    {STATUS_OPTIONS.filter((status) => status !== item.status).map((status) => (
                      <button
                        key={status}
                        type="button"
                        onClick={() => { void setStatus(item.id, status); }}
                        style={{
                          height: 28,
                          padding: '0 10px',
                          borderRadius: 9,
                          border: '1px solid var(--border-hi)',
                          background: 'var(--surface-2)',
                          color: 'var(--text)',
                          fontSize: 11.5,
                        }}
                      >
                        Mark {status}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ border: '1px solid var(--border)', borderRadius: 18, padding: 14, background: 'var(--surface)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Propose a shared action</div>
            {seedField ? (
              <div className="t-mono" style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                seeded from {seedField.fieldName}
              </div>
            ) : null}
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Owner entity id</span>
            <input value={ownerEntityId} onChange={(e) => setOwnerEntityId(e.target.value)} placeholder="deal:acme / workspace:founder-sales" className="s-input" />
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 10 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Action type</span>
              <select value={actionType} onChange={(e) => setActionType(e.target.value)} className="s-input">
                {SUPPORTED_CONTEXT_ACTION_TYPE_META.map((item) => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Risk</span>
              <select value={riskLevel} onChange={(e) => setRiskLevel(e.target.value as typeof riskLevel)} className="s-input">
                {RISK_OPTIONS.map((risk) => (
                  <option key={risk} value={risk}>{risk}</option>
                ))}
              </select>
            </label>
          </div>
          {selectedActionTypeMeta ? (
            <div style={{ marginTop: -2, fontSize: 12, lineHeight: 1.5, color: 'var(--text-dim)' }}>
              {selectedActionTypeMeta.helper}
            </div>
          ) : null}
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Draft the security follow-up email" className="s-input" />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Detail</span>
            <textarea value={detail} onChange={(e) => setDetail(e.target.value)} rows={3} className="s-input" style={{ resize: 'vertical' }} placeholder="Why this action matters, what it should include, and what evidence supports it." />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Source AI Field id</span>
            <input value={sourceAiFieldId} onChange={(e) => setSourceAiFieldId(e.target.value)} placeholder="af_..." className="s-input" />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Evidence ids</span>
            <input value={evidenceIds} onChange={(e) => setEvidenceIds(e.target.value)} placeholder="m_123, meeting:abc" className="s-input" />
          </label>
          <button
            type="button"
            onClick={() => { void save(); }}
            disabled={saving}
            style={{
              marginTop: 4,
              height: 38,
              borderRadius: 12,
              border: 'none',
              background: 'var(--gold)',
              color: '#fff',
              fontWeight: 600,
              cursor: saving ? 'progress' : 'pointer',
              opacity: saving ? 0.8 : 1,
            }}
          >
            {saving ? 'Saving…' : 'Propose Action'}
          </button>
        </div>
      </div>
    </section>
  );
}

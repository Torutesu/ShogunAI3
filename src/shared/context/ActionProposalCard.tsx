import { useEffect, useState } from 'react';
import { ACTION_LAYER_REFRESH_EVENT, dispatchActionLayerRefresh } from '@/shared/context/action-layer-events';
import { focusActionTrace } from '@/shared/context/action-trace-focus';
import { focusAiField } from '@/shared/context/ai-field-focus';
import { buildActionChatSeed, openChatWithSeed } from '@/shared/context/chat-composer-seed';
import {
  nativeDetailDescriptorForEntityId,
  openEvidenceReference,
  openContextTarget,
  openNativeDetailForEntityId,
} from '@/shared/context/context-target-navigation';
import { focusEntity } from '@/shared/context/entity-focus';
import {
  contextActionTypeMeta,
  normalizeContextActionType,
  SUPPORTED_CONTEXT_ACTION_TYPE_META,
} from '@/shared/context/action-types';
import { Icon } from '@/shared/icons';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';
import type { ContextActionRecord } from '@/shared/domain/context-layer';

const STATUS_OPTIONS = ['proposed', 'approved', 'executed', 'rejected'] as const;
const RISK_OPTIONS = ['low', 'medium', 'high', 'critical'] as const;

export interface ActionProposalCardProps {
  ownerEntityId: string;
  sourceAiFieldId?: string | null;
  seedActionType?: string;
  seedTitle?: string;
  seedDetail?: string;
  seedEvidenceIds?: string[];
  label?: string;
  onOpenAiFields?: (aiFieldId?: string | null) => void;
  onOpenActions?: (options?: { actionId?: string | null; aiFieldId?: string | null; openAudit?: boolean }) => void;
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)));
}

function normalizeActionRecord(item: ContextActionRecord): ContextActionRecord {
  return {
    ...item,
    actionType: normalizeContextActionType(item.actionType),
  };
}

function statusTone(status: string): string {
  if (status === 'approved') return 'rgba(44, 160, 97, 0.16)';
  if (status === 'executed') return 'rgba(32, 123, 215, 0.16)';
  if (status === 'rejected') return 'rgba(201, 67, 67, 0.16)';
  return 'rgba(193, 148, 49, 0.16)';
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

function openAiFields(ownerEntityId: string, aiFieldId?: string | null): void {
  const ownerId = String(ownerEntityId || '').trim();
  if (ownerId) focusEntity(ownerId);
  const fieldId = String(aiFieldId || '').trim();
  if (fieldId) focusAiField(fieldId);
  (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('ai_fields');
}

function openActionTrace(actionId: string, openAudit = false, aiFieldId?: string | null): void {
  const id = String(actionId || '').trim();
  if (!id) return;
  focusActionTrace({ actionId: id, aiFieldId: String(aiFieldId || '').trim() || null, openAudit });
  (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('actions');
}

function nativeDetailLabelForEvidenceId(evidenceId: string): string | null {
  return nativeDetailDescriptorForEntityId(evidenceId)?.label || null;
}

export function ActionProposalCard({
  ownerEntityId,
  sourceAiFieldId,
  seedActionType = 'follow_up_email_draft',
  seedTitle = '',
  seedDetail = '',
  seedEvidenceIds = [],
  label = 'Propose an Action',
  onOpenAiFields,
  onOpenActions,
}: ActionProposalCardProps): JSX.Element | null {
  const owner = String(ownerEntityId || '').trim();
  const [items, setItems] = useState<ContextActionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionType, setActionType] = useState(seedActionType);
  const [title, setTitle] = useState(seedTitle);
  const [detail, setDetail] = useState(seedDetail);
  const [riskLevel, setRiskLevel] = useState<'low' | 'medium' | 'high' | 'critical'>('medium');
  const [evidenceIds, setEvidenceIds] = useState(seedEvidenceIds.join(', '));
  const selectedActionTypeMeta = contextActionTypeMeta(actionType);

  const load = async () => {
    if (!owner) return;
    setLoading(true);
    const res = await runRuntimeAction(
      'action.list',
      { ownerEntityId: owner, limit: 6 },
      { silentError: true },
    );
    if (res?.ok && Array.isArray(res.data?.items)) {
      setItems((res.data.items as ContextActionRecord[]).map(normalizeActionRecord));
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!owner) {
      setItems([]);
      return;
    }
    void load();
  }, [owner]);

  useEffect(() => {
    if (!owner) return;
    const onRefresh = () => {
      void load();
    };
    window.addEventListener(ACTION_LAYER_REFRESH_EVENT, onRefresh);
    return () => {
      window.removeEventListener(ACTION_LAYER_REFRESH_EVENT, onRefresh);
    };
  }, [owner]);

  useEffect(() => {
    setActionType(seedActionType);
  }, [seedActionType]);

  useEffect(() => {
    setTitle(seedTitle);
  }, [seedTitle]);

  useEffect(() => {
    setDetail(seedDetail);
  }, [seedDetail]);

  useEffect(() => {
    setEvidenceIds(seedEvidenceIds.join(', '));
  }, [seedEvidenceIds]);

  useEffect(() => {
    if (seedActionType === 'create_task') {
      setRiskLevel('high');
      return;
    }
    if (seedActionType === 'follow_up_email_draft') {
      setRiskLevel('medium');
      return;
    }
    setRiskLevel('medium');
  }, [seedActionType]);

  if (!owner) return null;

  const save = async () => {
    const actionTitle = title.trim();
    const kind = actionType.trim();
    if (!kind || !actionTitle) {
      (window as any).SHOGUN_RUNTIME?.pushToast?.('action type / title を入力してください', 'warn');
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
        sourceAiFieldId: sourceAiFieldId || null,
        evidenceEventIds: uniqueIds(evidenceIds.split(',')),
      },
      { silentError: true },
    );
    setSaving(false);
    if (!res?.ok) {
      (window as any).SHOGUN_RUNTIME?.pushToast?.(res?.error?.message || 'Action を提案できませんでした', 'error');
      return;
    }
    (window as any).SHOGUN_RUNTIME?.pushToast?.('Action を proposed として追加しました', 'success');
    dispatchActionLayerRefresh('action-proposal-created');
    await load();
  };

  const setStatus = async (id: string, status: typeof STATUS_OPTIONS[number]) => {
    const res = await runRuntimeAction(
      'action.set_status',
      { id, status },
      { silentError: true },
    );
    if (!res?.ok) {
      (window as any).SHOGUN_RUNTIME?.pushToast?.(res?.error?.message || 'Action status を更新できませんでした', 'error');
      return;
    }
    dispatchActionLayerRefresh(`action-proposal-status-${status}`);
    await load();
  };

  return (
    <div
      style={{
        borderTop: '1px solid var(--border)',
        paddingTop: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="bolt" size={13} className="gold" />
        <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--text-dim)' }}>
        この owner に対して、承認前提の共有 Action を `proposed` として積みます。
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px', gap: 10 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Action type</span>
          <select value={actionType} onChange={(e) => setActionType(e.target.value)} className="s-input">
            {SUPPORTED_CONTEXT_ACTION_TYPE_META.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Risk</span>
          <select value={riskLevel} onChange={(e) => setRiskLevel(e.target.value as typeof riskLevel)} className="s-input">
            {RISK_OPTIONS.map((risk) => (
              <option key={risk} value={risk}>{risk}</option>
            ))}
          </select>
        </label>
      </div>
      {selectedActionTypeMeta ? (
        <div style={{ marginTop: -2, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-dim)' }}>
          {selectedActionTypeMeta.helper}
        </div>
      ) : null}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className="s-input" placeholder="Draft the follow-up" />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Detail</span>
        <textarea value={detail} onChange={(e) => setDetail(e.target.value)} rows={3} className="s-input" style={{ resize: 'vertical' }} />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Evidence ids</span>
        <input value={evidenceIds} onChange={(e) => setEvidenceIds(e.target.value)} className="s-input" placeholder="m_123, meeting:abc" />
      </label>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={() => { void save(); }}
          disabled={saving}
          style={{
            height: 34,
            padding: '0 12px',
            borderRadius: 10,
            border: 'none',
            background: 'var(--gold)',
            color: '#fff',
            fontWeight: 600,
            cursor: saving ? 'progress' : 'pointer',
            opacity: saving ? 0.82 : 1,
          }}
        >
          {saving ? 'Saving…' : 'Propose Action'}
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 600 }}>Recent Actions</div>
        <div className="t-mono" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
          {loading ? 'Loading…' : `${items.length} loaded`}
        </div>
      </div>
      {items.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.55 }}>
          No actions yet for this owner.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((item) => (
            <div
              key={item.id}
              style={{
                borderRadius: 12,
                padding: '10px 11px',
                background: 'color-mix(in srgb, var(--surface-2) 68%, transparent)',
                border: '1px solid var(--border)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span className="pill t-mono" style={{ fontSize: 10 }}>{item.actionType}</span>
                  <span className="t-mono" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>risk {item.riskLevel}</span>
                </div>
                <span className="t-mono" style={{ fontSize: 10.5, padding: '3px 7px', borderRadius: 999, background: statusTone(item.status) }}>
                  {item.status}
                </span>
              </div>
              <div style={{ marginTop: 6, fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>
                {item.title}
              </div>
              {item.detail ? (
                <div style={{ marginTop: 4, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-dim)' }}>
                  {item.detail}
                </div>
              ) : null}
              {item.evidenceEventIds.length ? (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                  {uniqueIds(item.evidenceEventIds).map((evidenceId) => (
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
                          height: 24,
                          padding: '0 8px',
                          borderRadius: 999,
                          border: '1px solid var(--border-hi)',
                          background: 'var(--surface)',
                          color: 'var(--text-dim)',
                          fontSize: 10.5,
                          fontFamily: 'inherit',
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
                            height: 24,
                            padding: '0 8px',
                            borderRadius: 999,
                            border: '1px solid var(--border-hi)',
                            background: 'color-mix(in srgb, var(--gold) 10%, var(--surface))',
                            color: 'var(--text)',
                            fontSize: 10.5,
                            fontFamily: 'inherit',
                          }}
                        >
                          {nativeDetailLabelForEvidenceId(evidenceId)}
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                <button
                  type="button"
                  onClick={() => { openEntityContext(item.ownerEntityId); }}
                  style={{
                    height: 26,
                    padding: '0 8px',
                    borderRadius: 8,
                    border: '1px solid var(--border-hi)',
                    background: 'var(--surface)',
                    color: 'var(--text)',
                    fontSize: 11,
                  }}
                >
                  Entity
                </button>
                {item.sourceAiFieldId ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (onOpenAiFields) {
                        onOpenAiFields(item.sourceAiFieldId);
                        return;
                      }
                      openAiFields(item.ownerEntityId, item.sourceAiFieldId);
                    }}
                    style={{
                      height: 26,
                      padding: '0 8px',
                      borderRadius: 8,
                      border: '1px solid var(--border-hi)',
                      background: 'var(--surface)',
                      color: 'var(--text)',
                      fontSize: 11,
                    }}
                  >
                    AI Field
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    if (onOpenActions) {
                      onOpenActions({ actionId: item.id, aiFieldId: item.sourceAiFieldId || null, openAudit: false });
                      return;
                    }
                    openActionTrace(item.id, false, item.sourceAiFieldId || null);
                  }}
                  style={{
                    height: 26,
                    padding: '0 8px',
                    borderRadius: 8,
                    border: '1px solid var(--border-hi)',
                    background: 'var(--surface)',
                    color: 'var(--text)',
                    fontSize: 11,
                  }}
                >
                  Open Action
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (onOpenActions) {
                      onOpenActions({ actionId: item.id, aiFieldId: item.sourceAiFieldId || null, openAudit: true });
                      return;
                    }
                    openActionTrace(item.id, true, item.sourceAiFieldId || null);
                  }}
                  style={{
                    height: 26,
                    padding: '0 8px',
                    borderRadius: 8,
                    border: '1px solid var(--border-hi)',
                    background: 'var(--surface)',
                    color: 'var(--text)',
                    fontSize: 11,
                  }}
                >
                  Open Audit
                </button>
                <button
                  type="button"
                  onClick={() => { askChatAboutAction(item); }}
                  style={{
                    height: 26,
                    padding: '0 8px',
                    borderRadius: 8,
                    border: '1px solid var(--border-hi)',
                    background: 'var(--surface)',
                    color: 'var(--text)',
                    fontSize: 11,
                  }}
                >
                  Ask Chat
                </button>
                {STATUS_OPTIONS.filter((status) => status !== item.status).map((status) => (
                  <button
                    key={status}
                    type="button"
                    onClick={() => { void setStatus(item.id, status); }}
                    style={{
                      height: 26,
                      padding: '0 8px',
                      borderRadius: 8,
                      border: '1px solid var(--border-hi)',
                      background: 'var(--surface)',
                      color: 'var(--text)',
                      fontSize: 11,
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
  );
}

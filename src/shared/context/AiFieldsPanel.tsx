import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/shared/icons';
import { buildFieldChatSeed, openChatWithSeed } from '@/shared/context/chat-composer-seed';
import { ACTION_LAYER_REFRESH_EVENT, dispatchActionLayerRefresh } from '@/shared/context/action-layer-events';
import {
  nativeDetailDescriptorForEntityId,
  openEvidenceReference,
  openNativeDetailForEntityId,
} from '@/shared/context/context-target-navigation';
import { signalMatchesField } from '@/features/entity-context/entity-kind-signals';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';
import type { AiFieldRecord } from '@/shared/domain/context-layer';

interface AiFieldsPanelProps {
  onProposeAction?: (item: AiFieldRecord) => void;
  focusFieldId?: string | null;
  focusOwnerEntityId?: string | null;
  focusSignalId?: string | null;
  onClearFocus?: () => void;
  onClearOwnerFocus?: () => void;
  seedDraft?: {
    ownerEntityId: string;
    fieldName: string;
    instruction: string;
    currentValue?: string;
    confidence?: number | null;
    evidenceEventIds?: string[];
  } | null;
  onConsumeSeedDraft?: () => void;
}

interface EvidencePreview {
  id: string;
  title: string;
  snippet?: string;
}

async function fetchEvidencePreview(id: string): Promise<EvidencePreview | null> {
  const rawId = String(id || '').trim();
  if (!rawId) return null;
  if (rawId.startsWith('meeting:')) {
    const meetingId = rawId.slice('meeting:'.length);
    const res = await runRuntimeAction('meetings.get', { meeting_id: meetingId }, { silentError: true });
    const meeting = res?.ok ? (res.data as any)?.meeting : null;
    const transcript = res?.ok && Array.isArray((res.data as any)?.transcript) ? (res.data as any).transcript : [];
    return {
      id: rawId,
      title: String(meeting?.title || meetingId || 'Meeting evidence'),
      snippet: transcript
        .slice(0, 2)
        .map((seg: any) => String(seg?.text || '').trim())
        .filter(Boolean)
        .join(' '),
    };
  }
  const res = await runRuntimeAction('memory.fetch', { ids: [rawId] }, { silentError: true });
  const fetched = res?.ok && Array.isArray(res.data?.items) ? res.data.items : [];
  const row = fetched[0];
  if (!row) return null;
  return {
    id: String(row.id || rawId),
    title: String(row.title || row.id || 'Memory item'),
    snippet: typeof row.snippet === 'string' ? row.snippet : '',
  };
}

function formatConfidence(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${Math.round(value * 100)}%`;
}

function truncate(text: string | undefined, max = 140): string {
  const raw = String(text || '').trim();
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max - 1)}…`;
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

function askChatAboutField(item: AiFieldRecord): void {
  openChatWithSeed(buildFieldChatSeed({
    ownerEntityId: item.ownerEntityId,
    fieldName: item.fieldName,
    currentValue: item.currentValue,
    instruction: item.instruction,
    evidenceIds: item.evidenceEventIds,
  }));
}

function nativeDetailLabelForEvidenceId(evidenceId: string): string | null {
  return nativeDetailDescriptorForEntityId(evidenceId)?.label || null;
}

export function AiFieldsPanel({
  onProposeAction,
  focusFieldId,
  focusOwnerEntityId,
  focusSignalId,
  onClearFocus,
  onClearOwnerFocus,
  seedDraft,
  onConsumeSeedDraft,
}: AiFieldsPanelProps): JSX.Element {
  const [items, setItems] = useState<AiFieldRecord[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [ownerEntityId, setOwnerEntityId] = useState('');
  const [fieldName, setFieldName] = useState('next_action');
  const [instruction, setInstruction] = useState('');
  const [currentValue, setCurrentValue] = useState('');
  const [confidence, setConfidence] = useState('0.72');
  const [evidenceIds, setEvidenceIds] = useState('');
  const [evidencePreviewByFieldId, setEvidencePreviewByFieldId] = useState<Record<string, EvidencePreview[]>>({});
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const reload = async () => {
    setLoading(true);
    const res = await runRuntimeAction(
      'ai_field.list',
      focusFieldId
        ? {
            id: focusFieldId,
            limit: 1,
          }
        : {
            limit: 12,
            query: query.trim(),
            ownerEntityId: String(focusOwnerEntityId || ownerFilter).trim(),
          },
      { silentError: true },
    );
    if (res?.ok && Array.isArray(res.data?.items)) {
      setItems(res.data.items as AiFieldRecord[]);
    }
    setLoading(false);
  };

  useEffect(() => {
    void reload();
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => {
      void reload();
    }, 180);
    return () => window.clearTimeout(id);
  }, [query, ownerFilter, focusFieldId, focusOwnerEntityId]);

  useEffect(() => {
    const onRefresh = () => {
      void reload();
    };
    window.addEventListener(ACTION_LAYER_REFRESH_EVENT, onRefresh);
    return () => {
      window.removeEventListener(ACTION_LAYER_REFRESH_EVENT, onRefresh);
    };
  }, [query, ownerFilter, focusFieldId, focusOwnerEntityId]);

  useEffect(() => {
    if (!focusOwnerEntityId || focusFieldId) return;
    setOwnerFilter(focusOwnerEntityId);
    setOwnerEntityId((prev) => prev || focusOwnerEntityId);
  }, [focusFieldId, focusOwnerEntityId]);

  useEffect(() => {
    const loadEvidence = async () => {
      const previewByFieldId: Record<string, EvidencePreview[]> = {};
      await Promise.all(
        items.map(async (item) => {
          const ids = item.evidenceEventIds.slice(0, 3);
          if (ids.length === 0) return;
          const previews = (await Promise.all(ids.map(fetchEvidencePreview))).filter(Boolean) as EvidencePreview[];
          previewByFieldId[item.id] = previews;
        }),
      );
      setEvidencePreviewByFieldId(previewByFieldId);
    };
    void loadEvidence();
  }, [items]);

  useEffect(() => {
    if (!focusFieldId) return;
    const focused = items.find((item) => item.id === focusFieldId);
    if (!focused) return;
    editField(focused);
  }, [focusFieldId, items]);

  useEffect(() => {
    const directFocusId = String(focusFieldId || '').trim();
    const signalMatch = items.find((item) => signalMatchesField(focusSignalId ?? null, item));
    const targetId = directFocusId || signalMatch?.id || '';
    if (!targetId) return;
    const node = itemRefs.current[targetId];
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [focusFieldId, focusSignalId, items]);

  useEffect(() => {
    if (!seedDraft) return;
    setEditingId(null);
    setOwnerEntityId(seedDraft.ownerEntityId);
    setFieldName(seedDraft.fieldName);
    setInstruction(seedDraft.instruction);
    setCurrentValue(String(seedDraft.currentValue || ''));
    setConfidence(
      typeof seedDraft.confidence === 'number' && Number.isFinite(seedDraft.confidence)
        ? String(seedDraft.confidence)
        : '0.72',
    );
    setEvidenceIds(Array.isArray(seedDraft.evidenceEventIds) ? seedDraft.evidenceEventIds.join(', ') : '');
    onConsumeSeedDraft?.();
  }, [onConsumeSeedDraft, seedDraft]);

  const resetForm = () => {
    setEditingId(null);
    setOwnerEntityId('');
    setFieldName('next_action');
    setInstruction('');
    setCurrentValue('');
    setConfidence('0.72');
    setEvidenceIds('');
  };

  const editField = (item: AiFieldRecord) => {
    setEditingId(item.id);
    setOwnerEntityId(item.ownerEntityId);
    setFieldName(item.fieldName);
    setInstruction(item.instruction);
    setCurrentValue(item.currentValue);
    setConfidence(
      typeof item.confidence === 'number' && Number.isFinite(item.confidence)
        ? String(item.confidence)
        : '',
    );
    setEvidenceIds(item.evidenceEventIds.join(', '));
  };

  const saveField = async () => {
    const owner = ownerEntityId.trim();
    const name = fieldName.trim();
    const instr = instruction.trim();
    if (!owner || !name || !instr) {
      (window as any).SHOGUN_RUNTIME?.pushToast?.('owner / field / instruction を入力してください', 'warn');
      return;
    }
    const conf = confidence.trim();
    const parsedConfidence = conf ? Number(conf) : null;
    setSaving(true);
    const res = await runRuntimeAction(
      'ai_field.upsert',
      {
        ...(editingId ? { id: editingId } : {}),
        ownerEntityId: owner,
        fieldName: name,
        instruction: instr,
        currentValue: currentValue.trim(),
        confidence: parsedConfidence,
        evidenceEventIds: parseEvidenceIds(evidenceIds),
      },
      { silentError: true },
    );
    setSaving(false);
    if (!res?.ok) {
      (window as any).SHOGUN_RUNTIME?.pushToast?.(res?.error?.message || 'AI Field を保存できませんでした', 'error');
      return;
    }
    resetForm();
    (window as any).SHOGUN_RUNTIME?.pushToast?.(
      editingId ? 'AI Field を更新しました' : 'AI Field を保存しました',
      'success',
    );
    dispatchActionLayerRefresh(editingId ? 'ai-field-updated' : 'ai-field-created');
    await reload();
  };

  return (
    <section
      style={{
        width: '100%',
        maxWidth: 980,
        margin: '28px auto 0',
        padding: '18px 18px 16px',
        borderRadius: 22,
        border: '1px solid var(--border)',
        background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface) 92%, var(--gold) 8%), var(--surface))',
        boxShadow: 'var(--shadow-md)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 14 }}>
        <div>
          <div className="t-mono" style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>
            Context Platform / AI Fields
          </div>
          <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text)' }}>
            Shared state across future product surfaces
          </div>
          <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.55, color: 'var(--text-dim)', maxWidth: 720 }}>
            Founder Sales や Fundraising、Meetings、Agents ごとに別管理するのではなく、同じ Core で扱うべき追跡状態をここから積み上げます。
          </div>
          {focusFieldId || focusOwnerEntityId ? (
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {focusFieldId ? (
                <span className="pill t-mono" style={{ fontSize: 10.5 }}>
                  ai_field {focusFieldId}
                </span>
              ) : null}
              {focusOwnerEntityId ? (
                <span className="pill t-mono" style={{ fontSize: 10.5 }}>
                  entity {focusOwnerEntityId}
                </span>
              ) : null}
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                {focusFieldId
                  ? 'queue artifact から trace した AI Field を表示中'
                  : 'Entity Context から渡された owner entity で絞り込み中'}
              </span>
              {focusFieldId && onClearFocus ? (
                <button
                  type="button"
                  onClick={onClearFocus}
                  style={{
                    height: 26,
                    padding: '0 9px',
                    borderRadius: 8,
                    border: '1px solid var(--border-hi)',
                    background: 'var(--surface-2)',
                    color: 'var(--text)',
                    fontSize: 11,
                  }}
                >
                  Clear focus
                </button>
              ) : null}
              {!focusFieldId && focusOwnerEntityId && onClearOwnerFocus ? (
                <button
                  type="button"
                  onClick={onClearOwnerFocus}
                  style={{
                    height: 26,
                    padding: '0 9px',
                    borderRadius: 8,
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
          onClick={() => { void reload(); }}
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

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.15fr) minmax(320px, 0.85fr)',
          gap: 16,
        }}
      >
        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 18,
            padding: 14,
            background: 'color-mix(in srgb, var(--surface-2) 65%, transparent)',
          }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search fields or values"
              className="s-input"
              disabled={Boolean(focusFieldId)}
            />
            <input
              value={ownerFilter}
              onChange={(e) => setOwnerFilter(e.target.value)}
              placeholder="Filter by owner entity"
              className="s-input"
              disabled={Boolean(focusFieldId || focusOwnerEntityId)}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Recent AI Fields</div>
            <div className="t-mono" style={{ fontSize: 11, color: 'var(--text-dim)' }}>{items.length} loaded</div>
          </div>
          {loading ? (
            <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>Loading…</div>
          ) : items.length === 0 ? (
            <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-dim)' }}>
              No AI Fields yet. Add one from the form to start tracking shared context such as blockers, next actions, or investor concerns.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {items.map((item) => {
                const previews = evidencePreviewByFieldId[item.id] || [];
                const isSignalFocused = signalMatchesField(focusSignalId ?? null, item);
                return (
                  <div
                    key={item.id}
                    ref={(node) => {
                      itemRefs.current[item.id] = node;
                    }}
                    style={{
                      padding: '12px 12px 10px',
                      borderRadius: 14,
                      border: isSignalFocused
                        ? '1px solid color-mix(in srgb, var(--gold) 72%, var(--border-hi))'
                        : '1px solid var(--border)',
                      background: isSignalFocused
                        ? 'color-mix(in srgb, var(--gold) 10%, var(--surface))'
                        : 'var(--surface)',
                      boxShadow: isSignalFocused ? '0 0 0 1px color-mix(in srgb, var(--gold) 18%, transparent)' : 'none',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className="pill t-mono" style={{ fontSize: 10 }}>{item.fieldName}</span>
                        <span className="t-mono" style={{ fontSize: 11, color: 'var(--text-dim)' }}>{item.ownerEntityId}</span>
                      </div>
                      <div className="t-mono" style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                        confidence {formatConfidence(item.confidence)}
                      </div>
                    </div>
                    <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--text)' }}>
                      {item.currentValue || 'No current value yet'}
                    </div>
                    <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.5, color: 'var(--text-dim)' }}>
                      {item.instruction}
                    </div>
                    <div className="t-mono" style={{ marginTop: 8, fontSize: 10.5, color: 'var(--text-dim)' }}>
                      evidence: {item.evidenceEventIds.length ? item.evidenceEventIds.join(', ') : 'none'}
                    </div>
                    {item.evidenceEventIds.length ? (
                      <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {item.evidenceEventIds.map((evidenceId) => (
                          <div key={evidenceId} style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                            <button
                              type="button"
                              onClick={() => {
                                openEvidenceReference({
                                  id: evidenceId,
                                  title: item.currentValue || item.instruction || item.fieldName,
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
                              open {evidenceId}
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
                    {previews.length ? (
                      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {previews.map((evidence) => (
                          <div
                            key={evidence.id}
                            style={{
                              borderRadius: 10,
                              padding: '8px 10px',
                              background: 'color-mix(in srgb, var(--surface-2) 72%, transparent)',
                              border: '1px solid color-mix(in srgb, var(--border) 85%, transparent)',
                              textAlign: 'left',
                              color: 'var(--text)',
                            }}
                          >
                            <button
                              type="button"
                              onClick={() => {
                                openEvidenceReference({
                                  id: evidence.id,
                                  title: evidence.title,
                                });
                              }}
                              style={{
                                width: '100%',
                                padding: 0,
                                border: 'none',
                                background: 'transparent',
                                textAlign: 'left',
                                color: 'inherit',
                                cursor: 'pointer',
                              }}
                            >
                              <div className="t-mono" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
                                {evidence.id}
                              </div>
                              <div style={{ marginTop: 3, fontSize: 12.5, color: 'var(--text)' }}>
                                {truncate(evidence.title, 64)}
                              </div>
                              {evidence.snippet ? (
                                <div style={{ marginTop: 4, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-dim)' }}>
                                  {truncate(evidence.snippet, 132)}
                                </div>
                              ) : null}
                            </button>
                            {nativeDetailLabelForEvidenceId(evidence.id) ? (
                              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    openNativeDetailForEntityId(evidence.id);
                                  }}
                                  className="btn btn-sm btn-ghost"
                                >
                                  {nativeDetailLabelForEvidenceId(evidence.id)}
                                </button>
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                    <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => askChatAboutField(item)}
                        style={{
                          height: 30,
                          padding: '0 10px',
                          borderRadius: 9,
                          border: '1px solid var(--border-hi)',
                          background: 'var(--surface-2)',
                          color: 'var(--text)',
                          fontSize: 12,
                        }}
                      >
                        Ask Chat
                      </button>
                      {onProposeAction ? (
                        <button
                          type="button"
                          onClick={() => onProposeAction(item)}
                          style={{
                            height: 30,
                            padding: '0 10px',
                            borderRadius: 9,
                            border: '1px solid color-mix(in srgb, var(--gold) 55%, var(--border-hi))',
                            background: 'color-mix(in srgb, var(--gold) 12%, var(--surface-2))',
                            color: 'var(--text)',
                            fontSize: 12,
                          }}
                        >
                          Propose action
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => editField(item)}
                        style={{
                          height: 30,
                          padding: '0 10px',
                          borderRadius: 9,
                          border: '1px solid var(--border-hi)',
                          background: 'var(--surface-2)',
                          color: 'var(--text)',
                          fontSize: 12,
                        }}
                      >
                        Edit
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 18,
            padding: 14,
            background: 'var(--surface)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>
              {editingId ? 'Edit shared field' : 'Create a shared field'}
            </div>
            {editingId ? (
              <button
                type="button"
                onClick={resetForm}
                style={{
                  height: 28,
                  padding: '0 10px',
                  borderRadius: 8,
                  border: '1px solid var(--border-hi)',
                  background: 'transparent',
                  color: 'var(--text-dim)',
                  fontSize: 12,
                }}
              >
                New field
              </button>
            ) : null}
          </div>
          {editingId ? (
            <div className="t-mono" style={{ fontSize: 11, color: 'var(--text-dim)' }}>
              editing {editingId}
            </div>
          ) : null}
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Owner entity id</span>
            <input value={ownerEntityId} onChange={(e) => setOwnerEntityId(e.target.value)} placeholder="company:acme / deal:seed-round" className="s-input" />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Field name</span>
            <input value={fieldName} onChange={(e) => setFieldName(e.target.value)} placeholder="next_action" className="s-input" />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Instruction</span>
            <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Track the most important next action for this entity using recent evidence." className="s-input" rows={3} style={{ resize: 'vertical' }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Current value</span>
            <textarea value={currentValue} onChange={(e) => setCurrentValue(e.target.value)} placeholder="Send security follow-up with timeline and owner." className="s-input" rows={3} style={{ resize: 'vertical' }} />
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Confidence</span>
              <input value={confidence} onChange={(e) => setConfidence(e.target.value)} placeholder="0.72" className="s-input" />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Evidence ids</span>
              <input value={evidenceIds} onChange={(e) => setEvidenceIds(e.target.value)} placeholder="m_123, m_456" className="s-input" />
            </label>
          </div>
          <button
            type="button"
            onClick={() => { void saveField(); }}
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
            {saving ? 'Saving…' : editingId ? 'Update AI Field' : 'Save AI Field'}
          </button>
        </div>
      </div>
    </section>
  );
}

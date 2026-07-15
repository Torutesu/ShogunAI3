import { useEffect, useMemo, useState } from 'react';
import { ActionProposalCard } from '@/shared/context/ActionProposalCard';
import { dispatchActionLayerRefresh } from '@/shared/context/action-layer-events';
import { focusActionTrace } from '@/shared/context/action-trace-focus';
import { focusAiField } from '@/shared/context/ai-field-focus';
import {
  openContextTarget,
  openEvidenceReference,
} from '@/shared/context/context-target-navigation';
import { focusEntity } from '@/shared/context/entity-focus';
import { openQueueArtifactInActions } from '@/shared/context/open-queue-artifact';
import { OwnerSummaryCard } from '@/shared/context/OwnerSummaryCard';
import { Icon } from '@/shared/icons';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';
import type { AiFieldRecord } from '@/shared/domain/context-layer';

export interface MemoryAiFieldPanelProps {
  scrubbed: any;
}

function uniqueEvidenceIds(ids: string[]): string[] {
  return Array.from(new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)));
}

export function MemoryAiFieldPanel({ scrubbed }: MemoryAiFieldPanelProps): JSX.Element | null {
  const memoryId = scrubbed?.memoryId ? String(scrubbed.memoryId) : '';
  const defaultOwner = scrubbed?.entityId ? String(scrubbed.entityId) : '';
  const [fields, setFields] = useState<AiFieldRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedFieldId, setSelectedFieldId] = useState<string>('');
  const [ownerEntityId, setOwnerEntityId] = useState(defaultOwner);
  const [fieldName, setFieldName] = useState('next_action');
  const [instruction, setInstruction] = useState('');
  const [currentValue, setCurrentValue] = useState('');
  const [confidence, setConfidence] = useState('0.7');

  const selectedField = useMemo(
    () => fields.find((field) => field.id === selectedFieldId) || null,
    [fields, selectedFieldId],
  );

  useEffect(() => {
    if (!defaultOwner) {
      setFields([]);
      setSelectedFieldId('');
      setOwnerEntityId('');
      return;
    }
    setOwnerEntityId(defaultOwner);
    let cancelled = false;
    setLoading(true);
    runRuntimeAction(
      'ai_field.list',
      { ownerEntityId: defaultOwner, limit: 12 },
      { silentError: true },
    ).then((res) => {
      if (cancelled) return;
      const items = res?.ok && Array.isArray(res.data?.items) ? (res.data.items as AiFieldRecord[]) : [];
      setFields(items);
      setLoading(false);
      if (items.length === 0) {
        setSelectedFieldId('');
        setFieldName('next_action');
        setInstruction(
          scrubbed?.title
            ? `Track the most important next action or blocker suggested by this memory: ${scrubbed.title}`
            : 'Track the most important next action for this entity.',
        );
        setCurrentValue(scrubbed?.title ? String(scrubbed.title) : '');
        setConfidence('0.7');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [defaultOwner, scrubbed?.title]);

  useEffect(() => {
    if (!selectedField) return;
    setOwnerEntityId(selectedField.ownerEntityId);
    setFieldName(selectedField.fieldName);
    setInstruction(selectedField.instruction);
    setCurrentValue(selectedField.currentValue);
    setConfidence(
      typeof selectedField.confidence === 'number' && Number.isFinite(selectedField.confidence)
        ? String(selectedField.confidence)
        : '',
    );
  }, [selectedField]);

  useEffect(() => {
    if (!memoryId) return;
    if (!selectedFieldId && !currentValue && scrubbed?.title) {
      setCurrentValue(String(scrubbed.title));
    }
  }, [memoryId, selectedFieldId, currentValue, scrubbed?.title]);

  if (!memoryId) return null;

  const save = async () => {
    const owner = ownerEntityId.trim();
    const name = fieldName.trim();
    const instr = instruction.trim();
    if (!owner || !name || !instr) {
      (window as any).SHOGUN_RUNTIME?.pushToast?.('AI Field の owner / field / instruction を入力してください', 'warn');
      return;
    }
    const parsedConfidence = confidence.trim() ? Number(confidence.trim()) : null;
    const evidenceEventIds = uniqueEvidenceIds([
      ...(selectedField?.evidenceEventIds || []),
      memoryId,
    ]);
    setSaving(true);
    const res = await runRuntimeAction(
      'ai_field.upsert',
      {
        ...(selectedField ? { id: selectedField.id } : {}),
        ownerEntityId: owner,
        fieldName: name,
        instruction: instr,
        currentValue: currentValue.trim(),
        confidence: parsedConfidence,
        evidenceEventIds,
      },
      { silentError: true },
    );
    setSaving(false);
    if (!res?.ok) {
      (window as any).SHOGUN_RUNTIME?.pushToast?.(res?.error?.message || 'AI Field を保存できませんでした', 'error');
      return;
    }
    (window as any).SHOGUN_RUNTIME?.pushToast?.(
      selectedField ? 'AI Field を更新しました' : 'AI Field を作成しました',
      'success',
    );
    dispatchActionLayerRefresh(selectedField ? 'memory-ai-field-updated' : 'memory-ai-field-created');
    if (owner) {
      const refresh = await runRuntimeAction(
        'ai_field.list',
        { ownerEntityId: owner, limit: 12 },
        { silentError: true },
      );
      const items = refresh?.ok && Array.isArray(refresh.data?.items) ? (refresh.data.items as AiFieldRecord[]) : [];
      setFields(items);
      const savedId = String((res.data as any)?.item?.id || selectedField?.id || '');
      setSelectedFieldId(savedId);
    }
  };

  return (
    <div
      style={{
        borderTop: '1px solid var(--border)',
        padding: '18px 22px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        background: 'color-mix(in srgb, var(--surface) 92%, var(--bg))',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Icon name="sparkles" size={14} className="gold" />
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
          Promote this memory into an AI Field
        </div>
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--text-dim)' }}>
        今見ている記憶を根拠として、`next_action` や `blocker` などの継続追跡フィールドに変換します。
      </div>
      {ownerEntityId.trim() ? (
        <OwnerSummaryCard
          entityId={ownerEntityId.trim()}
          onOpenQueueArtifact={(options) => {
            focusEntity(ownerEntityId.trim());
            openQueueArtifactInActions(options);
          }}
          onOpenEntityContext={() => {
            openContextTarget({ targetId: ownerEntityId.trim() });
          }}
          onOpenAiFields={() => {
            focusEntity(ownerEntityId.trim());
            (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('ai_fields');
          }}
          onOpenActions={(options) => {
            focusEntity(ownerEntityId.trim());
            const actionId = String(options?.actionId || '').trim();
            if (actionId) {
              focusActionTrace({
                actionId,
                aiFieldId: String(options?.aiFieldId || '').trim() || null,
                openAudit: options?.openAudit === true,
              });
            }
            (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('actions');
          }}
        />
      ) : null}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Existing field for this owner</span>
          <select
            value={selectedFieldId}
            onChange={(e) => setSelectedFieldId(e.target.value)}
            className="s-input"
            disabled={loading}
          >
            <option value="">{loading ? 'Loading…' : 'Create new field'}</option>
            {fields.map((field) => (
              <option key={field.id} value={field.id}>
                {field.fieldName} · {field.currentValue || field.instruction}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Owner entity id</span>
          <input
            value={ownerEntityId}
            onChange={(e) => setOwnerEntityId(e.target.value)}
            placeholder="deal:acme / company:foo"
            className="s-input"
          />
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px', gap: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Field name</span>
            <input
              value={fieldName}
              onChange={(e) => setFieldName(e.target.value)}
              placeholder="next_action"
              className="s-input"
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Confidence</span>
            <input
              value={confidence}
              onChange={(e) => setConfidence(e.target.value)}
              placeholder="0.7"
              className="s-input"
            />
          </label>
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Instruction</span>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={3}
            className="s-input"
            style={{ resize: 'vertical' }}
            placeholder="Track this field using future evidence."
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Current value</span>
          <textarea
            value={currentValue}
            onChange={(e) => setCurrentValue(e.target.value)}
            rows={3}
            className="s-input"
            style={{ resize: 'vertical' }}
            placeholder="Summarize the actionable state from this memory."
          />
        </label>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div className="t-mono" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
            evidence_event_ids will include {memoryId}
          </div>
          <button
            type="button"
            onClick={() => {
              openEvidenceReference({
                id: memoryId,
                title: scrubbed?.title || currentValue || fieldName,
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
            open evidence
          </button>
        </div>
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
          {saving ? 'Saving…' : selectedField ? 'Update AI Field' : 'Create AI Field'}
        </button>
      </div>
      <ActionProposalCard
        ownerEntityId={ownerEntityId}
        sourceAiFieldId={selectedField?.id || null}
        seedActionType={fieldName.trim() === 'blocker' ? 'create_task' : 'follow_up_email_draft'}
        seedTitle={currentValue.trim() || (scrubbed?.title ? `Act on ${scrubbed.title}` : '')}
        seedDetail={instruction.trim()}
        seedEvidenceIds={uniqueEvidenceIds([...(selectedField?.evidenceEventIds || []), memoryId])}
        label="Propose an Action from this memory"
        onOpenAiFields={(aiFieldId) => {
          focusEntity(ownerEntityId.trim());
          const fieldId = String(aiFieldId || '').trim();
          if (fieldId) focusAiField(fieldId);
          (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('ai_fields');
        }}
        onOpenActions={(options) => {
          focusEntity(ownerEntityId.trim());
          const actionId = String(options?.actionId || '').trim();
          if (actionId) {
            focusActionTrace({
              actionId,
              aiFieldId: String(options?.aiFieldId || '').trim() || null,
              openAudit: options?.openAudit === true,
            });
          }
          (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('actions');
        }}
      />
    </div>
  );
}

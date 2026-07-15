import React from 'react';
import { ActionProposalCard } from '@/shared/context/ActionProposalCard';
import { dispatchActionLayerRefresh } from '@/shared/context/action-layer-events';
import { focusActionTrace } from '@/shared/context/action-trace-focus';
import { focusAiField } from '@/shared/context/ai-field-focus';
import {
  nativeDetailDescriptorForEntityId,
  openEvidenceReference,
  openContextTarget,
  openNativeDetailForEntityId,
} from '@/shared/context/context-target-navigation';
import { focusEntity } from '@/shared/context/entity-focus';
import { openQueueArtifactInActions } from '@/shared/context/open-queue-artifact';
import { OwnerSummaryCard } from '@/shared/context/OwnerSummaryCard';
import { Icon } from '@/shared/icons';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';
import type { AiFieldRecord } from '@/shared/domain/context-layer';

interface WorkAiFieldPanelProps {
  project: any;
  memories: any[];
  onNavigateAway?: () => void;
}

export function WorkAiFieldPanel({ project, memories, onNavigateAway }: WorkAiFieldPanelProps): JSX.Element | null {
  const workspaceId = project?.id ? String(project.id) : '';
  const ownerEntityId = workspaceId ? `workspace:${workspaceId}` : '';
  const [items, setItems] = React.useState<AiFieldRecord[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [selectedFieldId, setSelectedFieldId] = React.useState('');
  const [fieldName, setFieldName] = React.useState('next_action');
  const [instruction, setInstruction] = React.useState('');
  const [currentValue, setCurrentValue] = React.useState('');
  const [confidence, setConfidence] = React.useState('0.7');
  const [evidenceId, setEvidenceId] = React.useState('');

  const selectedField = React.useMemo(
    () => items.find((item) => item.id === selectedFieldId) || null,
    [items, selectedFieldId],
  );

  const reload = React.useCallback(async () => {
    if (!ownerEntityId) return;
    setLoading(true);
    const res = await runRuntimeAction(
      'ai_field.list',
      { ownerEntityId, limit: 12 },
      { silentError: true },
    );
    const next = res?.ok && Array.isArray(res.data?.items) ? (res.data.items as AiFieldRecord[]) : [];
    setItems(next);
    setLoading(false);
  }, [ownerEntityId]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  React.useEffect(() => {
    const firstMemoryId = memories[0]?.id ? String(memories[0].id) : '';
    setEvidenceId((prev) => prev || firstMemoryId);
    if (!selectedField) {
      setFieldName('next_action');
      setInstruction(
        project?.name
          ? `Track the next action, blocker, or unresolved issue for workspace "${project.name}".`
          : 'Track the next action for this workspace.',
      );
      setCurrentValue(
        memories[0]?.title
          ? `Review ${memories[0].title}`
          : project?.name
            ? `Define next action for ${project.name}`
            : '',
      );
      return;
    }
    setFieldName(selectedField.fieldName);
    setInstruction(selectedField.instruction);
    setCurrentValue(selectedField.currentValue);
    setConfidence(
      typeof selectedField.confidence === 'number' && Number.isFinite(selectedField.confidence)
        ? String(selectedField.confidence)
        : '',
    );
  }, [selectedField, memories, project?.name]);

  if (!ownerEntityId) return null;

  const save = async () => {
    const name = fieldName.trim();
    const instr = instruction.trim();
    if (!name || !instr) {
      (window as any).SHOGUN_RUNTIME?.pushToast?.('field / instruction を入力してください', 'warn');
      return;
    }
    const parsedConfidence = confidence.trim() ? Number(confidence.trim()) : null;
    const evidenceEventIds = Array.from(
      new Set(
        [
          ...(selectedField?.evidenceEventIds || []),
          evidenceId || '',
        ].filter(Boolean),
      ),
    );
    setSaving(true);
    const res = await runRuntimeAction(
      'ai_field.upsert',
      {
        ...(selectedField ? { id: selectedField.id } : {}),
        ownerEntityId,
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
      (window as any).SHOGUN_RUNTIME?.pushToast?.(res?.error?.message || 'Workspace AI Field を保存できませんでした', 'error');
      return;
    }
    (window as any).SHOGUN_RUNTIME?.pushToast?.(
      selectedField ? 'Workspace AI Field を更新しました' : 'Workspace AI Field を作成しました',
      'success',
    );
    dispatchActionLayerRefresh(selectedField ? 'workspace-ai-field-updated' : 'workspace-ai-field-created');
    const savedId = String((res.data as any)?.item?.id || '');
    await reload();
    if (savedId) setSelectedFieldId(savedId);
  };

  return (
    <div
      className="card"
      style={{
        padding: 14,
        marginBottom: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        background: 'color-mix(in srgb, var(--surface) 92%, var(--gold) 8%)',
      }}
    >
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <Icon name="sparkles" size={13} className="gold" />
        <div style={{ fontSize: 13, fontWeight: 600 }}>Workspace AI Fields</div>
        <span style={{ flex: 1 }} />
        <span className="t-mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>
          {ownerEntityId}
        </span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.55 }}>
        この Workspace に紐づく継続追跡状態です。割り当て済み Memory を evidence にしながら、次アクションや blocker を更新できます。
      </div>
      {ownerEntityId.trim() ? (
        <OwnerSummaryCard
          entityId={ownerEntityId.trim()}
          hideNativeDetail
          onOpenQueueNativeDetail={(queueOwnerEntityId) => {
            openNativeDetailForEntityId(queueOwnerEntityId);
            onNavigateAway?.();
          }}
          onOpenQueueArtifact={(options) => {
            focusEntity(ownerEntityId.trim());
            openQueueArtifactInActions(options);
            onNavigateAway?.();
          }}
          onOpenEntityContext={() => {
            openContextTarget({ targetId: ownerEntityId.trim() });
            onNavigateAway?.();
          }}
          onOpenAiFields={() => {
            focusEntity(ownerEntityId.trim());
            (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('ai_fields');
            onNavigateAway?.();
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
            onNavigateAway?.();
          }}
        />
      ) : null}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Existing field</span>
          <select
            value={selectedFieldId}
            onChange={(e) => setSelectedFieldId(e.target.value)}
            className="s-input"
            disabled={loading}
          >
            <option value="">{loading ? 'Loading…' : 'Create new field'}</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.fieldName} · {item.currentValue || item.instruction}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Evidence memory</span>
          <select
            value={evidenceId}
            onChange={(e) => setEvidenceId(e.target.value)}
            className="s-input"
          >
            <option value="">No evidence memory</option>
            {memories.map((memory) => (
              <option key={memory.id} value={memory.id}>
                {memory.title || memory.id}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px', gap: 10 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Field name</span>
          <input
            value={fieldName}
            onChange={(e) => setFieldName(e.target.value)}
            className="s-input"
            placeholder="next_action"
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Confidence</span>
          <input
            value={confidence}
            onChange={(e) => setConfidence(e.target.value)}
            className="s-input"
            placeholder="0.7"
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
        />
      </label>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>
            evidence ids: {(selectedField?.evidenceEventIds || []).length}
          </div>
          {evidenceId ? (
            <button
              type="button"
              onClick={() => {
                const selectedMemory = memories.find((memory) => String(memory?.id || '') === evidenceId);
                openEvidenceReference({
                  id: evidenceId,
                  title: String(selectedMemory?.title || project?.name || currentValue || fieldName),
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
              open selected evidence
            </button>
          ) : null}
          {nativeDetailDescriptorForEntityId(ownerEntityId) ? (
            <button
              type="button"
              onClick={() => {
                openNativeDetailForEntityId(ownerEntityId);
                onNavigateAway?.();
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
              {nativeDetailDescriptorForEntityId(ownerEntityId)?.label}
            </button>
          ) : null}
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
        seedActionType={fieldName.trim() === 'blocker' ? 'create_task' : 'update_crm'}
        seedTitle={currentValue.trim() || (project?.name ? `Act on ${project.name}` : '')}
        seedDetail={instruction.trim()}
        seedEvidenceIds={Array.from(new Set([...(selectedField?.evidenceEventIds || []), evidenceId].filter(Boolean)))}
        label="Propose an Action for this workspace"
        onOpenAiFields={(aiFieldId) => {
          focusEntity(ownerEntityId.trim());
          const fieldId = String(aiFieldId || '').trim();
          if (fieldId) focusAiField(fieldId);
          (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('ai_fields');
          onNavigateAway?.();
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
          onNavigateAway?.();
        }}
      />
    </div>
  );
}

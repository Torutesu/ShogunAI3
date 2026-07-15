import { useEffect, useMemo, useState } from 'react';
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

export interface MeetingAiFieldPanelProps {
  meetingDetail: any;
  onNavigateAway?: () => void;
}

function excerptFromSegments(segments: any[]): string {
  return segments
    .slice(0, 4)
    .map((seg) => {
      const speaker = String(seg?.speaker || '').trim();
      const text = String(seg?.text || '').trim();
      if (!text) return '';
      return speaker ? `${speaker}: ${text}` : text;
    })
    .filter(Boolean)
    .join('\n');
}

function uniqueEvidenceIds(ids: string[]): string[] {
  return Array.from(new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)));
}

export function MeetingAiFieldPanel({ meetingDetail, onNavigateAway }: MeetingAiFieldPanelProps): JSX.Element | null {
  const meeting = meetingDetail?.meeting || {};
  const meetingId = meeting?.id ? String(meeting.id) : '';
  const evidenceId = meetingId ? `meeting:${meetingId}` : '';
  const defaultOwner = meetingId ? `meeting:${meetingId}` : '';
  const segments = Array.isArray(meetingDetail?.segments) ? meetingDetail.segments : [];
  const [fields, setFields] = useState<AiFieldRecord[]>([]);
  const [selectedFieldId, setSelectedFieldId] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ownerEntityId, setOwnerEntityId] = useState(defaultOwner);
  const [fieldName, setFieldName] = useState('next_action');
  const [instruction, setInstruction] = useState('');
  const [currentValue, setCurrentValue] = useState('');
  const [confidence, setConfidence] = useState('0.68');

  const selectedField = useMemo(
    () => fields.find((field) => field.id === selectedFieldId) || null,
    [fields, selectedFieldId],
  );

  useEffect(() => {
    if (!defaultOwner) return;
    let cancelled = false;
    setLoading(true);
    setOwnerEntityId(defaultOwner);
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
          meeting?.title
            ? `Track the next action, blocker, or unresolved issue from meeting "${meeting.title}".`
            : 'Track the next action from this meeting.',
        );
        setCurrentValue(meeting?.title ? `Follow up on ${meeting.title}` : excerptFromSegments(segments));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [defaultOwner, meeting?.title, segments]);

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

  if (!meetingId) return null;

  const save = async () => {
    const owner = ownerEntityId.trim();
    const name = fieldName.trim();
    const instr = instruction.trim();
    if (!owner || !name || !instr) {
      (window as any).SHOGUN_RUNTIME?.pushToast?.('AI Field の owner / field / instruction を入力してください', 'warn');
      return;
    }
    const parsedConfidence = confidence.trim() ? Number(confidence.trim()) : null;
    const evidenceEventIds = uniqueEvidenceIds([...(selectedField?.evidenceEventIds || []), evidenceId]);
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
      selectedField ? 'Meeting から AI Field を更新しました' : 'Meeting から AI Field を作成しました',
      'success',
    );
    dispatchActionLayerRefresh(selectedField ? 'meeting-ai-field-updated' : 'meeting-ai-field-created');
    const refresh = await runRuntimeAction(
      'ai_field.list',
      { ownerEntityId: owner, limit: 12 },
      { silentError: true },
    );
    const items = refresh?.ok && Array.isArray(refresh.data?.items) ? (refresh.data.items as AiFieldRecord[]) : [];
    setFields(items);
    setSelectedFieldId(String((res.data as any)?.item?.id || ''));
  };

  return (
    <div style={{ borderTop: '1px solid var(--border)', padding: '14px 22px 18px', background: 'color-mix(in srgb, var(--surface) 92%, var(--bg))' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Icon name="sparkles" size={13} className="gold" />
        <div style={{ fontSize: 13, fontWeight: 600 }}>Create or update an AI Field from this meeting</div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.55, marginBottom: 12 }}>
        会議内容を `next_action` や `blocker` として継続追跡に上げます。evidence には <code>{evidenceId}</code> を自動付与します。
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
      <div style={{ marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button
          type="button"
          onClick={() => {
            openEvidenceReference({
              id: evidenceId,
              title: meeting?.title || currentValue || fieldName,
            });
          }}
          style={{
            padding: '4px 9px',
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
        {nativeDetailDescriptorForEntityId(evidenceId) ? (
          <button
            type="button"
            onClick={() => {
              openNativeDetailForEntityId(evidenceId);
            }}
            style={{
              padding: '4px 9px',
              borderRadius: 999,
              border: '1px solid var(--border-hi)',
              background: 'color-mix(in srgb, var(--gold) 10%, var(--surface-2))',
              color: 'var(--text)',
              fontSize: 10.5,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            {nativeDetailDescriptorForEntityId(evidenceId)?.label}
          </button>
        ) : null}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Existing field</span>
          <select value={selectedFieldId} onChange={(e) => setSelectedFieldId(e.target.value)} className="s-input" disabled={loading}>
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
          <input value={ownerEntityId} onChange={(e) => setOwnerEntityId(e.target.value)} className="s-input" placeholder="meeting:mtg-1" />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Field name</span>
          <input value={fieldName} onChange={(e) => setFieldName(e.target.value)} className="s-input" placeholder="next_action" />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Confidence</span>
          <input value={confidence} onChange={(e) => setConfidence(e.target.value)} className="s-input" placeholder="0.68" />
        </label>
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Instruction</span>
        <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={3} className="s-input" style={{ resize: 'vertical' }} />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Current value</span>
        <textarea value={currentValue} onChange={(e) => setCurrentValue(e.target.value)} rows={4} className="s-input" style={{ resize: 'vertical' }} />
      </label>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
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
        seedTitle={currentValue.trim() || (meeting?.title ? `Follow up on ${meeting.title}` : '')}
        seedDetail={instruction.trim()}
        seedEvidenceIds={uniqueEvidenceIds([...(selectedField?.evidenceEventIds || []), evidenceId])}
        label="Propose an Action from this meeting"
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

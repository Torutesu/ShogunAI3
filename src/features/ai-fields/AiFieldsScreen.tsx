import { useState } from 'react';
import { Icon } from '@/shared/icons';
import { AiFieldsPanel } from '@/shared/context/AiFieldsPanel';
import { ActionQueuePanel } from '@/shared/context/ActionQueuePanel';
import {
  AI_FIELD_FOCUS_EVENT,
  clearAiFieldFocus,
  readAiFieldFocus,
} from '@/shared/context/ai-field-focus';
import { focusActionTrace } from '@/shared/context/action-trace-focus';
import {
  AI_FIELD_DRAFT_EVENT,
  clearAiFieldDraft,
  readAiFieldDraft,
} from '@/shared/context/ai-field-draft';
import {
  ENTITY_FOCUS_EVENT,
  clearEntityFocus,
  readEntityFocus,
} from '@/shared/context/entity-focus';
import {
  ENTITY_SIGNAL_FOCUS_EVENT,
  clearEntitySignalFocus,
  readEntitySignalFocus,
} from '@/features/entity-context/entity-signal-focus';
import { getEntitySignalLabel } from '@/shared/domain/entity-kind-signals';
import { useEventedValue } from '@/shared/context/focus-store';
import { OwnerSummaryCard } from '@/shared/context/OwnerSummaryCard';
import { openQueueArtifactInActions } from '@/shared/context/open-queue-artifact';
import {
  nativeDetailDescriptorForEntityId,
  openContextTarget,
  openNativeDetailForEntityId,
} from '@/shared/context/context-target-navigation';
import type { AiFieldRecord } from '@/shared/domain/context-layer';

export function AiFieldsScreen(): JSX.Element {
  const [actionSeedField, setActionSeedField] = useState<AiFieldRecord | null>(null);
  const focusedFieldId = useEventedValue(readAiFieldFocus, AI_FIELD_FOCUS_EVENT);
  const fieldDraft = useEventedValue(readAiFieldDraft, AI_FIELD_DRAFT_EVENT);
  const focusedEntityId = useEventedValue(readEntityFocus, ENTITY_FOCUS_EVENT);
  const focusedSignalId = useEventedValue(readEntitySignalFocus, ENTITY_SIGNAL_FOCUS_EVENT);

  const openEntityContext = () => {
    if (!focusedEntityId) return;
    openContextTarget({ targetId: focusedEntityId });
  };

  const nativeDetailDescriptor = nativeDetailDescriptorForEntityId(String(focusedEntityId || ''));
  const openNativeDetail = () => {
    openNativeDetailForEntityId(String(focusedEntityId || ''));
  };

  return (
    <div className="content-inner">
      <div className="page-head">
        <div>
          <div className="t-mono" style={{ marginBottom: 8 }}>CONTEXT PLATFORM</div>
          <h1>AI Fields <span className="jp">追跡状態</span></h1>
          <div className="sub">
            <span className="en-only">Shared, evidence-backed state that can be reused across Home, Memory, Meetings, Work, Chat, and future product surfaces.</span>
            <span className="jp">Home / Memory / Meetings / Work / Chat を横断して再利用する、根拠つきの共有状態です。</span>
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 16, display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 18 }}>
        <div style={{ width: 34, height: 34, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'color-mix(in srgb, var(--gold) 14%, var(--surface-2))', color: 'var(--gold)' }}>
          <Icon name="sparkles" size={16} />
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
            AI CRM でも Meeting Context でもなく、その上の shared core
          </div>
          <div>
            ここでは `next_action` / `blocker` / `budget` / `decision_maker` のような継続追跡状態をまとめて管理します。
            各 surface から作られた field をこの画面で横断的に検索・編集できます。
          </div>
          {focusedEntityId ? (
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className="pill t-mono" style={{ fontSize: 10.5 }}>
                entity {focusedEntityId}
              </span>
              <button
                type="button"
                onClick={openEntityContext}
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
                Open Entity Context
              </button>
              {nativeDetailDescriptor ? (
                <button
                  type="button"
                  onClick={openNativeDetail}
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
                  {nativeDetailDescriptor.label}
                </button>
              ) : null}
              {focusedSignalId ? (
                <>
                  <span className="pill t-mono" style={{ fontSize: 10.5 }}>
                    signal {getEntitySignalLabel(focusedSignalId)}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      clearEntitySignalFocus();
                    }}
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
                    Clear signal
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {focusedEntityId ? (
        <OwnerSummaryCard
          entityId={focusedEntityId}
          hideNativeDetail
          onOpenEntityContext={openEntityContext}
          onOpenQueueArtifact={(options) => {
            openQueueArtifactInActions(options);
          }}
          onOpenActions={(options) => {
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

      <AiFieldsPanel
        onProposeAction={setActionSeedField}
        focusFieldId={focusedFieldId}
        focusOwnerEntityId={focusedEntityId}
        focusSignalId={focusedSignalId}
        seedDraft={fieldDraft}
        onConsumeSeedDraft={() => {
          clearAiFieldDraft();
        }}
        onClearOwnerFocus={() => {
          clearEntityFocus();
        }}
        onClearFocus={() => {
          clearAiFieldFocus();
        }}
      />
      <ActionQueuePanel
        seedField={actionSeedField}
        focusOwnerEntityId={focusedEntityId}
        focusSignalId={focusedSignalId}
      />
    </div>
  );
}

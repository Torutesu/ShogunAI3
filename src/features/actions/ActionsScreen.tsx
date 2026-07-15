import { useEffect } from 'react';
import { Icon } from '@/shared/icons';
import { ActionQueuePanel } from '@/shared/context/ActionQueuePanel';
import { QueueArtifactsPanel } from '@/shared/context/QueueArtifactsPanel';
import {
  ACTION_TRACE_FOCUS_EVENT,
  clearActionTraceFocus,
  focusActionTrace,
  readActionTraceFocus,
} from '@/shared/context/action-trace-focus';
import {
  clearQueueArtifactFocus,
  QUEUE_ARTIFACT_FOCUS_EVENT,
  readQueueArtifactFocus,
} from '@/shared/context/queue-artifact-focus';
import {
  ACTION_DRAFT_EVENT,
  clearActionDraft,
  readActionDraft,
} from '@/shared/context/action-draft';
import {
  ENTITY_FOCUS_EVENT,
  clearEntityFocus,
  readEntityFocus,
} from '@/shared/context/entity-focus';
import {
  nativeDetailDescriptorForEntityId,
  openContextTarget,
  openNativeDetailForEntityId,
} from '@/shared/context/context-target-navigation';
import {
  ENTITY_SIGNAL_FOCUS_EVENT,
  clearEntitySignalFocus,
  readEntitySignalFocus,
} from '@/features/entity-context/entity-signal-focus';
import { getEntitySignalLabel } from '@/shared/domain/entity-kind-signals';
import { useEventedValue } from '@/shared/context/focus-store';
import { focusAiField } from '@/shared/context/ai-field-focus';
import { openQueueArtifactInActions } from '@/shared/context/open-queue-artifact';
import { OwnerSummaryCard } from '@/shared/context/OwnerSummaryCard';

export function ActionsScreen(): JSX.Element {
  const traceFocus = useEventedValue(readActionTraceFocus, ACTION_TRACE_FOCUS_EVENT);
  const actionDraft = useEventedValue(readActionDraft, ACTION_DRAFT_EVENT);
  const focusedEntityId = useEventedValue(readEntityFocus, ENTITY_FOCUS_EVENT);
  const focusedSignalId = useEventedValue(readEntitySignalFocus, ENTITY_SIGNAL_FOCUS_EVENT);
  const queueFocus = useEventedValue(readQueueArtifactFocus, QUEUE_ARTIFACT_FOCUS_EVENT);
  const queueFocusActionId = String(queueFocus.sourceActionId || '').trim();
  const queueFocusAiFieldId = String(queueFocus.sourceAiFieldId || '').trim() || null;
  const traceFocusActionId = String(traceFocus.actionId || '').trim();
  const traceFocusAiFieldId = String(traceFocus.aiFieldId || '').trim() || null;
  const queueFocusMatchesTrace = Boolean(
    queueFocusActionId
      && traceFocusActionId === queueFocusActionId
      && traceFocusAiFieldId === queueFocusAiFieldId,
  );
  const effectiveFocusActionId = queueFocusActionId || traceFocus.actionId;
  const effectiveFocusAiFieldId = queueFocusAiFieldId || traceFocus.aiFieldId;

  useEffect(() => {
    if (!queueFocusActionId) return;
    if (
      queueFocusMatchesTrace
    ) {
      return;
    }
    focusActionTrace({
      actionId: queueFocusActionId,
      aiFieldId: queueFocusAiFieldId,
      openAudit: false,
    });
  }, [queueFocusActionId, queueFocusAiFieldId, traceFocus.actionId, traceFocus.aiFieldId, traceFocus.openAudit]);

  const openEntityContext = () => {
    if (!focusedEntityId) return;
    openContextTarget({ targetId: focusedEntityId });
  };

  const nativeDetailDescriptor = nativeDetailDescriptorForEntityId(String(focusedEntityId || ''));
  const openNativeDetail = () => {
    openNativeDetailForEntityId(String(focusedEntityId || ''));
  };

  const inspectAiField = (aiFieldId: string) => {
    const id = String(aiFieldId || '').trim();
    if (!id) return;
    focusAiField(id);
    (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('ai_fields');
  };

  const inspectAction = (actionId: string, aiFieldId?: string | null) => {
    const id = String(actionId || '').trim();
    if (!id) return;
    focusActionTrace({ actionId: id, aiFieldId: String(aiFieldId || '').trim() || null, openAudit: false });
  };

  const inspectActionAudit = (actionId: string, aiFieldId?: string | null) => {
    const id = String(actionId || '').trim();
    if (!id) return;
    focusActionTrace({ actionId: id, aiFieldId: String(aiFieldId || '').trim() || null, openAudit: true });
  };

  const hasRuntimeFocus = Boolean(
    focusedEntityId
      || focusedSignalId
      || queueFocus.queueId
      || queueFocusActionId
      || queueFocusAiFieldId
      || traceFocusActionId
      || traceFocusAiFieldId
      || traceFocus.openAudit,
  );

  const focusControlButtonStyle = {
    height: 26,
    padding: '0 9px',
    borderRadius: 8,
    border: '1px solid var(--border-hi)',
    background: 'var(--surface-2)',
    color: 'var(--text)',
    fontSize: 11,
  } as const;

  return (
    <div className="content-inner">
      <div className="page-head">
        <div>
          <div className="t-mono" style={{ marginBottom: 8 }}>ACTION LAYER</div>
          <h1>Actions <span className="jp">行動提案</span></h1>
          <div className="sub">
            <span className="en-only">A dedicated surface for proposed, approved, executed, and rejected actions across the shared desktop context layer.</span>
            <span className="jp">共有コンテキスト基盤の上で、提案・承認・実行・却下される Action を横断管理する surface です。</span>
          </div>
        </div>
      </div>

      {hasRuntimeFocus ? (
        <div
          className="card"
          style={{
            padding: 14,
            marginBottom: 18,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            background: 'color-mix(in srgb, var(--surface-2) 72%, transparent)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div className="t-mono" style={{ fontSize: 10.5, color: 'var(--text-dim)', marginBottom: 4 }}>
                RUNTIME FOCUS
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.55 }}>
                Actions surface が今どの desktop context から開かれたかを保持しています。queue 起点の検査と action trace 起点の監査を分けて扱えます。
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {queueFocus.queueId || queueFocusActionId || queueFocusAiFieldId || queueFocus.ownerEntityId ? (
                <button
                  type="button"
                  onClick={() => {
                    clearQueueArtifactFocus();
                  }}
                  style={focusControlButtonStyle}
                >
                  Clear queue context
                </button>
              ) : null}
              {traceFocusActionId || traceFocusAiFieldId || traceFocus.openAudit ? (
                <button
                  type="button"
                  onClick={() => {
                    clearActionTraceFocus();
                  }}
                  style={focusControlButtonStyle}
                >
                  Clear action trace
                </button>
              ) : null}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {focusedEntityId ? (
              <span className="pill t-mono" style={{ fontSize: 10.5 }}>
                entity {focusedEntityId}
              </span>
            ) : null}
            {focusedSignalId ? (
              <span className="pill t-mono" style={{ fontSize: 10.5 }}>
                signal {getEntitySignalLabel(focusedSignalId)}
              </span>
            ) : null}
            {queueFocus.queueId ? (
              <span className="pill t-mono" style={{ fontSize: 10.5 }}>
                queue {queueFocus.queueId}
              </span>
            ) : null}
            {queueFocusActionId ? (
              <span className="pill t-mono" style={{ fontSize: 10.5 }}>
                queue_action {queueFocusActionId}
              </span>
            ) : null}
            {queueFocusAiFieldId ? (
              <span className="pill t-mono" style={{ fontSize: 10.5 }}>
                queue_ai_field {queueFocusAiFieldId}
              </span>
            ) : null}
            {traceFocusActionId ? (
              <span className="pill t-mono" style={{ fontSize: 10.5 }}>
                trace_action {traceFocusActionId}
              </span>
            ) : null}
            {traceFocusAiFieldId ? (
              <span className="pill t-mono" style={{ fontSize: 10.5 }}>
                trace_ai_field {traceFocusAiFieldId}
              </span>
            ) : null}
            {traceFocus.openAudit ? (
              <span className="pill t-mono" style={{ fontSize: 10.5 }}>
                audit open
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="card" style={{ padding: 16, display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 18 }}>
        <div style={{ width: 34, height: 34, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'color-mix(in srgb, var(--gold) 14%, var(--surface-2))', color: 'var(--gold)' }}>
          <Icon name="bolt" size={16} />
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
            Agent Runner の前に置く、人間承認つきの共有キュー
          </div>
          <div>
            `follow_up_email_draft` や `create_task`、`update_crm` のような外部影響のある操作を、いきなり実行せず `proposed` として蓄積し、監査可能な状態遷移で扱います。
          </div>
          {focusedEntityId ? (
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className="pill t-mono" style={{ fontSize: 10.5 }}>
                entity {focusedEntityId}
              </span>
              <button
                type="button"
                onClick={openEntityContext}
                style={focusControlButtonStyle}
              >
                Open Entity Context
              </button>
              {nativeDetailDescriptor?.kind === 'meeting' ? (
                <button
                  type="button"
                  onClick={openNativeDetail}
                  style={focusControlButtonStyle}
                >
                  Open Meeting Detail
                </button>
              ) : null}
              {nativeDetailDescriptor?.kind === 'workspace' ? (
                <button
                  type="button"
                  onClick={openNativeDetail}
                  style={focusControlButtonStyle}
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
                    style={focusControlButtonStyle}
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
          onOpenAiFields={() => {
            (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('ai_fields');
          }}
          onOpenQueueArtifact={(options) => {
            openQueueArtifactInActions(options);
          }}
          onOpenActions={(options) => {
            const targetId = String(options?.actionId || traceFocus.actionId || '').trim();
            if (targetId) {
              focusActionTrace({
                actionId: targetId,
                aiFieldId: String(options?.aiFieldId || '').trim() || null,
                openAudit: options?.openAudit === true,
              });
            }
          }}
        />
      ) : null}

      <ActionQueuePanel
        seedDraft={actionDraft}
        focusActionId={effectiveFocusActionId}
        focusSourceAiFieldId={effectiveFocusAiFieldId}
        focusOwnerEntityId={focusedEntityId}
        focusOpenAudit={queueFocusMatchesTrace ? traceFocus.openAudit : queueFocusActionId ? false : traceFocus.openAudit}
        focusSignalId={focusedSignalId}
        onConsumeSeedDraft={() => {
          clearActionDraft();
        }}
        onClearOwnerFocus={() => {
          clearEntityFocus();
        }}
        onClearTraceFocus={() => {
          clearActionTraceFocus();
        }}
      />
      <QueueArtifactsPanel
        onInspectAction={inspectAction}
        onInspectActionAudit={inspectActionAudit}
        onInspectAiField={inspectAiField}
        focusQueueId={queueFocus.queueId}
        focusSourceActionId={queueFocus.sourceActionId}
        focusSourceAiFieldId={queueFocus.sourceAiFieldId}
        focusOwnerEntityId={queueFocus.ownerEntityId}
        onClearFocus={() => {
          clearQueueArtifactFocus();
        }}
      />
    </div>
  );
}

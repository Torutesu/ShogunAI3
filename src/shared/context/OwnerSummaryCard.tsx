import { useEffect, useState } from 'react';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';
import { ACTION_LAYER_REFRESH_EVENT } from '@/shared/context/action-layer-events';
import { normalizeContextActionType } from '@/shared/context/action-types';
import {
  openNativeDetailForEntityId,
  nativeDetailDescriptorForEntityId,
} from '@/shared/context/context-target-navigation';
import {
  queueArtifactOwnerEntityId,
  queueArtifactNativeDetailState,
  queueArtifactSourceActionId,
} from '@/shared/context/queue-artifact-meta';
import type { OwnerContextSummaryRecord } from '@/shared/domain/context-layer';

function normalizeOwnerSummary(summary: OwnerContextSummaryRecord): OwnerContextSummaryRecord {
  return {
    ...summary,
    actions: {
      items: (summary.actions?.items || []).map((item) => ({
        ...item,
        actionType: normalizeContextActionType(item.actionType),
      })),
      total: summary.actions?.total || 0,
    },
  };
}

export function OwnerSummaryCard({
  entityId,
  onOpenEntityContext,
  onOpenAiFields,
  onOpenActions,
  onOpenQueueArtifact,
  hideNativeDetail = false,
  onOpenNativeDetail,
  onOpenQueueNativeDetail,
}: {
  entityId: string;
  onOpenEntityContext?: () => void;
  onOpenAiFields?: () => void;
  onOpenActions?: (options?: { openAudit?: boolean; actionId?: string | null; aiFieldId?: string | null }) => void;
  onOpenQueueArtifact?: (options: {
    queueId: string;
    sourceActionId?: string | null;
    sourceAiFieldId?: string | null;
    ownerEntityId?: string | null;
  }) => void;
  hideNativeDetail?: boolean;
  onOpenNativeDetail?: () => void;
  onOpenQueueNativeDetail?: (ownerEntityId: string) => void;
}): JSX.Element | null {
  const [summary, setSummary] = useState<OwnerContextSummaryRecord | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const ownerEntityId = String(entityId || '').trim();
      if (!ownerEntityId) {
        setSummary(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      const res = await runRuntimeAction(
        'context.owner_summary.get',
        { ownerEntityId, limit: 4 },
        { silentError: true },
      );
      if (cancelled) return;
      setSummary(
        res?.ok && res.data
          ? normalizeOwnerSummary(res.data as OwnerContextSummaryRecord)
          : null,
      );
      setLoading(false);
    };

    void load();
    const onRefresh = () => {
      void load();
    };
    window.addEventListener(ACTION_LAYER_REFRESH_EVENT, onRefresh);
    return () => {
      cancelled = true;
      window.removeEventListener(ACTION_LAYER_REFRESH_EVENT, onRefresh);
    };
  }, [entityId]);

  const latestAction = summary?.actions.items?.[0] || null;
  const latestQueue = summary?.queueArtifacts.items?.[0] || null;
  const latestAudit = summary?.latestAudits.find((item) => item.latestAudit)?.latestAudit || null;
  const normalizedEntityId = String(entityId || '').trim();
  const nativeDetailDescriptor = !hideNativeDetail
    ? nativeDetailDescriptorForEntityId(normalizedEntityId)
    : null;

  if (!normalizedEntityId) return null;

  const openNativeDetail = () => {
    if (onOpenNativeDetail) {
      onOpenNativeDetail();
      return;
    }
    openNativeDetailForEntityId(normalizedEntityId);
  };
  const latestQueueActionId = queueArtifactSourceActionId(latestQueue);
  const latestQueueAiFieldId = String(
    summary?.actions.items.find((item) => item.id === latestQueueActionId)?.sourceAiFieldId
      || latestAction?.sourceAiFieldId
      || summary?.aiFields?.items?.[0]?.id
      || '',
  ).trim() || null;
  const latestQueueId = String((latestQueue as any)?.id || '').trim();
  const latestQueueOwnerId = queueArtifactOwnerEntityId(latestQueue);
  const {
    ownerEntityId: latestQueueOwnerEntityId,
    nativeDetailDescriptor: latestQueueNativeDetailDescriptor,
    showNativeDetail: showLatestQueueNativeDetail,
  } = queueArtifactNativeDetailState(latestQueue, {
    currentEntityId: normalizedEntityId,
    hideWhenSameEntity: hideNativeDetail,
  });

  return (
    <div className="card" style={{ padding: 14, marginBottom: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-mute)', letterSpacing: '0.12em' }}>
            OWNER SUMMARY
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginTop: 4 }}>
            {entityId}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {onOpenEntityContext ? (
            <button type="button" className="btn btn-sm btn-ghost" onClick={onOpenEntityContext}>
              Entity Context
            </button>
          ) : null}
          {onOpenAiFields ? (
            <button type="button" className="btn btn-sm btn-ghost" onClick={onOpenAiFields}>
              AI Fields
            </button>
          ) : null}
          {onOpenActions ? (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => onOpenActions()}>
              Actions
            </button>
          ) : null}
          {nativeDetailDescriptor ? (
            <button type="button" className="btn btn-sm btn-ghost" onClick={openNativeDetail}>
              {nativeDetailDescriptor.label}
            </button>
          ) : null}
        </div>
      </div>

      {loading ? (
        <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Loading owner summary…</div>
      ) : null}

      {summary ? (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span className="pill t-mono" style={{ fontSize: 10.5 }}>
              fields {summary.summary.aiFieldCount}
            </span>
            <span className="pill t-mono" style={{ fontSize: 10.5 }}>
              actions {summary.summary.actionCount}
            </span>
            <span className="pill t-mono" style={{ fontSize: 10.5 }}>
              queue {summary.summary.queueArtifactCount}
            </span>
          </div>
          {latestAction ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 11.5, color: 'var(--text)', lineHeight: 1.5 }}>
                Latest action: {latestAction.title} [{latestAction.status}]
              </div>
              {onOpenActions ? (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => onOpenActions({ actionId: latestAction.id, aiFieldId: latestAction.sourceAiFieldId || null, openAudit: false })}
                >
                  Open action
                </button>
              ) : null}
            </div>
          ) : null}
          {latestQueue ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                Latest queue: {String(latestQueue.payload?.title || latestQueue.id || 'Queued artifact')}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {onOpenQueueArtifact && latestQueueId ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => onOpenQueueArtifact({
                      queueId: latestQueueId,
                      sourceActionId: latestQueueActionId || null,
                      sourceAiFieldId: latestQueueAiFieldId,
                      ownerEntityId: latestQueueOwnerId || null,
                    })}
                  >
                    Open queue item
                  </button>
                ) : null}
                {onOpenActions && latestQueueActionId ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => onOpenActions({ actionId: latestQueueActionId, aiFieldId: latestQueueAiFieldId, openAudit: false })}
                  >
                    Open queued action
                  </button>
                ) : null}
                {showLatestQueueNativeDetail && latestQueueNativeDetailDescriptor ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      if (onOpenQueueNativeDetail) {
                        onOpenQueueNativeDetail(latestQueueOwnerEntityId);
                        return;
                      }
                      openNativeDetailForEntityId(latestQueueOwnerEntityId);
                    }}
                  >
                    {latestQueueNativeDetailDescriptor.label}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          {latestAudit ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                Latest audit: {latestAudit.detail || latestAudit.eventType || 'audit recorded'}
              </div>
              {onOpenActions && latestAction ? (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => onOpenActions({ openAudit: true, actionId: latestAction.id, aiFieldId: latestAction.sourceAiFieldId || null })}
                >
                  Open audit
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

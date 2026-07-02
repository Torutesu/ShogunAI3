import { nativeDetailDescriptorForEntityId } from '@/shared/context/context-target-navigation';
import type { QueueArtifactRecord } from '@/shared/domain/context-layer';

type QueueArtifactLike = QueueArtifactRecord | Record<string, any> | null | undefined;

export function queueArtifactOwnerEntityId(item: QueueArtifactLike): string {
  return String(item?.payload?.owner_entity_id || '').trim();
}

export function queueArtifactSourceActionId(item: QueueArtifactLike): string {
  const direct = String(item?.payload?.source_action_id || '').trim();
  if (direct) return direct;
  return String(item?.provenance?.sourceAction?.id || '').trim();
}

export function queueArtifactTitle(item: QueueArtifactLike): string {
  return String(item?.payload?.title || item?.id || 'Queued artifact');
}

export function queueArtifactDetail(item: QueueArtifactLike): string {
  return String(item?.payload?.detail || item?.provenance?.latestAudit?.detail || '').trim();
}

export function queueArtifactAuditDetail(item: QueueArtifactLike): string {
  return String(item?.provenance?.latestAudit?.detail || '').trim();
}

export function queueArtifactAuditDetailFromSources(
  item: QueueArtifactLike,
  fallback?: { latestAudit?: { detail?: string | null } | null } | null,
): string {
  const primary = queueArtifactAuditDetail(item);
  if (primary) return primary;
  return String(fallback?.latestAudit?.detail || '').trim();
}

export function queueArtifactNativeDetailState(
  item: QueueArtifactLike,
  options?: {
    currentEntityId?: string | null;
    hideWhenSameEntity?: boolean;
  },
): {
  ownerEntityId: string;
  nativeDetailDescriptor: ReturnType<typeof nativeDetailDescriptorForEntityId>;
  showNativeDetail: boolean;
} {
  const ownerEntityId = queueArtifactOwnerEntityId(item);
  const nativeDetailDescriptor = ownerEntityId
    ? nativeDetailDescriptorForEntityId(ownerEntityId)
    : null;
  const currentEntityId = String(options?.currentEntityId || '').trim();
  const hideWhenSameEntity = options?.hideWhenSameEntity !== false;
  const showNativeDetail = Boolean(
    nativeDetailDescriptor
      && ownerEntityId
      && (!hideWhenSameEntity || ownerEntityId !== currentEntityId),
  );
  return {
    ownerEntityId,
    nativeDetailDescriptor,
    showNativeDetail,
  };
}

import { focusQueueArtifact } from '@/shared/context/queue-artifact-focus';

export function openQueueArtifactInActions(options: {
  queueId: string;
  sourceActionId?: string | null;
  sourceAiFieldId?: string | null;
  ownerEntityId?: string | null;
}): void {
  const queueId = String(options.queueId || '').trim();
  if (!queueId) return;
  focusQueueArtifact({
    queueId,
    sourceActionId: String(options.sourceActionId || '').trim() || null,
    sourceAiFieldId: String(options.sourceAiFieldId || '').trim() || null,
    ownerEntityId: String(options.ownerEntityId || '').trim() || null,
  });
  (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('actions');
}

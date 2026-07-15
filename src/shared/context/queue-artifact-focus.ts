import { createObjectFocusBinding, normalizeFocusString } from '@/shared/context/focus-store';

export const QUEUE_ARTIFACT_FOCUS_STORAGE_KEY = 'shogun-queue-artifact-focus';
export const QUEUE_ARTIFACT_FOCUS_EVENT = 'shogun-queue-artifact-focus';

export interface QueueArtifactFocusState {
  queueId: string | null;
  sourceActionId: string | null;
  sourceAiFieldId: string | null;
  ownerEntityId: string | null;
}

function normalizeState(raw: unknown): QueueArtifactFocusState {
  const parsed = (raw && typeof raw === 'object' ? raw : null) as Partial<QueueArtifactFocusState> | null;
  return {
    queueId: normalizeFocusString(parsed?.queueId ?? null),
    sourceActionId: normalizeFocusString(parsed?.sourceActionId ?? null),
    sourceAiFieldId: normalizeFocusString(parsed?.sourceAiFieldId ?? null),
    ownerEntityId: normalizeFocusString(parsed?.ownerEntityId ?? null),
  };
}

const queueArtifactFocusBinding = createObjectFocusBinding<QueueArtifactFocusState>(
  QUEUE_ARTIFACT_FOCUS_STORAGE_KEY,
  QUEUE_ARTIFACT_FOCUS_EVENT,
  normalizeState,
  (value) => !value.queueId && !value.sourceActionId && !value.sourceAiFieldId && !value.ownerEntityId,
);

export function readQueueArtifactFocus(): QueueArtifactFocusState {
  return queueArtifactFocusBinding.read();
}

export function writeQueueArtifactFocus(state: QueueArtifactFocusState): void {
  queueArtifactFocusBinding.write(state);
}

export function dispatchQueueArtifactFocus(state: QueueArtifactFocusState): void {
  queueArtifactFocusBinding.dispatch(state);
}

export function focusQueueArtifact(state: QueueArtifactFocusState): void {
  queueArtifactFocusBinding.focus(state);
}

export function clearQueueArtifactFocus(): void {
  queueArtifactFocusBinding.clear();
}

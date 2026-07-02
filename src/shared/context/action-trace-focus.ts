import { createObjectFocusBinding, normalizeFocusString } from '@/shared/context/focus-store';

export const ACTION_TRACE_FOCUS_STORAGE_KEY = 'shogun-action-trace-focus';
export const ACTION_TRACE_FOCUS_EVENT = 'shogun-action-trace-focus';

export interface ActionTraceFocusState {
  actionId: string | null;
  aiFieldId: string | null;
  openAudit: boolean;
}

function normalizeState(raw: unknown): ActionTraceFocusState {
  const parsed = (raw && typeof raw === 'object' ? raw : null) as Partial<ActionTraceFocusState> | null;
  return {
    actionId: normalizeFocusString(parsed?.actionId ?? null),
    aiFieldId: normalizeFocusString(parsed?.aiFieldId ?? null),
    openAudit: parsed?.openAudit === true,
  };
}

const actionTraceFocusBinding = createObjectFocusBinding<ActionTraceFocusState>(
  ACTION_TRACE_FOCUS_STORAGE_KEY,
  ACTION_TRACE_FOCUS_EVENT,
  normalizeState,
  (value) => !value.actionId && !value.aiFieldId && value.openAudit !== true,
);

export function readActionTraceFocus(): ActionTraceFocusState {
  return actionTraceFocusBinding.read();
}

export function writeActionTraceFocus(state: ActionTraceFocusState): void {
  actionTraceFocusBinding.write(state);
}

export function dispatchActionTraceFocus(state: ActionTraceFocusState): void {
  actionTraceFocusBinding.dispatch(state);
}

export function focusActionTrace(state: ActionTraceFocusState): void {
  actionTraceFocusBinding.focus(state);
}

export function clearActionTraceFocus(): void {
  actionTraceFocusBinding.clear();
}

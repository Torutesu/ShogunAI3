import { createStringFocusBinding } from '@/shared/context/focus-store';

export const ENTITY_SIGNAL_FOCUS_STORAGE_KEY = 'shogun-entity-signal-focus';
export const ENTITY_SIGNAL_FOCUS_EVENT = 'shogun-entity-signal-focus';

const entitySignalFocusBinding = createStringFocusBinding(
  ENTITY_SIGNAL_FOCUS_STORAGE_KEY,
  ENTITY_SIGNAL_FOCUS_EVENT,
  'signalId',
);

export function readEntitySignalFocus(): string | null {
  return entitySignalFocusBinding.read();
}

export function writeEntitySignalFocus(signalId: string | null): void {
  entitySignalFocusBinding.write(signalId);
}

export function dispatchEntitySignalFocus(signalId: string | null): void {
  entitySignalFocusBinding.dispatch(signalId);
}

export function focusEntitySignal(signalId: string): void {
  entitySignalFocusBinding.focus(signalId);
}

export function clearEntitySignalFocus(): void {
  entitySignalFocusBinding.clear();
}

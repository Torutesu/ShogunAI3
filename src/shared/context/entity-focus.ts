import { createStringFocusBinding } from '@/shared/context/focus-store';

export const ENTITY_FOCUS_STORAGE_KEY = 'shogun-entity-focus';
export const ENTITY_FOCUS_EVENT = 'shogun-entity-focus';

const entityFocusBinding = createStringFocusBinding(
  ENTITY_FOCUS_STORAGE_KEY,
  ENTITY_FOCUS_EVENT,
  'entityId',
);

export function readEntityFocus(): string | null {
  return entityFocusBinding.read();
}

export function writeEntityFocus(entityId: string | null): void {
  entityFocusBinding.write(entityId);
}

export function dispatchEntityFocus(entityId: string | null): void {
  entityFocusBinding.dispatch(entityId);
}

export function focusEntity(entityId: string): void {
  entityFocusBinding.focus(entityId);
}

export function clearEntityFocus(): void {
  entityFocusBinding.clear();
}

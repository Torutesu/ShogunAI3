import { createStringFocusBinding } from '@/shared/context/focus-store';

export const AI_FIELD_FOCUS_STORAGE_KEY = 'shogun-ai-field-focus';
export const AI_FIELD_FOCUS_EVENT = 'shogun-ai-field-focus';

const aiFieldFocusBinding = createStringFocusBinding(
  AI_FIELD_FOCUS_STORAGE_KEY,
  AI_FIELD_FOCUS_EVENT,
  'id',
);

export function readAiFieldFocus(): string | null {
  return aiFieldFocusBinding.read();
}

export function writeAiFieldFocus(id: string | null): void {
  aiFieldFocusBinding.write(id);
}

export function dispatchAiFieldFocus(id: string | null): void {
  aiFieldFocusBinding.dispatch(id);
}

export function focusAiField(id: string): void {
  aiFieldFocusBinding.focus(id);
}

export function clearAiFieldFocus(): void {
  aiFieldFocusBinding.clear();
}

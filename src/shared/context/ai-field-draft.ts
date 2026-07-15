import type { AiFieldUpsertInput } from '@/shared/domain/context-layer';
import { createDraftBinding } from '@/shared/context/focus-store';

export const AI_FIELD_DRAFT_STORAGE_KEY = 'shogun-ai-field-draft';
export const AI_FIELD_DRAFT_EVENT = 'shogun-ai-field-draft';

export interface AiFieldDraftState extends AiFieldUpsertInput {}

function normalizeDraft(raw: unknown): AiFieldDraftState | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const ownerEntityId = String(value.ownerEntityId || '').trim();
  const fieldName = String(value.fieldName || '').trim();
  const instruction = String(value.instruction || '').trim();
  if (!ownerEntityId || !fieldName || !instruction) return null;
  return {
    ownerEntityId,
    fieldName,
    instruction,
    currentValue: String(value.currentValue || '').trim(),
    confidence: typeof value.confidence === 'number' ? value.confidence : null,
    evidenceEventIds: Array.isArray(value.evidenceEventIds)
      ? value.evidenceEventIds.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
  };
}

const aiFieldDraftBinding = createDraftBinding<AiFieldDraftState>(
  AI_FIELD_DRAFT_STORAGE_KEY,
  AI_FIELD_DRAFT_EVENT,
  normalizeDraft,
);

export function readAiFieldDraft(): AiFieldDraftState | null {
  return aiFieldDraftBinding.read();
}

export function writeAiFieldDraft(draft: AiFieldDraftState | null): void {
  aiFieldDraftBinding.write(draft);
}

export function dispatchAiFieldDraft(draft: AiFieldDraftState | null): void {
  aiFieldDraftBinding.dispatch(draft);
}

export function seedAiFieldDraft(draft: AiFieldDraftState): void {
  aiFieldDraftBinding.seed(draft);
}

export function clearAiFieldDraft(): void {
  aiFieldDraftBinding.clear();
}

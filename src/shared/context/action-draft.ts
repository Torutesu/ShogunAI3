import type { ContextActionProposeInput } from '@/shared/domain/context-layer';
import { createDraftBinding } from '@/shared/context/focus-store';

export const ACTION_DRAFT_STORAGE_KEY = 'shogun-action-draft';
export const ACTION_DRAFT_EVENT = 'shogun-action-draft';

export interface ActionDraftState extends ContextActionProposeInput {}

function normalizeDraft(raw: unknown): ActionDraftState | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const ownerEntityId = String(value.ownerEntityId || '').trim();
  const actionType = String(value.actionType || '').trim();
  const title = String(value.title || '').trim();
  if (!ownerEntityId || !actionType || !title) return null;
  const riskLevel = ['low', 'medium', 'high', 'critical'].includes(String(value.riskLevel || ''))
    ? (value.riskLevel as NonNullable<ContextActionProposeInput['riskLevel']>)
    : 'medium';
  return {
    ownerEntityId,
    actionType,
    title,
    detail: String(value.detail || '').trim(),
    riskLevel,
    sourceAiFieldId: String(value.sourceAiFieldId || '').trim() || null,
    evidenceEventIds: Array.isArray(value.evidenceEventIds)
      ? value.evidenceEventIds.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
  };
}

const actionDraftBinding = createDraftBinding<ActionDraftState>(
  ACTION_DRAFT_STORAGE_KEY,
  ACTION_DRAFT_EVENT,
  normalizeDraft,
);

export function readActionDraft(): ActionDraftState | null {
  return actionDraftBinding.read();
}

export function writeActionDraft(draft: ActionDraftState | null): void {
  actionDraftBinding.write(draft);
}

export function dispatchActionDraft(draft: ActionDraftState | null): void {
  actionDraftBinding.dispatch(draft);
}

export function seedActionDraft(draft: ActionDraftState): void {
  actionDraftBinding.seed(draft);
}

export function clearActionDraft(): void {
  actionDraftBinding.clear();
}

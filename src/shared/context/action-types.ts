export const SUPPORTED_CONTEXT_ACTION_TYPES = [
  'follow_up_email_draft',
  'create_task',
  'update_crm',
] as const;

export type SupportedContextActionType = typeof SUPPORTED_CONTEXT_ACTION_TYPES[number];

export interface SupportedContextActionTypeMeta {
  value: SupportedContextActionType;
  label: string;
  helper: string;
}

export const SUPPORTED_CONTEXT_ACTION_TYPE_META: SupportedContextActionTypeMeta[] = [
  {
    value: 'follow_up_email_draft',
    label: 'Follow-up email draft',
    helper: 'Create a reviewable follow-up draft grounded in shared context.',
  },
  {
    value: 'create_task',
    label: 'Create task',
    helper: 'Queue a tracked task artifact for later human review or downstream processing.',
  },
  {
    value: 'update_crm',
    label: 'Queue CRM update',
    helper: 'Queue a CRM-style shared context update instead of writing directly.',
  },
];

export function normalizeContextActionType(value: string | null | undefined): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'queue_crm_update') return 'update_crm';
  return normalized;
}

export function isSupportedContextActionType(
  value: string | null | undefined,
): value is SupportedContextActionType {
  const normalized = normalizeContextActionType(value);
  return SUPPORTED_CONTEXT_ACTION_TYPES.includes(normalized as SupportedContextActionType);
}

export function contextActionTypeMeta(
  value: string | null | undefined,
): SupportedContextActionTypeMeta | null {
  const normalized = normalizeContextActionType(value);
  return SUPPORTED_CONTEXT_ACTION_TYPE_META.find((item) => item.value === normalized) || null;
}

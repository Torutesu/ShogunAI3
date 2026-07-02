import type { ContextEntityKind } from '@/shared/domain/context-layer';

export interface EntityFieldStarter {
  fieldName: string;
  label: string;
  instruction: string;
}

export interface EntityActionStarter {
  actionType: string;
  titleTemplate: string;
  detail: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

const DEFAULT_FIELD_STARTERS: EntityFieldStarter[] = [
  {
    fieldName: 'next_action',
    label: 'Next action',
    instruction: 'Track the clearest next action for this entity from shared desktop context evidence.',
  },
  {
    fieldName: 'blocker',
    label: 'Blocker',
    instruction: 'Track the current blocker or unresolved risk for this entity from shared desktop context evidence.',
  },
];

const FIELD_STARTERS_BY_KIND: Partial<Record<ContextEntityKind, EntityFieldStarter[]>> = {
  company: [
    { fieldName: 'decision_maker', label: 'Decision maker', instruction: 'Track who the real decision maker is for this company based on meetings, email, and notes.' },
    { fieldName: 'budget', label: 'Budget', instruction: 'Track the latest budget signal or purchasing constraint for this company.' },
    { fieldName: 'competitor', label: 'Competitor', instruction: 'Track competitors or alternatives mentioned around this company.' },
  ],
  deal: [
    { fieldName: 'next_action', label: 'Next step', instruction: 'Track the next concrete sales step needed to move this deal forward.' },
    { fieldName: 'blocker', label: 'Blocker', instruction: 'Track the strongest blocker preventing this deal from moving forward.' },
    { fieldName: 'urgency', label: 'Urgency', instruction: 'Track the latest urgency and timing signal for this deal.' },
  ],
  investor: [
    { fieldName: 'investor_concern', label: 'Concern', instruction: 'Track the biggest concern or objection this investor currently has.' },
    { fieldName: 'interest_level', label: 'Interest level', instruction: 'Track the current interest level of this investor from recent interactions.' },
    { fieldName: 'decision_process', label: 'Decision process', instruction: 'Track the investor decision process, timeline, and missing steps.' },
  ],
  project: [
    { fieldName: 'blocker', label: 'Blocker', instruction: 'Track the most important blocker slowing this project down.' },
    { fieldName: 'next_action', label: 'Next action', instruction: 'Track the next concrete action required to move this project forward.' },
    { fieldName: 'open_task', label: 'Open task', instruction: 'Track the most important unresolved task for this project.' },
  ],
  task: [
    { fieldName: 'status', label: 'Status', instruction: 'Track the latest status and state transition for this task.' },
    { fieldName: 'owner', label: 'Owner', instruction: 'Track who currently owns this task and whether handoff is needed.' },
    { fieldName: 'blocker', label: 'Blocker', instruction: 'Track the blocker preventing this task from being completed.' },
  ],
  workspace: [
    { fieldName: 'blocker', label: 'Blocker', instruction: 'Track the main blocker slowing this workspace down across the current operating lane.' },
    { fieldName: 'next_action', label: 'Next action', instruction: 'Track the clearest next action needed to move this workspace forward.' },
    { fieldName: 'open_task', label: 'Open task', instruction: 'Track the most important unresolved task inside this workspace.' },
  ],
  meeting: [
    { fieldName: 'decision', label: 'Decision', instruction: 'Track the most important decision reached or still pending from this meeting.' },
    { fieldName: 'objection', label: 'Objection', instruction: 'Track objections, concerns, or pushback surfaced in this meeting.' },
    { fieldName: 'follow_up', label: 'Follow-up', instruction: 'Track the most important follow-up required after this meeting.' },
  ],
};

const ACTION_STARTERS_BY_KIND: Partial<Record<ContextEntityKind, EntityActionStarter>> = {
  deal: {
    actionType: 'follow_up_email_draft',
    titleTemplate: 'Draft deal follow-up',
    detail: 'Draft the next-step follow-up for this deal based on the current context bundle.',
    riskLevel: 'medium',
  },
  investor: {
    actionType: 'follow_up_email_draft',
    titleTemplate: 'Draft investor follow-up',
    detail: 'Draft an investor follow-up grounded in the current fundraising context.',
    riskLevel: 'medium',
  },
  project: {
    actionType: 'create_task',
    titleTemplate: 'Create project task',
    detail: 'Turn the most urgent project need into a concrete tracked task.',
    riskLevel: 'medium',
  },
  task: {
    actionType: 'create_task',
    titleTemplate: 'Capture task follow-up',
    detail: 'Turn the current task state into a concrete tracked follow-up.',
    riskLevel: 'medium',
  },
  workspace: {
    actionType: 'create_task',
    titleTemplate: 'Create workspace task',
    detail: 'Turn the most urgent workspace need into a concrete tracked task.',
    riskLevel: 'medium',
  },
  company: {
    actionType: 'update_crm',
    titleTemplate: 'Queue company update',
    detail: 'Queue a CRM-style company context update backed by the latest evidence.',
    riskLevel: 'medium',
  },
  meeting: {
    actionType: 'create_task',
    titleTemplate: 'Capture meeting follow-up',
    detail: 'Turn meeting outcomes into a concrete reviewable follow-up task.',
    riskLevel: 'medium',
  },
};

export function inferEntityKind(entityId: string): ContextEntityKind | null {
  const raw = String(entityId || '').trim().toLowerCase();
  if (!raw || !raw.includes(':')) return null;
  const prefix = raw.split(':', 1)[0];
  const allowed: ContextEntityKind[] = ['person', 'company', 'project', 'workspace', 'deal', 'investor', 'meeting', 'document', 'task', 'app'];
  return allowed.includes(prefix as ContextEntityKind) ? (prefix as ContextEntityKind) : null;
}

export function getFieldStartersForEntityKind(kind: ContextEntityKind | null): EntityFieldStarter[] {
  if (!kind) return DEFAULT_FIELD_STARTERS;
  return FIELD_STARTERS_BY_KIND[kind] || DEFAULT_FIELD_STARTERS;
}

export function getActionStarterForEntityKind(kind: ContextEntityKind | null): EntityActionStarter {
  return ACTION_STARTERS_BY_KIND[kind || 'person'] || {
    actionType: 'follow_up_email_draft',
    titleTemplate: 'Draft follow-up',
    detail: 'Draft a next-step action grounded in the current entity context bundle.',
    riskLevel: 'medium',
  };
}

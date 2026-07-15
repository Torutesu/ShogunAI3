import type {
  AiFieldRecord,
  ContextActionRecord,
  ContextActionStatus,
  ContextEntityKind,
  EntityContextRecord,
} from '@/shared/domain/context-layer';

export interface EntitySignalCard {
  id: string;
  label: string;
  value: string;
  detail: string;
  tone?: 'default' | 'positive' | 'warning';
  fieldName?: string | null;
  fieldInstruction?: string | null;
  fieldId?: string | null;
  actionId?: string | null;
  ctaLabel?: string | null;
  ctaKind?: 'open_field' | 'create_field' | 'open_action' | 'propose_action' | null;
}

const SIGNAL_LABELS: Record<string, string> = {
  'signals-fields': 'Tracked fields',
  'signals-actions': 'Open actions',
  'signals-summaries': 'Recent summaries',
  'deal-next-step': 'Next step',
  'deal-blocker': 'Blocker',
  'deal-momentum': 'Momentum',
  'company-decision-maker': 'Decision maker',
  'company-budget': 'Budget',
  'company-competitor': 'Competitor',
  'investor-concern': 'Concern',
  'investor-interest': 'Interest',
  'investor-process': 'Decision process',
  'project-blocker': 'Blocker',
  'project-next': 'Next action',
  'project-activity': 'Activity',
  'task-status': 'Status',
  'task-owner': 'Owner',
  'task-blocker': 'Blocker',
  'workspace-blocker': 'Blocker',
  'workspace-next': 'Next action',
  'workspace-activity': 'Activity',
  'meeting-decision': 'Decision',
  'meeting-objection': 'Objection',
  'meeting-follow-up': 'Follow-up',
};

export function getEntitySignalLabel(signalId: string | null): string | null {
  const id = String(signalId || '').trim();
  if (!id) return null;
  return SIGNAL_LABELS[id] || id;
}

export function signalMatchesField(signalId: string | null, field: AiFieldRecord): boolean {
  const id = String(signalId || '').trim();
  if (!id) return false;
  const fieldName = normalize(field.fieldName);
  if (id === 'signals-fields') return true;
  if (id === 'signals-summaries') return fieldName === 'next_action';
  if (id.endsWith('next-step') || id.endsWith('next')) return fieldName === 'next_action' || fieldName === 'next_step';
  if (id.endsWith('blocker')) return fieldName === 'blocker';
  if (id.endsWith('decision-maker')) return fieldName === 'decision_maker';
  if (id.endsWith('budget')) return fieldName === 'budget';
  if (id.endsWith('competitor')) return fieldName === 'competitor';
  if (id.endsWith('concern')) return fieldName === 'investor_concern' || fieldName === 'concern';
  if (id.endsWith('interest')) return fieldName === 'interest_level';
  if (id.endsWith('process')) return fieldName === 'decision_process';
  if (id.endsWith('decision')) return fieldName === 'decision';
  if (id.endsWith('objection')) return fieldName === 'objection';
  if (id.endsWith('follow-up')) return fieldName === 'follow_up' || fieldName === 'next_action';
  return false;
}

export function signalMatchesAction(signalId: string | null, action: ContextActionRecord): boolean {
  const id = String(signalId || '').trim();
  if (!id) return false;
  if (id === 'signals-actions') return action.status === 'proposed' || action.status === 'approved';
  if (id.endsWith('momentum') || id.endsWith('activity')) return action.status === 'proposed' || action.status === 'approved' || action.status === 'executed';
  if (id.endsWith('follow-up') || id.endsWith('next-step')) return action.actionType === 'follow_up_email_draft';
  return false;
}

function normalize(text: string): string {
  return String(text || '').trim().toLowerCase();
}

function pickField(fields: AiFieldRecord[], names: string[]): AiFieldRecord | null {
  const wanted = names.map(normalize);
  return fields.find((field) => wanted.includes(normalize(field.fieldName))) || null;
}

function latestAction(actions: ContextActionRecord[], statuses?: ContextActionStatus[]): ContextActionRecord | null {
  const filtered = statuses?.length ? actions.filter((item) => statuses.includes(item.status)) : actions;
  return filtered[0] || null;
}

function countActions(actions: ContextActionRecord[], statuses: ContextActionStatus[]): number {
  return actions.filter((item) => statuses.includes(item.status)).length;
}

function formatFieldValue(field: AiFieldRecord | null, fallback: string): string {
  const value = String(field?.currentValue || '').trim();
  return value || fallback;
}

function genericSignals(bundle: EntityContextRecord): EntitySignalCard[] {
  const proposedCount = countActions(bundle.actions, ['proposed', 'approved']);
  return [
    {
      id: 'signals-fields',
      label: 'Tracked fields',
      value: `${bundle.aiFields.length}`,
      detail: bundle.aiFields.length ? bundle.aiFields.slice(0, 2).map((field) => field.fieldName).join(' · ') : 'No tracked fields yet',
      ctaKind: bundle.aiFields[0] ? 'open_field' : 'create_field',
      ctaLabel: bundle.aiFields[0] ? 'Open field' : 'Create field',
      fieldId: bundle.aiFields[0]?.id || null,
      fieldName: bundle.aiFields[0]?.fieldName || 'next_action',
      fieldInstruction: bundle.aiFields[0]?.instruction || 'Track the clearest next action for this entity from shared desktop context evidence.',
    },
    {
      id: 'signals-actions',
      label: 'Open actions',
      value: `${proposedCount}`,
      detail: proposedCount ? 'Proposed or approved actions are waiting in the queue' : 'No open actions yet',
      tone: proposedCount > 0 ? 'warning' : 'default',
      ctaKind: latestAction(bundle.actions, ['proposed', 'approved']) ? 'open_action' : 'propose_action',
      ctaLabel: latestAction(bundle.actions, ['proposed', 'approved']) ? 'Open action' : 'Propose action',
      actionId: latestAction(bundle.actions, ['proposed', 'approved'])?.id || null,
    },
    {
      id: 'signals-summaries',
      label: 'Recent summaries',
      value: `${bundle.recentSummaries.length}`,
      detail: bundle.recentSummaries[0]?.title || 'No related summaries yet',
      ctaKind: 'create_field',
      ctaLabel: 'Create field',
      fieldName: 'next_action',
      fieldInstruction: 'Track the clearest next action inferred from recent summaries and shared context evidence.',
    },
  ];
}

export function buildEntitySignals(
  kind: ContextEntityKind | null,
  bundle: EntityContextRecord,
): EntitySignalCard[] {
  const fields = bundle.aiFields;
  const actions = bundle.actions;

  if (kind === 'deal') {
    const nextStep = pickField(fields, ['next_action', 'next_step']);
    const blocker = pickField(fields, ['blocker']);
    const approved = countActions(actions, ['approved', 'executed']);
    return [
      {
        id: 'deal-next-step',
        label: 'Next step',
        value: formatFieldValue(nextStep, 'No next step yet'),
        detail: nextStep?.instruction || latestAction(actions)?.title || 'Create a next-step field or propose a follow-up action',
        fieldName: 'next_action',
        fieldInstruction: nextStep?.instruction || 'Track the next concrete sales step needed to move this deal forward.',
        fieldId: nextStep?.id || null,
        ctaKind: nextStep ? 'open_field' : 'create_field',
        ctaLabel: nextStep ? 'Open field' : 'Create field',
      },
      {
        id: 'deal-blocker',
        label: 'Blocker',
        value: formatFieldValue(blocker, 'No blocker tracked'),
        detail: blocker?.instruction || 'Track the strongest blocker preventing this deal from moving',
        tone: blocker?.currentValue ? 'warning' : 'default',
        fieldName: 'blocker',
        fieldInstruction: blocker?.instruction || 'Track the strongest blocker preventing this deal from moving forward.',
        fieldId: blocker?.id || null,
        ctaKind: blocker ? 'open_field' : 'create_field',
        ctaLabel: blocker ? 'Open field' : 'Create field',
      },
      {
        id: 'deal-momentum',
        label: 'Momentum',
        value: approved > 0 ? `${approved} active moves` : 'No approved moves',
        detail: latestAction(actions, ['approved', 'executed'])?.title || 'No approved or executed actions yet',
        tone: approved > 0 ? 'positive' : 'default',
        actionId: latestAction(actions, ['approved', 'executed'])?.id || null,
        ctaKind: latestAction(actions, ['approved', 'executed']) ? 'open_action' : 'propose_action',
        ctaLabel: latestAction(actions, ['approved', 'executed']) ? 'Open action' : 'Propose action',
      },
    ];
  }

  if (kind === 'company') {
    const decisionMaker = pickField(fields, ['decision_maker']);
    const budget = pickField(fields, ['budget']);
    const competitor = pickField(fields, ['competitor']);
    return [
      {
        id: 'company-decision-maker',
        label: 'Decision maker',
        value: formatFieldValue(decisionMaker, 'Unknown'),
        detail: decisionMaker?.instruction || 'No decision-maker signal tracked yet',
        fieldName: 'decision_maker',
        fieldInstruction: decisionMaker?.instruction || 'Track who the real decision maker is for this company based on meetings, email, and notes.',
        fieldId: decisionMaker?.id || null,
        ctaKind: decisionMaker ? 'open_field' : 'create_field',
        ctaLabel: decisionMaker ? 'Open field' : 'Create field',
      },
      {
        id: 'company-budget',
        label: 'Budget',
        value: formatFieldValue(budget, 'No budget signal'),
        detail: budget?.instruction || 'No budget field tracked yet',
        fieldName: 'budget',
        fieldInstruction: budget?.instruction || 'Track the latest budget signal or purchasing constraint for this company.',
        fieldId: budget?.id || null,
        ctaKind: budget ? 'open_field' : 'create_field',
        ctaLabel: budget ? 'Open field' : 'Create field',
      },
      {
        id: 'company-competitor',
        label: 'Competitor',
        value: formatFieldValue(competitor, 'No competitor tracked'),
        detail: competitor?.instruction || 'Track alternatives or competitors around this account',
        fieldName: 'competitor',
        fieldInstruction: competitor?.instruction || 'Track competitors or alternatives mentioned around this company.',
        fieldId: competitor?.id || null,
        ctaKind: competitor ? 'open_field' : 'create_field',
        ctaLabel: competitor ? 'Open field' : 'Create field',
      },
    ];
  }

  if (kind === 'investor') {
    const concern = pickField(fields, ['investor_concern', 'concern']);
    const interest = pickField(fields, ['interest_level']);
    const process = pickField(fields, ['decision_process']);
    return [
      {
        id: 'investor-concern',
        label: 'Concern',
        value: formatFieldValue(concern, 'No concern tracked'),
        detail: concern?.instruction || 'Track the strongest investor concern',
        tone: concern?.currentValue ? 'warning' : 'default',
        fieldName: 'investor_concern',
        fieldInstruction: concern?.instruction || 'Track the biggest concern or objection this investor currently has.',
        fieldId: concern?.id || null,
        ctaKind: concern ? 'open_field' : 'create_field',
        ctaLabel: concern ? 'Open field' : 'Create field',
      },
      {
        id: 'investor-interest',
        label: 'Interest',
        value: formatFieldValue(interest, 'Unknown'),
        detail: interest?.instruction || 'Track the current investor interest level',
        fieldName: 'interest_level',
        fieldInstruction: interest?.instruction || 'Track the current interest level of this investor from recent interactions.',
        fieldId: interest?.id || null,
        ctaKind: interest ? 'open_field' : 'create_field',
        ctaLabel: interest ? 'Open field' : 'Create field',
      },
      {
        id: 'investor-process',
        label: 'Decision process',
        value: formatFieldValue(process, 'Not mapped yet'),
        detail: process?.instruction || 'Track timeline, partners, and next diligence steps',
        fieldName: 'decision_process',
        fieldInstruction: process?.instruction || 'Track the investor decision process, timeline, and missing steps.',
        fieldId: process?.id || null,
        ctaKind: process ? 'open_field' : 'create_field',
        ctaLabel: process ? 'Open field' : 'Create field',
      },
    ];
  }

  if (kind === 'project') {
    const blocker = pickField(fields, ['blocker']);
    const nextAction = pickField(fields, ['next_action', 'open_task']);
    const activeActions = countActions(actions, ['proposed', 'approved']);
    return [
      {
        id: 'project-blocker',
        label: 'Blocker',
        value: formatFieldValue(blocker, 'No blocker tracked'),
        detail: blocker?.instruction || 'Track the main project blocker',
        tone: blocker?.currentValue ? 'warning' : 'default',
        fieldName: 'blocker',
        fieldInstruction: blocker?.instruction || 'Track the most important blocker slowing this project down.',
        fieldId: blocker?.id || null,
        ctaKind: blocker ? 'open_field' : 'create_field',
        ctaLabel: blocker ? 'Open field' : 'Create field',
      },
      {
        id: 'project-next',
        label: 'Next action',
        value: formatFieldValue(nextAction, 'No next action yet'),
        detail: nextAction?.instruction || 'Track the next concrete project move',
        fieldName: 'next_action',
        fieldInstruction: nextAction?.instruction || 'Track the next concrete action required to move this project forward.',
        fieldId: nextAction?.id || null,
        ctaKind: nextAction ? 'open_field' : 'create_field',
        ctaLabel: nextAction ? 'Open field' : 'Create field',
      },
      {
        id: 'project-activity',
        label: 'Activity',
        value: activeActions > 0 ? `${activeActions} queued` : 'Quiet',
        detail: bundle.recentSummaries[0]?.title || 'No recent summary activity yet',
        tone: activeActions > 0 ? 'positive' : 'default',
        actionId: latestAction(actions, ['proposed', 'approved'])?.id || null,
        ctaKind: latestAction(actions, ['proposed', 'approved']) ? 'open_action' : 'propose_action',
        ctaLabel: latestAction(actions, ['proposed', 'approved']) ? 'Open action' : 'Propose action',
      },
    ];
  }

  if (kind === 'task') {
    const status = pickField(fields, ['status']);
    const owner = pickField(fields, ['owner']);
    const blocker = pickField(fields, ['blocker', 'unresolved_issue']);
    return [
      {
        id: 'task-status',
        label: 'Status',
        value: formatFieldValue(status, 'No status tracked'),
        detail: status?.instruction || 'Track the current task state and latest movement',
        fieldName: 'status',
        fieldInstruction: status?.instruction || 'Track the latest status and state transition for this task.',
        fieldId: status?.id || null,
        ctaKind: status ? 'open_field' : 'create_field',
        ctaLabel: status ? 'Open field' : 'Create field',
      },
      {
        id: 'task-owner',
        label: 'Owner',
        value: formatFieldValue(owner, 'No owner tracked'),
        detail: owner?.instruction || 'Track the current owner and any handoff risk',
        fieldName: 'owner',
        fieldInstruction: owner?.instruction || 'Track who currently owns this task and whether handoff is needed.',
        fieldId: owner?.id || null,
        ctaKind: owner ? 'open_field' : 'create_field',
        ctaLabel: owner ? 'Open field' : 'Create field',
      },
      {
        id: 'task-blocker',
        label: 'Blocker',
        value: formatFieldValue(blocker, 'No blocker tracked'),
        detail: blocker?.instruction || latestAction(actions, ['proposed', 'approved'])?.title || 'Track the blocker preventing this task from closing',
        tone: blocker?.currentValue ? 'warning' : 'default',
        fieldName: 'blocker',
        fieldInstruction: blocker?.instruction || 'Track the blocker preventing this task from being completed.',
        fieldId: blocker?.id || null,
        ctaKind: blocker ? 'open_field' : 'create_field',
        ctaLabel: blocker ? 'Open field' : 'Create field',
      },
    ];
  }

  if (kind === 'workspace') {
    const blocker = pickField(fields, ['blocker']);
    const nextAction = pickField(fields, ['next_action', 'open_task']);
    const activeActions = countActions(actions, ['proposed', 'approved']);
    return [
      {
        id: 'workspace-blocker',
        label: 'Blocker',
        value: formatFieldValue(blocker, 'No blocker tracked'),
        detail: blocker?.instruction || 'Track the main blocker across this workspace',
        tone: blocker?.currentValue ? 'warning' : 'default',
        fieldName: 'blocker',
        fieldInstruction: blocker?.instruction || 'Track the main blocker slowing this workspace down across the current operating lane.',
        fieldId: blocker?.id || null,
        ctaKind: blocker ? 'open_field' : 'create_field',
        ctaLabel: blocker ? 'Open field' : 'Create field',
      },
      {
        id: 'workspace-next',
        label: 'Next action',
        value: formatFieldValue(nextAction, 'No next action yet'),
        detail: nextAction?.instruction || 'Track the clearest next move for this workspace',
        fieldName: 'next_action',
        fieldInstruction: nextAction?.instruction || 'Track the clearest next action needed to move this workspace forward.',
        fieldId: nextAction?.id || null,
        ctaKind: nextAction ? 'open_field' : 'create_field',
        ctaLabel: nextAction ? 'Open field' : 'Create field',
      },
      {
        id: 'workspace-activity',
        label: 'Activity',
        value: activeActions > 0 ? `${activeActions} queued` : 'Quiet',
        detail: bundle.recentSummaries[0]?.title || 'No recent workspace activity yet',
        tone: activeActions > 0 ? 'positive' : 'default',
        actionId: latestAction(actions, ['proposed', 'approved'])?.id || null,
        ctaKind: latestAction(actions, ['proposed', 'approved']) ? 'open_action' : 'propose_action',
        ctaLabel: latestAction(actions, ['proposed', 'approved']) ? 'Open action' : 'Propose action',
      },
    ];
  }

  if (kind === 'meeting') {
    const decision = pickField(fields, ['decision']);
    const objection = pickField(fields, ['objection']);
    const followUp = pickField(fields, ['follow_up', 'next_action']);
    return [
      {
        id: 'meeting-decision',
        label: 'Decision',
        value: formatFieldValue(decision, 'No decision tracked'),
        detail: decision?.instruction || 'Track the clearest meeting decision',
        fieldName: 'decision',
        fieldInstruction: decision?.instruction || 'Track the most important decision reached or still pending from this meeting.',
        fieldId: decision?.id || null,
        ctaKind: decision ? 'open_field' : 'create_field',
        ctaLabel: decision ? 'Open field' : 'Create field',
      },
      {
        id: 'meeting-objection',
        label: 'Objection',
        value: formatFieldValue(objection, 'No objection tracked'),
        detail: objection?.instruction || 'Track pushback or unresolved concerns',
        tone: objection?.currentValue ? 'warning' : 'default',
        fieldName: 'objection',
        fieldInstruction: objection?.instruction || 'Track objections, concerns, or pushback surfaced in this meeting.',
        fieldId: objection?.id || null,
        ctaKind: objection ? 'open_field' : 'create_field',
        ctaLabel: objection ? 'Open field' : 'Create field',
      },
      {
        id: 'meeting-follow-up',
        label: 'Follow-up',
        value: formatFieldValue(followUp, 'No follow-up tracked'),
        detail: followUp?.instruction || latestAction(actions)?.title || 'Turn meeting outcomes into a follow-up action',
        fieldName: 'follow_up',
        fieldInstruction: followUp?.instruction || 'Track the most important follow-up required after this meeting.',
        fieldId: followUp?.id || null,
        ctaKind: followUp ? 'open_field' : 'create_field',
        ctaLabel: followUp ? 'Open field' : 'Create field',
      },
    ];
  }

  return genericSignals(bundle);
}

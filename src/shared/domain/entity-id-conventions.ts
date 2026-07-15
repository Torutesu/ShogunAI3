export interface EntityIdConvention {
  kind: string;
  example: string;
  description: string;
}

export const ENTITY_ID_CONVENTIONS: Record<string, EntityIdConvention> = {
  person: {
    kind: 'person',
    example: 'person:yamada_taro',
    description: 'Individual people such as founders, customers, or internal teammates.',
  },
  company: {
    kind: 'company',
    example: 'company:acme',
    description: 'Customer or partner organizations.',
  },
  project: {
    kind: 'project',
    example: 'project:apollo',
    description: 'Ongoing internal or client projects.',
  },
  workspace: {
    kind: 'workspace',
    example: 'workspace:founder-sales',
    description: 'Workspaces and operating lanes treated as first-class context entities.',
  },
  deal: {
    kind: 'deal',
    example: 'deal:seed-round',
    description: 'Commercial or fundraising opportunities tracked over time.',
  },
  investor: {
    kind: 'investor',
    example: 'investor:sequoia',
    description: 'Investor relationships and fundraising counterparties.',
  },
  meeting: {
    kind: 'meeting',
    example: 'meeting:board-sync-2026-06-28',
    description: 'Meeting sessions and imported conversations.',
  },
  document: {
    kind: 'document',
    example: 'document:pricing-sheet',
    description: 'Tracked docs, decks, or files.',
  },
  task: {
    kind: 'task',
    example: 'task:onboarding-followup',
    description: 'Task-like entities that need explicit tracking.',
  },
  app: {
    kind: 'app',
    example: 'app:cursor',
    description: 'Apps or tools treated as first-class context entities.',
  },
};

export function getEntityIdConvention(kind: string): EntityIdConvention | null {
  const key = String(kind || '').trim().toLowerCase();
  return ENTITY_ID_CONVENTIONS[key] || null;
}

export function buildEntityConventionExamples(kinds: string[]): EntityIdConvention[] {
  return kinds
    .map((kind) => getEntityIdConvention(kind))
    .filter((item): item is EntityIdConvention => Boolean(item));
}

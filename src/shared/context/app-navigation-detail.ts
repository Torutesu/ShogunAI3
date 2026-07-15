// Navigation payload shape shared across the app (native navigation dispatch)
// and shared-layer panels that need to construct/consume it. Lives in `shared`
// so shared-layer consumers don't have to import from `app` (boundaries rule).
export type AppNavigationDetail = {
  screen?: string | null;
  settingsPane?: string | null;
  entityId?: string | null;
  meetingId?: string | null;
  workspaceId?: string | null;
  memoryId?: string | null;
  query?: string | null;
  view?: 'river' | 'search' | string | null;
  aiFieldId?: string | null;
  actionId?: string | null;
  queueId?: string | null;
  sourceActionId?: string | null;
  openAudit?: boolean | null;
  text?: string | null;
  webSearch?: boolean | null;
  assembleMemory?: boolean | null;
  autoSend?: boolean | null;
  newChat?: boolean | null;
  memoryAssemblyQuery?: string | null;
  memoryAssemblyLimit?: number | null;
  memoryAssemblySemantic?: boolean | null;
};

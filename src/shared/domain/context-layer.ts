export type ContextEntityKind =
  | 'person'
  | 'company'
  | 'project'
  | 'workspace'
  | 'deal'
  | 'investor'
  | 'meeting'
  | 'document'
  | 'task'
  | 'app';

export type ContextEventKind =
  | 'email_received'
  | 'email_sent'
  | 'meeting_started'
  | 'meeting_transcribed'
  | 'browser_page_viewed'
  | 'document_edited'
  | 'slack_message'
  | 'github_issue_updated'
  | 'file_opened'
  | 'screen_context_captured';

export interface ContextEntityRecord {
  id: string;
  kind: ContextEntityKind;
  label: string;
  summary?: string | null;
  sourceIds: string[];
  relatedEntityIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ContextEventRecord {
  id: string;
  kind: ContextEventKind;
  title: string;
  sourceId: string;
  ownerEntityId: string | null;
  relatedEntityIds: string[];
  occurredAt: number;
  capturedAt: number;
  contentText?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface ContextMemoryRecord {
  id: string;
  title: string;
  summary: string;
  confidence: number | null;
  sourceEventIds: string[];
  relatedEntityIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ContextRelationshipRecord {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  relationshipType: string;
  confidence: number | null;
  sourceEventIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ContextSourceRecord {
  id: string;
  sourceType: string;
  externalId: string | null;
  displayName: string;
  syncStatus: 'active' | 'paused' | 'error';
  lastSyncedAt: number | null;
}

export interface ContextPermissionRecord {
  id: string;
  scope: string;
  resourceType: string;
  resourceId: string | null;
  actor: string;
  effect: 'allow' | 'deny';
  reason: string;
  updatedAt: number;
}

export interface ContextAuditLogRecord {
  id: string;
  actor: string;
  objectType: 'ai_field' | 'action' | 'memory' | 'permission';
  objectId: string;
  eventType: string;
  detail: string;
  payload: unknown | null;
  evidenceEventIds: string[];
  createdAt: number;
}

export interface AiFieldRecord {
  id: string;
  ownerEntityId: string;
  fieldName: string;
  instruction: string;
  currentValue: string;
  confidence: number | null;
  evidenceEventIds: string[];
  createdAt: number;
  lastUpdatedAt: number;
}

export interface AiFieldUpsertInput {
  id?: string;
  ownerEntityId: string;
  fieldName: string;
  instruction: string;
  currentValue?: string;
  confidence?: number | null;
  evidenceEventIds?: string[];
}

export type ContextActionStatus = 'proposed' | 'approved' | 'executed' | 'rejected';
export type ContextActionRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ContextActionRecord {
  id: string;
  ownerEntityId: string;
  actionType: string;
  title: string;
  detail: string;
  status: ContextActionStatus;
  riskLevel: ContextActionRiskLevel;
  sourceAiFieldId: string | null;
  evidenceEventIds: string[];
  executionResult: unknown | null;
  executedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ContextActionAuditEvent {
  id: string;
  actionId: string;
  eventType: 'proposed' | 'status_changed' | 'executed';
  actor: string;
  fromStatus: ContextActionStatus | null;
  toStatus: ContextActionStatus | null;
  detail: string;
  payload: unknown | null;
  createdAt: number;
}

export interface EntitySummaryRecord {
  targetKind: string;
  targetId: string;
  title: string;
  keyPoints: string[];
  sourceType: string;
  priority: string;
  reason?: string | null;
  model: string;
  schemaVersion: number;
  generatedAt: number;
  lang?: string;
}

export interface EntityContextRecord {
  entityId: string;
  entityLabel: string;
  lang: string;
  rollup: EntitySummaryRecord | null;
  recentSummaries: EntitySummaryRecord[];
  aiFields: AiFieldRecord[];
  actions: ContextActionRecord[];
}

export interface QueueArtifactRecord {
  id: string;
  createdAt: number;
  payload?: Record<string, unknown>;
  provenance?: {
    sourceAction?: {
      id: string;
      status: string;
      riskLevel: string;
      title: string;
    } | null;
    latestAudit?: {
      eventType: string;
      detail: string;
    } | null;
  } | null;
}

export interface OwnerContextSummaryRecord {
  ownerEntityId: string;
  entityContext: EntityContextRecord | null;
  aiFields: {
    items: AiFieldRecord[];
    total: number;
  };
  actions: {
    items: ContextActionRecord[];
    total: number;
  };
  queueArtifacts: {
    items: QueueArtifactRecord[];
    total: number;
  };
  latestAudits: Array<{
    actionId: string;
    latestAudit: ContextAuditLogRecord | null;
  }>;
  summary: {
    aiFieldCount: number;
    actionCount: number;
    queueArtifactCount: number;
    actionStatusCounts: Record<string, number>;
  };
}

export interface ContextActionProposeInput {
  id?: string;
  ownerEntityId: string;
  actionType: string;
  title: string;
  detail?: string;
  status?: ContextActionStatus;
  riskLevel?: ContextActionRiskLevel;
  sourceAiFieldId?: string | null;
  evidenceEventIds?: string[];
}

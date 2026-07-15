import type { AppNavigationDetail } from '@/shared/context/app-navigation-detail';
import { focusAiField } from '@/shared/context/ai-field-focus';
import { focusActionTrace } from '@/shared/context/action-trace-focus';
import { openChatWithSeed } from '@/shared/context/chat-composer-seed';
import { focusEntity } from '@/shared/context/entity-focus';
import { openQueueArtifactInActions } from '@/shared/context/open-queue-artifact';
import {
  jumpToMemorySearch,
  jumpToMemoryTimeline,
  openMeetingDetail,
  openNativeDetailForEntityId,
  openWorkspaceDetail,
} from '@/shared/context/context-target-navigation';

export type { AppNavigationDetail } from '@/shared/context/app-navigation-detail';

export function historicalImportResultNavigation(succeeded: boolean): AppNavigationDetail {
  return succeeded ? { screen: 'memory' } : { settingsPane: 'integrations' };
}

export function historicalImportProgressNavigation(progress: {
  provider?: string | null;
  phase?: string | null;
} | null | undefined, activeProvider?: string | null): AppNavigationDetail | null {
  const provider = normalized(progress?.provider);
  const phase = normalized(progress?.phase).toLowerCase();
  const currentProvider = normalized(activeProvider);
  if (!provider || !currentProvider || provider !== currentProvider || phase !== 'done') {
    return null;
  }
  return historicalImportResultNavigation(true);
}

function normalized(value: unknown): string {
  return String(value || '').trim();
}

function normalizeScreenId(value: unknown): string {
  const screen = normalized(value).toLowerCase();
  if (!screen) return '';
  switch (screen) {
    case 'founder-sales':
      return 'founder_sales';
    case 'project-memory':
      return 'project_memory';
    case 'entity-context':
      return 'entity_context';
    case 'ai-fields':
      return 'ai_fields';
    default:
      return screen;
  }
}

function memoryView(value: unknown): 'river' | 'search' {
  return normalized(value) === 'search' ? 'search' : 'river';
}

export function applyNativeNavigation(
  detail: AppNavigationDetail,
  handlers: {
    setActiveScreen: (screenId: string) => void;
    openSettingsPane?: (paneId: string) => void;
  },
): boolean {
  const { setActiveScreen, openSettingsPane } = handlers;
  const screen = normalizeScreenId(detail.screen);
  const settingsPane = normalized(detail.settingsPane);
  const entityId = normalized(detail.entityId);
  const meetingId = normalized(detail.meetingId);
  const workspaceId = normalized(detail.workspaceId);
  const memoryId = normalized(detail.memoryId);
  const query = normalized(detail.query);
  const aiFieldId = normalized(detail.aiFieldId);
  const actionId = normalized(detail.actionId);
  const queueId = normalized(detail.queueId);
  const sourceActionId = normalized(detail.sourceActionId);
  const view = memoryView(detail.view);
  const text = normalized(detail.text);

  if (meetingId) {
    openMeetingDetail(meetingId);
    return true;
  }

  if (workspaceId) {
    openWorkspaceDetail(workspaceId);
    return true;
  }

  if (memoryId) {
    jumpToMemoryTimeline({ memoryId, query, view });
    return true;
  }

  if (screen === 'memory' && query) {
    jumpToMemorySearch(query, view);
    return true;
  }

  if (screen === 'chat' && text) {
    const memoryAssemblyLimit = Number.isFinite(Number(detail.memoryAssemblyLimit))
      ? Number(detail.memoryAssemblyLimit)
      : null;
    openChatWithSeed({
      text,
      webSearch: detail.webSearch === true,
      assembleMemory: detail.assembleMemory !== false,
      autoSend: detail.autoSend === true,
      newChat: detail.newChat === true,
      memoryAssemblyQuery: normalized(detail.memoryAssemblyQuery),
      memoryAssemblySemantic: detail.memoryAssemblySemantic !== false,
      ...(memoryAssemblyLimit != null ? { memoryAssemblyLimit } : {}),
    });
    return true;
  }

  if (screen === 'settings' && openSettingsPane) {
    openSettingsPane(settingsPane || 'general');
    return true;
  }

  if (queueId) {
    if (entityId) focusEntity(entityId);
    openQueueArtifactInActions({
      queueId,
      sourceActionId: sourceActionId || actionId || null,
      sourceAiFieldId: aiFieldId || null,
      ownerEntityId: entityId || null,
    });
    return true;
  }

  if (aiFieldId) {
    focusAiField(aiFieldId);
    if (entityId) focusEntity(entityId);
    setActiveScreen('ai_fields');
    return true;
  }

  if (actionId) {
    focusActionTrace({ actionId, aiFieldId: null, openAudit: detail.openAudit === true });
    if (entityId) focusEntity(entityId);
    setActiveScreen('actions');
    return true;
  }

  if (entityId) {
    focusEntity(entityId);
    if (screen === 'entity_context' || screen === 'ai_fields' || screen === 'actions') {
      setActiveScreen(screen);
      return true;
    }
    if (openNativeDetailForEntityId(entityId)) {
      return true;
    }
    setActiveScreen('entity_context');
    return true;
  }

  if (screen) {
    setActiveScreen(screen);
    return true;
  }

  if (settingsPane && openSettingsPane) {
    openSettingsPane(settingsPane);
    return true;
  }

  return false;
}

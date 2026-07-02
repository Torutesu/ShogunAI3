import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyNativeNavigation,
  historicalImportProgressNavigation,
  historicalImportResultNavigation,
} from './native-navigation';

const focusAiFieldMock = vi.fn();
const focusActionTraceMock = vi.fn();
const focusEntityMock = vi.fn();
const openChatWithSeedMock = vi.fn();
const openQueueArtifactInActionsMock = vi.fn();
const jumpToMemorySearchMock = vi.fn();
const jumpToMemoryTimelineMock = vi.fn();
const openMeetingDetailMock = vi.fn();
const openNativeDetailForEntityIdMock = vi.fn();
const openWorkspaceDetailMock = vi.fn();

vi.mock('@/shared/context/ai-field-focus', () => ({
  focusAiField: (...args: unknown[]) => focusAiFieldMock(...args),
}));

vi.mock('@/shared/context/action-trace-focus', () => ({
  focusActionTrace: (...args: unknown[]) => focusActionTraceMock(...args),
}));

vi.mock('@/shared/context/entity-focus', () => ({
  focusEntity: (...args: unknown[]) => focusEntityMock(...args),
}));

vi.mock('@/shared/context/chat-composer-seed', () => ({
  openChatWithSeed: (...args: unknown[]) => openChatWithSeedMock(...args),
}));

vi.mock('@/shared/context/open-queue-artifact', () => ({
  openQueueArtifactInActions: (...args: unknown[]) => openQueueArtifactInActionsMock(...args),
}));

vi.mock('@/shared/context/context-target-navigation', () => ({
  jumpToMemorySearch: (...args: unknown[]) => jumpToMemorySearchMock(...args),
  jumpToMemoryTimeline: (...args: unknown[]) => jumpToMemoryTimelineMock(...args),
  openMeetingDetail: (...args: unknown[]) => openMeetingDetailMock(...args),
  openNativeDetailForEntityId: (...args: unknown[]) => openNativeDetailForEntityIdMock(...args),
  openWorkspaceDetail: (...args: unknown[]) => openWorkspaceDetailMock(...args),
}));

describe('applyNativeNavigation', () => {
  const setActiveScreen = vi.fn();
  const openSettingsPane = vi.fn();

  beforeEach(() => {
    setActiveScreen.mockReset();
    openSettingsPane.mockReset();
    focusAiFieldMock.mockReset();
    focusActionTraceMock.mockReset();
    focusEntityMock.mockReset();
    openChatWithSeedMock.mockReset();
    openQueueArtifactInActionsMock.mockReset();
    jumpToMemorySearchMock.mockReset();
    jumpToMemoryTimelineMock.mockReset();
    openMeetingDetailMock.mockReset();
    openNativeDetailForEntityIdMock.mockReset();
    openWorkspaceDetailMock.mockReset();
  });

  it('opens meeting detail directly when a meeting id is provided', () => {
    expect(applyNativeNavigation({ screen: 'meetings', meetingId: 'mtg-1' }, { setActiveScreen, openSettingsPane })).toBe(true);
    expect(openMeetingDetailMock).toHaveBeenCalledWith('mtg-1');
  });

  it('opens workspace detail directly when a workspace id is provided', () => {
    expect(applyNativeNavigation({ screen: 'work', workspaceId: 'apollo' }, { setActiveScreen, openSettingsPane })).toBe(true);
    expect(openWorkspaceDetailMock).toHaveBeenCalledWith('apollo');
  });

  it('jumps to a concrete memory item when a memory id is provided', () => {
    expect(applyNativeNavigation({ screen: 'memory', memoryId: 'mem-1', query: 'Aurora', view: 'river' }, { setActiveScreen, openSettingsPane })).toBe(true);
    expect(jumpToMemoryTimelineMock).toHaveBeenCalledWith({
      memoryId: 'mem-1',
      query: 'Aurora',
      view: 'river',
    });
  });

  it('jumps to memory search when only a memory query is provided', () => {
    expect(applyNativeNavigation({ screen: 'memory', query: 'security review', view: 'search' }, { setActiveScreen, openSettingsPane })).toBe(true);
    expect(jumpToMemorySearchMock).toHaveBeenCalledWith('security review', 'search');
  });

  it('opens chat with a seeded composer payload from native callers', () => {
    expect(applyNativeNavigation({
      screen: 'chat',
      text: 'Summarize the Aurora follow-up.',
      newChat: true,
      autoSend: true,
      assembleMemory: true,
      memoryAssemblyQuery: 'company:aurora',
      memoryAssemblyLimit: 18,
      memoryAssemblySemantic: false,
    }, { setActiveScreen, openSettingsPane })).toBe(true);
    expect(openChatWithSeedMock).toHaveBeenCalledWith({
      text: 'Summarize the Aurora follow-up.',
      webSearch: false,
      assembleMemory: true,
      autoSend: true,
      newChat: true,
      memoryAssemblyQuery: 'company:aurora',
      memoryAssemblyLimit: 18,
      memoryAssemblySemantic: false,
    });
    expect(setActiveScreen).not.toHaveBeenCalled();
  });

  it('focuses ai fields with the supplied entity owner', () => {
    expect(applyNativeNavigation({ aiFieldId: 'field-1', entityId: 'deal:aurora' }, { setActiveScreen, openSettingsPane })).toBe(true);
    expect(focusAiFieldMock).toHaveBeenCalledWith('field-1');
    expect(focusEntityMock).toHaveBeenCalledWith('deal:aurora');
    expect(setActiveScreen).toHaveBeenCalledWith('ai_fields');
  });

  it('focuses actions with optional audit mode and owner context', () => {
    expect(applyNativeNavigation({ actionId: 'act-1', entityId: 'workspace:apollo', openAudit: true }, { setActiveScreen, openSettingsPane })).toBe(true);
    expect(focusActionTraceMock).toHaveBeenCalledWith({
      actionId: 'act-1',
      aiFieldId: null,
      openAudit: true,
    });
    expect(focusEntityMock).toHaveBeenCalledWith('workspace:apollo');
    expect(setActiveScreen).toHaveBeenCalledWith('actions');
  });

  it('opens queued artifacts in Actions with optional owner context', () => {
    expect(
      applyNativeNavigation(
        { queueId: 'queue-1', sourceActionId: 'act-queue-1', aiFieldId: 'af-queue-1', entityId: 'workspace:apollo' },
        { setActiveScreen, openSettingsPane },
      ),
    ).toBe(true);
    expect(focusEntityMock).toHaveBeenCalledWith('workspace:apollo');
    expect(openQueueArtifactInActionsMock).toHaveBeenCalledWith({
      queueId: 'queue-1',
      sourceActionId: 'act-queue-1',
      sourceAiFieldId: 'af-queue-1',
      ownerEntityId: 'workspace:apollo',
    });
    expect(setActiveScreen).not.toHaveBeenCalled();
  });

  it('opens entity-oriented screens when an entity id is provided', () => {
    expect(applyNativeNavigation({ screen: 'entity_context', entityId: 'company:aurora' }, { setActiveScreen, openSettingsPane })).toBe(true);
    expect(focusEntityMock).toHaveBeenCalledWith('company:aurora');
    expect(setActiveScreen).toHaveBeenCalledWith('entity_context');
  });

  it('normalizes kebab-case screen ids from native callers', () => {
    expect(applyNativeNavigation({ screen: 'founder-sales' }, { setActiveScreen, openSettingsPane })).toBe(true);
    expect(setActiveScreen).toHaveBeenCalledWith('founder_sales');
  });

  it('falls back to native detail routing for meeting/workspace entity ids', () => {
    openNativeDetailForEntityIdMock.mockReturnValue(true);
    expect(applyNativeNavigation({ entityId: 'workspace:apollo' }, { setActiveScreen, openSettingsPane })).toBe(true);
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('workspace:apollo');
    expect(setActiveScreen).not.toHaveBeenCalled();
  });

  it('opens settings panes from native callers when requested', () => {
    expect(applyNativeNavigation({ settingsPane: 'integrations' }, { setActiveScreen, openSettingsPane })).toBe(true);
    expect(openSettingsPane).toHaveBeenCalledWith('integrations');
    expect(setActiveScreen).not.toHaveBeenCalled();
  });

  it('routes settings screen payloads into the settings pane handler', () => {
    expect(applyNativeNavigation({ screen: 'settings', settingsPane: 'privacy' }, { setActiveScreen, openSettingsPane })).toBe(true);
    expect(openSettingsPane).toHaveBeenCalledWith('privacy');
    expect(setActiveScreen).not.toHaveBeenCalled();
  });

  it('defaults plain settings screen payloads to the general pane', () => {
    expect(applyNativeNavigation({ screen: 'settings' }, { setActiveScreen, openSettingsPane })).toBe(true);
    expect(openSettingsPane).toHaveBeenCalledWith('general');
    expect(setActiveScreen).not.toHaveBeenCalled();
  });

  it('returns false when no usable navigation target is supplied', () => {
    expect(applyNativeNavigation({}, { setActiveScreen, openSettingsPane })).toBe(false);
  });
});

describe('historicalImportResultNavigation', () => {
  it('routes successful imports to Memory', () => {
    expect(historicalImportResultNavigation(true)).toEqual({ screen: 'memory' });
  });

  it('routes failed imports back to Integrations settings', () => {
    expect(historicalImportResultNavigation(false)).toEqual({ settingsPane: 'integrations' });
  });
});

describe('historicalImportProgressNavigation', () => {
  it('routes matching done events to Memory', () => {
    expect(
      historicalImportProgressNavigation(
        { provider: 'gmail', phase: 'done' },
        'gmail',
      ),
    ).toEqual({ screen: 'memory' });
  });

  it('ignores non-matching or incomplete progress events', () => {
    expect(
      historicalImportProgressNavigation(
        { provider: 'slack', phase: 'pages' },
        'slack',
      ),
    ).toBeNull();
    expect(
      historicalImportProgressNavigation(
        { provider: 'gmail', phase: 'done' },
        'google_drive',
      ),
    ).toBeNull();
  });
});

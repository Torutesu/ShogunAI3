import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RecentContextCard } from './RecentContextCard';
import { ACTION_LAYER_REFRESH_EVENT } from '@/shared/context/action-layer-events';
import {
  clearQueueArtifactFocus,
  readQueueArtifactFocus,
} from '@/shared/context/queue-artifact-focus';

const runRuntimeActionMock = vi.fn();
const focusEntityMock = vi.fn();
const focusAiFieldMock = vi.fn();
const focusActionTraceMock = vi.fn();
const openChatWithSeedMock = vi.fn();
const buildEntityChatSeedMock = vi.fn((input) => ({ text: `entity:${input.entityId}` }));
const buildFieldChatSeedMock = vi.fn((input) => ({ text: `field:${input.ownerEntityId}` }));
const buildActionChatSeedMock = vi.fn((input) => ({ text: `action:${input.ownerEntityId}` }));
const openContextTargetMock = vi.fn();
const nativeDetailDescriptorForEntityIdMock = vi.fn((entityId: string) => {
  const normalized = String(entityId || '').trim();
  if (normalized.startsWith('meeting:')) {
    return { kind: 'meeting', id: normalized.slice('meeting:'.length), label: 'Open Meeting Detail' };
  }
  if (normalized.startsWith('workspace:')) {
    return { kind: 'workspace', id: normalized.slice('workspace:'.length), label: 'Open Workspace Detail' };
  }
  return null;
});
const openNativeDetailForEntityIdMock = vi.fn((entityId: string) => {
  const normalized = String(entityId || '').trim();
  if (normalized.startsWith('meeting:')) {
    (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('meetings');
    window.dispatchEvent(
      new CustomEvent('shogun-open-meeting-detail', {
        detail: { meetingId: normalized.slice('meeting:'.length) },
      }),
    );
    return true;
  }
  if (normalized.startsWith('workspace:')) {
    (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('work');
    window.dispatchEvent(
      new CustomEvent('shogun-open-workspace-detail', {
        detail: { workspaceId: normalized.slice('workspace:'.length) },
      }),
    );
    return true;
  }
  return false;
});

vi.mock('@/shared/ipc/runtime-actions', () => ({
  runRuntimeAction: (...args: unknown[]) => runRuntimeActionMock(...args),
}));

vi.mock('@/shared/context/entity-focus', () => ({
  focusEntity: (...args: unknown[]) => focusEntityMock(...args),
}));

vi.mock('@/shared/context/ai-field-focus', () => ({
  focusAiField: (...args: unknown[]) => focusAiFieldMock(...args),
}));

vi.mock('@/shared/context/action-trace-focus', () => ({
  focusActionTrace: (...args: unknown[]) => focusActionTraceMock(...args),
}));

vi.mock('@/shared/context/context-target-navigation', () => ({
  nativeDetailDescriptorForEntityId: (entityId: string) => nativeDetailDescriptorForEntityIdMock(entityId),
  openContextTarget: (...args: unknown[]) => openContextTargetMock(...args),
  openNativeDetailForEntityId: (entityId: string) => openNativeDetailForEntityIdMock(entityId),
}));

vi.mock('@/shared/context/chat-composer-seed', () => ({
  buildEntityChatSeed: (...args: any[]) => buildEntityChatSeedMock(args[0]),
  buildFieldChatSeed: (...args: any[]) => buildFieldChatSeedMock(args[0]),
  buildActionChatSeed: (...args: any[]) => buildActionChatSeedMock(args[0]),
  openChatWithSeed: (...args: any[]) => openChatWithSeedMock(args[0]),
}));

describe('RecentContextCard', () => {
  beforeEach(() => {
    runRuntimeActionMock.mockReset();
    focusEntityMock.mockReset();
    focusAiFieldMock.mockReset();
    focusActionTraceMock.mockReset();
    openChatWithSeedMock.mockReset();
    buildEntityChatSeedMock.mockClear();
    buildFieldChatSeedMock.mockClear();
    buildActionChatSeedMock.mockClear();
    openContextTargetMock.mockReset();
    nativeDetailDescriptorForEntityIdMock.mockClear();
    openNativeDetailForEntityIdMock.mockClear();
    clearQueueArtifactFocus();
    (window as any).SHOGUN_RUNTIME = { setActiveScreen: vi.fn() };
  });

  it('loads owner summaries into the desktop Home context card', async () => {
    const onOpenMeetingDetail = vi.fn();
    window.addEventListener('shogun-open-meeting-detail', onOpenMeetingDetail as EventListener);
    runRuntimeActionMock.mockImplementation((actionKey: string, payload?: any) => {
      if (actionKey === 'context.recent.get') {
        return Promise.resolve({
          ok: true,
          data: {
            recentAiFields: {
              items: [
                {
                  id: 'af-1',
                  ownerEntityId: 'company:aurora',
                  fieldName: 'blocker',
                  instruction: 'Track current blocker',
                  currentValue: 'Security review pending',
                  evidenceEventIds: ['mem-1'],
                },
              ],
              total: 1,
            },
            recentActions: {
              items: [
                {
                  id: 'act-1',
                  ownerEntityId: 'company:aurora',
                  actionType: 'follow_up_email_draft',
                  title: 'Draft security follow-up',
                  detail: 'Cover owner and delivery date.',
                  status: 'approved',
                  riskLevel: 'medium',
                  sourceAiFieldId: 'af-1',
                },
              ],
              total: 1,
            },
            recentQueueArtifacts: {
              items: [
                {
                  id: 'queue-1',
                  createdAt: 1719622800000,
                  payload: {
                    title: 'Queue onboarding checklist',
                    detail: 'Send task list after approval.',
                    owner_entity_id: 'company:aurora',
                    source_action_id: 'act-1',
                  },
                  provenance: {
                    sourceAction: {
                      id: 'act-1',
                      status: 'approved',
                      riskLevel: 'medium',
                      title: 'Draft security follow-up',
                    },
                    latestAudit: {
                      eventType: 'approved',
                      detail: 'Approved for queue execution',
                    },
                  },
                },
              ],
              total: 1,
            },
            recentMeetings: [
              {
                id: 'mtg-1',
                title: 'Aurora sync',
                started_at: '2026-06-29T01:00:00',
              },
            ],
          },
        });
      }
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: String(payload?.ownerEntityId || 'company:aurora'),
            aiFields: {
              items: [
                {
                  id: 'af-1',
                  ownerEntityId: 'company:aurora',
                  fieldName: 'blocker',
                  instruction: 'Track current blocker',
                  currentValue: 'Security review pending',
                  evidenceEventIds: ['mem-1'],
                },
              ],
              total: 1,
            },
            actions: {
              items: [
                {
                  id: 'act-1',
                  ownerEntityId: 'company:aurora',
                  actionType: 'follow_up_email_draft',
                  title: 'Draft security follow-up',
                  detail: 'Cover owner and delivery date.',
                  status: 'approved',
                  riskLevel: 'medium',
                  sourceAiFieldId: 'af-1',
                },
              ],
              total: 1,
            },
            queueArtifacts: {
              items: [
                {
                  id: 'sch-1',
                  payload: {
                    title: 'Send onboarding checklist',
                    owner_entity_id: 'workspace:apollo',
                    source_action_id: 'act-queue-1',
                  },
                },
              ],
              total: 1,
            },
            latestAudits: [
              {
                actionId: 'act-1',
                latestAudit: {
                  id: 'audit-1',
                  eventType: 'approved',
                  detail: 'Approved for queue execution',
                },
              },
            ],
            summary: {
              aiFieldCount: 1,
              actionCount: 1,
              queueArtifactCount: 1,
              actionStatusCounts: {
                proposed: 0,
                approved: 1,
                executed: 0,
                rejected: 0,
              },
            },
          },
        });
      }
      if (actionKey === 'context.search') {
        return Promise.resolve({ ok: true, data: { timeline: { hits: [], total: 0 }, aiFields: { items: [], total: 0 }, actions: { items: [], total: 0 } } });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(<RecentContextCard />);

    await waitFor(() => {
      expect(screen.getByText('OWNER SUMMARIES')).toBeInTheDocument();
    });

    expect(screen.getAllByText('company:aurora').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Latest action: Draft security follow-up [approved]').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Latest queue: Send onboarding checklist').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Latest audit: Approved for queue execution').length).toBeGreaterThan(0);
    expect(screen.getByText('QUEUE ARTIFACTS')).toBeInTheDocument();
    expect(screen.getByText('Queue onboarding checklist')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Entity Context' })[0] as HTMLElement);
    expect(openContextTargetMock).toHaveBeenCalledWith({ targetId: 'company:aurora' });

    fireEvent.click(screen.getByRole('button', { name: 'Open Action' }));
    expect(focusActionTraceMock).toHaveBeenCalledWith({ actionId: 'act-1', aiFieldId: 'af-1', openAudit: false });

    const actionsButtons = screen.getAllByRole('button', { name: 'Actions' });
    expect(actionsButtons.length).toBeGreaterThan(1);
    fireEvent.click(actionsButtons[1] as HTMLElement);
    expect(focusActionTraceMock).toHaveBeenCalledWith({ actionId: 'act-1', aiFieldId: 'af-1', openAudit: false });
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');

    fireEvent.click(screen.getAllByRole('button', { name: 'Open queued action' })[0] as HTMLElement);
    expect(focusActionTraceMock).toHaveBeenCalledWith({ actionId: 'act-queue-1', aiFieldId: null, openAudit: false });
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');

    fireEvent.click(screen.getAllByRole('button', { name: 'Open queue item' })[0] as HTMLElement);
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');
    expect(readQueueArtifactFocus()).toEqual({
      queueId: 'sch-1',
      sourceActionId: 'act-queue-1',
      sourceAiFieldId: null,
      ownerEntityId: 'workspace:apollo',
    });

    fireEvent.click(screen.getAllByRole('button', { name: 'Open Workspace Detail' })[0] as HTMLElement);
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('workspace:apollo');

    const aiFieldsButtons = screen.getAllByRole('button', { name: 'AI Fields' });
    expect(aiFieldsButtons.length).toBeGreaterThan(1);
    fireEvent.click(aiFieldsButtons[1] as HTMLElement);
    expect(focusEntityMock).toHaveBeenCalledWith('company:aurora');
    expect(focusAiFieldMock).toHaveBeenCalledWith('af-1');
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('ai_fields');

    fireEvent.click(screen.getAllByRole('button', { name: 'Open Audit' })[0] as HTMLElement);
    expect(focusActionTraceMock).toHaveBeenCalledWith({ actionId: 'act-1', aiFieldId: 'af-1', openAudit: true });
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');

    const askChatButtons = screen.getAllByRole('button', { name: 'Ask Chat' });
    expect(askChatButtons.length).toBeGreaterThan(1);
    fireEvent.click(askChatButtons[1] as HTMLElement);
    expect(buildEntityChatSeedMock).toHaveBeenCalledWith({
      entityId: 'company:aurora',
      entityLabel: 'company:aurora',
      fieldLabel: 'blocker = Security review pending',
      actionLabel: 'Draft security follow-up [approved]',
    });
    expect(openChatWithSeedMock).toHaveBeenCalledWith({ text: 'entity:company:aurora' });

    const openButtons = screen.getAllByRole('button', { name: 'Open' });
    fireEvent.click(openButtons[openButtons.length - 1] as HTMLElement);
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('meetings');

    await waitFor(() => {
      expect((onOpenMeetingDetail.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ meetingId: 'mtg-1' });
    });

    const contextButtons = screen.getAllByRole('button', { name: 'Context' });
    expect(contextButtons.length).toBeGreaterThan(0);
    fireEvent.click(contextButtons[contextButtons.length - 1] as HTMLElement);
    expect(openContextTargetMock).toHaveBeenCalledWith({ targetId: 'meeting:mtg-1' });

    const allAskChatButtons = screen.getAllByRole('button', { name: 'Ask Chat' });
    fireEvent.click(allAskChatButtons[allAskChatButtons.length - 2] as HTMLElement);
    expect(buildEntityChatSeedMock).toHaveBeenCalledWith({
      entityId: 'company:aurora',
      entityLabel: 'company:aurora',
      fieldLabel: null,
      actionLabel: 'Queue onboarding checklist',
    });
    expect(openChatWithSeedMock).toHaveBeenCalledWith({ text: 'entity:company:aurora' });

    fireEvent.click(allAskChatButtons[allAskChatButtons.length - 1] as HTMLElement);
    expect(buildEntityChatSeedMock).toHaveBeenCalledWith({
      entityId: 'meeting:mtg-1',
      entityLabel: 'Aurora sync',
      fieldLabel: null,
      actionLabel: null,
    });
    expect(openChatWithSeedMock).toHaveBeenCalledWith({ text: 'entity:meeting:mtg-1' });

  });

  it('shows native detail CTA for meeting owner summaries and routes via shared helper', async () => {
    const onOpenMeetingDetail = vi.fn();
    window.addEventListener('shogun-open-meeting-detail', onOpenMeetingDetail as EventListener);
    runRuntimeActionMock.mockImplementation((actionKey: string, payload?: any) => {
      if (actionKey === 'context.recent.get') {
        return Promise.resolve({
          ok: true,
          data: {
            recentAiFields: {
              items: [
                {
                  id: 'af-meeting-1',
                  ownerEntityId: 'meeting:mtg-42',
                  fieldName: 'next_action',
                  instruction: 'Track next step',
                  currentValue: 'Send recap',
                  evidenceEventIds: ['meeting:mtg-42'],
                },
              ],
              total: 1,
            },
            recentActions: { items: [], total: 0 },
            recentMeetings: [],
          },
        });
      }
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: String(payload?.ownerEntityId || 'meeting:mtg-42'),
            aiFields: {
              items: [
                {
                  id: 'af-meeting-1',
                  ownerEntityId: 'meeting:mtg-42',
                  fieldName: 'next_action',
                  instruction: 'Track next step',
                  currentValue: 'Send recap',
                  evidenceEventIds: ['meeting:mtg-42'],
                },
              ],
              total: 1,
            },
            actions: { items: [], total: 0 },
            queueArtifacts: { items: [], total: 0 },
            latestAudits: [],
            summary: {
              aiFieldCount: 1,
              actionCount: 0,
              queueArtifactCount: 0,
              actionStatusCounts: {
                proposed: 0,
                approved: 0,
                executed: 0,
                rejected: 0,
              },
            },
          },
        });
      }
      if (actionKey === 'context.search') {
        return Promise.resolve({ ok: true, data: { timeline: { hits: [], total: 0 }, aiFields: { items: [], total: 0 }, actions: { items: [], total: 0 } } });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(<RecentContextCard />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open Meeting Detail' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open Meeting Detail' }));
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('meeting:mtg-42');
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('meetings');
    await waitFor(() => {
      expect((onOpenMeetingDetail.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ meetingId: 'mtg-42' });
    });

    window.removeEventListener('shogun-open-meeting-detail', onOpenMeetingDetail as EventListener);
  });

  it('shows entity and native-detail actions for timeline search hits', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'context.recent.get') {
        return Promise.resolve({
          ok: true,
          data: {
            recentAiFields: {
              items: [
                {
                  id: 'af-workspace-1',
                  ownerEntityId: 'workspace:apollo',
                  fieldName: 'next_action',
                  instruction: 'Track workspace follow-up',
                  currentValue: 'Capture diligence asks',
                  evidenceEventIds: [],
                },
              ],
              total: 1,
            },
            recentActions: { items: [], total: 0 },
            recentMeetings: [],
          },
        });
      }
      if (actionKey === 'context.search') {
        return Promise.resolve({
          ok: true,
          data: {
            timeline: {
              hits: [
                {
                  targetId: 'workspace:apollo',
                  targetKind: 'workspace',
                  title: 'Apollo workspace follow-ups',
                  keyPoints: ['Capture diligence asks in the workspace.'],
                },
              ],
              total: 1,
            },
            aiFields: { items: [], total: 0 },
            actions: { items: [], total: 0 },
          },
        });
      }
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({ ok: true, data: null });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(<RecentContextCard />);

    fireEvent.change(screen.getByPlaceholderText('budget / blocker / Apollo / investor concern'), {
      target: { value: 'Apollo' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => {
      expect(screen.getByText('Apollo workspace follow-ups')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Entity Context' }));
    expect(openContextTargetMock).toHaveBeenCalledWith({ targetId: 'workspace:apollo' });

    fireEvent.click(screen.getByRole('button', { name: 'Open Workspace Detail' }));
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('workspace:apollo');
  });

  it('reruns shared context search after a refresh event when a query is active', async () => {
    let searchCount = 0;
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'context.recent.get') {
        return Promise.resolve({
          ok: true,
          data: {
            recentAiFields: { items: [], total: 0 },
            recentActions: { items: [], total: 0 },
            recentQueueArtifacts: { items: [], total: 0 },
            recentMeetings: [],
          },
        });
      }
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({ ok: true, data: null });
      }
      if (actionKey === 'context.search') {
        searchCount += 1;
        return Promise.resolve({
          ok: true,
          data: {
            timeline: {
              hits: [
                {
                  targetId: 'workspace:apollo',
                  targetKind: 'workspace',
                  title: searchCount === 1
                    ? 'Apollo workspace follow-ups'
                    : 'Apollo workspace blocker moved to procurement',
                  keyPoints: [
                    searchCount === 1
                      ? 'Capture diligence asks in the workspace.'
                      : 'Procurement review is now blocking the workspace.',
                  ],
                },
              ],
              total: 1,
            },
            aiFields: { items: [], total: 0 },
            actions: { items: [], total: 0 },
          },
        });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(<RecentContextCard />);

    fireEvent.change(screen.getByPlaceholderText('budget / blocker / Apollo / investor concern'), {
      target: { value: 'Apollo' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => {
      expect(screen.getByText('Apollo workspace follow-ups')).toBeInTheDocument();
    });

    window.dispatchEvent(new CustomEvent(ACTION_LAYER_REFRESH_EVENT, { detail: { reason: 'test-refresh' } }));

    await waitFor(() => {
      expect(screen.getByText('Apollo workspace blocker moved to procurement')).toBeInTheDocument();
    });
  });

  it('shows native desktop routing for recent queue artifacts owned by a workspace', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'context.recent.get') {
        return Promise.resolve({
          ok: true,
          data: {
            recentAiFields: {
              items: [
                {
                  id: 'af-workspace-1',
                  ownerEntityId: 'workspace:apollo',
                  fieldName: 'next_action',
                  instruction: 'Track workspace follow-up',
                  currentValue: 'Capture diligence asks',
                  evidenceEventIds: [],
                },
              ],
              total: 1,
            },
            recentActions: { items: [], total: 0 },
            recentQueueArtifacts: {
              items: [
                {
                  id: 'queue-workspace-1',
                  createdAt: 1719622800000,
                  payload: {
                    title: 'Queue Apollo CRM update',
                    detail: 'Push latest diligence notes into the workspace.',
                    owner_entity_id: 'workspace:apollo',
                    source_action_id: 'act-workspace-1',
                  },
                },
              ],
              total: 1,
            },
            recentMeetings: [],
          },
        });
      }
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({ ok: true, data: null });
      }
      if (actionKey === 'context.search') {
        return Promise.resolve({ ok: true, data: { timeline: { hits: [], total: 0 }, aiFields: { items: [], total: 0 }, actions: { items: [], total: 0 } } });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(<RecentContextCard />);

    await waitFor(() => {
      expect(screen.getByText('Queue Apollo CRM update')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open Action' }));
    expect(focusActionTraceMock).toHaveBeenCalledWith({ actionId: 'act-workspace-1', aiFieldId: 'af-workspace-1', openAudit: false });

    fireEvent.click(screen.getByRole('button', { name: 'Context' }));
    expect(openContextTargetMock).toHaveBeenCalledWith({ targetId: 'workspace:apollo' });

    fireEvent.click(screen.getByRole('button', { name: 'Open Workspace Detail' }));
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('workspace:apollo');

    const askChatButtons = screen.getAllByRole('button', { name: 'Ask Chat' });
    fireEvent.click(askChatButtons[askChatButtons.length - 1] as HTMLElement);
    expect(buildEntityChatSeedMock).toHaveBeenCalledWith({
      entityId: 'workspace:apollo',
      entityLabel: 'workspace:apollo',
      fieldLabel: null,
      actionLabel: 'Queue Apollo CRM update',
    });
    expect(openChatWithSeedMock).toHaveBeenCalledWith({ text: 'entity:workspace:apollo' });
  });

  it('derives entity chips and owner summaries from queue artifacts even without recent fields or actions', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string, payload?: any) => {
      if (actionKey === 'context.recent.get') {
        return Promise.resolve({
          ok: true,
          data: {
            recentAiFields: { items: [], total: 0 },
            recentActions: { items: [], total: 0 },
            recentQueueArtifacts: {
              items: [
                {
                  id: 'queue-owner-only-1',
                  createdAt: 1719622800000,
                  payload: {
                    title: 'Queue investor follow-up',
                    owner_entity_id: 'workspace:deal-room',
                    source_action_id: 'act-owner-only-1',
                  },
                },
              ],
              total: 1,
            },
            recentMeetings: [],
          },
        });
      }
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: String(payload?.ownerEntityId || 'workspace:deal-room'),
            aiFields: { items: [], total: 0 },
            actions: {
              items: [
                {
                  id: 'act-owner-only-1',
                  ownerEntityId: 'workspace:deal-room',
                  actionType: 'update_crm',
                  title: 'Queue investor follow-up',
                  detail: 'Sync the latest diligence thread.',
                  status: 'approved',
                  riskLevel: 'medium',
                },
              ],
              total: 1,
            },
            queueArtifacts: {
              items: [
                {
                  id: 'queue-owner-only-1',
                  payload: {
                    title: 'Queue investor follow-up',
                  },
                },
              ],
              total: 1,
            },
            latestAudits: [],
            summary: {
              aiFieldCount: 0,
              actionCount: 1,
              queueArtifactCount: 1,
              actionStatusCounts: {
                proposed: 0,
                approved: 1,
                executed: 0,
                rejected: 0,
              },
            },
          },
        });
      }
      if (actionKey === 'context.search') {
        return Promise.resolve({ ok: true, data: { timeline: { hits: [], total: 0 }, aiFields: { items: [], total: 0 }, actions: { items: [], total: 0 } } });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(<RecentContextCard />);

    await waitFor(() => {
      expect(screen.getByText('OWNER SUMMARIES')).toBeInTheDocument();
    });

    expect(screen.getAllByText('workspace:deal-room').length).toBeGreaterThan(0);
    expect(runRuntimeActionMock).toHaveBeenCalledWith(
      'context.owner_summary.get',
      { ownerEntityId: 'workspace:deal-room', limit: 4 },
      { silentError: true },
    );
    expect(screen.getByText('Latest action: Queue investor follow-up [approved]')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Open Workspace Detail' }).length).toBeGreaterThan(0);
  });

  it('uses owner summary queue artifacts for Ask Chat even when recent fields and actions are empty', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string, payload?: any) => {
      if (actionKey === 'context.recent.get') {
        return Promise.resolve({
          ok: true,
          data: {
            recentAiFields: { items: [], total: 0 },
            recentActions: { items: [], total: 0 },
            recentQueueArtifacts: {
              items: [
                {
                  id: 'queue-summary-only-1',
                  createdAt: 1719622800000,
                  payload: {
                    title: 'Queue LP update',
                    owner_entity_id: 'workspace:fundraise-room',
                    source_action_id: 'act-summary-only-1',
                  },
                },
              ],
              total: 1,
            },
            recentMeetings: [],
          },
        });
      }
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: String(payload?.ownerEntityId || 'workspace:fundraise-room'),
            aiFields: { items: [], total: 0 },
            actions: { items: [], total: 0 },
            queueArtifacts: {
              items: [
                {
                  id: 'queue-summary-only-1',
                  payload: {
                    title: 'Queue LP update',
                    owner_entity_id: 'workspace:fundraise-room',
                    source_action_id: 'act-summary-only-1',
                  },
                },
              ],
              total: 1,
            },
            latestAudits: [],
            summary: {
              aiFieldCount: 0,
              actionCount: 0,
              queueArtifactCount: 1,
              actionStatusCounts: {
                proposed: 0,
                approved: 0,
                executed: 0,
                rejected: 0,
              },
            },
          },
        });
      }
      if (actionKey === 'context.search') {
        return Promise.resolve({ ok: true, data: { timeline: { hits: [], total: 0 }, aiFields: { items: [], total: 0 }, actions: { items: [], total: 0 } } });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(<RecentContextCard />);

    await waitFor(() => {
      expect(screen.getAllByText('workspace:fundraise-room').length).toBeGreaterThan(0);
    });

    const askChatButtons = screen.getAllByRole('button', { name: 'Ask Chat' });
    fireEvent.click(askChatButtons[1] as HTMLElement);
    expect(buildEntityChatSeedMock).toHaveBeenCalledWith({
      entityId: 'workspace:fundraise-room',
      entityLabel: 'workspace:fundraise-room',
      fieldLabel: null,
      actionLabel: 'Queue LP update',
    });
    expect(openChatWithSeedMock).toHaveBeenCalledWith({ text: 'entity:workspace:fundraise-room' });
    expect(screen.getAllByRole('button', { name: 'Open Workspace Detail' })).toHaveLength(2);
  });

  it('derives meeting owner summaries from recent meetings even without recent fields or actions', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string, payload?: any) => {
      if (actionKey === 'context.recent.get') {
        return Promise.resolve({
          ok: true,
          data: {
            recentAiFields: { items: [], total: 0 },
            recentActions: { items: [], total: 0 },
            recentQueueArtifacts: { items: [], total: 0 },
            recentMeetings: [
              {
                id: 'mtg-entity-only-1',
                title: 'Apollo diligence sync',
                started_at: '2026-06-29T09:00:00',
              },
            ],
          },
        });
      }
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: String(payload?.ownerEntityId || 'meeting:mtg-entity-only-1'),
            aiFields: {
              items: [
                {
                  id: 'af-meeting-only-1',
                  ownerEntityId: 'meeting:mtg-entity-only-1',
                  fieldName: 'next_action',
                  instruction: 'Track next action',
                  currentValue: 'Send recap',
                  evidenceEventIds: ['meeting:mtg-entity-only-1'],
                },
              ],
              total: 1,
            },
            actions: { items: [], total: 0 },
            queueArtifacts: { items: [], total: 0 },
            latestAudits: [],
            summary: {
              aiFieldCount: 1,
              actionCount: 0,
              queueArtifactCount: 0,
              actionStatusCounts: {
                proposed: 0,
                approved: 0,
                executed: 0,
                rejected: 0,
              },
            },
          },
        });
      }
      if (actionKey === 'context.search') {
        return Promise.resolve({ ok: true, data: { timeline: { hits: [], total: 0 }, aiFields: { items: [], total: 0 }, actions: { items: [], total: 0 } } });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(<RecentContextCard />);

    await waitFor(() => {
      expect(screen.getByText('meeting:mtg-entity-only-1')).toBeInTheDocument();
    });

    expect(runRuntimeActionMock).toHaveBeenCalledWith(
      'context.owner_summary.get',
      { ownerEntityId: 'meeting:mtg-entity-only-1', limit: 4 },
      { silentError: true },
    );
    expect(screen.getByRole('button', { name: 'Open Meeting Detail' })).toBeInTheDocument();
  });
});

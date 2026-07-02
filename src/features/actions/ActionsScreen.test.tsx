import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionsScreen } from './ActionsScreen';
import {
  clearQueueArtifactFocus,
  readQueueArtifactFocus,
} from '@/shared/context/queue-artifact-focus';
import type { ActionTraceFocusState } from '@/shared/context/action-trace-focus';

const runRuntimeActionMock = vi.fn();
let focusedEntityIdValue = 'company:aurora';
const openContextTargetMock = vi.fn();
const focusActionTraceMock = vi.fn();
const clearActionTraceFocusMock = vi.fn();
let queueFocusValue = {
  queueId: null as string | null,
  sourceActionId: null as string | null,
  sourceAiFieldId: null as string | null,
  ownerEntityId: null as string | null,
};
let traceFocusValue: ActionTraceFocusState = { actionId: 'act-1', aiFieldId: null, openAudit: false };

vi.mock('@/shared/ipc/runtime-actions', () => ({
  runRuntimeAction: (...args: unknown[]) => runRuntimeActionMock(...args),
}));

vi.mock('@/shared/context/focus-store', async () => {
  const actual = await vi.importActual<typeof import('@/shared/context/focus-store')>('@/shared/context/focus-store');
  return {
    ...actual,
    useEventedValue: (reader: () => unknown) => reader(),
  };
});

vi.mock('@/shared/context/action-trace-focus', () => ({
  ACTION_TRACE_FOCUS_EVENT: 'action-trace-focus',
  clearActionTraceFocus: () => {
    clearActionTraceFocusMock();
    traceFocusValue = { actionId: null, aiFieldId: null, openAudit: false };
  },
  focusActionTrace: (...args: unknown[]) => focusActionTraceMock(...args),
  readActionTraceFocus: () => traceFocusValue,
}));

vi.mock('@/shared/context/action-draft', () => ({
  ACTION_DRAFT_EVENT: 'action-draft',
  clearActionDraft: vi.fn(),
  readActionDraft: () => null,
}));

vi.mock('@/shared/context/queue-artifact-focus', () => ({
  QUEUE_ARTIFACT_FOCUS_EVENT: 'queue-artifact-focus',
  clearQueueArtifactFocus: () => {
    queueFocusValue = { queueId: null, sourceActionId: null, sourceAiFieldId: null, ownerEntityId: null };
  },
  readQueueArtifactFocus: () => queueFocusValue,
  focusQueueArtifact: (state: typeof queueFocusValue) => {
    queueFocusValue = {
      queueId: state.queueId ?? null,
      sourceActionId: state.sourceActionId ?? null,
      sourceAiFieldId: state.sourceAiFieldId ?? null,
      ownerEntityId: state.ownerEntityId ?? null,
    };
  },
}));

vi.mock('@/shared/context/entity-focus', () => ({
  ENTITY_FOCUS_EVENT: 'entity-focus',
  clearEntityFocus: vi.fn(),
  readEntityFocus: () => focusedEntityIdValue,
}));

vi.mock('@/features/entity-context/entity-signal-focus', () => ({
  ENTITY_SIGNAL_FOCUS_EVENT: 'entity-signal-focus',
  clearEntitySignalFocus: vi.fn(),
  readEntitySignalFocus: () => null,
}));

vi.mock('@/shared/context/ai-field-focus', () => ({
  focusAiField: vi.fn(),
}));

vi.mock('@/shared/context/context-target-navigation', async () => {
  const actual = await vi.importActual<typeof import('@/shared/context/context-target-navigation')>('@/shared/context/context-target-navigation');
  return {
    ...actual,
    openContextTarget: (...args: unknown[]) => openContextTargetMock(...args),
  };
});

describe('ActionsScreen', () => {
  beforeEach(() => {
    runRuntimeActionMock.mockReset();
    focusedEntityIdValue = 'company:aurora';
    openContextTargetMock.mockReset();
    focusActionTraceMock.mockReset();
    clearActionTraceFocusMock.mockReset();
    queueFocusValue = { queueId: null, sourceActionId: null, sourceAiFieldId: null, ownerEntityId: null };
    traceFocusValue = { actionId: 'act-1', aiFieldId: null, openAudit: false };
    clearQueueArtifactFocus();
    (window as any).SHOGUN_RUNTIME = { setActiveScreen: vi.fn() };
  });

  it('shows owner summary context for the focused entity', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: 'company:aurora',
            entityContext: null,
            aiFields: { items: [], total: 0 },
            actions: {
              items: [
                {
                  id: 'act-1',
                  ownerEntityId: 'company:aurora',
                  actionType: 'update_crm',
                  title: 'Queue company update',
                  detail: '',
                  status: 'approved',
                  riskLevel: 'medium',
                  sourceAiFieldId: 'af-owner-1',
                  evidenceEventIds: [],
                  executionResult: null,
                  executedAt: null,
                  createdAt: 0,
                  updatedAt: 0,
                },
              ],
              total: 1,
            },
            queueArtifacts: {
              items: [
                {
                  id: 'crm-q-1',
                  createdAt: 0,
                  payload: {
                    title: 'Update CRM blocker field',
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
                  actor: 'user',
                  objectType: 'action',
                  objectId: 'act-1',
                  eventType: 'status_changed',
                  detail: 'Approved by operator',
                  payload: null,
                  evidenceEventIds: [],
                  createdAt: 0,
                },
              },
            ],
            summary: {
              aiFieldCount: 2,
              actionCount: 1,
              queueArtifactCount: 1,
              actionStatusCounts: { proposed: 0, approved: 1, executed: 0, rejected: 0 },
            },
          },
        });
      }
      if (actionKey === 'action.list' || actionKey === 'queue.tasks.list' || actionKey === 'queue.crm_updates.list' || actionKey === 'action.audit_list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(<ActionsScreen />);

    await waitFor(() => {
      expect(screen.getByText('OWNER SUMMARY')).toBeInTheDocument();
    });
    expect(screen.getByText('Latest action: Queue company update [approved]')).toBeInTheDocument();
    expect(screen.getByText('Latest queue: Update CRM blocker field')).toBeInTheDocument();
    expect(screen.getByText('Latest audit: Approved by operator')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open queue item' }));
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');
    expect(readQueueArtifactFocus()).toEqual({
      queueId: 'crm-q-1',
      sourceActionId: 'act-queue-1',
      sourceAiFieldId: 'af-owner-1',
      ownerEntityId: 'workspace:apollo',
    });
  });

  it('preserves ai field context when inspecting queue action provenance', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: 'company:aurora',
            aiFields: { items: [], total: 0 },
            actions: { items: [], total: 0 },
            queueArtifacts: { items: [], total: 0 },
            latestAudits: [],
            summary: {
              aiFieldCount: 0,
              actionCount: 0,
              queueArtifactCount: 0,
              actionStatusCounts: {},
            },
          },
        });
      }
      if (actionKey === 'queue.tasks.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'queue-task-1',
                createdAt: 0,
                payload: {
                  title: 'Create Aurora follow-up task',
                  owner_entity_id: 'company:aurora',
                  source_action_id: 'act-queue-1',
                },
              },
            ],
          },
        });
      }
      if (actionKey === 'queue.crm_updates.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'action.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'act-queue-1',
                ownerEntityId: 'company:aurora',
                actionType: 'create_task',
                status: 'approved',
                riskLevel: 'medium',
                title: 'Create Aurora follow-up task',
                detail: 'Track the next follow-up in the shared task queue.',
                sourceAiFieldId: 'af-owner-1',
                evidenceEventIds: [],
                executionResult: null,
                executedAt: null,
                createdAt: 0,
                updatedAt: 0,
              },
            ],
          },
        });
      }
      if (actionKey === 'action.audit_list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'audit-queue-1',
                eventType: 'approved',
                detail: 'Approved before queueing',
              },
            ],
          },
        });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(<ActionsScreen />);

    await waitFor(() => {
      expect(screen.getByText('Create Aurora follow-up task')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'action act-queue-1' }));
    expect(focusActionTraceMock).toHaveBeenCalledWith({
      actionId: 'act-queue-1',
      aiFieldId: 'af-owner-1',
      openAudit: false,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open audit' }));
    expect(focusActionTraceMock).toHaveBeenCalledWith({
      actionId: 'act-queue-1',
      aiFieldId: 'af-owner-1',
      openAudit: true,
    });
  });

  it('restores action trace focus from queue focus when the screen opens from a queued artifact', async () => {
    queueFocusValue = {
      queueId: 'queue-task-1',
      sourceActionId: 'act-queue-1',
      sourceAiFieldId: 'af-owner-1',
      ownerEntityId: 'company:aurora',
    };

    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: 'company:aurora',
            aiFields: { items: [], total: 0 },
            actions: { items: [], total: 0 },
            queueArtifacts: { items: [], total: 0 },
            latestAudits: [],
            summary: {
              aiFieldCount: 0,
              actionCount: 0,
              queueArtifactCount: 0,
              actionStatusCounts: {},
            },
          },
        });
      }
      if (actionKey === 'action.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'act-queue-1',
                ownerEntityId: 'company:aurora',
                actionType: 'create_task',
                title: 'Create Aurora follow-up task',
                detail: 'Track the next follow-up in the shared task queue.',
                status: 'approved',
                riskLevel: 'medium',
                sourceAiFieldId: 'af-owner-1',
                evidenceEventIds: [],
                executionResult: null,
                executedAt: null,
                createdAt: 0,
                updatedAt: 0,
              },
            ],
          },
        });
      }
      if (actionKey === 'queue.tasks.list' || actionKey === 'queue.crm_updates.list' || actionKey === 'action.audit_list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(<ActionsScreen />);

    await waitFor(() => {
      expect(screen.getByText('Create Aurora follow-up task')).toBeInTheDocument();
    });

    expect(focusActionTraceMock).toHaveBeenCalledWith({
      actionId: 'act-queue-1',
      aiFieldId: 'af-owner-1',
      openAudit: false,
    });

    expect(screen.getByText('RUNTIME FOCUS')).toBeInTheDocument();
    expect(screen.getAllByText('queue queue-task-1').length).toBeGreaterThan(0);
    expect(screen.getByText('queue_action act-queue-1')).toBeInTheDocument();
    expect(screen.getByText('queue_ai_field af-owner-1')).toBeInTheDocument();
    expect(screen.getByText('trace_action act-1')).toBeInTheDocument();
    expect(screen.getByText('ai_field af-owner-1')).toBeInTheDocument();
  });

  it('does not clear audit mode when queue focus already matches the current trace', async () => {
    queueFocusValue = {
      queueId: 'queue-task-1',
      sourceActionId: 'act-queue-1',
      sourceAiFieldId: 'af-owner-1',
      ownerEntityId: 'company:aurora',
    };

    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: 'company:aurora',
            aiFields: { items: [], total: 0 },
            actions: { items: [], total: 0 },
            queueArtifacts: { items: [], total: 0 },
            latestAudits: [],
            summary: {
              aiFieldCount: 0,
              actionCount: 0,
              queueArtifactCount: 0,
              actionStatusCounts: {},
            },
          },
        });
      }
      if (actionKey === 'action.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'act-queue-1',
                ownerEntityId: 'company:aurora',
                actionType: 'create_task',
                title: 'Create Aurora follow-up task',
                detail: 'Track the next follow-up in the shared task queue.',
                status: 'approved',
                riskLevel: 'medium',
                sourceAiFieldId: 'af-owner-1',
                evidenceEventIds: [],
                executionResult: null,
                executedAt: null,
                createdAt: 0,
                updatedAt: 0,
              },
            ],
          },
        });
      }
      if (actionKey === 'action.audit_list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'audit-1',
                actor: 'user',
                objectType: 'action',
                objectId: 'act-queue-1',
                eventType: 'approved',
                detail: 'Approved in queue review',
                payload: null,
                evidenceEventIds: [],
                createdAt: 0,
              },
            ],
          },
        });
      }
      if (actionKey === 'queue.tasks.list' || actionKey === 'queue.crm_updates.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    focusActionTraceMock.mockReset();
    render(<ActionsScreen />);

    await waitFor(() => {
      expect(screen.getByText('Create Aurora follow-up task')).toBeInTheDocument();
    });

    focusActionTraceMock.mockReset();
    fireEvent.click(screen.getByRole('button', { name: 'Show audit' }));

    await waitFor(() => {
      expect(screen.getByText('Approved in queue review')).toBeInTheDocument();
    });

    expect(focusActionTraceMock).not.toHaveBeenCalled();
  });

  it('exposes top-level clear controls for queue context and action trace', async () => {
    queueFocusValue = {
      queueId: 'queue-task-1',
      sourceActionId: 'act-queue-1',
      sourceAiFieldId: 'af-owner-1',
      ownerEntityId: 'company:aurora',
    };
    traceFocusValue = { actionId: 'act-queue-1', aiFieldId: 'af-owner-1', openAudit: true };

    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: 'company:aurora',
            aiFields: { items: [], total: 0 },
            actions: { items: [], total: 0 },
            queueArtifacts: { items: [], total: 0 },
            latestAudits: [],
            summary: {
              aiFieldCount: 0,
              actionCount: 0,
              queueArtifactCount: 0,
              actionStatusCounts: {},
            },
          },
        });
      }
      if (actionKey === 'action.list' || actionKey === 'queue.tasks.list' || actionKey === 'queue.crm_updates.list' || actionKey === 'action.audit_list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(<ActionsScreen />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Clear queue context' })).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: 'Clear action trace' })).toBeInTheDocument();
    expect(screen.getByText('audit open')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear queue context' }));
    expect(readQueueArtifactFocus()).toEqual({
      queueId: null,
      sourceActionId: null,
      sourceAiFieldId: null,
      ownerEntityId: null,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Clear action trace' }));
    expect(clearActionTraceFocusMock).toHaveBeenCalledTimes(1);
  });

  it('routes the focused entity context button through shared navigation', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: 'company:aurora',
            aiFields: { items: [], total: 0 },
            actions: { items: [], total: 0 },
            queueArtifacts: { items: [], total: 0 },
            latestAudits: [],
            summary: {
              aiFieldCount: 0,
              actionCount: 0,
              queueArtifactCount: 0,
              actionStatusCounts: {},
            },
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<ActionsScreen />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open Entity Context' }));
    expect(openContextTargetMock).toHaveBeenCalledWith({ targetId: 'company:aurora' });
  });

  it('opens meeting detail from a focused meeting entity', async () => {
    const onOpenMeetingDetail = vi.fn();
    focusedEntityIdValue = 'meeting:mtg-1';
    window.addEventListener('shogun-open-meeting-detail', onOpenMeetingDetail as EventListener);
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: 'meeting:mtg-1',
            aiFields: { items: [], total: 0 },
            actions: { items: [], total: 0 },
            queueArtifacts: { items: [], total: 0 },
            latestAudits: [],
            summary: {
              aiFieldCount: 0,
              actionCount: 0,
              queueArtifactCount: 0,
              actionStatusCounts: {},
            },
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<ActionsScreen />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open Meeting Detail' }));
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('meetings');
    await waitFor(() => {
      expect((onOpenMeetingDetail.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ meetingId: 'mtg-1' });
    });
    window.removeEventListener('shogun-open-meeting-detail', onOpenMeetingDetail as EventListener);
  });

  it('opens workspace detail from a focused workspace entity', async () => {
    const onOpenWorkspaceDetail = vi.fn();
    focusedEntityIdValue = 'workspace:apollo';
    window.addEventListener('shogun-open-workspace-detail', onOpenWorkspaceDetail as EventListener);
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: 'workspace:apollo',
            aiFields: { items: [], total: 0 },
            actions: { items: [], total: 0 },
            queueArtifacts: { items: [], total: 0 },
            latestAudits: [],
            summary: {
              aiFieldCount: 0,
              actionCount: 0,
              queueArtifactCount: 0,
              actionStatusCounts: {},
            },
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<ActionsScreen />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open Workspace Detail' }));
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('work');
    await waitFor(() => {
      expect((onOpenWorkspaceDetail.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ workspaceId: 'apollo' });
    });
    window.removeEventListener('shogun-open-workspace-detail', onOpenWorkspaceDetail as EventListener);
  });
});

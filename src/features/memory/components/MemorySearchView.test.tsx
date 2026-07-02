import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { MemorySearchView } from './MemorySearchView';
import {
  clearQueueArtifactFocus,
  readQueueArtifactFocus,
} from '@/shared/context/queue-artifact-focus';

const runRuntimeActionMock = vi.fn();
const openMemoryEntryInChatMock = vi.fn();
const openContextTargetMock = vi.fn();
const focusActionTraceMock = vi.fn();
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
const openNativeDetailForEntityIdMock = vi.fn();

vi.mock('@/shared/ipc/runtime-actions', () => ({
  runRuntimeAction: (...args: unknown[]) => runRuntimeActionMock(...args),
}));

vi.mock('@/shared/context/context-target-navigation', () => ({
  openContextTarget: (...args: unknown[]) => openContextTargetMock(...args),
  nativeDetailDescriptorForEntityId: (entityId: string) => nativeDetailDescriptorForEntityIdMock(entityId),
  openNativeDetailForEntityId: (entityId: string) => openNativeDetailForEntityIdMock(entityId),
}));

vi.mock('@/shared/context/action-trace-focus', () => ({
  focusActionTrace: (...args: unknown[]) => focusActionTraceMock(...args),
}));

vi.mock('../lib/runtime', async () => {
  const actual = await vi.importActual<typeof import('../lib/runtime')>('../lib/runtime');
  return {
    ...actual,
    openMemoryEntryInChat: (...args: unknown[]) => openMemoryEntryInChatMock(...args),
  };
});

describe('MemorySearchView', () => {
  beforeEach(() => {
    runRuntimeActionMock.mockReset();
    openMemoryEntryInChatMock.mockReset();
    openContextTargetMock.mockReset();
    focusActionTraceMock.mockReset();
    nativeDetailDescriptorForEntityIdMock.mockClear();
    openNativeDetailForEntityIdMock.mockReset();
    clearQueueArtifactFocus();
    (window as any).SHOGUN_RUNTIME = {
      setActiveScreen: vi.fn(),
    };
  });

  it('opens chat, owner summary, entity context, and native detail from memory hits', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'memory.timelineSearch') {
        return Promise.resolve({
          ok: true,
          data: {
            hits: [
              {
                id: 'mem-1',
                title: 'Aurora sync note',
                snippet: 'Need security follow-up.',
                source: 'meeting',
                entity_id: 'company:aurora',
              },
              {
                id: 'mem-2',
                title: 'Weekly sync transcript',
                snippet: 'Next steps captured in workspace.',
                source: 'meeting',
                entity_id: 'meeting:mtg-1',
              },
            ],
          },
        });
      }
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
                  sourceAiFieldId: 'af-1',
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
              aiFieldCount: 0,
              actionCount: 1,
              queueArtifactCount: 1,
              actionStatusCounts: { proposed: 0, approved: 1, executed: 0, rejected: 0 },
            },
          },
        });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(
      <MemorySearchView
        workProjects={[]}
        assignments={{}}
        setAssignments={() => {}}
        allowServerMemoryAssembly={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Aurora sync note')).toBeInTheDocument();
    });

    const auroraCard = screen.getByText('Aurora sync note').closest('label');
    const meetingCard = screen.getByText('Weekly sync transcript').closest('label');
    expect(auroraCard).not.toBeNull();
    expect(meetingCard).not.toBeNull();

    const askChatButtons = screen.getAllByRole('button', { name: 'Ask Chat' });
    const loadSummaryButtons = screen.getAllByRole('button', { name: 'Load Summary' });
    const entityContextButtons = screen.getAllByRole('button', { name: 'Entity Context' });
    expect(askChatButtons.length).toBeGreaterThan(0);
    expect(loadSummaryButtons.length).toBeGreaterThan(0);
    expect(entityContextButtons.length).toBeGreaterThan(0);

    fireEvent.click(askChatButtons[0]!);
    expect(openMemoryEntryInChatMock).toHaveBeenCalledWith(
      { title: 'Aurora sync note', snippet: 'Need security follow-up.' },
      expect.objectContaining({
        memoryAssemblyQuery: 'company:aurora',
        allowServerMemoryAssembly: false,
        newChat: true,
      }),
    );

    fireEvent.click(loadSummaryButtons[0]!);
    await waitFor(() => {
      expect(screen.getByText('Latest action: Queue company update [approved]')).toBeInTheDocument();
    });
    expect(screen.getByText('Latest queue: Update CRM blocker field')).toBeInTheDocument();
    expect(screen.getByText('Latest audit: Approved by operator')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open queued action' }));
    expect(focusActionTraceMock).toHaveBeenCalledWith({
      actionId: 'act-queue-1',
      aiFieldId: 'af-1',
      openAudit: false,
    });
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');

    fireEvent.click(screen.getByRole('button', { name: 'Open queue item' }));
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');
    expect(readQueueArtifactFocus()).toEqual({
      queueId: 'crm-q-1',
      sourceActionId: 'act-queue-1',
      sourceAiFieldId: 'af-1',
      ownerEntityId: 'workspace:apollo',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open Workspace Detail' }));
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('workspace:apollo');

    fireEvent.click(entityContextButtons[0]!);
    expect(openContextTargetMock).toHaveBeenCalledWith({ targetId: 'company:aurora' });

    fireEvent.click(screen.getByRole('button', { name: 'Open Meeting Detail' }));
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('meeting:mtg-1');
  });

  it('hides redundant queue native detail buttons when the queue owner matches the summary entity', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'memory.timelineSearch') {
        return Promise.resolve({
          ok: true,
          data: {
            hits: [
              {
                id: 'mem-1',
                title: 'Apollo workspace note',
                snippet: 'Workspace follow-up needed.',
                source: 'meeting',
                entity_id: 'workspace:apollo',
              },
            ],
          },
        });
      }
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: 'workspace:apollo',
            entityContext: null,
            aiFields: { items: [], total: 0 },
            actions: { items: [], total: 0 },
            queueArtifacts: {
              items: [
                {
                  id: 'task-q-1',
                  createdAt: 0,
                  payload: {
                    title: 'Apollo workspace handoff',
                    owner_entity_id: 'workspace:apollo',
                    source_action_id: 'act-queue-1',
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
              actionStatusCounts: { proposed: 0, approved: 0, executed: 0, rejected: 0 },
            },
          },
        });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(
      <MemorySearchView
        workProjects={[]}
        assignments={{}}
        setAssignments={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Apollo workspace note')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Load Summary' }));

    await waitFor(() => {
      expect(screen.getByText('Latest queue: Apollo workspace handoff')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: 'Open queued action' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Open Workspace Detail' })).toHaveLength(1);
  });
});

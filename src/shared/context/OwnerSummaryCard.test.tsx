import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OwnerSummaryCard } from './OwnerSummaryCard';
import { ACTION_LAYER_REFRESH_EVENT } from './action-layer-events';

const runRuntimeActionMock = vi.fn();
const onOpenActionsMock = vi.fn();
const onOpenQueueArtifactMock = vi.fn();
const openNativeDetailForEntityIdMock = vi.fn();
const onOpenQueueNativeDetailMock = vi.fn();

vi.mock('@/shared/ipc/runtime-actions', () => ({
  runRuntimeAction: (...args: unknown[]) => runRuntimeActionMock(...args),
}));

vi.mock('@/shared/context/context-target-navigation', () => ({
  nativeDetailDescriptorForEntityId: (entityId: string) => {
    const normalized = String(entityId || '').trim();
    if (normalized.startsWith('meeting:')) {
      return { kind: 'meeting', id: normalized.slice('meeting:'.length), label: 'Open Meeting Detail' };
    }
    if (normalized.startsWith('workspace:')) {
      return { kind: 'workspace', id: normalized.slice('workspace:'.length), label: 'Open Workspace Detail' };
    }
    return null;
  },
  openNativeDetailForEntityId: (...args: unknown[]) => openNativeDetailForEntityIdMock(...args),
}));

describe('OwnerSummaryCard', () => {
  beforeEach(() => {
    runRuntimeActionMock.mockReset();
    onOpenActionsMock.mockReset();
    onOpenQueueArtifactMock.mockReset();
    openNativeDetailForEntityIdMock.mockReset();
    onOpenQueueNativeDetailMock.mockReset();
  });

  it('deep-links to the latest action and audit', async () => {
    runRuntimeActionMock.mockResolvedValue({
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
        queueArtifacts: { items: [], total: 0 },
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
          queueArtifactCount: 0,
          actionStatusCounts: { proposed: 0, approved: 1, executed: 0, rejected: 0 },
        },
      },
    });

    render(
      <OwnerSummaryCard
        entityId="company:aurora"
        onOpenActions={onOpenActionsMock}
        onOpenQueueArtifact={onOpenQueueArtifactMock}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Latest action: Queue company update [approved]')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open action' }));
    expect(onOpenActionsMock).toHaveBeenCalledWith({ actionId: 'act-1', aiFieldId: 'af-owner-1', openAudit: false });

    fireEvent.click(screen.getByRole('button', { name: 'Open audit' }));
    expect(onOpenActionsMock).toHaveBeenCalledWith({ actionId: 'act-1', aiFieldId: 'af-owner-1', openAudit: true });
  });

  it('opens native detail CTAs for meeting and workspace owners', async () => {
    runRuntimeActionMock.mockResolvedValue({
      ok: true,
      data: {
        ownerEntityId: 'meeting:mtg-1',
        entityContext: null,
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

    const { rerender } = render(<OwnerSummaryCard entityId="meeting:mtg-1" />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open Meeting Detail' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open Meeting Detail' }));
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('meeting:mtg-1');

    rerender(<OwnerSummaryCard entityId="workspace:apollo" />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open Workspace Detail' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open Workspace Detail' }));
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('workspace:apollo');
  });

  it('deep-links from the latest queue row to its action and native owner detail', async () => {
    runRuntimeActionMock.mockResolvedValue({
      ok: true,
      data: {
        ownerEntityId: 'company:aurora',
        entityContext: null,
        aiFields: {
          items: [
            {
              id: 'af-owner-1',
              ownerEntityId: 'company:aurora',
              fieldName: 'blocker',
              instruction: 'Track current blocker',
              currentValue: 'Security review pending',
              confidence: 0.82,
              evidenceEventIds: [],
            },
          ],
          total: 1,
        },
        actions: {
          items: [
            {
              id: 'act-owner-1',
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
              id: 'queue-1',
              createdAt: 0,
              payload: {
                title: 'Push Apollo update',
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
          actionStatusCounts: {},
        },
      },
    });

    render(
      <OwnerSummaryCard
        entityId="company:aurora"
        onOpenActions={onOpenActionsMock}
        onOpenQueueArtifact={onOpenQueueArtifactMock}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Latest queue: Push Apollo update')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open queue item' }));
    expect(onOpenQueueArtifactMock).toHaveBeenCalledWith({
      queueId: 'queue-1',
      sourceActionId: 'act-queue-1',
      sourceAiFieldId: 'af-owner-1',
      ownerEntityId: 'workspace:apollo',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open queued action' }));
    expect(onOpenActionsMock).toHaveBeenCalledWith({ actionId: 'act-queue-1', aiFieldId: 'af-owner-1', openAudit: false });

    fireEvent.click(screen.getByRole('button', { name: 'Open Workspace Detail' }));
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('workspace:apollo');
  });

  it('hides redundant latest queue native detail buttons for the current native owner and uses the callback for cross-owner detail opens', async () => {
    runRuntimeActionMock
      .mockResolvedValueOnce({
        ok: true,
        data: {
          ownerEntityId: 'workspace:apollo',
          entityContext: null,
          aiFields: { items: [], total: 0 },
          actions: { items: [], total: 0 },
          queueArtifacts: {
            items: [
              {
                id: 'queue-same-owner',
                createdAt: 0,
                payload: {
                  title: 'Apollo sync task',
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
            actionStatusCounts: {},
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          ownerEntityId: 'meeting:mtg-1',
          entityContext: null,
          aiFields: { items: [], total: 0 },
          actions: { items: [], total: 0 },
          queueArtifacts: {
            items: [
              {
                id: 'queue-other-owner',
                createdAt: 0,
                payload: {
                  title: 'Apollo workspace follow-up',
                  owner_entity_id: 'workspace:apollo',
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
            actionStatusCounts: {},
          },
        },
      });

    const { rerender } = render(
      <OwnerSummaryCard
        entityId="workspace:apollo"
        hideNativeDetail
        onOpenActions={onOpenActionsMock}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Latest queue: Apollo sync task')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Open Workspace Detail' })).not.toBeInTheDocument();

    rerender(
      <OwnerSummaryCard
        entityId="meeting:mtg-1"
        hideNativeDetail
        onOpenQueueNativeDetail={onOpenQueueNativeDetailMock}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Latest queue: Apollo workspace follow-up')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open Workspace Detail' }));
    expect(onOpenQueueNativeDetailMock).toHaveBeenCalledWith('workspace:apollo');
    expect(openNativeDetailForEntityIdMock).not.toHaveBeenCalled();
  });

  it('reloads the owner summary when the action layer emits a refresh event', async () => {
    runRuntimeActionMock
      .mockResolvedValueOnce({
        ok: true,
        data: {
          ownerEntityId: 'company:aurora',
          entityContext: null,
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
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          ownerEntityId: 'company:aurora',
          entityContext: null,
          aiFields: { items: [], total: 0 },
          actions: {
            items: [
              {
                id: 'act-refresh-1',
                ownerEntityId: 'company:aurora',
                actionType: 'create_task',
                title: 'Refreshed action',
                detail: '',
                status: 'approved',
                riskLevel: 'medium',
                sourceAiFieldId: null,
                evidenceEventIds: [],
                executionResult: null,
                executedAt: null,
                createdAt: 0,
                updatedAt: 0,
              },
            ],
            total: 1,
          },
          queueArtifacts: { items: [], total: 0 },
          latestAudits: [],
          summary: {
            aiFieldCount: 0,
            actionCount: 1,
            queueArtifactCount: 0,
            actionStatusCounts: { approved: 1 },
          },
        },
      });

    render(<OwnerSummaryCard entityId="company:aurora" onOpenActions={onOpenActionsMock} />);

    await waitFor(() => {
      expect(screen.getByText('actions 0')).toBeInTheDocument();
    });

    window.dispatchEvent(new CustomEvent(ACTION_LAYER_REFRESH_EVENT, { detail: { reason: 'test-refresh' } }));

    await waitFor(() => {
      expect(screen.getByText('Latest action: Refreshed action [approved]')).toBeInTheDocument();
    });
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedTasksCard } from './SharedTasksCard';
import { ACTION_LAYER_REFRESH_EVENT } from '@/shared/context/action-layer-events';

const runRuntimeActionMock = vi.fn();
const focusEntityMock = vi.fn();
const focusActionTraceMock = vi.fn();
const openChatWithSeedMock = vi.fn();
const buildActionChatSeedMock = vi.fn((input) => ({ text: `action:${input.ownerEntityId}` }));
const openContextTargetMock = vi.fn();
const openNativeDetailForEntityIdMock = vi.fn((entityId: string) => {
  const normalized = String(entityId || '').trim();
  if (normalized.startsWith('workspace:')) {
    (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('work');
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

vi.mock('@/shared/context/action-trace-focus', () => ({
  focusActionTrace: (...args: unknown[]) => focusActionTraceMock(...args),
}));

vi.mock('@/shared/context/chat-composer-seed', () => ({
  buildActionChatSeed: (...args: any[]) => buildActionChatSeedMock(args[0]),
  openChatWithSeed: (...args: any[]) => openChatWithSeedMock(args[0]),
}));

vi.mock('@/shared/context/context-target-navigation', () => ({
  nativeDetailDescriptorForEntityId: (entityId: string) => {
    const normalized = String(entityId || '').trim();
    if (normalized.startsWith('workspace:')) {
      return { kind: 'workspace', id: normalized.slice('workspace:'.length), label: 'Open Workspace Detail' };
    }
    return null;
  },
  openContextTarget: (...args: unknown[]) => openContextTargetMock(...args),
  openNativeDetailForEntityId: (entityId: string) => openNativeDetailForEntityIdMock(entityId),
}));

describe('SharedTasksCard', () => {
  beforeEach(() => {
    runRuntimeActionMock.mockReset();
    focusEntityMock.mockReset();
    focusActionTraceMock.mockReset();
    openChatWithSeedMock.mockReset();
    buildActionChatSeedMock.mockClear();
    openContextTargetMock.mockReset();
    openNativeDetailForEntityIdMock.mockReset();
    (window as any).SHOGUN_RUNTIME = { setActiveScreen: vi.fn() };
  });

  it('loads pending shared tasks and routes actions through desktop handlers', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'context.tasks.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'task-act-1',
                ownerEntityId: 'workspace:apollo',
                actionType: 'create_task',
                title: 'Create Apollo follow-up task',
                detail: 'Track the diligence follow-up as a shared task.',
                status: 'approved',
                riskLevel: 'medium',
                sourceAiFieldId: 'af-workspace-1',
              },
            ],
            total: 1,
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<SharedTasksCard />);

    await waitFor(() => {
      expect(screen.getByText('Pending tasks across the desktop context layer')).toBeInTheDocument();
    });

    expect(screen.getByText('Create Apollo follow-up task')).toBeInTheDocument();
    expect(screen.getByText('workspace:apollo')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open task' }));
    expect(focusEntityMock).toHaveBeenCalledWith('workspace:apollo');
    expect(focusActionTraceMock).toHaveBeenCalledWith({
      actionId: 'task-act-1',
      aiFieldId: 'af-workspace-1',
      openAudit: false,
    });
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');

    fireEvent.click(screen.getByRole('button', { name: 'Owner context' }));
    expect(openContextTargetMock).toHaveBeenCalledWith({ targetId: 'workspace:apollo' });

    fireEvent.click(screen.getByRole('button', { name: 'Open Workspace Detail' }));
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('workspace:apollo');

    fireEvent.click(screen.getByRole('button', { name: 'Ask Chat' }));
    expect(buildActionChatSeedMock).toHaveBeenCalledWith({
      ownerEntityId: 'workspace:apollo',
      title: 'Create Apollo follow-up task',
      actionType: 'create_task',
      status: 'approved',
      riskLevel: 'medium',
      detail: 'Track the diligence follow-up as a shared task.',
    });
    expect(openChatWithSeedMock).toHaveBeenCalledWith({ text: 'action:workspace:apollo' });
  });

  it('returns null when there are no pending shared tasks', async () => {
    runRuntimeActionMock.mockResolvedValue({
      ok: true,
      data: {
        items: [],
        total: 0,
      },
    });

    const { container } = render(<SharedTasksCard />);

    await waitFor(() => {
      expect(runRuntimeActionMock).toHaveBeenCalledWith(
        'context.tasks.list',
        { statuses: ['proposed', 'approved'], limit: 6 },
        { silentError: true },
      );
    });

    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it('reloads shared tasks when the action layer refreshes', async () => {
    let taskVersion = 1;
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'context.tasks.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: taskVersion === 1
              ? [
                  {
                    id: 'task-act-1',
                    ownerEntityId: 'workspace:apollo',
                    actionType: 'create_task',
                    title: 'Create Apollo follow-up task',
                    detail: 'Track the diligence follow-up as a shared task.',
                    status: 'approved',
                    riskLevel: 'medium',
                    sourceAiFieldId: 'af-workspace-1',
                  },
                ]
              : [
                  {
                    id: 'task-act-2',
                    ownerEntityId: 'workspace:apollo',
                    actionType: 'create_task',
                    title: 'Prepare Apollo pricing draft',
                    detail: 'Update the shared task list after review.',
                    status: 'proposed',
                    riskLevel: 'low',
                    sourceAiFieldId: 'af-workspace-2',
                  },
                ],
            total: 1,
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<SharedTasksCard />);

    await waitFor(() => {
      expect(screen.getByText('Create Apollo follow-up task')).toBeInTheDocument();
    });

    taskVersion = 2;
    window.dispatchEvent(new CustomEvent(ACTION_LAYER_REFRESH_EVENT, { detail: { reason: 'test-refresh' } }));

    await waitFor(() => {
      expect(screen.getByText('Prepare Apollo pricing draft')).toBeInTheDocument();
    });
  });
});

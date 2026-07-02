import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkScreen } from './WorkScreen';
import {
  clearPendingWorkspaceDetailId,
  stashPendingWorkspaceDetailId,
} from '@/shared/context/native-detail-events';

const runRuntimeActionMock = vi.fn();
let workProjectsValue = [
  { id: 'apollo', name: 'Apollo', archived: false },
];

vi.mock('@/shared/ipc/runtime-actions', () => ({
  runRuntimeAction: (...args: unknown[]) => runRuntimeActionMock(...args),
}));

function buildOwnerSummary() {
  return {
    ok: true,
    data: {
      ownerEntityId: 'work:apollo',
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
  };
}

describe('WorkScreen', () => {
  beforeEach(() => {
    clearPendingWorkspaceDetailId();
    runRuntimeActionMock.mockReset();
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'settings.load') {
        return Promise.resolve({
          ok: true,
          data: {
            settings: {
              sections: {
                workspace_memberships: {
                  memberships: {
                    'mem-1': 'apollo',
                  },
                },
              },
            },
          },
        });
      }
      if (actionKey === 'memory.fetch') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'mem-1',
                title: 'Apollo kickoff notes',
                source: 'manual',
                created_at: 1710000000000,
              },
            ],
          },
        });
      }
      if (actionKey === 'settings.save') {
        return Promise.resolve({ ok: true, data: {} });
      }
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve(buildOwnerSummary());
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    workProjectsValue = [
      { id: 'apollo', name: 'Apollo', archived: false },
    ];
    (window as any).SHOGUN_RUNTIME = {
      getWorkProjects: () => workProjectsValue,
    };
  });

  afterEach(() => {
    delete (window as any).SHOGUN_RUNTIME;
  });

  it('opens the workspace detail modal from the native detail event', async () => {
    render(<WorkScreen />);

    window.dispatchEvent(
      new CustomEvent('shogun-workspace-memberships-changed', {
        detail: {
          memberships: {
            'mem-1': 'apollo',
          },
        },
      }),
    );

    window.dispatchEvent(
      new CustomEvent('shogun-open-workspace-detail', {
        detail: { workspaceId: 'apollo' },
      }),
    );

    let dialog: HTMLElement;
    await waitFor(() => {
      dialog = screen.getByRole('dialog');
      expect(dialog).toBeInTheDocument();
    });
    dialog = screen.getByRole('dialog');

    expect(within(dialog).getByText('Apollo')).toBeInTheDocument();
    expect(within(dialog).getByText(/memories assigned/i)).toBeInTheDocument();
  });

  it('retries a native workspace detail event after the project list updates', async () => {
    workProjectsValue = [];
    render(<WorkScreen />);

    window.dispatchEvent(
      new CustomEvent('shogun-open-workspace-detail', {
        detail: { workspaceId: 'apollo' },
      }),
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    workProjectsValue = [
      { id: 'apollo', name: 'Apollo', archived: false },
    ];
    window.dispatchEvent(new CustomEvent('shogun-work-projects-changed'));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toHaveTextContent('Apollo');
    });
    expect(runRuntimeActionMock).toHaveBeenCalledWith(
      'memory.fetch',
      { ids: ['mem-1'] },
      { silentError: true },
    );
  });

  it('retries a native workspace detail event after memberships arrive', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'settings.load') {
        return new Promise(() => {});
      }
      if (actionKey === 'memory.fetch') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'mem-1',
                title: 'Apollo kickoff notes',
                source: 'manual',
                created_at: 1710000000000,
              },
            ],
          },
        });
      }
      if (actionKey === 'settings.save') {
        return Promise.resolve({ ok: true, data: {} });
      }
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve(buildOwnerSummary());
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(<WorkScreen />);

    window.dispatchEvent(
      new CustomEvent('shogun-open-workspace-detail', {
        detail: { workspaceId: 'apollo' },
      }),
    );

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toHaveTextContent('Apollo');
    });
    expect(screen.getByRole('dialog')).toHaveTextContent(/loading/i);
    expect(runRuntimeActionMock).not.toHaveBeenCalledWith(
      'memory.fetch',
      { ids: ['mem-1'] },
      { silentError: true },
    );

    window.dispatchEvent(
      new CustomEvent('shogun-workspace-memberships-changed', {
        detail: {
          memberships: {
            'mem-1': 'apollo',
          },
        },
      }),
    );

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toHaveTextContent('Apollo kickoff notes');
    });
    expect(runRuntimeActionMock).toHaveBeenCalledWith(
      'memory.fetch',
      { ids: ['mem-1'] },
      { silentError: true },
    );
  });

  it('opens the workspace detail modal from pending native navigation after mount', async () => {
    stashPendingWorkspaceDetailId('apollo');

    render(<WorkScreen />);

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toHaveTextContent('Apollo');
    });
    await waitFor(() => {
      expect(runRuntimeActionMock).toHaveBeenCalledWith(
        'memory.fetch',
        { ids: ['mem-1'] },
        { silentError: true },
      );
    });
  });

  it('reloads an open workspace detail when memberships change', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string, payload?: any) => {
      if (actionKey === 'settings.load') {
        return Promise.resolve({
          ok: true,
          data: {
            settings: {
              sections: {
                workspace_memberships: {
                  memberships: {
                    'mem-1': 'apollo',
                  },
                },
              },
            },
          },
        });
      }
      if (actionKey === 'memory.fetch') {
        const ids = Array.isArray(payload?.ids) ? payload.ids : [];
        return Promise.resolve({
          ok: true,
          data: {
            items: ids.map((id: string) => ({
              id,
              title: id === 'mem-1' ? 'Apollo kickoff notes' : 'Apollo procurement follow-up',
              source: 'manual',
              created_at: 1710000000000,
            })),
          },
        });
      }
      if (actionKey === 'settings.save') {
        return Promise.resolve({ ok: true, data: {} });
      }
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve(buildOwnerSummary());
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(<WorkScreen />);

    window.dispatchEvent(
      new CustomEvent('shogun-open-workspace-detail', {
        detail: { workspaceId: 'apollo' },
      }),
    );

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toHaveTextContent('Apollo kickoff notes');
    });

    window.dispatchEvent(
      new CustomEvent('shogun-workspace-memberships-changed', {
        detail: {
          memberships: {
            'mem-1': 'apollo',
            'mem-2': 'apollo',
          },
        },
      }),
    );

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toHaveTextContent('Apollo procurement follow-up');
    });
    expect(runRuntimeActionMock).toHaveBeenCalledWith(
      'memory.fetch',
      { ids: ['mem-1', 'mem-2'] },
      { silentError: true },
    );
  });

  it('reloads memberships from desktop settings refresh while a workspace detail is open', async () => {
    let memberships: Record<string, string> = {
      'mem-1': 'apollo',
    };

    runRuntimeActionMock.mockImplementation((actionKey: string, payload?: any) => {
      if (actionKey === 'settings.load') {
        return Promise.resolve({
          ok: true,
          data: {
            settings: {
              sections: {
                workspace_memberships: {
                  memberships,
                },
              },
            },
          },
        });
      }
      if (actionKey === 'memory.fetch') {
        const ids = Array.isArray(payload?.ids) ? payload.ids : [];
        return Promise.resolve({
          ok: true,
          data: {
            items: ids.map((id: string) => ({
              id,
              title: id === 'mem-2' ? 'Apollo customer follow-up' : 'Apollo kickoff notes',
              source: 'manual',
              created_at: 1710000000000,
            })),
          },
        });
      }
      if (actionKey === 'settings.save') {
        return Promise.resolve({ ok: true, data: {} });
      }
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve(buildOwnerSummary());
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(<WorkScreen />);

    window.dispatchEvent(
      new CustomEvent('shogun-open-workspace-detail', {
        detail: { workspaceId: 'apollo' },
      }),
    );

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toHaveTextContent('Apollo kickoff notes');
    });
    expect(within(screen.getByRole('dialog')).getByText(/1 memory assigned/i)).toBeInTheDocument();

    memberships = {
      'mem-1': 'apollo',
      'mem-2': 'apollo',
    };

    window.dispatchEvent(new CustomEvent('shogun-settings-refresh'));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toHaveTextContent('Apollo customer follow-up');
    });
    expect(within(screen.getByRole('dialog')).getByText(/2 memories assigned/i)).toBeInTheDocument();
    expect(runRuntimeActionMock).toHaveBeenCalledWith(
      'memory.fetch',
      { ids: ['mem-1', 'mem-2'] },
      { silentError: true },
    );
  });
});

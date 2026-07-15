import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useMemoryWorkspace } from './useMemoryWorkspace';

const runRuntimeActionMock = vi.fn();

vi.mock('@/shared/ipc/runtime-actions', () => ({
  runRuntimeAction: (...args: unknown[]) => runRuntimeActionMock(...args),
}));

function settingsResponse(memberships: Record<string, string>) {
  return {
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
  };
}

describe('useMemoryWorkspace', () => {
  beforeEach(() => {
    runRuntimeActionMock.mockReset();
    (window as any).SHOGUN_RUNTIME = {
      getWorkProjects: () => [],
    };
  });

  it('updates workspace assignments from desktop membership events', async () => {
    let memberships: Record<string, string> = { 'mem-1': 'workspace:apollo' };

    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'settings.load') {
        return Promise.resolve(settingsResponse(memberships));
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    const { result } = renderHook(() => useMemoryWorkspace());

    await waitFor(() => {
      expect(result.current.workspaceAssignments).toEqual({ 'mem-1': 'workspace:apollo' });
    });

    act(() => {
      window.dispatchEvent(new CustomEvent('shogun-workspace-memberships-changed', {
        detail: {
          memberships: { 'mem-1': 'workspace:zephyr', 'mem-2': 'workspace:aurora' },
        },
      }));
    });

    expect(result.current.workspaceAssignments).toEqual({
      'mem-1': 'workspace:zephyr',
      'mem-2': 'workspace:aurora',
    });

    memberships = { 'mem-3': 'workspace:delta' };

    act(() => {
      window.dispatchEvent(new CustomEvent('shogun-settings-refresh'));
    });

    await waitFor(() => {
      expect(result.current.workspaceAssignments).toEqual({ 'mem-3': 'workspace:delta' });
    });
  });
});

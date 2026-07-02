import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useMemoryRetrievalSettings } from './useMemoryRetrievalSettings';

const runRuntimeActionMock = vi.fn();

vi.mock('@/shared/ipc/runtime-actions', () => ({
  runRuntimeAction: (...args: unknown[]) => runRuntimeActionMock(...args),
}));

function settingsResponse({
  semanticRerank = true,
  enableMemorySummary = true,
  readPath = 'graph',
  allowChatServerMemoryAssembly = true,
} = {}) {
  return {
    ok: true,
    data: {
      settings: {
        sections: {
          memory: {
            semanticRerank,
            enableMemorySummary,
          },
          kioku_graph: {
            read_path: readPath,
          },
          privacy: {
            allowChatServerMemoryAssembly,
          },
        },
      },
    },
  };
}

describe('useMemoryRetrievalSettings', () => {
  beforeEach(() => {
    runRuntimeActionMock.mockReset();
  });

  it('reloads the desktop memory settings on shogun-settings-refresh', async () => {
    let semanticRerank = true;
    let enableMemorySummary = true;
    let readPath = 'graph';
    let allowChatServerMemoryAssembly = true;

    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'settings.load') {
        return Promise.resolve(settingsResponse({
          semanticRerank,
          enableMemorySummary,
          readPath,
          allowChatServerMemoryAssembly,
        }));
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    const { result } = renderHook(() => useMemoryRetrievalSettings());

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
      expect(result.current.summaryEnabled).toBe(true);
      expect(result.current.graphReadPath).toBe('graph');
      expect(result.current.allowServerMemoryAssembly).toBe(true);
    });

    semanticRerank = false;
    enableMemorySummary = false;
    readPath = 'legacy';
    allowChatServerMemoryAssembly = false;

    act(() => {
      window.dispatchEvent(new CustomEvent('shogun-settings-refresh'));
    });

    await waitFor(() => {
      expect(result.current.summaryEnabled).toBe(false);
      expect(result.current.graphReadPath).toBe('legacy');
      expect(result.current.allowServerMemoryAssembly).toBe(false);
      expect(result.current.withSemantic({ query: 'aurora' })).toEqual({ query: 'aurora' });
    });
  });
});

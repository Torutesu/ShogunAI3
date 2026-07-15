import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryScreen } from './MemoryScreen';
import {
  clearPendingMemoryTimelineJump,
  stashPendingMemoryTimelineJump,
} from '@/shared/context/native-detail-events';

const runRuntimeActionMock = vi.fn();

vi.mock('@/shared/ipc/runtime-actions', () => ({
  runRuntimeAction: (...args: unknown[]) => runRuntimeActionMock(...args),
}));

vi.mock('./hooks/useMemoryWorkspace', () => ({
  useMemoryWorkspace: () => ({
    workspaceAssignments: {},
    setWorkspaceAssignments: vi.fn(),
    workProjects: [],
    assignMemoryToWorkspace: vi.fn(),
  }),
}));

vi.mock('./hooks/useMemoryFilters', () => ({
  useMemoryFilters: () => ({
    activeFilters: {
      sources: { screen: true, audio: true, input: true, calendar: true, mail: true },
      priority: { high: true, medium: true, low: true },
      providers: {},
    },
    filtersOpen: false,
    setFiltersOpen: vi.fn(),
    toggleFilter: vi.fn(),
    activeFilterCount: 0,
    resetFilters: vi.fn(),
    applyFilters: vi.fn(),
  }),
}));

vi.mock('./hooks/useMemoryRetrievalSettings', () => ({
  useMemoryRetrievalSettings: () => ({
    graphReadPath: false,
    summaryEnabled: false,
    allowServerMemoryAssembly: true,
    loaded: true,
    withSemantic: (payload: unknown) => payload,
  }),
}));

vi.mock('./components/MemoryRiverView', () => ({
  MemoryRiverView: ({
    scrubbed,
  }: {
    scrubbed?: { memoryId?: string | null; title?: string | null };
  }) => (
    <div data-testid="memory-river-view">
      River:{scrubbed?.memoryId || 'none'}:{scrubbed?.title || 'none'}
    </div>
  ),
}));

vi.mock('./components/MemorySearchView', () => ({
  MemorySearchView: ({
    seedQuery,
  }: {
    seedQuery?: string;
  }) => <div data-testid="memory-search-view">Search:{seedQuery || ''}</div>,
}));

vi.mock('./components/MemoryDigestView', () => ({
  MemoryDigestView: () => <div data-testid="memory-digest-view" />,
}));

vi.mock('./components/MemoryKakejikuView', () => ({
  MemoryKakejikuView: () => <div data-testid="memory-kakejiku-view" />,
}));

vi.mock('./components/MemoryHeatmapView', () => ({
  MemoryHeatmapView: () => <div data-testid="memory-heatmap-view" />,
}));

describe('MemoryScreen', () => {
  beforeEach(() => {
    clearPendingMemoryTimelineJump();
    runRuntimeActionMock.mockReset();
    runRuntimeActionMock.mockImplementation((actionKey: string, payload?: any) => {
      if (actionKey === 'entity.query') {
        return Promise.resolve({ ok: true, data: { entities: [] } });
      }
      if (actionKey === 'memory.timelineSearch') {
        return Promise.resolve({
          ok: true,
          data: {
            hits: [
              {
                id: 'mem-42',
                title: 'Aurora context capture',
                snippet: 'Important CRM note',
                source: 'manual',
                created_at: 1710000000000,
              },
            ],
            total: 1,
          },
        });
      }
      if (actionKey === 'memory.fetch') {
        if (payload?.id === 'mem-42') {
          return Promise.resolve({
            ok: true,
            data: {
              items: [
                {
                  id: 'mem-42',
                  title: 'Aurora context capture',
                  snippet: 'Important CRM note',
                  source: 'manual',
                  created_at: 1710000000000,
                },
              ],
            },
          });
        }
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      return Promise.resolve({ ok: true, data: {} });
    });
  });

  it('opens a pending memory jump after mount for lazy desktop transitions', async () => {
    stashPendingMemoryTimelineJump({
      memoryId: 'mem-42',
      query: 'Aurora context capture',
      view: 'river',
    });

    render(<MemoryScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('memory-river-view')).toHaveTextContent('mem-42');
      expect(screen.getByTestId('memory-river-view')).toHaveTextContent('Aurora context capture');
    });
  });

  it('opens a pending search jump after mount for lazy desktop transitions', async () => {
    stashPendingMemoryTimelineJump({
      query: 'security follow-up',
      view: 'search',
    });

    render(<MemoryScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('memory-search-view')).toHaveTextContent('Search:security follow-up');
    });
  });
});

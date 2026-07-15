import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryRiverView } from './MemoryRiverView';

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
const openContextTargetMock = vi.fn();
const openNativeDetailForEntityIdMock = vi.fn();

vi.mock('@/shared/context/context-target-navigation', () => ({
  nativeDetailDescriptorForEntityId: (entityId: string) => nativeDetailDescriptorForEntityIdMock(entityId),
  openContextTarget: (...args: unknown[]) => openContextTargetMock(...args),
  openNativeDetailForEntityId: (entityId: string) => openNativeDetailForEntityIdMock(entityId),
}));

vi.mock('./MemoryAiFieldPanel', () => ({
  MemoryAiFieldPanel: () => <div>Memory AI Field Panel</div>,
}));

describe('MemoryRiverView', () => {
  beforeEach(() => {
    nativeDetailDescriptorForEntityIdMock.mockClear();
    openContextTargetMock.mockReset();
    openNativeDetailForEntityIdMock.mockReset();
  });

  it('shows native detail and entity context actions for a meeting-linked memory', () => {
    render(
      <MemoryRiverView
        timelineLoading={false}
        events={[{ id: 'mem-1' }]}
        rawEvents={[{ id: 'mem-1' }]}
        scrubIdx={0}
        setScrubIdx={() => {}}
        scrubbed={{
          memoryId: 'mem-1',
          title: 'Aurora sync note',
          snippet: 'Security blocker discussed.',
          sourceRaw: 'meeting',
          src: 'meeting',
          t: '09:00',
          entityId: 'meeting:mtg-1',
        }}
        scrubSummary={null}
        scrubSummaryLoading={false}
        setScrubSummary={() => {}}
        setScrubSummaryLoading={() => {}}
        showRaw={true}
        setShowRaw={() => {}}
        setSummaryByMemId={() => ({})}
        batchSummarizing={0}
        timelineScrollRef={{ current: null }}
        scrollTimeline={() => {}}
        hourIndexFromEvents={{ counts: Array(24).fill(0), firstIdx: Array(24).fill(undefined), maxC: 1, topPriority: Array(24).fill(null) }}
        timeSpanLabel="09:00 - 10:00"
        srcIcon={() => 'calendar'}
        srcLabel={() => 'Meeting'}
        workProjects={[]}
        workspaceAssignments={{}}
        assignMenuOpen={false}
        setAssignMenuOpen={() => false}
        newWorkspaceDraft=""
        setNewWorkspaceDraft={() => {}}
        assignMemoryToWorkspace={async () => {}}
        allowServerMemoryAssembly={true}
      />,
    );

    expect(screen.getByText('meeting:mtg-1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Entity Context' }));
    expect(openContextTargetMock).toHaveBeenCalledWith({ targetId: 'meeting:mtg-1' });

    fireEvent.click(screen.getByRole('button', { name: 'Open Meeting Detail' }));
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('meeting:mtg-1');
  });
});

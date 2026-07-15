import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  jumpToMemoryTimeline,
  nativeDetailDescriptorForEntityId,
  openEvidenceReference,
  openContextTarget,
  openMeetingDetail,
  openNativeDetailForEntityId,
  openWorkspaceDetail,
} from './context-target-navigation';
import {
  clearPendingMemoryTimelineJump,
  clearPendingMeetingDetailId,
  clearPendingWorkspaceDetailId,
  takePendingMemoryTimelineJump,
  takePendingMeetingDetailId,
  takePendingWorkspaceDetailId,
} from './native-detail-events';

const focusEntityMock = vi.fn();

vi.mock('./entity-focus', () => ({
  focusEntity: (...args: unknown[]) => focusEntityMock(...args),
}));

describe('context target navigation', () => {
  beforeEach(() => {
    focusEntityMock.mockReset();
    clearPendingMemoryTimelineJump();
    clearPendingMeetingDetailId();
    clearPendingWorkspaceDetailId();
    (window as any).SHOGUN_RUNTIME = {
      setActiveScreen: vi.fn(),
    };
  });

  it('jumps to a concrete memory item by id', async () => {
    const onJump = vi.fn();
    window.addEventListener('shogun-jump-memory-timeline', onJump);

    jumpToMemoryTimeline({ memoryId: 'mem-123', query: 'Aurora', view: 'river' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('memory');
    expect(onJump).toHaveBeenCalledTimes(1);
    expect((onJump.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      memoryId: 'mem-123',
      query: 'Aurora',
      view: 'river',
    });
    window.removeEventListener('shogun-jump-memory-timeline', onJump);
  });

  it('opens targetKind=item records in Memory', async () => {
    const onJump = vi.fn();
    window.addEventListener('shogun-jump-memory-timeline', onJump);

    const result = openContextTarget({
      targetId: 'mem-456',
      targetKind: 'item',
      title: 'Investor call',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result).toBe('memory');
    expect((onJump.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      memoryId: 'mem-456',
      query: 'Investor call',
      view: 'river',
    });
    window.removeEventListener('shogun-jump-memory-timeline', onJump);
  });

  it('opens entity ids in Entity Context', () => {
    const result = openContextTarget({
      targetId: 'company:aurora',
      title: 'Aurora account',
    });

    expect(result).toBe('entity');
    expect(focusEntityMock).toHaveBeenCalledWith('company:aurora');
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('entity_context');
  });

  it('opens meeting ids in native meeting detail', async () => {
    const onOpen = vi.fn();
    window.addEventListener('shogun-open-meeting-detail', onOpen);

    const result = openContextTarget({
      targetId: 'meeting:mtg-ctx-1',
      title: 'Aurora sync',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result).toBe('meeting');
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('meetings');
    expect((onOpen.mock.calls[0]![0] as CustomEvent).detail).toEqual({ meetingId: 'mtg-ctx-1' });
    window.removeEventListener('shogun-open-meeting-detail', onOpen);
  });

  it('opens workspace ids in native workspace detail', async () => {
    const onOpen = vi.fn();
    window.addEventListener('shogun-open-workspace-detail', onOpen);

    const result = openContextTarget({
      targetId: 'workspace:founder-sales',
      title: 'Founder sales workspace',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result).toBe('workspace');
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('work');
    expect((onOpen.mock.calls[0]![0] as CustomEvent).detail).toEqual({ workspaceId: 'founder-sales' });
    window.removeEventListener('shogun-open-workspace-detail', onOpen);
  });

  it('falls back to Memory search for non-item summaries', async () => {
    const onJump = vi.fn();
    window.addEventListener('shogun-jump-memory-timeline', onJump);

    const result = openContextTarget({
      targetId: 'unknown-target',
      targetKind: 'session',
      title: 'security follow-up',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result).toBe('search');
    expect((onJump.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      query: 'security follow-up',
      view: 'search',
    });
    window.removeEventListener('shogun-jump-memory-timeline', onJump);
  });

  it('opens evidence ids as memory items by default', async () => {
    const onJump = vi.fn();
    window.addEventListener('shogun-jump-memory-timeline', onJump);

    const result = openEvidenceReference({
      id: 'mem-evidence-1',
      title: 'Security review note',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result).toBe('memory');
    expect((onJump.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      memoryId: 'mem-evidence-1',
      query: 'Security review note',
      view: 'river',
    });
    window.removeEventListener('shogun-jump-memory-timeline', onJump);
  });

  it('opens workspace evidence ids in native workspace detail', async () => {
    const onOpen = vi.fn();
    window.addEventListener('shogun-open-workspace-detail', onOpen);

    const result = openEvidenceReference({
      id: 'workspace:apollo',
      title: 'Apollo workspace note',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result).toBe('workspace');
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('work');
    expect((onOpen.mock.calls[0]![0] as CustomEvent).detail).toEqual({ workspaceId: 'apollo' });
    window.removeEventListener('shogun-open-workspace-detail', onOpen);
  });

  it('opens meeting detail via the shared native event', async () => {
    const onOpen = vi.fn();
    window.addEventListener('shogun-open-meeting-detail', onOpen);

    openMeetingDetail('mtg-aurora-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('meetings');
    expect((onOpen.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      meetingId: 'mtg-aurora-1',
    });
    window.removeEventListener('shogun-open-meeting-detail', onOpen);
  });

  it('opens workspace detail via the shared native event', async () => {
    const onOpen = vi.fn();
    window.addEventListener('shogun-open-workspace-detail', onOpen);

    openWorkspaceDetail('apollo');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('work');
    expect((onOpen.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      workspaceId: 'apollo',
    });
    window.removeEventListener('shogun-open-workspace-detail', onOpen);
  });

  it('derives native detail descriptors from entity ids', () => {
    expect(nativeDetailDescriptorForEntityId('meeting:mtg-1')).toEqual({
      kind: 'meeting',
      id: 'mtg-1',
      label: 'Open Meeting Detail',
    });
    expect(nativeDetailDescriptorForEntityId('workspace:apollo')).toEqual({
      kind: 'workspace',
      id: 'apollo',
      label: 'Open Workspace Detail',
    });
    expect(nativeDetailDescriptorForEntityId('company:aurora')).toBeNull();
  });

  it('opens native details directly from entity ids', async () => {
    const onMeetingOpen = vi.fn();
    const onWorkspaceOpen = vi.fn();
    window.addEventListener('shogun-open-meeting-detail', onMeetingOpen);
    window.addEventListener('shogun-open-workspace-detail', onWorkspaceOpen);

    expect(openNativeDetailForEntityId('meeting:mtg-2')).toBe(true);
    expect(openNativeDetailForEntityId('workspace:founder-sales')).toBe(true);
    expect(openNativeDetailForEntityId('company:aurora')).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((onMeetingOpen.mock.calls[0]![0] as CustomEvent).detail).toEqual({ meetingId: 'mtg-2' });
    expect((onWorkspaceOpen.mock.calls[0]![0] as CustomEvent).detail).toEqual({ workspaceId: 'founder-sales' });
    window.removeEventListener('shogun-open-meeting-detail', onMeetingOpen);
    window.removeEventListener('shogun-open-workspace-detail', onWorkspaceOpen);
  });

  it('stashes pending native detail ids for lazy desktop screen transitions', async () => {
    openMeetingDetail('mtg-pending-1');
    openWorkspaceDetail('workspace-pending-1');
    jumpToMemoryTimeline({ memoryId: 'mem-pending-1', query: 'Aurora', view: 'river' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(takePendingMemoryTimelineJump()).toEqual({
      memoryId: 'mem-pending-1',
      query: 'Aurora',
      view: 'river',
    });
    expect(takePendingMeetingDetailId()).toBe('mtg-pending-1');
    expect(takePendingWorkspaceDetailId()).toBe('workspace-pending-1');
  });
});

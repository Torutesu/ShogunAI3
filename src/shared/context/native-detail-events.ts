let pendingMeetingDetailId: string | null = null;
let pendingWorkspaceDetailId: string | null = null;
let pendingMemoryTimelineJump:
  | { query?: string; view?: 'river' | 'search'; memoryId?: string }
  | null = null;

function normalizeId(value: string | null | undefined): string | null {
  const id = String(value || '').trim();
  return id ? id : null;
}

export function stashPendingMeetingDetailId(meetingId: string | null | undefined): void {
  pendingMeetingDetailId = normalizeId(meetingId);
}

export function takePendingMeetingDetailId(): string | null {
  const id = pendingMeetingDetailId;
  pendingMeetingDetailId = null;
  return id;
}

export function clearPendingMeetingDetailId(meetingId?: string | null): void {
  const nextId = normalizeId(meetingId);
  if (!nextId || pendingMeetingDetailId === nextId) {
    pendingMeetingDetailId = null;
  }
}

export function dispatchOpenMeetingDetail(meetingId: string | null | undefined): void {
  const id = normalizeId(meetingId);
  if (!id) return;
  stashPendingMeetingDetailId(id);
  try {
    window.dispatchEvent(
      new CustomEvent('shogun-open-meeting-detail', {
        detail: { meetingId: id },
      }),
    );
  } catch (_error) {
    /* ignore */
  }
}

export function stashPendingWorkspaceDetailId(workspaceId: string | null | undefined): void {
  pendingWorkspaceDetailId = normalizeId(workspaceId);
}

export function takePendingWorkspaceDetailId(): string | null {
  const id = pendingWorkspaceDetailId;
  pendingWorkspaceDetailId = null;
  return id;
}

export function clearPendingWorkspaceDetailId(workspaceId?: string | null): void {
  const nextId = normalizeId(workspaceId);
  if (!nextId || pendingWorkspaceDetailId === nextId) {
    pendingWorkspaceDetailId = null;
  }
}

export function dispatchOpenWorkspaceDetail(workspaceId: string | null | undefined): void {
  const id = normalizeId(workspaceId);
  if (!id) return;
  stashPendingWorkspaceDetailId(id);
  try {
    window.dispatchEvent(
      new CustomEvent('shogun-open-workspace-detail', {
        detail: { workspaceId: id },
      }),
    );
  } catch (_error) {
    /* ignore */
  }
}

export function stashPendingMemoryTimelineJump(detail: {
  query?: string | null;
  view?: string | null;
  memoryId?: string | null;
} | null): void {
  if (!detail) {
    pendingMemoryTimelineJump = null;
    return;
  }
  const query = normalizeId(detail.query);
  const memoryId = normalizeId(detail.memoryId);
  const view = String(detail.view || '').trim() === 'search' ? 'search' : 'river';
  if (!query && !memoryId) {
    pendingMemoryTimelineJump = null;
    return;
  }
  pendingMemoryTimelineJump = {
    ...(query ? { query } : {}),
    ...(memoryId ? { memoryId } : {}),
    view,
  };
}

export function takePendingMemoryTimelineJump():
  | { query?: string; view?: 'river' | 'search'; memoryId?: string }
  | null {
  const detail = pendingMemoryTimelineJump;
  pendingMemoryTimelineJump = null;
  return detail;
}

export function clearPendingMemoryTimelineJump(): void {
  pendingMemoryTimelineJump = null;
}

export function dispatchMemoryTimelineJump(detail: {
  query?: string | null;
  view?: string | null;
  memoryId?: string | null;
}): void {
  const query = normalizeId(detail.query);
  const memoryId = normalizeId(detail.memoryId);
  const view = String(detail.view || '').trim() === 'search' ? 'search' : 'river';
  if (!query && !memoryId) return;
  stashPendingMemoryTimelineJump({ query, memoryId, view });
  try {
    window.dispatchEvent(
      new CustomEvent('shogun-jump-memory-timeline', {
        detail: {
          ...(query ? { query } : {}),
          ...(memoryId ? { memoryId } : {}),
          view,
        },
      }),
    );
  } catch (_error) {
    /* ignore */
  }
}

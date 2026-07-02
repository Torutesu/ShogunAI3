import { focusEntity } from '@/shared/context/entity-focus';
import {
  dispatchMemoryTimelineJump,
  dispatchOpenMeetingDetail,
  dispatchOpenWorkspaceDetail,
} from '@/shared/context/native-detail-events';

const ENTITY_TARGET_RE =
  /^(company|deal|investor|project|workspace|task|person|meeting|document|app):/i;

function activeRuntime(): any {
  return (window as any).SHOGUN_RUNTIME;
}

export function jumpToMemoryTimeline(options: {
  memoryId?: string | null;
  query?: string | null;
  view?: 'river' | 'search';
}): void {
  const memoryId = String(options.memoryId || '').trim();
  const query = String(options.query || '').trim();
  const view = options.view === 'search' ? 'search' : 'river';
  if (!memoryId) return;
  activeRuntime()?.setActiveScreen?.('memory');
  setTimeout(() => {
    dispatchMemoryTimelineJump({ memoryId, query, view });
  }, 0);
}

export function jumpToMemorySearch(query: string, view: 'river' | 'search' = 'search'): void {
  const nextQuery = String(query || '').trim();
  if (!nextQuery) return;
  activeRuntime()?.setActiveScreen?.('memory');
  setTimeout(() => {
    dispatchMemoryTimelineJump({ query: nextQuery, view });
  }, 0);
}

export function meetingIdFromContextTarget(targetId: string): string | null {
  const id = String(targetId || '').trim();
  if (!id) return null;
  if (id.startsWith('meeting:')) return id.slice('meeting:'.length) || null;
  if (id.startsWith('mtg-')) return id;
  return null;
}

export function workspaceIdFromContextTarget(targetId: string): string | null {
  const id = String(targetId || '').trim();
  if (!id) return null;
  if (id.startsWith('workspace:')) return id.slice('workspace:'.length) || null;
  return null;
}

export function nativeDetailDescriptorForEntityId(entityId: string): {
  kind: 'meeting' | 'workspace';
  id: string;
  label: 'Open Meeting Detail' | 'Open Workspace Detail';
} | null {
  const normalized = String(entityId || '').trim();
  if (!normalized) return null;
  const meetingId = meetingIdFromContextTarget(normalized);
  if (meetingId) {
    return {
      kind: 'meeting',
      id: meetingId,
      label: 'Open Meeting Detail',
    };
  }
  const workspaceId = workspaceIdFromContextTarget(normalized);
  if (workspaceId) {
    return {
      kind: 'workspace',
      id: workspaceId,
      label: 'Open Workspace Detail',
    };
  }
  return null;
}

export function openMeetingDetail(meetingId: string): void {
  const id = String(meetingId || '').trim();
  if (!id) return;
  activeRuntime()?.setActiveScreen?.('meetings');
  setTimeout(() => {
    dispatchOpenMeetingDetail(id);
  }, 0);
}

export function openWorkspaceDetail(workspaceId: string): void {
  const id = String(workspaceId || '').trim();
  if (!id) return;
  activeRuntime()?.setActiveScreen?.('work');
  setTimeout(() => {
    dispatchOpenWorkspaceDetail(id);
  }, 0);
}

export function openNativeDetailForEntityId(entityId: string): boolean {
  const descriptor = nativeDetailDescriptorForEntityId(entityId);
  if (!descriptor) return false;
  if (descriptor.kind === 'meeting') {
    openMeetingDetail(descriptor.id);
    return true;
  }
  openWorkspaceDetail(descriptor.id);
  return true;
}

export function openContextTarget(options: {
  targetId?: string | null;
  targetKind?: string | null;
  title?: string | null;
}): 'memory' | 'entity' | 'meeting' | 'workspace' | 'search' | 'noop' {
  const targetId = String(options.targetId || '').trim();
  const targetKind = String(options.targetKind || '').trim().toLowerCase();
  const title = String(options.title || '').trim();

  if (targetKind === 'item' && targetId) {
    jumpToMemoryTimeline({ memoryId: targetId, query: title, view: 'river' });
    return 'memory';
  }

  const nativeDetailDescriptor = nativeDetailDescriptorForEntityId(targetId);
  if (nativeDetailDescriptor) {
    openNativeDetailForEntityId(targetId);
    return nativeDetailDescriptor.kind;
  }

  if (targetId && ENTITY_TARGET_RE.test(targetId)) {
    focusEntity(targetId);
    activeRuntime()?.setActiveScreen?.('entity_context');
    return 'entity';
  }

  const query = title || targetId;
  if (query) {
    jumpToMemorySearch(query, 'search');
    return 'search';
  }

  return 'noop';
}

export function openEvidenceReference(options: {
  id?: string | null;
  title?: string | null;
}): 'memory' | 'entity' | 'meeting' | 'workspace' | 'noop' {
  const id = String(options.id || '').trim();
  const title = String(options.title || '').trim();
  if (!id) return 'noop';

  const nativeDetailDescriptor = nativeDetailDescriptorForEntityId(id);
  if (nativeDetailDescriptor) {
    openNativeDetailForEntityId(id);
    return nativeDetailDescriptor.kind;
  }

  if (ENTITY_TARGET_RE.test(id)) {
    focusEntity(id);
    activeRuntime()?.setActiveScreen?.('entity_context');
    return 'entity';
  }

  jumpToMemoryTimeline({ memoryId: id, query: title, view: 'river' });
  return 'memory';
}

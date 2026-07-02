import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkAiFieldPanel } from './WorkAiFieldPanel';
import { ACTION_LAYER_REFRESH_EVENT } from '@/shared/context/action-layer-events';

const runRuntimeActionMock = vi.fn();
const openEvidenceReferenceMock = vi.fn();
const openContextTargetMock = vi.fn();
const nativeDetailDescriptorForEntityIdMock = vi.fn((entityId: string) => {
  const normalized = String(entityId || '').trim();
  if (normalized.startsWith('workspace:')) {
    return { kind: 'workspace', id: normalized.slice('workspace:'.length), label: 'Open Workspace Detail' };
  }
  return null;
});
const openNativeDetailForEntityIdMock = vi.fn();
const focusEntityMock = vi.fn();
const focusActionTraceMock = vi.fn();

vi.mock('@/shared/ipc/runtime-actions', () => ({
  runRuntimeAction: (...args: unknown[]) => runRuntimeActionMock(...args),
}));

vi.mock('@/shared/context/context-target-navigation', () => ({
  openEvidenceReference: (...args: unknown[]) => openEvidenceReferenceMock(...args),
  openContextTarget: (...args: unknown[]) => openContextTargetMock(...args),
  nativeDetailDescriptorForEntityId: (entityId: string) => nativeDetailDescriptorForEntityIdMock(entityId),
  openNativeDetailForEntityId: (entityId: string) => openNativeDetailForEntityIdMock(entityId),
}));

vi.mock('@/shared/context/entity-focus', () => ({
  focusEntity: (...args: unknown[]) => focusEntityMock(...args),
}));

vi.mock('@/shared/context/action-trace-focus', () => ({
  focusActionTrace: (...args: unknown[]) => focusActionTraceMock(...args),
}));

describe('WorkAiFieldPanel', () => {
  beforeEach(() => {
    runRuntimeActionMock.mockReset();
    openEvidenceReferenceMock.mockReset();
    openContextTargetMock.mockReset();
    nativeDetailDescriptorForEntityIdMock.mockClear();
    openNativeDetailForEntityIdMock.mockReset();
    focusEntityMock.mockReset();
    focusActionTraceMock.mockReset();
    (window as any).SHOGUN_RUNTIME = {
      setActiveScreen: vi.fn(),
    };
  });

  it('opens the selected evidence memory', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'ai_field.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: 'workspace:workspace-1',
            summary: {
              ownerEntityId: 'workspace:workspace-1',
              aiFieldCount: 1,
              actionCount: 1,
              queueArtifactCount: 1,
            },
            actions: {
              items: [
                {
                  id: 'act-1',
                  ownerEntityId: 'workspace:workspace-1',
                  actionType: 'create_task',
                  title: 'Draft Apollo next steps',
                  detail: 'Turn workspace blockers into tasks',
                  status: 'approved',
                  sourceAiFieldId: 'af-1',
                  evidenceEventIds: ['mem-1'],
                  createdAt: '2026-06-29T00:00:00.000Z',
                  updatedAt: '2026-06-29T00:00:00.000Z',
                },
              ],
            },
            queueArtifacts: {
              items: [
                {
                  id: 'queue-1',
                  ownerEntityId: 'workspace:workspace-1',
                  queueType: 'task',
                  payload: { title: 'Apollo workspace sync' },
                  createdAt: '2026-06-29T00:00:00.000Z',
                },
              ],
            },
            latestAudits: [
              {
                actionId: 'act-1',
                latestAudit: {
                  id: 'audit-1',
                  actionId: 'act-1',
                  eventType: 'approved',
                  detail: 'Approved by workspace operator',
                  createdAt: '2026-06-29T00:00:00.000Z',
                },
              },
            ],
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(
      <WorkAiFieldPanel
        project={{ id: 'workspace-1', name: 'Apollo' }}
        memories={[{ id: 'mem-1', title: 'Apollo kickoff note' }]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'open selected evidence' }));
    expect(openEvidenceReferenceMock).toHaveBeenCalledWith({
      id: 'mem-1',
      title: 'Apollo kickoff note',
    });
  });

  it('opens shared context screens from the workspace owner summary', async () => {
    const onNavigateAway = vi.fn();
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'ai_field.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: 'workspace:workspace-1',
            summary: {
              ownerEntityId: 'workspace:workspace-1',
              aiFieldCount: 1,
              actionCount: 1,
              queueArtifactCount: 1,
            },
            actions: {
              items: [
                {
                  id: 'act-1',
                  ownerEntityId: 'workspace:workspace-1',
                  actionType: 'create_task',
                  title: 'Draft Apollo next steps',
                  detail: 'Turn workspace blockers into tasks',
                  status: 'approved',
                  sourceAiFieldId: 'af-1',
                  evidenceEventIds: ['mem-1'],
                  createdAt: '2026-06-29T00:00:00.000Z',
                  updatedAt: '2026-06-29T00:00:00.000Z',
                },
              ],
            },
            queueArtifacts: {
              items: [
                {
                  id: 'queue-1',
                  ownerEntityId: 'workspace:workspace-1',
                  queueType: 'task',
                  payload: { title: 'Apollo workspace sync' },
                  createdAt: '2026-06-29T00:00:00.000Z',
                },
              ],
            },
            latestAudits: [
              {
                actionId: 'act-1',
                latestAudit: {
                  id: 'audit-1',
                  actionId: 'act-1',
                  eventType: 'approved',
                  detail: 'Approved by workspace operator',
                  createdAt: '2026-06-29T00:00:00.000Z',
                },
              },
            ],
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(
      <WorkAiFieldPanel
        project={{ id: 'workspace-1', name: 'Apollo' }}
        memories={[{ id: 'mem-1', title: 'Apollo kickoff note' }]}
        onNavigateAway={onNavigateAway}
      />,
    );

    expect(await screen.findByText('Latest audit: Approved by workspace operator')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open audit' }));

    expect(focusEntityMock).toHaveBeenCalledWith('workspace:workspace-1');
    expect(focusActionTraceMock).toHaveBeenCalledWith({
      actionId: 'act-1',
      aiFieldId: 'af-1',
      openAudit: true,
    });
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');
    expect(onNavigateAway).toHaveBeenCalled();
  });

  it('routes the owner summary entity button through shared navigation', async () => {
    const onNavigateAway = vi.fn();
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'ai_field.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: 'workspace:workspace-1',
            summary: {
              ownerEntityId: 'workspace:workspace-1',
              aiFieldCount: 0,
              actionCount: 0,
              queueArtifactCount: 0,
            },
            actions: { items: [] },
            queueArtifacts: { items: [] },
            latestAudits: [],
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(
      <WorkAiFieldPanel
        project={{ id: 'workspace-1', name: 'Apollo' }}
        memories={[{ id: 'mem-1', title: 'Apollo kickoff note' }]}
        onNavigateAway={onNavigateAway}
      />,
    );

    expect(await screen.findByRole('button', { name: 'Entity Context' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Entity Context' }));
    expect(openContextTargetMock).toHaveBeenCalledWith({ targetId: 'workspace:workspace-1' });
    expect(onNavigateAway).toHaveBeenCalled();
  });

  it('shows native detail CTA for the workspace owner', async () => {
    const onNavigateAway = vi.fn();
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'ai_field.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: 'workspace:workspace-1',
            summary: {
              ownerEntityId: 'workspace:workspace-1',
              aiFieldCount: 0,
              actionCount: 0,
              queueArtifactCount: 0,
            },
            actions: { items: [] },
            queueArtifacts: { items: [] },
            latestAudits: [],
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(
      <WorkAiFieldPanel
        project={{ id: 'workspace-1', name: 'Apollo' }}
        memories={[{ id: 'mem-1', title: 'Apollo kickoff note' }]}
        onNavigateAway={onNavigateAway}
      />,
    );

    expect(await screen.findByRole('button', { name: 'Open Workspace Detail' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open Workspace Detail' }));
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('workspace:workspace-1');
    expect(onNavigateAway).toHaveBeenCalled();
  });

  it('dispatches action layer refresh after saving a workspace AI field', async () => {
    const refreshSpy = vi.fn();
    window.addEventListener(ACTION_LAYER_REFRESH_EVENT, refreshSpy);
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'ai_field.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'ai_field.upsert') {
        return Promise.resolve({ ok: true, data: { item: { id: 'af-work-1' } } });
      }
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: 'workspace:workspace-1',
            summary: { ownerEntityId: 'workspace:workspace-1', aiFieldCount: 0, actionCount: 0, queueArtifactCount: 0 },
            actions: { items: [] },
            queueArtifacts: { items: [] },
            latestAudits: [],
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<WorkAiFieldPanel project={{ id: 'workspace-1', name: 'Apollo' }} memories={[{ id: 'mem-1', title: 'Apollo kickoff note' }]} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create AI Field' }));

    await screen.findByRole('button', { name: 'Create AI Field' });
    expect(refreshSpy).toHaveBeenCalled();
    expect((refreshSpy.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ reason: 'workspace-ai-field-created' });
    window.removeEventListener(ACTION_LAYER_REFRESH_EVENT, refreshSpy);
  });
});

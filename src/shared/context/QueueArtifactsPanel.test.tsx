import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { QueueArtifactsPanel } from './QueueArtifactsPanel';
import { ACTION_LAYER_REFRESH_EVENT } from './action-layer-events';

const runRuntimeActionMock = vi.fn();
const openEvidenceReferenceMock = vi.fn();
const openContextTargetMock = vi.fn();
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
const openNativeDetailForEntityIdMock = vi.fn();
const openChatWithSeedMock = vi.fn();
const buildEntityChatSeedMock = vi.fn((input) => ({ text: `seed:${input.entityId}` }));
const focusEntityMock = vi.fn();
const inspectActionMock = vi.fn();
const inspectActionAuditMock = vi.fn();

vi.mock('@/shared/ipc/runtime-actions', () => ({
  runRuntimeAction: (...args: unknown[]) => runRuntimeActionMock(...args),
}));

vi.mock('./context-target-navigation', () => ({
  openEvidenceReference: (...args: unknown[]) => openEvidenceReferenceMock(...args),
  openContextTarget: (...args: unknown[]) => openContextTargetMock(...args),
  nativeDetailDescriptorForEntityId: (entityId: string) => nativeDetailDescriptorForEntityIdMock(entityId),
  openNativeDetailForEntityId: (entityId: string) => openNativeDetailForEntityIdMock(entityId),
}));

vi.mock('./chat-composer-seed', () => ({
  buildEntityChatSeed: (...args: any[]) => buildEntityChatSeedMock(args[0]),
  openChatWithSeed: (...args: any[]) => openChatWithSeedMock(args[0]),
}));

vi.mock('./entity-focus', () => ({
  focusEntity: (...args: any[]) => focusEntityMock(args[0]),
}));

describe('QueueArtifactsPanel', () => {
  beforeEach(() => {
    runRuntimeActionMock.mockReset();
    openEvidenceReferenceMock.mockReset();
    openContextTargetMock.mockReset();
    nativeDetailDescriptorForEntityIdMock.mockClear();
    openNativeDetailForEntityIdMock.mockReset();
    openChatWithSeedMock.mockReset();
    buildEntityChatSeedMock.mockClear();
    focusEntityMock.mockReset();
    inspectActionMock.mockReset();
    inspectActionAuditMock.mockReset();
    (window as any).SHOGUN_RUNTIME = { setActiveScreen: vi.fn(), pushToast: vi.fn() };
  });

  it('opens evidence references from queued artifacts', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'queue.tasks.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'sch-1',
                createdAt: Date.now(),
                payload: {
                  title: 'Create onboarding task',
                  owner_entity_id: 'company:aurora',
                  source_action_id: 'act-1',
                  evidence_event_ids: ['mem-1', 'meeting:aurora-sync'],
                },
              },
            ],
          },
        });
      }
      if (actionKey === 'action.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'act-1',
                status: 'executed',
                riskLevel: 'medium',
                title: 'Create onboarding task',
                sourceAiFieldId: 'af-1',
              },
            ],
          },
        });
      }
      if (actionKey === 'action.audit_list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'audit-1',
                eventType: 'executed',
                detail: 'Executed action via queue_only',
              },
            ],
          },
        });
      }
      if (actionKey === 'queue.crm_updates.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<QueueArtifactsPanel onInspectAction={inspectActionMock} onInspectActionAudit={inspectActionAuditMock} />);

    await waitFor(() => {
      expect(screen.getByText('Create onboarding task')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText('Executed action via queue_only')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'evidence mem-1' }));
    expect(openEvidenceReferenceMock).toHaveBeenCalledWith({
      id: 'mem-1',
      title: 'Create onboarding task',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Entity' }));
    expect(openContextTargetMock).toHaveBeenCalledWith({ targetId: 'company:aurora' });

    fireEvent.click(screen.getByRole('button', { name: 'Ask Chat' }));
    expect(buildEntityChatSeedMock).toHaveBeenCalledWith({
      entityId: 'company:aurora',
      entityLabel: 'company:aurora',
      actionLabel: 'Create onboarding task',
    });
    expect(openChatWithSeedMock).toHaveBeenCalledWith({ text: 'seed:company:aurora' });

    fireEvent.click(screen.getByRole('button', { name: 'action act-1' }));
    expect(inspectActionMock).toHaveBeenCalledWith('act-1', 'af-1');

    fireEvent.click(screen.getByRole('button', { name: 'Open audit' }));
    expect(inspectActionAuditMock).toHaveBeenCalledWith('act-1', 'af-1');
  });

  it('reloads queue items when the action layer emits a refresh event', async () => {
    let taskListCount = 0;
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'queue.tasks.list') {
        taskListCount += 1;
        return Promise.resolve({
          ok: true,
          data: {
            items: taskListCount === 1
              ? []
              : [
                  {
                    id: 'sch-2',
                    createdAt: Date.now(),
                    payload: {
                      title: 'Queued after execute',
                      owner_entity_id: 'company:aurora',
                      evidence_event_ids: [],
                    },
                  },
                ],
          },
        });
      }
      if (actionKey === 'queue.crm_updates.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'action.list' || actionKey === 'action.audit_list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<QueueArtifactsPanel />);

    await waitFor(() => {
      expect(screen.getByText('No locally queued tasks yet.')).toBeInTheDocument();
    });

    window.dispatchEvent(new CustomEvent(ACTION_LAYER_REFRESH_EVENT, { detail: { reason: 'test' } }));

    await waitFor(() => {
      expect(screen.getByText('Queued after execute')).toBeInTheDocument();
    });
  });

  it('shows queue-kind-specific retry and remove toasts', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string, payload?: any) => {
      if (actionKey === 'queue.tasks.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'task-q-1',
                createdAt: Date.now(),
                payload: {
                  title: 'Task queue row',
                  owner_entity_id: 'company:aurora',
                },
              },
            ],
          },
        });
      }
      if (actionKey === 'queue.crm_updates.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'crm-q-1',
                createdAt: Date.now(),
                payload: {
                  title: 'CRM queue row',
                  owner_entity_id: 'company:aurora',
                },
              },
            ],
          },
        });
      }
      if (actionKey === 'queue.tasks.retry' || actionKey === 'queue.crm_updates.remove') {
        return Promise.resolve({ ok: true, data: { id: String(payload?.id || '') } });
      }
      if (actionKey === 'action.list' || actionKey === 'action.audit_list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    const refreshSpy = vi.fn();
    window.addEventListener(ACTION_LAYER_REFRESH_EVENT, refreshSpy);

    render(<QueueArtifactsPanel />);

    await waitFor(() => {
      expect(screen.getByText('Task queue row')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText('CRM queue row')).toBeInTheDocument();
    });

    const retryButtons = screen.getAllByRole('button', { name: 'Retry' });
    fireEvent.click(retryButtons[0] as HTMLElement);
    await waitFor(() => {
      expect((window as any).SHOGUN_RUNTIME.pushToast).toHaveBeenCalledWith(
        'task queue item を再投入しました',
        'success',
      );
    });
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect((refreshSpy.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ reason: 'queue.tasks.retry' });
    expect((window as any).SHOGUN_RUNTIME.pushToast).toHaveBeenCalledWith(
      'task queue item を再投入しました',
      'success',
    );

    const removeButtons = screen.getAllByRole('button', { name: 'Remove' });
    fireEvent.click(removeButtons[1] as HTMLElement);
    await waitFor(() => {
      expect((window as any).SHOGUN_RUNTIME.pushToast).toHaveBeenCalledWith(
        'CRM update queue item を削除しました',
        'success',
      );
    });
    expect(refreshSpy).toHaveBeenCalledTimes(2);
    expect((refreshSpy.mock.calls[1]?.[0] as CustomEvent).detail).toEqual({ reason: 'queue.crm_updates.remove' });

    window.removeEventListener(ACTION_LAYER_REFRESH_EVENT, refreshSpy);
  });

  it('shows native detail CTA for meeting evidence on queued artifacts', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'queue.tasks.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'sch-1',
                createdAt: Date.now(),
                payload: {
                  title: 'Create onboarding task',
                  owner_entity_id: 'company:aurora',
                  source_action_id: 'act-1',
                  evidence_event_ids: ['meeting:aurora-sync'],
                },
              },
            ],
          },
        });
      }
      if (actionKey === 'action.list' || actionKey === 'action.audit_list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'queue.crm_updates.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<QueueArtifactsPanel />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open Meeting Detail' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open Meeting Detail' }));
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('meeting:aurora-sync');
  });

  it('routes the owner entity button through shared native navigation for meeting queue items', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'queue.tasks.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'sch-1',
                createdAt: Date.now(),
                payload: {
                  title: 'Create onboarding task',
                  owner_entity_id: 'meeting:aurora-sync',
                  source_action_id: 'act-1',
                  evidence_event_ids: [],
                },
              },
            ],
          },
        });
      }
      if (actionKey === 'action.list' || actionKey === 'action.audit_list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'queue.crm_updates.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<QueueArtifactsPanel />);

    await waitFor(() => {
      expect(screen.getByText('Create onboarding task')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Entity' }));
    expect(openContextTargetMock).toHaveBeenCalledWith({ targetId: 'meeting:aurora-sync' });
  });

  it('shows owner native detail CTA for workspace queue items', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'queue.tasks.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'sch-3',
                createdAt: Date.now(),
                payload: {
                  title: 'Workspace queue item',
                  owner_entity_id: 'workspace:apollo',
                  source_action_id: 'act-3',
                  evidence_event_ids: [],
                },
              },
            ],
          },
        });
      }
      if (actionKey === 'action.list' || actionKey === 'action.audit_list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'queue.crm_updates.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<QueueArtifactsPanel />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open Workspace Detail' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open Workspace Detail' }));
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('workspace:apollo');
  });

  it('shows queue focus chips and clear control when focus props are provided', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'queue.tasks.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'sch-focus-1',
                createdAt: Date.now(),
                payload: {
                  title: 'Focused queue item',
                  owner_entity_id: 'company:aurora',
                  source_action_id: 'act-focus-1',
                  evidence_event_ids: [],
                },
              },
            ],
          },
        });
      }
      if (actionKey === 'action.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'act-focus-1',
                status: 'executed',
                riskLevel: 'medium',
                title: 'Focused source action',
                detail: 'Carry the Aurora follow-up into the shared task queue.',
                sourceAiFieldId: 'af-focus-1',
              },
            ],
          },
        });
      }
      if (actionKey === 'action.audit_list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'audit-focus-1',
                eventType: 'executed',
                detail: 'Executed action via queue_only',
              },
            ],
          },
        });
      }
      if (actionKey === 'queue.crm_updates.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    const clearMock = vi.fn();
    const inspectAiFieldMock = vi.fn();
    render(
      <QueueArtifactsPanel
        focusQueueId="sch-focus-1"
        focusSourceActionId="act-focus-1"
        focusOwnerEntityId="company:aurora"
        onClearFocus={clearMock}
        onInspectAiField={inspectAiFieldMock}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Focused queue item')).toBeInTheDocument();
    });

    expect(screen.getByText('queue sch-focus-1')).toBeInTheDocument();
    expect(screen.getAllByText('action act-focus-1').length).toBeGreaterThan(0);
    expect(screen.getByText('ai_field af-focus-1')).toBeInTheDocument();
    expect(screen.getByText('entity company:aurora')).toBeInTheDocument();
    expect(screen.getByText('FOCUSED PROVENANCE')).toBeInTheDocument();
    expect(screen.getByText('Source action: Focused source action')).toBeInTheDocument();
    expect(screen.getByText('Carry the Aurora follow-up into the shared task queue.')).toBeInTheDocument();
    expect(screen.getByText('Latest audit: Executed action via queue_only')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ai_field af-focus-1' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'ai_field af-focus-1' }));
    expect(inspectAiFieldMock).toHaveBeenCalledWith('af-focus-1');

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(clearMock).toHaveBeenCalledTimes(1);
  });
});

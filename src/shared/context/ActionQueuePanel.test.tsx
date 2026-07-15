import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionQueuePanel } from './ActionQueuePanel';
import { ACTION_LAYER_REFRESH_EVENT } from './action-layer-events';

const runRuntimeActionMock = vi.fn();
const focusQueueArtifactMock = vi.fn();
const openChatWithSeedMock = vi.fn();
const buildActionChatSeedMock = vi.fn((input) => ({ text: `seed:${input.ownerEntityId}` }));
const buildDraftChatSeedMock = vi.fn((input) => ({ text: `draft-seed:${input.ownerEntityId}`, body: input.draftContent }));
const focusEntityMock = vi.fn();
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
const openEvidenceReferenceMock = vi.fn();
const openNativeDetailForEntityIdMock = vi.fn();

vi.mock('@/shared/ipc/runtime-actions', () => ({
  runRuntimeAction: (...args: unknown[]) => runRuntimeActionMock(...args),
}));

vi.mock('./chat-composer-seed', () => ({
  buildActionChatSeed: (...args: any[]) => buildActionChatSeedMock(args[0]),
  buildDraftChatSeed: (...args: any[]) => buildDraftChatSeedMock(args[0]),
  openChatWithSeed: (...args: any[]) => openChatWithSeedMock(args[0]),
}));

vi.mock('./context-target-navigation', () => ({
  nativeDetailDescriptorForEntityId: (entityId: string) => nativeDetailDescriptorForEntityIdMock(entityId),
  openContextTarget: (...args: any[]) => openContextTargetMock(args[0]),
  openEvidenceReference: (...args: any[]) => openEvidenceReferenceMock(args[0]),
  openNativeDetailForEntityId: (entityId: string) => openNativeDetailForEntityIdMock(entityId),
}));

vi.mock('./entity-focus', () => ({
  focusEntity: (...args: any[]) => focusEntityMock(args[0]),
}));

vi.mock('./queue-artifact-focus', () => ({
  focusQueueArtifact: (...args: any[]) => focusQueueArtifactMock(args[0]),
}));

describe('ActionQueuePanel', () => {
  beforeEach(() => {
    runRuntimeActionMock.mockReset();
    openChatWithSeedMock.mockReset();
    buildActionChatSeedMock.mockClear();
    buildDraftChatSeedMock.mockClear();
    focusEntityMock.mockReset();
    openContextTargetMock.mockReset();
    nativeDetailDescriptorForEntityIdMock.mockClear();
    openEvidenceReferenceMock.mockReset();
    openNativeDetailForEntityIdMock.mockReset();
    focusQueueArtifactMock.mockReset();
    (window as any).SHOGUN_RUNTIME = { setActiveScreen: vi.fn(), pushToast: vi.fn() };
  });

  it('opens entity context and chat from an action item', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'action.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'act-1',
                ownerEntityId: 'company:aurora',
                actionType: 'follow_up_email_draft',
                title: 'Draft security follow-up',
                detail: 'Include owner and timeline.',
                status: 'approved',
                riskLevel: 'medium',
                sourceAiFieldId: null,
                evidenceEventIds: ['mem-1'],
                executionResult: null,
                executedAt: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
            ],
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<ActionQueuePanel />);

    await waitFor(() => {
      expect(screen.getByText('Draft security follow-up')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Entity' }));
    expect(openContextTargetMock).toHaveBeenCalledWith({ targetId: 'company:aurora' });

    fireEvent.click(screen.getByRole('button', { name: 'Ask Chat' }));
    expect(buildActionChatSeedMock).toHaveBeenCalledWith({
      ownerEntityId: 'company:aurora',
      title: 'Draft security follow-up',
      actionType: 'follow_up_email_draft',
      status: 'approved',
      riskLevel: 'medium',
      detail: 'Include owner and timeline.',
    });
    expect(openChatWithSeedMock).toHaveBeenCalledWith({ text: 'seed:company:aurora' });
  });

  it('dispatches an action-layer refresh event and auto-focuses the queued task after execution', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'action.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'act-2',
                ownerEntityId: 'company:aurora',
                actionType: 'create_task',
                title: 'Create onboarding task',
                detail: 'Queue the post-meeting onboarding task.',
                status: 'approved',
                riskLevel: 'medium',
                sourceAiFieldId: 'af-1',
                evidenceEventIds: ['mem-1'],
                executionResult: null,
                executedAt: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
            ],
          },
        });
      }
      if (actionKey === 'action.execute') {
        return Promise.resolve({
          ok: true,
          data: {
            sideEffect: 'queue_only',
            item: {
              id: 'act-2',
              ownerEntityId: 'company:aurora',
              actionType: 'create_task',
              title: 'Create onboarding task',
              detail: 'Queue the post-meeting onboarding task.',
              status: 'executed',
              riskLevel: 'medium',
              sourceAiFieldId: 'af-1',
              evidenceEventIds: ['mem-1'],
              executionResult: { queued: { id: 'sch-1' } },
              executedAt: Date.now(),
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    const refreshSpy = vi.fn();
    window.addEventListener(ACTION_LAYER_REFRESH_EVENT, refreshSpy);

    render(<ActionQueuePanel />);

    await waitFor(() => {
      expect(screen.getByText('Create onboarding task')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Queue task' }));

    await waitFor(() => {
      expect(runRuntimeActionMock).toHaveBeenCalledWith('action.execute', { id: 'act-2' }, { silentError: true });
    });
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(focusQueueArtifactMock).toHaveBeenCalledWith({
      queueId: 'sch-1',
      sourceActionId: 'act-2',
      sourceAiFieldId: 'af-1',
      ownerEntityId: 'company:aurora',
    });
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');
    expect((window as any).SHOGUN_RUNTIME.pushToast).toHaveBeenCalledWith(
      '承認済み Action を実行し、task queue を開きました',
      'success',
    );

    window.removeEventListener(ACTION_LAYER_REFRESH_EVENT, refreshSpy);
  });

  it('reloads the action queue when the shared action layer refreshes', async () => {
    let listCount = 0;
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'action.list') {
        listCount += 1;
        return Promise.resolve({
          ok: true,
          data: {
            items: listCount === 1
              ? []
              : [
                  {
                    id: 'act-refresh-1',
                    ownerEntityId: 'company:aurora',
                    actionType: 'create_task',
                    title: 'Refreshed queue action',
                    detail: 'Loaded after shared refresh.',
                    status: 'approved',
                    riskLevel: 'medium',
                    sourceAiFieldId: null,
                    evidenceEventIds: [],
                    executionResult: null,
                    executedAt: null,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                  },
                ],
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<ActionQueuePanel />);

    await waitFor(() => {
      expect(screen.getByText('No proposed actions yet. Start by converting an AI Field into a concrete, reviewable next step.')).toBeInTheDocument();
    });

    window.dispatchEvent(new CustomEvent(ACTION_LAYER_REFRESH_EVENT, { detail: { reason: 'test-refresh' } }));

    await waitFor(() => {
      expect(screen.getByText('Refreshed queue action')).toBeInTheDocument();
    });
  });

  it('opens the task queue focus for executed task actions', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'action.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'act-queued',
                ownerEntityId: 'company:aurora',
                actionType: 'create_task',
                title: 'Create onboarding task',
                detail: 'Queue the post-meeting onboarding task.',
                status: 'executed',
                riskLevel: 'medium',
                sourceAiFieldId: 'af-1',
                evidenceEventIds: ['mem-1'],
                executionResult: { queued: { id: 'sch-queued-1' } },
                executedAt: Date.now(),
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
            ],
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<ActionQueuePanel />);

    await waitFor(() => {
      expect(screen.getByText('Create onboarding task')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open task queue' }));

    expect(focusQueueArtifactMock).toHaveBeenCalledWith({
      queueId: 'sch-queued-1',
      sourceActionId: 'act-queued',
      sourceAiFieldId: 'af-1',
      ownerEntityId: 'company:aurora',
    });
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');
  });

  it('opens the CRM queue focus for executed CRM actions', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'action.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'act-crm',
                ownerEntityId: 'company:aurora',
                actionType: 'update_crm',
                title: 'Queue CRM blocker update',
                detail: 'Queue the latest blocker update into CRM.',
                status: 'executed',
                riskLevel: 'medium',
                sourceAiFieldId: 'af-1',
                evidenceEventIds: ['mem-1'],
                executionResult: { queued: { id: 'crm-queued-1' } },
                executedAt: Date.now(),
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
            ],
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<ActionQueuePanel />);

    await waitFor(() => {
      expect(screen.getByText('Queue CRM blocker update')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open CRM queue' }));

    expect(focusQueueArtifactMock).toHaveBeenCalledWith({
      queueId: 'crm-queued-1',
      sourceActionId: 'act-crm',
      sourceAiFieldId: 'af-1',
      ownerEntityId: 'company:aurora',
    });
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');
  });

  it('dispatches an action-layer refresh event and auto-focuses the CRM queue after execution', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'action.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'act-crm-exec',
                ownerEntityId: 'company:aurora',
                actionType: 'update_crm',
                title: 'Queue CRM blocker update',
                detail: 'Queue the latest blocker update into CRM.',
                status: 'approved',
                riskLevel: 'medium',
                sourceAiFieldId: 'af-1',
                evidenceEventIds: ['mem-1'],
                executionResult: null,
                executedAt: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
            ],
          },
        });
      }
      if (actionKey === 'action.execute') {
        return Promise.resolve({
          ok: true,
          data: {
            sideEffect: 'crm_queue_only',
            item: {
              id: 'act-crm-exec',
              ownerEntityId: 'company:aurora',
              actionType: 'update_crm',
              title: 'Queue CRM blocker update',
              detail: 'Queue the latest blocker update into CRM.',
              status: 'executed',
              riskLevel: 'medium',
              sourceAiFieldId: 'af-1',
              evidenceEventIds: ['mem-1'],
              executionResult: { queued: { id: 'crm-1' } },
              executedAt: Date.now(),
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<ActionQueuePanel />);

    await waitFor(() => {
      expect(screen.getByText('Queue CRM blocker update')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Queue CRM update' }));

    await waitFor(() => {
      expect(runRuntimeActionMock).toHaveBeenCalledWith('action.execute', { id: 'act-crm-exec' }, { silentError: true });
    });
    expect(focusQueueArtifactMock).toHaveBeenCalledWith({
      queueId: 'crm-1',
      sourceActionId: 'act-crm-exec',
      sourceAiFieldId: 'af-1',
      ownerEntityId: 'company:aurora',
    });
    expect((window as any).SHOGUN_RUNTIME.pushToast).toHaveBeenCalledWith(
      '承認済み Action を実行し、CRM queue を開きました',
      'success',
    );
  });

  it('treats legacy queue_crm_update items as executable CRM actions', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'action.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'act-crm-legacy',
                ownerEntityId: 'company:aurora',
                actionType: 'queue_crm_update',
                title: 'Legacy CRM queue item',
                detail: 'Created before the action type rename.',
                status: 'approved',
                riskLevel: 'medium',
                sourceAiFieldId: 'af-1',
                evidenceEventIds: ['mem-1'],
                executionResult: null,
                executedAt: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
            ],
          },
        });
      }
      if (actionKey === 'action.execute') {
        return Promise.resolve({
          ok: true,
          data: {
            sideEffect: 'crm_queue_only',
            item: {
              id: 'act-crm-legacy',
              ownerEntityId: 'company:aurora',
              actionType: 'queue_crm_update',
              title: 'Legacy CRM queue item',
              detail: 'Created before the action type rename.',
              status: 'executed',
              riskLevel: 'medium',
              sourceAiFieldId: 'af-1',
              evidenceEventIds: ['mem-1'],
              executionResult: { queued: { id: 'crm-legacy-1' } },
              executedAt: Date.now(),
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<ActionQueuePanel />);

    await waitFor(() => {
      expect(screen.getByText('Legacy CRM queue item')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Queue CRM update' }));

    await waitFor(() => {
      expect(runRuntimeActionMock).toHaveBeenCalledWith('action.execute', { id: 'act-crm-legacy' }, { silentError: true });
    });
    expect(focusQueueArtifactMock).toHaveBeenCalledWith({
      queueId: 'crm-legacy-1',
      sourceActionId: 'act-crm-legacy',
      sourceAiFieldId: 'af-1',
      ownerEntityId: 'company:aurora',
    });
  });

  it('auto-opens executed draft results in Chat with a draft seed', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'action.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'act-draft',
                ownerEntityId: 'company:aurora',
                actionType: 'follow_up_email_draft',
                title: 'Draft security follow-up',
                detail: 'Include owner and timeline.',
                status: 'approved',
                riskLevel: 'medium',
                sourceAiFieldId: null,
                evidenceEventIds: ['mem-1'],
                executionResult: null,
                executedAt: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
            ],
          },
        });
      }
      if (actionKey === 'action.execute') {
        return Promise.resolve({
          ok: true,
          data: {
            sideEffect: 'draft_only',
            item: {
              id: 'act-draft',
              ownerEntityId: 'company:aurora',
              actionType: 'follow_up_email_draft',
              title: 'Draft security follow-up',
              detail: 'Include owner and timeline.',
              status: 'executed',
              riskLevel: 'medium',
              sourceAiFieldId: null,
              evidenceEventIds: ['mem-1'],
              executionResult: {
                content: '# Draft\n\nSubject: Follow-up\n\nPlease review the timeline.',
              },
              executedAt: Date.now(),
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<ActionQueuePanel />);

    await waitFor(() => {
      expect(screen.getByText('Draft security follow-up')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Execute draft' }));

    await waitFor(() => {
      expect(runRuntimeActionMock).toHaveBeenCalledWith('action.execute', { id: 'act-draft' }, { silentError: true });
    });

    expect(buildDraftChatSeedMock).toHaveBeenCalledWith({
      ownerEntityId: 'company:aurora',
      title: 'Draft security follow-up',
      actionType: 'follow_up_email_draft',
      detail: 'Include owner and timeline.',
      draftContent: '# Draft\n\nSubject: Follow-up\n\nPlease review the timeline.',
    });
    expect(openChatWithSeedMock).toHaveBeenCalledWith({
      text: 'draft-seed:company:aurora',
      body: '# Draft\n\nSubject: Follow-up\n\nPlease review the timeline.',
    });
    expect((window as any).SHOGUN_RUNTIME.pushToast).toHaveBeenCalledWith(
      '承認済み Action を実行し、draft を Chat に開きました',
      'success',
    );
  });

  it('prefers native navigation payloads for executed task actions', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'action.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'act-nav-task',
                ownerEntityId: 'company:aurora',
                actionType: 'create_task',
                title: 'Create onboarding task',
                detail: 'Queue the post-meeting onboarding task.',
                status: 'approved',
                riskLevel: 'medium',
                sourceAiFieldId: 'af-1',
                evidenceEventIds: ['mem-1'],
                executionResult: null,
                executedAt: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
            ],
          },
        });
      }
      if (actionKey === 'action.execute') {
        return Promise.resolve({
          ok: true,
          data: {
            sideEffect: 'queue_only',
            navigation: {
              screen: 'actions',
              queueId: 'sch-nav-1',
              sourceActionId: 'act-nav-task',
              aiFieldId: 'af-1',
              entityId: 'company:aurora',
            },
            item: {
              id: 'act-nav-task',
              ownerEntityId: 'company:aurora',
              actionType: 'create_task',
              title: 'Create onboarding task',
              detail: 'Queue the post-meeting onboarding task.',
              status: 'executed',
              riskLevel: 'medium',
              sourceAiFieldId: 'af-1',
              evidenceEventIds: ['mem-1'],
              executionResult: { queued: { id: 'sch-nav-1' } },
              executedAt: Date.now(),
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    const navigateSpy = vi.fn();
    window.addEventListener('shogun-app-navigate', navigateSpy as EventListener);

    render(<ActionQueuePanel />);

    await waitFor(() => {
      expect(screen.getByText('Create onboarding task')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Queue task' }));

    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledTimes(1);
    });
    expect((navigateSpy.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      screen: 'actions',
      queueId: 'sch-nav-1',
      sourceActionId: 'act-nav-task',
      aiFieldId: 'af-1',
      entityId: 'company:aurora',
    });
    expect(focusQueueArtifactMock).not.toHaveBeenCalled();
    expect(openChatWithSeedMock).not.toHaveBeenCalled();

    window.removeEventListener('shogun-app-navigate', navigateSpy as EventListener);
  });

  it('prefers native navigation payloads for executed draft actions', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'action.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'act-nav-draft',
                ownerEntityId: 'company:aurora',
                actionType: 'follow_up_email_draft',
                title: 'Draft security follow-up',
                detail: 'Include owner and timeline.',
                status: 'approved',
                riskLevel: 'medium',
                sourceAiFieldId: null,
                evidenceEventIds: ['mem-1'],
                executionResult: null,
                executedAt: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
            ],
          },
        });
      }
      if (actionKey === 'action.execute') {
        return Promise.resolve({
          ok: true,
          data: {
            sideEffect: 'draft_only',
            navigation: {
              screen: 'chat',
              text: 'Draft reply for Aurora',
              assembleMemory: true,
              newChat: true,
              autoSend: false,
              memoryAssemblyQuery: 'Aurora follow-up',
            },
            item: {
              id: 'act-nav-draft',
              ownerEntityId: 'company:aurora',
              actionType: 'follow_up_email_draft',
              title: 'Draft security follow-up',
              detail: 'Include owner and timeline.',
              status: 'executed',
              riskLevel: 'medium',
              sourceAiFieldId: null,
              evidenceEventIds: ['mem-1'],
              executionResult: {
                content: '# Draft\n\nSubject: Follow-up\n\nPlease review the timeline.',
              },
              executedAt: Date.now(),
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    const navigateSpy = vi.fn();
    window.addEventListener('shogun-app-navigate', navigateSpy as EventListener);

    render(<ActionQueuePanel />);

    await waitFor(() => {
      expect(screen.getByText('Draft security follow-up')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Execute draft' }));

    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledTimes(1);
    });
    expect((navigateSpy.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      screen: 'chat',
      text: 'Draft reply for Aurora',
      assembleMemory: true,
      newChat: true,
      autoSend: false,
      memoryAssemblyQuery: 'Aurora follow-up',
    });
    expect(buildDraftChatSeedMock).not.toHaveBeenCalled();
    expect(openChatWithSeedMock).not.toHaveBeenCalled();
    expect(focusQueueArtifactMock).not.toHaveBeenCalled();

    window.removeEventListener('shogun-app-navigate', navigateSpy as EventListener);
  });

  it('manually opens executed draft results in Chat with a draft seed', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'action.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'act-draft',
                ownerEntityId: 'company:aurora',
                actionType: 'follow_up_email_draft',
                title: 'Draft security follow-up',
                detail: 'Include owner and timeline.',
                status: 'executed',
                riskLevel: 'medium',
                sourceAiFieldId: null,
                evidenceEventIds: ['mem-1'],
                executionResult: {
                  content: '# Draft\n\nSubject: Follow-up\n\nPlease review the timeline.',
                },
                executedAt: Date.now(),
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
            ],
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<ActionQueuePanel />);

    await waitFor(() => {
      expect(screen.getByText('Draft security follow-up')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open draft in Chat' }));

    expect(buildDraftChatSeedMock).toHaveBeenCalledWith({
      ownerEntityId: 'company:aurora',
      title: 'Draft security follow-up',
      actionType: 'follow_up_email_draft',
      detail: 'Include owner and timeline.',
      draftContent: '# Draft\n\nSubject: Follow-up\n\nPlease review the timeline.',
    });
    expect(openChatWithSeedMock).toHaveBeenCalledWith({
      text: 'draft-seed:company:aurora',
      body: '# Draft\n\nSubject: Follow-up\n\nPlease review the timeline.',
    });
  });

  it('shows native detail CTA for meeting evidence on actions', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'action.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'act-1',
                ownerEntityId: 'company:aurora',
                actionType: 'follow_up_email_draft',
                title: 'Draft security follow-up',
                detail: 'Include owner and timeline.',
                status: 'approved',
                riskLevel: 'medium',
                sourceAiFieldId: null,
                evidenceEventIds: ['meeting:mtg-1'],
                executionResult: null,
                executedAt: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
            ],
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<ActionQueuePanel />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open Meeting Detail' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open Meeting Detail' }));
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('meeting:mtg-1');
  });

  it('routes the owner entity button through shared native navigation for meeting owners', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'action.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'act-1',
                ownerEntityId: 'meeting:mtg-1',
                actionType: 'follow_up_email_draft',
                title: 'Draft security follow-up',
                detail: 'Include owner and timeline.',
                status: 'approved',
                riskLevel: 'medium',
                sourceAiFieldId: null,
                evidenceEventIds: ['mem-1'],
                executionResult: null,
                executedAt: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
            ],
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<ActionQueuePanel />);

    await waitFor(() => {
      expect(screen.getByText('Draft security follow-up')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Entity' }));
    expect(openContextTargetMock).toHaveBeenCalledWith({ targetId: 'meeting:mtg-1' });
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionProposalCard } from './ActionProposalCard';
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
const buildActionChatSeedMock = vi.fn((input) => ({ text: `seed:${input.ownerEntityId}` }));
const focusEntityMock = vi.fn();
const focusAiFieldMock = vi.fn();
const focusActionTraceMock = vi.fn();

vi.mock('@/shared/ipc/runtime-actions', () => ({
  runRuntimeAction: (...args: unknown[]) => runRuntimeActionMock(...args),
}));

vi.mock('./context-target-navigation', () => ({
  openEvidenceReference: (...args: any[]) => openEvidenceReferenceMock(args[0]),
  openContextTarget: (...args: any[]) => openContextTargetMock(args[0]),
  nativeDetailDescriptorForEntityId: (entityId: string) => nativeDetailDescriptorForEntityIdMock(entityId),
  openNativeDetailForEntityId: (entityId: string) => openNativeDetailForEntityIdMock(entityId),
}));

vi.mock('./chat-composer-seed', () => ({
  buildActionChatSeed: (...args: any[]) => buildActionChatSeedMock(args[0]),
  openChatWithSeed: (...args: any[]) => openChatWithSeedMock(args[0]),
}));

vi.mock('./entity-focus', () => ({
  focusEntity: (...args: any[]) => focusEntityMock(args[0]),
}));

vi.mock('./ai-field-focus', () => ({
  focusAiField: (...args: any[]) => focusAiFieldMock(args[0]),
}));

vi.mock('./action-trace-focus', () => ({
  focusActionTrace: (...args: any[]) => focusActionTraceMock(args[0]),
}));

describe('ActionProposalCard', () => {
  beforeEach(() => {
    runRuntimeActionMock.mockReset();
    openEvidenceReferenceMock.mockReset();
    openContextTargetMock.mockReset();
    nativeDetailDescriptorForEntityIdMock.mockClear();
    openNativeDetailForEntityIdMock.mockReset();
    openChatWithSeedMock.mockReset();
    buildActionChatSeedMock.mockClear();
    focusEntityMock.mockReset();
    focusAiFieldMock.mockReset();
    focusActionTraceMock.mockReset();
    (window as any).SHOGUN_RUNTIME = { setActiveScreen: vi.fn(), pushToast: vi.fn() };
  });

  it('opens entity, AI field, action trace, chat, and evidence from recent actions', async () => {
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
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<ActionProposalCard ownerEntityId="company:aurora" />);

    await waitFor(() => {
      expect(screen.getByText('Draft security follow-up')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'evidence mem-1' }));
    expect(openEvidenceReferenceMock).toHaveBeenCalledWith({
      id: 'mem-1',
      title: 'Draft security follow-up',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Entity' }));
    expect(openContextTargetMock).toHaveBeenCalledWith({ targetId: 'company:aurora' });

    fireEvent.click(screen.getByRole('button', { name: 'AI Field' }));
    expect(focusEntityMock).toHaveBeenCalledWith('company:aurora');
    expect(focusAiFieldMock).toHaveBeenCalledWith('af-1');
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('ai_fields');

    fireEvent.click(screen.getByRole('button', { name: 'Open Action' }));
    expect(focusActionTraceMock).toHaveBeenCalledWith({
      actionId: 'act-1',
      aiFieldId: 'af-1',
      openAudit: false,
    });
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');

    fireEvent.click(screen.getByRole('button', { name: 'Open Audit' }));
    expect(focusActionTraceMock).toHaveBeenCalledWith({
      actionId: 'act-1',
      aiFieldId: 'af-1',
      openAudit: true,
    });
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');

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

  it('shows native detail CTA for meeting evidence on recent actions', async () => {
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

    render(<ActionProposalCard ownerEntityId="company:aurora" />);

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

    render(<ActionProposalCard ownerEntityId="meeting:mtg-1" />);

    await waitFor(() => {
      expect(screen.getByText('Draft security follow-up')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Entity' }));
    expect(openContextTargetMock).toHaveBeenCalledWith({ targetId: 'meeting:mtg-1' });
  });

  it('dispatches action layer refresh after proposing a new action', async () => {
    const refreshSpy = vi.fn();
    window.addEventListener(ACTION_LAYER_REFRESH_EVENT, refreshSpy);
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'action.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'action.propose') {
        return Promise.resolve({ ok: true, data: { item: { id: 'act-new-1' } } });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<ActionProposalCard ownerEntityId="company:aurora" seedTitle="Draft Aurora follow-up" />);

    fireEvent.click(screen.getByRole('button', { name: 'Propose Action' }));

    await waitFor(() => {
      expect(refreshSpy).toHaveBeenCalled();
    });
    expect((refreshSpy.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ reason: 'action-proposal-created' });
    window.removeEventListener(ACTION_LAYER_REFRESH_EVENT, refreshSpy);
  });

  it('dispatches action layer refresh after changing action status', async () => {
    const refreshSpy = vi.fn();
    window.addEventListener(ACTION_LAYER_REFRESH_EVENT, refreshSpy);
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
                status: 'proposed',
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
      if (actionKey === 'action.set_status') {
        return Promise.resolve({ ok: true, data: { id: 'act-1', status: 'approved' } });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<ActionProposalCard ownerEntityId="company:aurora" />);

    await waitFor(() => {
      expect(screen.getByText('Draft security follow-up')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Mark approved' }));

    await waitFor(() => {
      expect(refreshSpy).toHaveBeenCalled();
    });
    expect((refreshSpy.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ reason: 'action-proposal-status-approved' });
    window.removeEventListener(ACTION_LAYER_REFRESH_EVENT, refreshSpy);
  });

  it('reloads recent actions when the shared action layer refreshes', async () => {
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
                    actionType: 'follow_up_email_draft',
                    title: 'Refreshed follow-up draft',
                    detail: 'Loaded after shared action refresh.',
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

    render(<ActionProposalCard ownerEntityId="company:aurora" />);

    await waitFor(() => {
      expect(screen.getByText('No actions yet for this owner.')).toBeInTheDocument();
    });

    window.dispatchEvent(new CustomEvent(ACTION_LAYER_REFRESH_EVENT, { detail: { reason: 'test-refresh' } }));

    await waitFor(() => {
      expect(screen.getByText('Refreshed follow-up draft')).toBeInTheDocument();
    });
  });
});

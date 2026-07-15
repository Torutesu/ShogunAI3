import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryAiFieldPanel } from './MemoryAiFieldPanel';
import { ACTION_LAYER_REFRESH_EVENT } from '@/shared/context/action-layer-events';

const runRuntimeActionMock = vi.fn();
const focusEntityMock = vi.fn();
const focusAiFieldMock = vi.fn();
const focusActionTraceMock = vi.fn();
const openContextTargetMock = vi.fn();
const nativeDetailDescriptorForEntityIdMock = vi.fn((_entityId: string) => null);
const openNativeDetailForEntityIdMock = vi.fn();

vi.mock('@/shared/ipc/runtime-actions', () => ({
  runRuntimeAction: (...args: unknown[]) => runRuntimeActionMock(...args),
}));

vi.mock('@/shared/context/context-target-navigation', () => ({
  openContextTarget: (...args: unknown[]) => openContextTargetMock(...args),
  openEvidenceReference: vi.fn(),
  nativeDetailDescriptorForEntityId: (entityId: string) => nativeDetailDescriptorForEntityIdMock(entityId),
  openNativeDetailForEntityId: (entityId: string) => openNativeDetailForEntityIdMock(entityId),
}));

vi.mock('@/shared/context/entity-focus', () => ({
  focusEntity: (...args: unknown[]) => focusEntityMock(...args),
}));

vi.mock('@/shared/context/ai-field-focus', () => ({
  focusAiField: (...args: unknown[]) => focusAiFieldMock(...args),
}));

vi.mock('@/shared/context/action-trace-focus', () => ({
  focusActionTrace: (...args: unknown[]) => focusActionTraceMock(...args),
}));

describe('MemoryAiFieldPanel', () => {
  beforeEach(() => {
    runRuntimeActionMock.mockReset();
    focusEntityMock.mockReset();
    focusAiFieldMock.mockReset();
    focusActionTraceMock.mockReset();
    openContextTargetMock.mockReset();
    nativeDetailDescriptorForEntityIdMock.mockClear();
    openNativeDetailForEntityIdMock.mockReset();
    (window as any).SHOGUN_RUNTIME = { setActiveScreen: vi.fn(), pushToast: vi.fn() };
  });

  it('shows owner summary context for the memory entity and opens action trace from the embedded action card', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'ai_field.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'action.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'act-embedded-1',
                ownerEntityId: 'company:aurora',
                actionType: 'follow_up_email_draft',
                title: 'Send Aurora recap',
                detail: 'Summarize blockers and next step.',
                status: 'approved',
                riskLevel: 'medium',
                sourceAiFieldId: 'af-1',
                evidenceEventIds: ['mem-1'],
                executionResult: null,
                executedAt: null,
                createdAt: 0,
                updatedAt: 0,
              },
            ],
          },
        });
      }
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: 'company:aurora',
            entityContext: null,
            aiFields: { items: [], total: 0 },
            actions: {
              items: [
                {
                  id: 'act-1',
                  ownerEntityId: 'company:aurora',
                  actionType: 'update_crm',
                  title: 'Queue company update',
                  detail: '',
                  status: 'approved',
                  riskLevel: 'medium',
                  sourceAiFieldId: null,
                  evidenceEventIds: [],
                  executionResult: null,
                  executedAt: null,
                  createdAt: 0,
                  updatedAt: 0,
                },
              ],
              total: 1,
            },
            queueArtifacts: {
              items: [
                {
                  id: 'crm-q-1',
                  createdAt: 0,
                  payload: { title: 'Update CRM blocker field' },
                },
              ],
              total: 1,
            },
            latestAudits: [
              {
                actionId: 'act-1',
                latestAudit: {
                  id: 'audit-1',
                  actor: 'user',
                  objectType: 'action',
                  objectId: 'act-1',
                  eventType: 'status_changed',
                  detail: 'Approved by operator',
                  payload: null,
                  evidenceEventIds: [],
                  createdAt: 0,
                },
              },
            ],
            summary: {
              aiFieldCount: 0,
              actionCount: 1,
              queueArtifactCount: 1,
              actionStatusCounts: { proposed: 0, approved: 1, executed: 0, rejected: 0 },
            },
          },
        });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(
      <MemoryAiFieldPanel
        scrubbed={{ memoryId: 'mem-1', entityId: 'company:aurora', title: 'Aurora sync note' }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('OWNER SUMMARY')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText('Latest action: Queue company update [approved]')).toBeInTheDocument();
    });
    expect(screen.getByText('Latest queue: Update CRM blocker field')).toBeInTheDocument();
    expect(screen.getByText('Latest audit: Approved by operator')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Send Aurora recap')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open Audit' }));
    expect(focusEntityMock).toHaveBeenCalledWith('company:aurora');
    expect(focusActionTraceMock).toHaveBeenCalledWith({
      actionId: 'act-embedded-1',
      aiFieldId: 'af-1',
      openAudit: true,
    });
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');
  });

  it('routes the owner summary entity button through shared navigation', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'ai_field.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'action.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: 'meeting:mtg-1',
            entityContext: null,
            aiFields: { items: [], total: 0 },
            actions: { items: [], total: 0 },
            queueArtifacts: { items: [], total: 0 },
            latestAudits: [],
            summary: {
              aiFieldCount: 0,
              actionCount: 0,
              queueArtifactCount: 0,
              actionStatusCounts: { proposed: 0, approved: 0, executed: 0, rejected: 0 },
            },
          },
        });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(
      <MemoryAiFieldPanel
        scrubbed={{ memoryId: 'mem-1', entityId: 'meeting:mtg-1', title: 'Aurora sync note' }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Entity Context' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Entity Context' }));
    expect(openContextTargetMock).toHaveBeenCalledWith({ targetId: 'meeting:mtg-1' });
  });

  it('dispatches action layer refresh after saving an AI field from memory', async () => {
    const refreshSpy = vi.fn();
    window.addEventListener(ACTION_LAYER_REFRESH_EVENT, refreshSpy);
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'ai_field.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'ai_field.upsert') {
        return Promise.resolve({ ok: true, data: { item: { id: 'af-memory-1' } } });
      }
      if (actionKey === 'action.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: 'company:aurora',
            entityContext: null,
            aiFields: { items: [], total: 0 },
            actions: { items: [], total: 0 },
            queueArtifacts: { items: [], total: 0 },
            latestAudits: [],
            summary: { aiFieldCount: 0, actionCount: 0, queueArtifactCount: 0, actionStatusCounts: {} },
          },
        });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(<MemoryAiFieldPanel scrubbed={{ memoryId: 'mem-1', entityId: 'company:aurora', title: 'Aurora sync note' }} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create AI Field' }));

    await waitFor(() => {
      expect(refreshSpy).toHaveBeenCalled();
    });
    expect((refreshSpy.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ reason: 'memory-ai-field-created' });
    window.removeEventListener(ACTION_LAYER_REFRESH_EVENT, refreshSpy);
  });
});

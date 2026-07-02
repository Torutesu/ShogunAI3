import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetingAiFieldPanel } from './MeetingAiFieldPanel';
import { ACTION_LAYER_REFRESH_EVENT } from '@/shared/context/action-layer-events';

const runRuntimeActionMock = vi.fn();
const focusEntityMock = vi.fn();
const focusActionTraceMock = vi.fn();
const openEvidenceReferenceMock = vi.fn();
const openContextTargetMock = vi.fn();
const nativeDetailDescriptorForEntityIdMock = vi.fn((entityId: string) => {
  const normalized = String(entityId || '').trim();
  if (normalized.startsWith('meeting:')) {
    return { kind: 'meeting', id: normalized.slice('meeting:'.length), label: 'Open Meeting Detail' };
  }
  return null;
});
const openNativeDetailForEntityIdMock = vi.fn();

vi.mock('@/shared/ipc/runtime-actions', () => ({
  runRuntimeAction: (...args: unknown[]) => runRuntimeActionMock(...args),
}));

vi.mock('@/shared/context/entity-focus', () => ({
  focusEntity: (...args: unknown[]) => focusEntityMock(...args),
}));

vi.mock('@/shared/context/action-trace-focus', () => ({
  focusActionTrace: (...args: unknown[]) => focusActionTraceMock(...args),
}));

vi.mock('@/shared/context/context-target-navigation', () => ({
  openEvidenceReference: (...args: unknown[]) => openEvidenceReferenceMock(...args),
  openContextTarget: (...args: unknown[]) => openContextTargetMock(...args),
  nativeDetailDescriptorForEntityId: (entityId: string) => nativeDetailDescriptorForEntityIdMock(entityId),
  openNativeDetailForEntityId: (entityId: string) => openNativeDetailForEntityIdMock(entityId),
}));

describe('MeetingAiFieldPanel', () => {
  beforeEach(() => {
    runRuntimeActionMock.mockReset();
    focusEntityMock.mockReset();
    focusActionTraceMock.mockReset();
    openEvidenceReferenceMock.mockReset();
    openContextTargetMock.mockReset();
    nativeDetailDescriptorForEntityIdMock.mockClear();
    openNativeDetailForEntityIdMock.mockReset();
    (window as any).SHOGUN_RUNTIME = { setActiveScreen: vi.fn(), pushToast: vi.fn() };
  });

  it('shows owner summary context for the meeting entity', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'ai_field.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: 'meeting:mtg-1',
            entityContext: null,
            aiFields: { items: [], total: 0 },
            actions: {
              items: [
                {
                  id: 'act-1',
                  ownerEntityId: 'meeting:mtg-1',
                  actionType: 'follow_up_email_draft',
                  title: 'Draft meeting follow-up',
                  detail: '',
                  status: 'approved',
                  riskLevel: 'medium',
                  sourceAiFieldId: 'af-1',
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
                  id: 'sch-1',
                  createdAt: 0,
                  payload: {
                    title: 'Send meeting follow-up draft',
                    owner_entity_id: 'meeting:mtg-1',
                    source_action_id: 'act-queue-1',
                  },
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
                  detail: 'Approved after meeting review',
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
      <MeetingAiFieldPanel
        meetingDetail={{ meeting: { id: 'mtg-1', title: 'Aurora sync' }, segments: [] }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('OWNER SUMMARY')).toBeInTheDocument();
    });
    expect(screen.getByText('Latest action: Draft meeting follow-up [approved]')).toBeInTheDocument();
    expect(screen.getByText('Latest queue: Send meeting follow-up draft')).toBeInTheDocument();
    expect(screen.getByText('Latest audit: Approved after meeting review')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open queued action' }));
    expect(focusActionTraceMock).toHaveBeenCalledWith({
      actionId: 'act-queue-1',
      aiFieldId: 'af-1',
      openAudit: false,
    });
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');

    fireEvent.click(screen.getAllByRole('button', { name: 'Open Meeting Detail' })[0] as HTMLElement);
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('meeting:mtg-1');
  });

  it('shows native detail CTA for the meeting evidence id', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'ai_field.list') {
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
              actionStatusCounts: {},
            },
          },
        });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(
      <MeetingAiFieldPanel
        meetingDetail={{ meeting: { id: 'mtg-1', title: 'Aurora sync' }, segments: [] }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open Meeting Detail' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open Meeting Detail' }));
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('meeting:mtg-1');
  });

  it('routes the owner summary entity button through shared navigation', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'ai_field.list') {
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
              actionStatusCounts: {},
            },
          },
        });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(
      <MeetingAiFieldPanel
        meetingDetail={{ meeting: { id: 'mtg-1', title: 'Aurora sync' }, segments: [] }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Entity Context' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Entity Context' }));
    expect(openContextTargetMock).toHaveBeenCalledWith({ targetId: 'meeting:mtg-1' });
  });

  it('dispatches action layer refresh after saving an AI field from the meeting detail', async () => {
    const refreshSpy = vi.fn();
    window.addEventListener(ACTION_LAYER_REFRESH_EVENT, refreshSpy);
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'ai_field.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'ai_field.upsert') {
        return Promise.resolve({ ok: true, data: { item: { id: 'af-new-1' } } });
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
            summary: { aiFieldCount: 0, actionCount: 0, queueArtifactCount: 0, actionStatusCounts: {} },
          },
        });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(<MeetingAiFieldPanel meetingDetail={{ meeting: { id: 'mtg-1', title: 'Aurora sync' }, segments: [] }} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create AI Field' }));

    await waitFor(() => {
      expect(refreshSpy).toHaveBeenCalled();
    });
    expect((refreshSpy.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ reason: 'meeting-ai-field-created' });
    window.removeEventListener(ACTION_LAYER_REFRESH_EVENT, refreshSpy);
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiFieldsScreen } from './AiFieldsScreen';

const runRuntimeActionMock = vi.fn();
const openContextTargetMock = vi.fn();
const openNativeDetailForEntityIdMock = vi.fn();
const focusActionTraceMock = vi.fn();
let focusedEntityIdValue = 'company:aurora';

vi.mock('@/shared/ipc/runtime-actions', () => ({
  runRuntimeAction: (...args: unknown[]) => runRuntimeActionMock(...args),
}));

vi.mock('@/shared/context/focus-store', async () => {
  const actual = await vi.importActual<typeof import('@/shared/context/focus-store')>('@/shared/context/focus-store');
  return {
    ...actual,
    useEventedValue: (reader: () => unknown) => reader(),
  };
});

vi.mock('@/shared/context/ai-field-focus', () => ({
  AI_FIELD_FOCUS_EVENT: 'ai-field-focus',
  clearAiFieldFocus: vi.fn(),
  readAiFieldFocus: () => null,
}));

vi.mock('@/shared/context/ai-field-draft', () => ({
  AI_FIELD_DRAFT_EVENT: 'ai-field-draft',
  clearAiFieldDraft: vi.fn(),
  readAiFieldDraft: () => null,
}));

vi.mock('@/shared/context/action-trace-focus', () => ({
  focusActionTrace: (...args: unknown[]) => focusActionTraceMock(...args),
}));

vi.mock('@/shared/context/context-target-navigation', async () => {
  const actual = await vi.importActual<typeof import('@/shared/context/context-target-navigation')>('@/shared/context/context-target-navigation');
  return {
    ...actual,
    openContextTarget: (...args: unknown[]) => openContextTargetMock(...args),
    openNativeDetailForEntityId: (entityId: string) => openNativeDetailForEntityIdMock(entityId),
  };
});

vi.mock('@/shared/context/entity-focus', () => ({
  ENTITY_FOCUS_EVENT: 'entity-focus',
  clearEntityFocus: vi.fn(),
  readEntityFocus: () => focusedEntityIdValue,
}));

vi.mock('@/features/entity-context/entity-signal-focus', () => ({
  ENTITY_SIGNAL_FOCUS_EVENT: 'entity-signal-focus',
  clearEntitySignalFocus: vi.fn(),
  readEntitySignalFocus: () => null,
}));

describe('AiFieldsScreen', () => {
  beforeEach(() => {
    runRuntimeActionMock.mockReset();
    openContextTargetMock.mockReset();
    openNativeDetailForEntityIdMock.mockReset();
    focusActionTraceMock.mockReset();
    focusedEntityIdValue = 'company:aurora';
    (window as any).SHOGUN_RUNTIME = { setActiveScreen: vi.fn() };
  });

  it('shows owner summary context for the focused entity', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
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
                  sourceAiFieldId: 'af-owner-1',
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
                  payload: {
                    title: 'Update CRM blocker field',
                    owner_entity_id: 'workspace:apollo',
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
                  detail: 'Approved by operator',
                  payload: null,
                  evidenceEventIds: [],
                  createdAt: 0,
                },
              },
            ],
            summary: {
              aiFieldCount: 2,
              actionCount: 1,
              queueArtifactCount: 1,
              actionStatusCounts: { proposed: 0, approved: 1, executed: 0, rejected: 0 },
            },
          },
        });
      }
      if (actionKey === 'ai_field.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'action.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(<AiFieldsScreen />);

    await waitFor(() => {
      expect(screen.getByText('OWNER SUMMARY')).toBeInTheDocument();
    });
    expect(screen.getByText('Latest action: Queue company update [approved]')).toBeInTheDocument();
    expect(screen.getByText('Latest queue: Update CRM blocker field')).toBeInTheDocument();
    expect(screen.getByText('Latest audit: Approved by operator')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open queued action' }));
    expect(focusActionTraceMock).toHaveBeenCalledWith({
      actionId: 'act-queue-1',
      aiFieldId: 'af-owner-1',
      openAudit: false,
    });
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');

    fireEvent.click(screen.getByRole('button', { name: 'Open Workspace Detail' }));
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('workspace:apollo');
  });

  it('routes the focused entity context button through shared navigation', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
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
            summary: {
              aiFieldCount: 0,
              actionCount: 0,
              queueArtifactCount: 0,
              actionStatusCounts: {},
            },
          },
        });
      }
      if (actionKey === 'ai_field.list' || actionKey === 'action.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(<AiFieldsScreen />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open Entity Context' }));
    expect(openContextTargetMock).toHaveBeenCalledWith({ targetId: 'company:aurora' });
  });

  it('shows native detail CTA for focused workspace entities', async () => {
    focusedEntityIdValue = 'workspace:apollo';
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: 'workspace:apollo',
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
      if (actionKey === 'ai_field.list' || actionKey === 'action.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(<AiFieldsScreen />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open Workspace Detail' }));
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('workspace:apollo');
  });
});

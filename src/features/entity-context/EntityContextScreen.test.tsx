import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTION_LAYER_REFRESH_EVENT } from '@/shared/context/action-layer-events';

import { EntityContextScreen } from './EntityContextScreen';

const runRuntimeActionMock = vi.fn();
const focusAiFieldMock = vi.fn();
const focusActionTraceMock = vi.fn();
const seedActionDraftMock = vi.fn();
const seedAiFieldDraftMock = vi.fn();
const focusEntityMock = vi.fn();
const openChatWithSeedMock = vi.fn();
const buildEntityChatSeedMock = vi.fn((input) => ({ text: `entity:${input.entityId}` }));
const openContextTargetMock = vi.fn();
const openNativeDetailForEntityIdMock = vi.fn();

vi.mock('@/shared/ipc/runtime-actions', () => ({
  runRuntimeAction: (...args: unknown[]) => runRuntimeActionMock(...args),
}));

vi.mock('@/shared/context/ai-field-focus', () => ({
  focusAiField: (...args: unknown[]) => focusAiFieldMock(...args),
}));

vi.mock('@/shared/context/action-trace-focus', () => ({
  focusActionTrace: (...args: unknown[]) => focusActionTraceMock(...args),
}));

vi.mock('@/shared/context/action-draft', () => ({
  seedActionDraft: (...args: unknown[]) => seedActionDraftMock(...args),
}));

vi.mock('@/shared/context/ai-field-draft', () => ({
  seedAiFieldDraft: (...args: unknown[]) => seedAiFieldDraftMock(...args),
}));

vi.mock('@/shared/context/entity-focus', () => ({
  ENTITY_FOCUS_EVENT: 'entity-focus',
  focusEntity: (...args: unknown[]) => focusEntityMock(...args),
  readEntityFocus: () => null,
}));

vi.mock('@/features/entity-context/entity-signal-focus', () => ({
  ENTITY_SIGNAL_FOCUS_EVENT: 'entity-signal-focus',
  clearEntitySignalFocus: vi.fn(),
  focusEntitySignal: vi.fn(),
  readEntitySignalFocus: () => null,
}));

vi.mock('@/shared/context/chat-composer-seed', () => ({
  buildEntityChatSeed: (...args: any[]) => buildEntityChatSeedMock(args[0]),
  openChatWithSeed: (...args: any[]) => openChatWithSeedMock(args[0]),
}));

vi.mock('@/shared/context/context-target-navigation', () => ({
  nativeDetailDescriptorForEntityId: (entityId: string) => {
    const normalized = String(entityId || '').trim();
    if (normalized.startsWith('meeting:')) {
      return { kind: 'meeting', id: normalized.slice('meeting:'.length), label: 'Open Meeting Detail' };
    }
    if (normalized.startsWith('workspace:')) {
      return { kind: 'workspace', id: normalized.slice('workspace:'.length), label: 'Open Workspace Detail' };
    }
    return null;
  },
  openNativeDetailForEntityId: (...args: unknown[]) => openNativeDetailForEntityIdMock(...args),
  openContextTarget: (...args: unknown[]) => openContextTargetMock(...args),
}));

describe('EntityContextScreen', () => {
  beforeEach(() => {
    runRuntimeActionMock.mockReset();
    focusAiFieldMock.mockReset();
    focusActionTraceMock.mockReset();
    seedActionDraftMock.mockReset();
    seedAiFieldDraftMock.mockReset();
    focusEntityMock.mockReset();
    openChatWithSeedMock.mockReset();
    buildEntityChatSeedMock.mockClear();
    openContextTargetMock.mockReset();
    openNativeDetailForEntityIdMock.mockReset();
    (window as any).SHOGUN_RUNTIME = { setActiveScreen: vi.fn(), pushToast: vi.fn() };
  });

  it('loads owner summary data into the canonical entity context view', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string, payload?: any) => {
      if (actionKey === 'ai_field.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'af-1',
                ownerEntityId: 'company:aurora',
                fieldName: 'blocker',
                instruction: 'Track the strongest blocker.',
                currentValue: 'Security review pending',
                confidence: 0.83,
                evidenceEventIds: ['mem-1'],
                createdAt: 1710000000000,
                lastUpdatedAt: 1710000001000,
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
                ownerEntityId: 'company:aurora',
                actionType: 'update_crm',
                title: 'Queue company update',
                detail: 'Push the latest blocker into the sales record.',
                status: 'approved',
                riskLevel: 'medium',
                sourceAiFieldId: 'af-1',
                evidenceEventIds: ['mem-1'],
                executionResult: null,
                executedAt: null,
                createdAt: 1710000000000,
                updatedAt: 1710000001000,
              },
            ],
          },
        });
      }
      if (actionKey === 'queue.tasks.list' || actionKey === 'queue.crm_updates.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'context.tasks.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'task-act-1',
                ownerEntityId: 'company:aurora',
                actionType: 'create_task',
                title: 'Create security follow-up task',
                detail: 'Track the security review follow-up as a pending shared task.',
                status: 'approved',
                riskLevel: 'medium',
                sourceAiFieldId: 'af-1',
                evidenceEventIds: ['mem-1'],
                executionResult: null,
                executedAt: null,
                createdAt: 1710000000000,
                updatedAt: 1710000001000,
              },
            ],
            total: 1,
          },
        });
      }
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: String(payload?.ownerEntityId || 'company:aurora'),
            entityContext: {
              entityId: 'company:aurora',
              entityLabel: 'company:aurora',
              lang: 'en',
              rollup: {
                targetKind: 'entity_rollup',
                targetId: 'company:aurora',
                title: 'Aurora is blocked on security review',
                keyPoints: ['Security review is still the main blocker.'],
                sourceType: 'entity_rollup',
                priority: 'medium',
                model: 'mock',
                schemaVersion: 1,
                generatedAt: 1710000002000,
              },
              recentSummaries: [],
              aiFields: [
                {
                  id: 'af-1',
                  ownerEntityId: 'company:aurora',
                  fieldName: 'blocker',
                  instruction: 'Track the strongest blocker.',
                  currentValue: 'Security review pending',
                  confidence: 0.83,
                  evidenceEventIds: ['mem-1'],
                  createdAt: 1710000000000,
                  lastUpdatedAt: 1710000001000,
                },
              ],
              actions: [
                {
                  id: 'act-1',
                  ownerEntityId: 'company:aurora',
                  actionType: 'update_crm',
                  title: 'Queue company update',
                  detail: 'Push the latest blocker into the sales record.',
                  status: 'approved',
                  riskLevel: 'medium',
                  sourceAiFieldId: 'af-1',
                  evidenceEventIds: ['mem-1'],
                  executionResult: null,
                  executedAt: null,
                  createdAt: 1710000000000,
                  updatedAt: 1710000001000,
                },
              ],
            },
            aiFields: { items: [], total: 0 },
            actions: {
              items: [
                {
                  id: 'act-1',
                  ownerEntityId: 'company:aurora',
                  actionType: 'update_crm',
                  title: 'Queue company update',
                  detail: 'Push the latest blocker into the sales record.',
                  status: 'approved',
                  riskLevel: 'medium',
                  sourceAiFieldId: 'af-1',
                  evidenceEventIds: ['mem-1'],
                  executionResult: null,
                  executedAt: null,
                  createdAt: 1710000000000,
                  updatedAt: 1710000001000,
                },
              ],
              total: 1,
            },
            queueArtifacts: {
              items: [
                {
                  id: 'crm-q-1',
                  createdAt: 1710000003000,
                  payload: {
                    title: 'Update CRM blocker field',
                    owner_entity_id: 'workspace:apollo',
                    source_action_id: 'act-queue-1',
                  },
                  provenance: {
                    latestAudit: {
                      eventType: 'executed',
                      detail: 'Queued after approval',
                    },
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
                  createdAt: 1710000002500,
                },
              },
            ],
            summary: {
              aiFieldCount: 1,
              actionCount: 1,
              queueArtifactCount: 1,
              actionStatusCounts: {
                proposed: 0,
                approved: 1,
                executed: 0,
                rejected: 0,
              },
            },
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<EntityContextScreen />);

    fireEvent.change(screen.getByPlaceholderText('company:acme / deal:seed-round / workspace:apollo'), {
      target: { value: 'company:aurora' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));

    await waitFor(() => {
      expect(screen.getByText('Aurora is blocked on security review')).toBeInTheDocument();
    });

    expect(screen.getByText('Update CRM blocker field')).toBeInTheDocument();
    expect(screen.getByText('Queued after approval')).toBeInTheDocument();
    expect(screen.getByText('Approved by operator')).toBeInTheDocument();
    expect(screen.getAllByText('Create security follow-up task').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Open queued action' }));
    expect(focusActionTraceMock).toHaveBeenCalledWith({ actionId: 'act-queue-1', aiFieldId: 'af-1', openAudit: false });
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');

    fireEvent.click(screen.getByRole('button', { name: 'Open task' }));
    expect(focusActionTraceMock).toHaveBeenCalledWith({ actionId: 'task-act-1', aiFieldId: 'af-1', openAudit: false });
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');

    fireEvent.click(screen.getByRole('button', { name: 'Open Workspace Detail' }));
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('workspace:apollo');

    fireEvent.click(screen.getByRole('button', { name: 'Open audit' }));
    expect(focusActionTraceMock).toHaveBeenCalledWith({ actionId: 'act-1', aiFieldId: 'af-1', openAudit: true });
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');
  });

  it('opens meeting detail for meeting entities', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string, payload?: any) => {
      if (
        actionKey === 'ai_field.list'
        || actionKey === 'action.list'
        || actionKey === 'queue.tasks.list'
        || actionKey === 'queue.crm_updates.list'
        || actionKey === 'context.tasks.list'
      ) {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: String(payload?.ownerEntityId || 'meeting:mtg-1'),
            entityContext: {
              entityId: 'meeting:mtg-1',
              entityLabel: 'meeting:mtg-1',
              lang: 'en',
              rollup: {
                targetKind: 'entity_rollup',
                targetId: 'meeting:mtg-1',
                title: 'Aurora sync meeting',
                keyPoints: [],
                sourceType: 'entity_rollup',
                priority: 'medium',
                model: 'mock',
                schemaVersion: 1,
                generatedAt: 1710000002000,
              },
              recentSummaries: [],
              aiFields: [],
              actions: [],
            },
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
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<EntityContextScreen />);
    fireEvent.change(screen.getByPlaceholderText('company:acme / deal:seed-round / workspace:apollo'), {
      target: { value: 'meeting:mtg-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Open Meeting Detail' }));
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('meeting:mtg-1');
  });

  it('opens workspace detail for workspace entities', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string, payload?: any) => {
      if (
        actionKey === 'ai_field.list'
        || actionKey === 'action.list'
        || actionKey === 'queue.tasks.list'
        || actionKey === 'queue.crm_updates.list'
        || actionKey === 'context.tasks.list'
      ) {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: String(payload?.ownerEntityId || 'workspace:apollo'),
            entityContext: {
              entityId: 'workspace:apollo',
              entityLabel: 'workspace:apollo',
              lang: 'en',
              rollup: {
                targetKind: 'entity_rollup',
                targetId: 'workspace:apollo',
                title: 'Apollo workspace',
                keyPoints: [],
                sourceType: 'entity_rollup',
                priority: 'medium',
                model: 'mock',
                schemaVersion: 1,
                generatedAt: 1710000002000,
              },
              recentSummaries: [],
              aiFields: [],
              actions: [],
            },
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
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<EntityContextScreen />);
    fireEvent.change(screen.getByPlaceholderText('company:acme / deal:seed-round / workspace:apollo'), {
      target: { value: 'workspace:apollo' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Open Workspace Detail' }));
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('workspace:apollo');
  });

  it('hides redundant queue native detail buttons when the queued owner matches the current entity', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string, payload?: any) => {
      if (
        actionKey === 'ai_field.list'
        || actionKey === 'action.list'
        || actionKey === 'queue.tasks.list'
        || actionKey === 'queue.crm_updates.list'
        || actionKey === 'context.tasks.list'
      ) {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: String(payload?.ownerEntityId || 'workspace:apollo'),
            entityContext: {
              entityId: 'workspace:apollo',
              entityLabel: 'workspace:apollo',
              lang: 'en',
              rollup: {
                targetKind: 'entity_rollup',
                targetId: 'workspace:apollo',
                title: 'Apollo workspace',
                keyPoints: [],
                sourceType: 'entity_rollup',
                priority: 'medium',
                model: 'mock',
                schemaVersion: 1,
                generatedAt: 1710000002000,
              },
              recentSummaries: [],
              aiFields: [],
              actions: [],
            },
            aiFields: { items: [], total: 0 },
            actions: { items: [], total: 0 },
            queueArtifacts: {
              items: [
                {
                  id: 'task-q-1',
                  createdAt: 1710000003000,
                  payload: {
                    title: 'Apollo task queue item',
                    owner_entity_id: 'workspace:apollo',
                    source_action_id: 'act-queue-1',
                  },
                  provenance: {},
                },
              ],
              total: 1,
            },
            latestAudits: [],
            summary: {
              aiFieldCount: 0,
              actionCount: 0,
              queueArtifactCount: 1,
              actionStatusCounts: {},
            },
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<EntityContextScreen />);
    fireEvent.change(screen.getByPlaceholderText('company:acme / deal:seed-round / workspace:apollo'), {
      target: { value: 'workspace:apollo' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));

    await waitFor(() => {
      expect(screen.getByText('Apollo task queue item')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: 'Open queued action' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Open Workspace Detail' })).toHaveLength(1);
  });

  it('includes queue artifact owners in entity suggestions', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'ai_field.list' || actionKey === 'action.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'queue.tasks.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'task-q-1',
                payload: {
                  owner_entity_id: 'workspace:apollo',
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
                payload: {
                  owner_entity_id: 'company:aurora',
                },
              },
            ],
          },
        });
      }
      if (actionKey === 'context.tasks.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: 'workspace:apollo',
            entityContext: {
              entityId: 'workspace:apollo',
              entityLabel: 'workspace:apollo',
              lang: 'en',
              rollup: {
                targetKind: 'entity_rollup',
                targetId: 'workspace:apollo',
                title: 'Apollo workspace',
                keyPoints: [],
                sourceType: 'entity_rollup',
                priority: 'medium',
                model: 'mock',
                schemaVersion: 1,
                generatedAt: 1710000002000,
              },
              recentSummaries: [],
              aiFields: [],
              actions: [],
            },
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
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<EntityContextScreen />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'workspace:apollo' })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'company:aurora' })).toBeInTheDocument();
  });

  it('reloads the active entity context when the shared action layer refreshes', async () => {
    let summaryCount = 0;
    runRuntimeActionMock.mockImplementation((actionKey: string, payload?: any) => {
      if (actionKey === 'ai_field.list' || actionKey === 'action.list') {
        return Promise.resolve({
          ok: true,
          data: { items: [{ ownerEntityId: 'company:aurora' }] },
        });
      }
      if (actionKey === 'queue.tasks.list' || actionKey === 'queue.crm_updates.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'context.tasks.list') {
        return Promise.resolve({ ok: true, data: { items: [], total: 0 } });
      }
      if (actionKey === 'context.owner_summary.get') {
        summaryCount += 1;
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: String(payload?.ownerEntityId || 'company:aurora'),
            entityContext: {
              entityId: 'company:aurora',
              entityLabel: 'company:aurora',
              lang: 'en',
              rollup: {
                targetKind: 'entity_rollup',
                targetId: 'company:aurora',
                title: summaryCount === 1
                  ? 'Aurora is blocked on security review'
                  : 'Aurora blocker moved to procurement review',
                keyPoints: [
                  summaryCount === 1
                    ? 'Security review is still the main blocker.'
                    : 'Procurement review is now the top blocker.',
                ],
                sourceType: 'entity_rollup',
                priority: 'medium',
                model: 'mock',
                schemaVersion: 1,
                generatedAt: 1710000002000,
              },
              recentSummaries: [],
              aiFields: [],
              actions: [],
            },
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
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<EntityContextScreen />);

    fireEvent.change(screen.getByPlaceholderText('company:acme / deal:seed-round / workspace:apollo'), {
      target: { value: 'company:aurora' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));

    await waitFor(() => {
      expect(screen.getByText('Aurora is blocked on security review')).toBeInTheDocument();
    });

    window.dispatchEvent(new CustomEvent(ACTION_LAYER_REFRESH_EVENT, { detail: { reason: 'test-refresh' } }));

    await waitFor(() => {
      expect(screen.getByText('Aurora blocker moved to procurement review')).toBeInTheDocument();
    });
  });
});

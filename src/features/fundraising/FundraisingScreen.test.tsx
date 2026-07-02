import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FundraisingScreen } from './FundraisingScreen';

const runRuntimeActionMock = vi.fn();
const seedAiFieldDraftMock = vi.fn();
const seedActionDraftMock = vi.fn();
const focusEntityMock = vi.fn();
const focusActionTraceMock = vi.fn();
const openNativeDetailForEntityIdMock = vi.fn();

vi.mock('@/shared/ipc/runtime-actions', () => ({
  runRuntimeAction: (...args: unknown[]) => runRuntimeActionMock(...args),
}));

vi.mock('@/shared/context/ai-field-draft', () => ({
  seedAiFieldDraft: (...args: unknown[]) => seedAiFieldDraftMock(...args),
}));

vi.mock('@/shared/context/action-draft', () => ({
  seedActionDraft: (...args: unknown[]) => seedActionDraftMock(...args),
}));

vi.mock('@/shared/context/entity-focus', () => ({
  focusEntity: (...args: unknown[]) => focusEntityMock(...args),
}));

vi.mock('@/shared/context/action-trace-focus', () => ({
  focusActionTrace: (...args: unknown[]) => focusActionTraceMock(...args),
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
  openContextTarget: vi.fn(),
}));

describe('FundraisingScreen', () => {
  beforeEach(() => {
    runRuntimeActionMock.mockReset();
    seedAiFieldDraftMock.mockReset();
    seedActionDraftMock.mockReset();
    focusEntityMock.mockReset();
    focusActionTraceMock.mockReset();
    openNativeDetailForEntityIdMock.mockReset();
    (window as any).SHOGUN_RUNTIME = { setActiveScreen: vi.fn() };
  });

  it('creates investor-focused AI field and action drafts from the fundraising surface', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'ai_field.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'af-investor-1',
                ownerEntityId: 'investor:sequoia',
                fieldName: 'interest_level',
                instruction: 'Track the current interest level of this investor from recent interactions.',
                currentValue: 'High after partner meeting',
                confidence: 0.88,
                evidenceEventIds: ['meeting:fundraise-sync'],
                createdAt: 1710000000000,
                lastUpdatedAt: 1710000001000,
              },
            ],
          },
        });
      }
      if (actionKey === 'action.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<FundraisingScreen />);

    await waitFor(() => {
      expect(screen.getByText('sequoia · investor')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Track Concern' }));
    expect(seedAiFieldDraftMock).toHaveBeenCalledWith({
      ownerEntityId: 'investor:sequoia',
      fieldName: 'investor_concern',
      instruction: 'Track the biggest concern or objection this investor currently has.',
      currentValue: '',
      confidence: 0.72,
      evidenceEventIds: [],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Draft investor follow-up' }));
    expect(seedActionDraftMock).toHaveBeenCalledWith({
      ownerEntityId: 'investor:sequoia',
      actionType: 'follow_up_email_draft',
      title: 'Draft investor follow-up · sequoia · investor',
      detail: 'Draft an investor follow-up grounded in the current fundraising context.',
      riskLevel: 'medium',
      sourceAiFieldId: 'af-investor-1',
      evidenceEventIds: ['meeting:fundraise-sync'],
    });
  });

  it('quick-creates an investor entity through shared AI Field persistence', async () => {
    const fieldItems: Array<Record<string, unknown>> = [];
    runRuntimeActionMock.mockImplementation((actionKey: string, payload?: any) => {
      if (actionKey === 'ai_field.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: fieldItems,
          },
        });
      }
      if (actionKey === 'action.list' || actionKey === 'context.tasks.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'ai_field.upsert') {
        fieldItems.unshift({
          id: 'af-created-investor-1',
          ownerEntityId: payload.ownerEntityId,
          fieldName: payload.fieldName,
          instruction: payload.instruction,
          currentValue: payload.currentValue,
          confidence: payload.confidence,
          evidenceEventIds: payload.evidenceEventIds,
          createdAt: 1710000010000,
          lastUpdatedAt: 1710000011000,
        });
        return Promise.resolve({
          ok: true,
          data: {
            item: fieldItems[0],
          },
        });
      }
      if (actionKey === 'action.propose') {
        return Promise.resolve({
          ok: true,
          data: {
            item: {
              id: 'act-created-investor-1',
              ...payload,
              status: 'proposed',
              createdAt: 1710000012000,
              updatedAt: 1710000012000,
            },
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<FundraisingScreen />);

    await waitFor(() => {
      expect(screen.getByText('No investor:/deal: entities found yet. Shared AI Fields and Actions with fundraising-oriented owner ids will appear here.')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Quick create' }));
    fireEvent.change(screen.getByLabelText('Entity suffix'), {
      target: { value: 'Benchmark Capital' },
    });
    fireEvent.change(screen.getByLabelText('Starter value'), {
      target: { value: 'Needs a tighter answer on capital efficiency.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create investor' }));

    await waitFor(() => {
      expect(runRuntimeActionMock).toHaveBeenCalledWith(
        'ai_field.upsert',
        {
          ownerEntityId: 'investor:benchmark-capital',
          fieldName: 'investor_concern',
          instruction: 'Track the biggest concern or objection this investor currently has.',
          currentValue: 'Needs a tighter answer on capital efficiency.',
          confidence: 0.72,
          evidenceEventIds: [],
        },
        { silentError: true },
      );
    });
    expect(runRuntimeActionMock).toHaveBeenCalledWith(
      'action.propose',
      {
        ownerEntityId: 'investor:benchmark-capital',
        actionType: 'follow_up_email_draft',
        title: 'Draft investor follow-up · benchmark-capital · investor',
        detail: 'Draft an investor follow-up grounded in the current fundraising context.',
        riskLevel: 'medium',
        sourceAiFieldId: 'af-created-investor-1',
        evidenceEventIds: [],
      },
      { silentError: true },
    );

    await waitFor(() => {
      expect(screen.getByText('benchmark-capital · investor')).toBeInTheDocument();
    });
    expect(focusEntityMock).toHaveBeenCalledWith('investor:benchmark-capital');
  });

  it('loads shared owner summary evidence for fundraising entities', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'ai_field.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'af-investor-1',
                ownerEntityId: 'investor:sequoia',
                fieldName: 'interest_level',
                instruction: 'Track the current interest level of this investor from recent interactions.',
                currentValue: 'High after partner meeting',
                confidence: 0.88,
                evidenceEventIds: ['meeting:fundraise-sync'],
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
                id: 'act-investor-1',
                ownerEntityId: 'investor:sequoia',
                actionType: 'follow_up_email_draft',
                title: 'Draft investor follow-up',
                detail: 'Summarize the partner meeting and answer diligence questions.',
                status: 'approved',
                riskLevel: 'medium',
                sourceAiFieldId: 'af-investor-1',
                evidenceEventIds: ['meeting:fundraise-sync'],
                executionResult: null,
                executedAt: null,
                createdAt: 1710000000000,
                updatedAt: 1710000001000,
              },
            ],
          },
        });
      }
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: 'investor:sequoia',
            entityContext: {
              entityId: 'investor:sequoia',
              entityLabel: 'investor:sequoia',
              lang: 'en',
              rollup: {
                targetKind: 'entity_rollup',
                targetId: 'investor:sequoia',
                title: 'Sequoia is highly engaged after partner review',
                keyPoints: ['Interest is high, but diligence answers are still needed.'],
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
            actions: {
              items: [
                {
                  id: 'act-investor-1',
                  ownerEntityId: 'investor:sequoia',
                  actionType: 'follow_up_email_draft',
                  title: 'Draft investor follow-up',
                  detail: 'Summarize the partner meeting and answer diligence questions.',
                  status: 'approved',
                  riskLevel: 'medium',
                  sourceAiFieldId: 'af-investor-1',
                  evidenceEventIds: ['meeting:fundraise-sync'],
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
                  id: 'sch-investor-1',
                  createdAt: 1710000003000,
                  payload: {
                    title: 'Send Sequoia follow-up draft',
                    owner_entity_id: 'workspace:apollo',
                    source_action_id: 'act-queue-1',
                  },
                  provenance: {
                    latestAudit: {
                      eventType: 'executed',
                      detail: 'Queued after partner approval',
                    },
                  },
                },
              ],
              total: 1,
            },
            latestAudits: [
              {
                actionId: 'act-investor-1',
                latestAudit: {
                  id: 'audit-investor-1',
                  actor: 'user',
                  objectType: 'action',
                  objectId: 'act-investor-1',
                  eventType: 'status_changed',
                  detail: 'Approved after partner sync',
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

    render(<FundraisingScreen />);

    await waitFor(() => {
      expect(screen.getByText('sequoia · investor')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Load summary' }));

    await waitFor(() => {
      expect(screen.getByText('Sequoia is highly engaged after partner review')).toBeInTheDocument();
    });

    expect(screen.getByText('Approved after partner sync')).toBeInTheDocument();
    expect(screen.getByText('Send Sequoia follow-up draft')).toBeInTheDocument();
    expect(screen.getByText('Queued after partner approval')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open queued action' }));
    expect(focusEntityMock).toHaveBeenCalledWith('investor:sequoia');
    expect(focusActionTraceMock).toHaveBeenCalledWith({
      actionId: 'act-queue-1',
      aiFieldId: 'af-investor-1',
      openAudit: false,
    });
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');

    fireEvent.click(screen.getByRole('button', { name: 'Open Workspace Detail' }));
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('workspace:apollo');
  });

  it('shows the shared fundraising task inbox and opens pending task actions', async () => {
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
                id: 'act-fundraise-task-1',
                ownerEntityId: 'investor:sequoia',
                actionType: 'create_task',
                title: 'Create diligence follow-up task',
                detail: 'Track the remaining diligence answers as a fundraising task.',
                status: 'approved',
                riskLevel: 'medium',
                sourceAiFieldId: 'af-investor-1',
                evidenceEventIds: ['meeting:fundraise-sync'],
                executionResult: null,
                executedAt: null,
                createdAt: 1710000000000,
                updatedAt: 1710000001000,
              },
            ],
          },
        });
      }
      if (actionKey === 'context.tasks.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'act-fundraise-task-1',
                ownerEntityId: 'investor:sequoia',
                actionType: 'create_task',
                title: 'Create diligence follow-up task',
                detail: 'Track the remaining diligence answers as a fundraising task.',
                status: 'approved',
                riskLevel: 'medium',
                sourceAiFieldId: 'af-investor-1',
                evidenceEventIds: ['meeting:fundraise-sync'],
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
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<FundraisingScreen />);

    await waitFor(() => {
      expect(screen.getByText('Shared fundraising tasks across investor and deal entities')).toBeInTheDocument();
    });

    expect(screen.getAllByText('Create diligence follow-up task').length).toBeGreaterThan(0);
    expect(screen.getAllByText('investor:sequoia').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Open task' }));
    expect(focusEntityMock).toHaveBeenCalledWith('investor:sequoia');
    expect(focusActionTraceMock).toHaveBeenCalledWith({
      actionId: 'act-fundraise-task-1',
      aiFieldId: 'af-investor-1',
      openAudit: false,
    });
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');
  });
});

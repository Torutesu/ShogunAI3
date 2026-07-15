import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FounderSalesScreen } from './FounderSalesScreen';

const runRuntimeActionMock = vi.fn();
const seedAiFieldDraftMock = vi.fn();
const seedActionDraftMock = vi.fn();
const focusEntityMock = vi.fn();
const focusActionTraceMock = vi.fn();
const openNativeDetailForEntityIdMock = vi.fn();
const openContextTargetMock = vi.fn();
const pushToastMock = vi.fn();

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
  openContextTarget: (...args: unknown[]) => openContextTargetMock(...args),
}));

describe('FounderSalesScreen', () => {
  beforeEach(() => {
    runRuntimeActionMock.mockReset();
    seedAiFieldDraftMock.mockReset();
    seedActionDraftMock.mockReset();
    focusEntityMock.mockReset();
    focusActionTraceMock.mockReset();
    openNativeDetailForEntityIdMock.mockReset();
    openContextTargetMock.mockReset();
    pushToastMock.mockReset();
    (window as any).SHOGUN_RUNTIME = { setActiveScreen: vi.fn(), pushToast: pushToastMock };
  });

  it('creates AI field and action drafts from the founder sales surface', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'ai_field.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'af-1',
                ownerEntityId: 'company:aurora',
                fieldName: 'blocker',
                instruction: 'Track the strongest blocker for Aurora.',
                currentValue: 'Security review is still pending',
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
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<FounderSalesScreen />);

    await waitFor(() => {
      expect(screen.getByText('aurora · company')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Track Next Action' }));
    expect(seedAiFieldDraftMock).toHaveBeenCalledWith({
      ownerEntityId: 'company:aurora',
      fieldName: 'next_action',
      instruction: 'Track next action for company:aurora using shared desktop context evidence.',
      currentValue: '',
      confidence: 0.72,
      evidenceEventIds: [],
    });
    expect(focusEntityMock).toHaveBeenCalledWith('company:aurora');
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('ai_fields');

    fireEvent.click(screen.getByRole('button', { name: 'Queue company update' }));
    expect(seedActionDraftMock).toHaveBeenCalledWith({
      ownerEntityId: 'company:aurora',
      actionType: 'update_crm',
      title: 'Queue company update · aurora · company',
      detail: 'Queue a CRM-style company context update backed by the latest evidence.',
      riskLevel: 'medium',
      sourceAiFieldId: 'af-1',
      evidenceEventIds: ['mem-1'],
    });
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');
  });

  it('quick-creates a company entity through shared AI Field persistence', async () => {
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
          id: 'af-created-1',
          ownerEntityId: payload.ownerEntityId,
          fieldName: payload.fieldName,
          instruction: payload.instruction,
          currentValue: payload.currentValue,
          confidence: payload.confidence,
          evidenceEventIds: payload.evidenceEventIds,
          createdAt: 1710000004000,
          lastUpdatedAt: 1710000005000,
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
              id: 'act-created-1',
              ...payload,
              status: 'proposed',
              createdAt: 1710000006000,
              updatedAt: 1710000006000,
            },
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<FounderSalesScreen />);

    await waitFor(() => {
      expect(screen.getByText('No company:/deal: entities found yet. Shared AI Fields and Actions with sales-oriented owner ids will appear here.')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Quick create' }));
    fireEvent.change(screen.getByLabelText('Entity suffix'), {
      target: { value: 'Aurora Labs' },
    });
    fireEvent.change(screen.getByLabelText('Starter value'), {
      target: { value: 'Security review is the first blocker to track.' },
    });
    fireEvent.change(screen.getByLabelText('After create'), {
      target: { value: 'entity_context' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create company' }));

    await waitFor(() => {
      expect(runRuntimeActionMock).toHaveBeenCalledWith(
        'ai_field.upsert',
        {
          ownerEntityId: 'company:aurora-labs',
          fieldName: 'decision_maker',
          instruction: 'Track who the real decision maker is for this company based on meetings, email, and notes.',
          currentValue: 'Security review is the first blocker to track.',
          confidence: 0.72,
          evidenceEventIds: [],
        },
        { silentError: true },
      );
    });
    expect(runRuntimeActionMock).toHaveBeenCalledWith(
      'action.propose',
      {
        ownerEntityId: 'company:aurora-labs',
        actionType: 'update_crm',
        title: 'Queue company update · aurora-labs · company',
        detail: 'Queue a CRM-style company context update backed by the latest evidence.',
        riskLevel: 'medium',
        sourceAiFieldId: 'af-created-1',
        evidenceEventIds: [],
      },
      { silentError: true },
    );

    await waitFor(() => {
      expect(screen.getByText('aurora-labs · company')).toBeInTheDocument();
    });
    expect(focusEntityMock).toHaveBeenCalledWith('company:aurora-labs');
    expect(openContextTargetMock).toHaveBeenCalledWith({
      targetId: 'company:aurora-labs',
    });
    const successToast = pushToastMock.mock.calls.find(
      (call) => call[0] === 'Created company:aurora-labs and starter action',
    );
    expect(successToast?.[2]?.action?.label).toBe('Open action');
    focusActionTraceMock.mockClear();
    successToast?.[2]?.action?.onClick();
    expect(focusActionTraceMock).toHaveBeenCalledWith({
      actionId: 'act-created-1',
      aiFieldId: 'af-created-1',
      openAudit: false,
    });
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');
  });

  it('loads shared owner summary evidence including queue and audit details', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'ai_field.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'af-1',
                ownerEntityId: 'company:aurora',
                fieldName: 'blocker',
                instruction: 'Track the strongest blocker for Aurora.',
                currentValue: 'Security review is still pending',
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
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: 'company:aurora',
            entityContext: {
              entityId: 'company:aurora',
              entityLabel: 'company:aurora',
              lang: 'en',
              rollup: {
                targetKind: 'entity_rollup',
                targetId: 'company:aurora',
                title: 'Aurora is stuck on security review',
                keyPoints: ['Security review is the main blocker.'],
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

    render(<FounderSalesScreen />);

    await waitFor(() => {
      expect(screen.getByText('aurora · company')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Load summary' }));

    await waitFor(() => {
      expect(screen.getByText('Aurora is stuck on security review')).toBeInTheDocument();
    });

    expect(screen.getByText('Approved by operator')).toBeInTheDocument();
    expect(screen.getByText('Update CRM blocker field')).toBeInTheDocument();
    expect(screen.getByText('Queued after approval')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open queued action' }));
    expect(focusEntityMock).toHaveBeenCalledWith('company:aurora');
    expect(focusActionTraceMock).toHaveBeenCalledWith({
      actionId: 'act-queue-1',
      aiFieldId: 'af-1',
      openAudit: false,
    });
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');

    fireEvent.click(screen.getByRole('button', { name: 'Open Workspace Detail' }));
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('workspace:apollo');
  });

  it('shows the shared sales task inbox and opens pending task actions', async () => {
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
                id: 'act-sales-task-1',
                ownerEntityId: 'company:aurora',
                actionType: 'create_task',
                title: 'Create security follow-up task',
                detail: 'Track the security review follow-up as an owned sales task.',
                status: 'approved',
                riskLevel: 'medium',
                sourceAiFieldId: 'af-1',
                evidenceEventIds: ['mem-aurora-1'],
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
                id: 'act-sales-task-1',
                ownerEntityId: 'company:aurora',
                actionType: 'create_task',
                title: 'Create security follow-up task',
                detail: 'Track the security review follow-up as an owned sales task.',
                status: 'approved',
                riskLevel: 'medium',
                sourceAiFieldId: 'af-1',
                evidenceEventIds: ['mem-aurora-1'],
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

    render(<FounderSalesScreen />);

    await waitFor(() => {
      expect(screen.getByText('Shared follow-up tasks across company and deal entities')).toBeInTheDocument();
    });

    expect(screen.getAllByText('Create security follow-up task').length).toBeGreaterThan(0);
    expect(screen.getAllByText('company:aurora').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Open task' }));
    expect(focusEntityMock).toHaveBeenCalledWith('company:aurora');
    expect(focusActionTraceMock).toHaveBeenCalledWith({
      actionId: 'act-sales-task-1',
      aiFieldId: 'af-1',
      openAudit: false,
    });
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');
  });
});

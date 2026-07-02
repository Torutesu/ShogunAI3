import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectMemoryScreen } from './ProjectMemoryScreen';

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

describe('ProjectMemoryScreen', () => {
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

  it('creates task-oriented AI field and action drafts from the project memory surface', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'ai_field.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'af-task-1',
                ownerEntityId: 'task:onboarding-followup',
                fieldName: 'status',
                instruction: 'Track the latest status and state transition for this task.',
                currentValue: 'Waiting on legal review',
                confidence: 0.91,
                evidenceEventIds: ['mem-task-1'],
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

    render(<ProjectMemoryScreen />);

    await waitFor(() => {
      expect(screen.getByText('onboarding-followup · task')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Track Owner' }));
    expect(seedAiFieldDraftMock).toHaveBeenCalledWith({
      ownerEntityId: 'task:onboarding-followup',
      fieldName: 'owner',
      instruction: 'Track who currently owns this task and whether handoff is needed.',
      currentValue: '',
      confidence: 0.72,
      evidenceEventIds: [],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Capture task follow-up' }));
    expect(seedActionDraftMock).toHaveBeenCalledWith({
      ownerEntityId: 'task:onboarding-followup',
      actionType: 'create_task',
      title: 'Capture task follow-up · onboarding-followup · task',
      detail: 'Turn the current task state into a concrete tracked follow-up.',
      riskLevel: 'medium',
      sourceAiFieldId: 'af-task-1',
      evidenceEventIds: ['mem-task-1'],
    });
  });

  it('quick-creates a project entity through shared AI Field persistence', async () => {
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
          id: 'af-created-project-1',
          ownerEntityId: payload.ownerEntityId,
          fieldName: payload.fieldName,
          instruction: payload.instruction,
          currentValue: payload.currentValue,
          confidence: payload.confidence,
          evidenceEventIds: payload.evidenceEventIds,
          createdAt: 1710000020000,
          lastUpdatedAt: 1710000021000,
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
              id: 'act-created-project-1',
              ...payload,
              status: 'proposed',
              createdAt: 1710000022000,
              updatedAt: 1710000022000,
            },
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<ProjectMemoryScreen />);

    await waitFor(() => {
      expect(screen.getByText('No project:/task: entities found yet. Shared AI Fields and Actions with project-oriented owner ids will appear here.')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Quick create' }));
    fireEvent.change(screen.getByLabelText('Entity kind'), {
      target: { value: 'project' },
    });
    fireEvent.change(screen.getByLabelText('Entity suffix'), {
      target: { value: 'Apollo Revamp' },
    });
    fireEvent.change(screen.getByLabelText('Starter value'), {
      target: { value: 'Waiting on final API contract before implementation.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => {
      expect(runRuntimeActionMock).toHaveBeenCalledWith(
        'ai_field.upsert',
        {
          ownerEntityId: 'project:apollo-revamp',
          fieldName: 'blocker',
          instruction: 'Track the most important blocker slowing this project down.',
          currentValue: 'Waiting on final API contract before implementation.',
          confidence: 0.72,
          evidenceEventIds: [],
        },
        { silentError: true },
      );
    });
    expect(runRuntimeActionMock).toHaveBeenCalledWith(
      'action.propose',
      {
        ownerEntityId: 'project:apollo-revamp',
        actionType: 'create_task',
        title: 'Create project task · apollo-revamp · project',
        detail: 'Turn the most urgent project need into a concrete tracked task.',
        riskLevel: 'medium',
        sourceAiFieldId: 'af-created-project-1',
        evidenceEventIds: [],
      },
      { silentError: true },
    );

    await waitFor(() => {
      expect(screen.getByText('apollo-revamp · project')).toBeInTheDocument();
    });
    expect(focusEntityMock).toHaveBeenCalledWith('project:apollo-revamp');
  });

  it('can quick-create a project without proposing a starter action', async () => {
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
          id: 'af-created-project-2',
          ownerEntityId: payload.ownerEntityId,
          fieldName: payload.fieldName,
          instruction: payload.instruction,
          currentValue: payload.currentValue,
          confidence: payload.confidence,
          evidenceEventIds: payload.evidenceEventIds,
          createdAt: 1710000030000,
          lastUpdatedAt: 1710000031000,
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
              id: 'act-created-project-2',
              ...payload,
            },
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<ProjectMemoryScreen />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Quick create' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Quick create' }));
    fireEvent.click(screen.getByLabelText('Also create starter action'));
    fireEvent.change(screen.getByLabelText('After create'), {
      target: { value: 'stay' },
    });
    fireEvent.change(screen.getByLabelText('Entity kind'), {
      target: { value: 'project' },
    });
    fireEvent.change(screen.getByLabelText('Entity suffix'), {
      target: { value: 'Mercury Ops' },
    });
    fireEvent.change(screen.getByLabelText('Starter value'), {
      target: { value: 'Need final resourcing call before kickoff.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => {
      expect(runRuntimeActionMock).toHaveBeenCalledWith(
        'ai_field.upsert',
        {
          ownerEntityId: 'project:mercury-ops',
          fieldName: 'blocker',
          instruction: 'Track the most important blocker slowing this project down.',
          currentValue: 'Need final resourcing call before kickoff.',
          confidence: 0.72,
          evidenceEventIds: [],
        },
        { silentError: true },
      );
    });
    expect(runRuntimeActionMock).not.toHaveBeenCalledWith(
      'action.propose',
      expect.anything(),
      { silentError: true },
    );
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).not.toHaveBeenCalledWith('ai_fields');
    expect(openContextTargetMock).not.toHaveBeenCalled();
    const successToast = pushToastMock.mock.calls.find(
      (call) => call[0] === 'Created project:mercury-ops',
    );
    expect(successToast?.[2]?.action?.label).toBe('Open field');
    successToast?.[2]?.action?.onClick();
    expect(focusEntityMock).toHaveBeenCalledWith('project:mercury-ops');
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('ai_fields');
  });

  it('shows the shared task inbox and opens pending task actions from the project memory surface', async () => {
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
                id: 'act-task-1',
                ownerEntityId: 'task:onboarding-followup',
                actionType: 'create_task',
                title: 'Capture task follow-up',
                detail: 'Turn the legal-review wait into an owned follow-up item.',
                status: 'approved',
                riskLevel: 'medium',
                sourceAiFieldId: 'af-task-1',
                evidenceEventIds: ['mem-task-1'],
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
                id: 'act-task-1',
                ownerEntityId: 'task:onboarding-followup',
                actionType: 'create_task',
                title: 'Capture task follow-up',
                detail: 'Turn the legal-review wait into an owned follow-up item.',
                status: 'approved',
                riskLevel: 'medium',
                sourceAiFieldId: 'af-task-1',
                evidenceEventIds: ['mem-task-1'],
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

    render(<ProjectMemoryScreen />);

    await waitFor(() => {
      expect(screen.getByText('Shared task queue across project and task entities')).toBeInTheDocument();
    });

    expect(screen.getAllByText('Capture task follow-up').length).toBeGreaterThan(0);
    expect(screen.getAllByText('task:onboarding-followup').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Open task' }));
    expect(focusEntityMock).toHaveBeenCalledWith('task:onboarding-followup');
    expect(focusActionTraceMock).toHaveBeenCalledWith({
      actionId: 'act-task-1',
      aiFieldId: 'af-task-1',
      openAudit: false,
    });
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');
  });

  it('loads shared owner summary evidence for project and task entities', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'ai_field.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'af-task-1',
                ownerEntityId: 'task:onboarding-followup',
                fieldName: 'status',
                instruction: 'Track the latest status and state transition for this task.',
                currentValue: 'Waiting on legal review',
                confidence: 0.91,
                evidenceEventIds: ['mem-task-1'],
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
                id: 'act-task-1',
                ownerEntityId: 'task:onboarding-followup',
                actionType: 'create_task',
                title: 'Capture task follow-up',
                detail: 'Turn the legal-review wait into an owned follow-up item.',
                status: 'approved',
                riskLevel: 'medium',
                sourceAiFieldId: 'af-task-1',
                evidenceEventIds: ['mem-task-1'],
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
            ownerEntityId: 'task:onboarding-followup',
            entityContext: {
              entityId: 'task:onboarding-followup',
              entityLabel: 'task:onboarding-followup',
              lang: 'en',
              rollup: {
                targetKind: 'entity_rollup',
                targetId: 'task:onboarding-followup',
                title: 'Onboarding follow-up is blocked on legal review',
                keyPoints: ['Ownership is clear, but the unblocker is still pending.'],
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
                  id: 'act-task-1',
                  ownerEntityId: 'task:onboarding-followup',
                  actionType: 'create_task',
                  title: 'Capture task follow-up',
                  detail: 'Turn the legal-review wait into an owned follow-up item.',
                  status: 'approved',
                  riskLevel: 'medium',
                  sourceAiFieldId: 'af-task-1',
                  evidenceEventIds: ['mem-task-1'],
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
                  id: 'sch-task-1',
                  createdAt: 1710000003000,
                  payload: {
                    title: 'Follow up with legal on onboarding review',
                    owner_entity_id: 'workspace:apollo',
                    source_action_id: 'act-queue-1',
                  },
                  provenance: {
                    latestAudit: {
                      eventType: 'executed',
                      detail: 'Queued after builder approval',
                    },
                  },
                },
              ],
              total: 1,
            },
            latestAudits: [
              {
                actionId: 'act-task-1',
                latestAudit: {
                  id: 'audit-task-1',
                  actor: 'user',
                  objectType: 'action',
                  objectId: 'act-task-1',
                  eventType: 'status_changed',
                  detail: 'Approved during project review',
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

    render(<ProjectMemoryScreen />);

    await waitFor(() => {
      expect(screen.getByText('onboarding-followup · task')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Load summary' }));

    await waitFor(() => {
      expect(screen.getByText('Onboarding follow-up is blocked on legal review')).toBeInTheDocument();
    });

    expect(screen.getByText('Approved during project review')).toBeInTheDocument();
    expect(screen.getByText('Follow up with legal on onboarding review')).toBeInTheDocument();
    expect(screen.getByText('Queued after builder approval')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open queued action' }));
    expect(focusEntityMock).toHaveBeenCalledWith('task:onboarding-followup');
    expect(focusActionTraceMock).toHaveBeenCalledWith({
      actionId: 'act-queue-1',
      aiFieldId: 'af-task-1',
      openAudit: false,
    });
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');

    fireEvent.click(screen.getByRole('button', { name: 'Open Workspace Detail' }));
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('workspace:apollo');
  });
});

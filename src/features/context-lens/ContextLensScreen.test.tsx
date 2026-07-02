import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ContextLensScreen } from './ContextLensScreen';
import { ACTION_LAYER_REFRESH_EVENT } from '@/shared/context/action-layer-events';

const runRuntimeActionMock = vi.fn();
const seedAiFieldDraftMock = vi.fn();
const seedActionDraftMock = vi.fn();
const focusEntityMock = vi.fn();
const focusAiFieldMock = vi.fn();
const focusActionTraceMock = vi.fn();
const openChatWithSeedMock = vi.fn();
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

vi.mock('@/shared/context/ai-field-focus', () => ({
  focusAiField: (...args: unknown[]) => focusAiFieldMock(...args),
}));

vi.mock('@/shared/context/action-trace-focus', () => ({
  focusActionTrace: (...args: unknown[]) => focusActionTraceMock(...args),
}));

vi.mock('@/shared/context/chat-composer-seed', () => ({
  buildActionChatSeed: (payload: unknown) => payload,
  buildEntityChatSeed: (payload: unknown) => payload,
  openChatWithSeed: (...args: unknown[]) => openChatWithSeedMock(...args),
}));

vi.mock('@/shared/context/context-target-navigation', async () => {
  const actual = await vi.importActual<typeof import('@/shared/context/context-target-navigation')>('@/shared/context/context-target-navigation');
  return {
    ...actual,
    openContextTarget: (...args: unknown[]) => openContextTargetMock(...args),
  };
});

const config = {
  headerEyebrow: 'APPLICATION LAYER',
  title: 'Fundraising',
  titleJp: '資金調達コンテキスト',
  descriptionEn: 'Test surface',
  descriptionJp: 'Test surface',
  summaryText: 'Test summary',
  searchPlaceholder: 'Search',
  loadingText: 'Loading…',
  emptyText: 'Empty',
  ownerKinds: ['investor', 'deal'],
  fieldPriority: ['investor_concern', 'next_action'],
  statLabels: {
    primary: 'investors',
    secondary: 'deals',
    openActions: 'open actions',
  },
};

describe('ContextLensScreen', () => {
  beforeEach(() => {
    runRuntimeActionMock.mockReset();
    seedAiFieldDraftMock.mockReset();
    seedActionDraftMock.mockReset();
    focusEntityMock.mockReset();
    focusAiFieldMock.mockReset();
    focusActionTraceMock.mockReset();
    openChatWithSeedMock.mockReset();
    openContextTargetMock.mockReset();
    pushToastMock.mockReset();
    (window as any).SHOGUN_RUNTIME = { setActiveScreen: vi.fn(), pushToast: pushToastMock };
  });

  it('quick-creates and opens entity context when selected as the post-create destination', async () => {
    const fieldItems: Array<Record<string, unknown>> = [];
    const refreshSpy = vi.fn();
    window.addEventListener(ACTION_LAYER_REFRESH_EVENT, refreshSpy);
    runRuntimeActionMock.mockImplementation((actionKey: string, payload?: any) => {
      if (actionKey === 'ai_field.list') {
        return Promise.resolve({ ok: true, data: { items: fieldItems } });
      }
      if (actionKey === 'action.list' || actionKey === 'context.tasks.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'ai_field.upsert') {
        fieldItems.unshift({
          id: 'af-created-ctx-1',
          ownerEntityId: payload.ownerEntityId,
          fieldName: payload.fieldName,
          instruction: payload.instruction,
          currentValue: payload.currentValue,
          confidence: payload.confidence,
          evidenceEventIds: payload.evidenceEventIds,
          createdAt: 1710000100000,
          lastUpdatedAt: 1710000101000,
        });
        return Promise.resolve({ ok: true, data: { item: fieldItems[0] } });
      }
      if (actionKey === 'action.propose') {
        return Promise.resolve({
          ok: true,
          data: {
            item: {
              id: 'act-created-ctx-1',
              ...payload,
              status: 'proposed',
            },
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<ContextLensScreen config={config} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Quick create' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Quick create' }));
    fireEvent.change(screen.getByLabelText('Entity suffix'), {
      target: { value: 'Atlas Ventures' },
    });
    fireEvent.change(screen.getByLabelText('Starter value'), {
      target: { value: 'Needs stronger partner follow-up.' },
    });
    fireEvent.change(screen.getByLabelText('After create'), {
      target: { value: 'entity_context' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create investor' }));

    await waitFor(() => {
      expect(openContextTargetMock).toHaveBeenCalledWith({
        targetId: 'investor:atlas-ventures',
      });
    });
    expect(refreshSpy).toHaveBeenCalled();
    expect((refreshSpy.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      reason: 'context-lens-ai-field-created',
    });
    window.removeEventListener(ACTION_LAYER_REFRESH_EVENT, refreshSpy);
  });

  it('quick-creates and stays on the current screen when stay mode is selected', async () => {
    const fieldItems: Array<Record<string, unknown>> = [];
    runRuntimeActionMock.mockImplementation((actionKey: string, payload?: any) => {
      if (actionKey === 'ai_field.list') {
        return Promise.resolve({ ok: true, data: { items: fieldItems } });
      }
      if (actionKey === 'action.list' || actionKey === 'context.tasks.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'ai_field.upsert') {
        fieldItems.unshift({
          id: 'af-created-ctx-2',
          ownerEntityId: payload.ownerEntityId,
          fieldName: payload.fieldName,
          instruction: payload.instruction,
          currentValue: payload.currentValue,
          confidence: payload.confidence,
          evidenceEventIds: payload.evidenceEventIds,
          createdAt: 1710000110000,
          lastUpdatedAt: 1710000111000,
        });
        return Promise.resolve({ ok: true, data: { item: fieldItems[0] } });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<ContextLensScreen config={config} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Quick create' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Quick create' }));
    fireEvent.click(screen.getByLabelText('Also create starter action'));
    fireEvent.change(screen.getByLabelText('Entity suffix'), {
      target: { value: 'Northstar Capital' },
    });
    fireEvent.change(screen.getByLabelText('Starter value'), {
      target: { value: 'Waiting on updated memo.' },
    });
    fireEvent.change(screen.getByLabelText('After create'), {
      target: { value: 'stay' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create investor' }));

    await waitFor(() => {
      expect(screen.getByText('northstar-capital · investor')).toBeInTheDocument();
    });
    expect(openContextTargetMock).not.toHaveBeenCalled();
    expect(focusActionTraceMock).not.toHaveBeenCalled();
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).not.toHaveBeenCalled();
    const successToast = pushToastMock.mock.calls.find(
      (call) => call[0] === 'Created investor:northstar-capital',
    );
    expect(successToast?.[2]?.action?.label).toBe('Open field');
  });

  it('reloads when the shared action-layer refresh event is dispatched externally', async () => {
    const fieldItems: Array<Record<string, unknown>> = [];
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'ai_field.list') {
        return Promise.resolve({ ok: true, data: { items: fieldItems } });
      }
      if (actionKey === 'action.list' || actionKey === 'context.tasks.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<ContextLensScreen config={config} />);

    await waitFor(() => {
      expect(screen.getByText('Empty')).toBeInTheDocument();
    });

    fieldItems.unshift({
      id: 'af-refresh-1',
      ownerEntityId: 'investor:floodgate',
      fieldName: 'investor_concern',
      instruction: 'Track current concern.',
      currentValue: 'Needs stronger pipeline detail.',
      confidence: 0.82,
      evidenceEventIds: [],
      createdAt: 1710000120000,
      lastUpdatedAt: 1710000121000,
    });

    window.dispatchEvent(
      new CustomEvent(ACTION_LAYER_REFRESH_EVENT, {
        detail: { reason: 'test-refresh' },
      }),
    );

    await waitFor(() => {
      expect(screen.getByText('floodgate · investor')).toBeInTheDocument();
    });
  });

  it('reloads loaded evidence snapshots when the shared refresh event is dispatched', async () => {
    let summaryCallCount = 0;
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'ai_field.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'af-investor-1',
                ownerEntityId: 'investor:sequoia',
                fieldName: 'investor_concern',
                instruction: 'Track current concern.',
                currentValue: 'Needs stronger data room organization.',
                confidence: 0.8,
                evidenceEventIds: [],
                createdAt: 1710000130000,
                lastUpdatedAt: 1710000131000,
              },
            ],
          },
        });
      }
      if (actionKey === 'action.list' || actionKey === 'context.tasks.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'context.owner_summary.get') {
        summaryCallCount += 1;
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
                title: summaryCallCount === 1 ? 'Sequoia summary' : 'Sequoia summary refreshed',
                keyPoints: [summaryCallCount === 1 ? 'One cached summary point' : 'Refreshed summary point'],
                sourceType: 'entity_rollup',
                priority: 'medium',
                model: 'mock',
                schemaVersion: 1,
                generatedAt: 1710000132000,
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
              aiFieldCount: 1,
              actionCount: 0,
              queueArtifactCount: 0,
              actionStatusCounts: {},
            },
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<ContextLensScreen config={config} />);

    await waitFor(() => {
      expect(screen.getByText('sequoia · investor')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Load summary' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Refresh summary' })).toBeInTheDocument();
      expect(screen.getByText('Sequoia summary')).toBeInTheDocument();
    });

    window.dispatchEvent(
      new CustomEvent(ACTION_LAYER_REFRESH_EVENT, {
        detail: { reason: 'external-refresh' },
      }),
    );

    await waitFor(() => {
      expect(screen.getByText('Sequoia summary refreshed')).toBeInTheDocument();
    });
  });

  it('keeps the latest loaded evidence summary when refresh responses resolve out of order', async () => {
    const summaryResolvers: Array<(value: unknown) => void> = [];
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'ai_field.list') {
        return Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: 'af-investor-race-1',
                ownerEntityId: 'investor:sequoia',
                fieldName: 'investor_concern',
                instruction: 'Track current concern.',
                currentValue: 'Needs stronger diligence narrative.',
                confidence: 0.8,
                evidenceEventIds: [],
                createdAt: 1710000130000,
                lastUpdatedAt: 1710000131000,
              },
            ],
          },
        });
      }
      if (actionKey === 'action.list' || actionKey === 'context.tasks.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'context.owner_summary.get') {
        return new Promise((resolve) => {
          summaryResolvers.push(resolve);
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<ContextLensScreen config={config} />);

    await waitFor(() => {
      expect(screen.getByText('sequoia · investor')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Load summary' }));

    await waitFor(() => {
      expect(summaryResolvers).toHaveLength(1);
    });

    window.dispatchEvent(
      new CustomEvent(ACTION_LAYER_REFRESH_EVENT, {
        detail: { reason: 'external-refresh-race' },
      }),
    );

    await waitFor(() => {
      expect(summaryResolvers).toHaveLength(2);
    });

    summaryResolvers[1]!({
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
            title: 'Sequoia summary refreshed',
            keyPoints: ['Fresh summary wins.'],
            sourceType: 'entity_rollup',
            priority: 'medium',
            model: 'mock',
            schemaVersion: 1,
            generatedAt: 1710000133000,
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
          aiFieldCount: 1,
          actionCount: 0,
          queueArtifactCount: 0,
          actionStatusCounts: {},
        },
      },
    });

    await waitFor(() => {
      expect(screen.getByText('Sequoia summary refreshed')).toBeInTheDocument();
    });

    summaryResolvers[0]!({
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
            title: 'Sequoia stale summary',
            keyPoints: ['Old summary should be ignored.'],
            sourceType: 'entity_rollup',
            priority: 'medium',
            model: 'mock',
            schemaVersion: 1,
            generatedAt: 1710000132000,
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
          aiFieldCount: 1,
          actionCount: 0,
          queueArtifactCount: 0,
          actionStatusCounts: {},
        },
      },
    });

    await waitFor(() => {
      expect(screen.getByText('Sequoia summary refreshed')).toBeInTheDocument();
    });
    expect(screen.queryByText('Sequoia stale summary')).not.toBeInTheDocument();
  });

  it('opens source meeting detail from shared action evidence', async () => {
    const onOpenMeetingDetail = vi.fn();
    window.addEventListener('shogun-open-meeting-detail', onOpenMeetingDetail as EventListener);
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
                instruction: 'Track current interest.',
                currentValue: 'High',
                confidence: 0.9,
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
                title: 'Sequoia is engaged',
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
            actions: {
              items: [
                {
                  id: 'act-investor-1',
                  ownerEntityId: 'investor:sequoia',
                  actionType: 'follow_up_email_draft',
                  title: 'Draft investor follow-up',
                  detail: 'Summarize the partner meeting.',
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
            queueArtifacts: { items: [], total: 0 },
            latestAudits: [],
            summary: {
              aiFieldCount: 1,
              actionCount: 1,
              queueArtifactCount: 0,
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

    render(<ContextLensScreen config={config} />);

    await waitFor(() => {
      expect(screen.getByText('sequoia · investor')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Load summary' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open source meeting' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open source meeting' }));
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('meetings');
    await waitFor(() => {
      expect((onOpenMeetingDetail.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ meetingId: 'fundraise-sync' });
    });

    window.removeEventListener('shogun-open-meeting-detail', onOpenMeetingDetail as EventListener);
  });

  it('opens workspace detail from recent summary targets', async () => {
    const onOpenWorkspaceDetail = vi.fn();
    window.addEventListener('shogun-open-workspace-detail', onOpenWorkspaceDetail as EventListener);
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
                instruction: 'Track current interest.',
                currentValue: 'High',
                confidence: 0.9,
                evidenceEventIds: [],
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
                title: 'Sequoia is engaged',
                keyPoints: [],
                sourceType: 'entity_rollup',
                priority: 'medium',
                model: 'mock',
                schemaVersion: 1,
                generatedAt: 1710000002000,
              },
              recentSummaries: [
                {
                  targetKind: 'workspace',
                  targetId: 'workspace:apollo',
                  title: 'Apollo workspace follow-ups',
                  keyPoints: ['Capture diligence asks in the workspace.'],
                  sourceType: 'workspace_summary',
                  priority: 'medium',
                  model: 'mock',
                  schemaVersion: 1,
                  generatedAt: 1710000002100,
                },
              ],
              aiFields: [],
              actions: [],
            },
            aiFields: { items: [], total: 0 },
            actions: { items: [], total: 0 },
            queueArtifacts: { items: [], total: 0 },
            latestAudits: [],
            summary: {
              aiFieldCount: 1,
              actionCount: 0,
              queueArtifactCount: 0,
              actionStatusCounts: {
                proposed: 0,
                approved: 0,
                executed: 0,
                rejected: 0,
              },
            },
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<ContextLensScreen config={config} />);

    await waitFor(() => {
      expect(screen.getByText('sequoia · investor')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Load summary' }));

    await waitFor(() => {
      expect(screen.getByText('Apollo workspace follow-ups')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Open Workspace Detail'));
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('work');
    await waitFor(() => {
      expect((onOpenWorkspaceDetail.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ workspaceId: 'apollo' });
    });

    window.removeEventListener('shogun-open-workspace-detail', onOpenWorkspaceDetail as EventListener);
  });

  it('opens queued action and workspace detail from queue artifact evidence', async () => {
    const onOpenWorkspaceDetail = vi.fn();
    window.addEventListener('shogun-open-workspace-detail', onOpenWorkspaceDetail as EventListener);
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
                instruction: 'Track current interest.',
                currentValue: 'High',
                confidence: 0.9,
                evidenceEventIds: [],
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
                title: 'Sequoia is engaged',
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
                  id: 'queue-1',
                  createdAt: 1710000003000,
                  payload: {
                    title: 'Queue Apollo update',
                    owner_entity_id: 'workspace:apollo',
                    source_action_id: 'act-queue-1',
                  },
                  provenance: {
                    latestAudit: {
                      eventType: 'approved',
                      detail: 'Queued after approval',
                    },
                  },
                },
              ],
              total: 1,
            },
            latestAudits: [],
            summary: {
              aiFieldCount: 1,
              actionCount: 0,
              queueArtifactCount: 1,
              actionStatusCounts: {
                proposed: 0,
                approved: 0,
                executed: 0,
                rejected: 0,
              },
            },
          },
        });
      }
      return Promise.resolve({ ok: true, data: { items: [] } });
    });

    render(<ContextLensScreen config={config} />);

    await waitFor(() => {
      expect(screen.getByText('sequoia · investor')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Load summary' }));

    await waitFor(() => {
      expect(screen.getByText('Queue Apollo update')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open queued action' }));
    expect(focusEntityMock).toHaveBeenCalledWith('investor:sequoia');
    expect(focusActionTraceMock).toHaveBeenCalledWith({
      actionId: 'act-queue-1',
      aiFieldId: 'af-investor-1',
      openAudit: false,
    });
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');

    fireEvent.click(screen.getByRole('button', { name: 'Open Workspace Detail' }));
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('work');
    await waitFor(() => {
      expect((onOpenWorkspaceDetail.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ workspaceId: 'apollo' });
    });

    const askChatButtons = screen.getAllByRole('button', { name: 'Ask Chat' });
    expect(askChatButtons.length).toBeGreaterThan(1);
    fireEvent.click(askChatButtons[1] as HTMLElement);
    expect(openChatWithSeedMock).toHaveBeenCalledWith({
      entityId: 'workspace:apollo',
      entityLabel: 'workspace:apollo',
      actionLabel: 'Queue Apollo update',
    });

    window.removeEventListener('shogun-open-workspace-detail', onOpenWorkspaceDetail as EventListener);
  });

  it('preserves source ai field context when opening shared actions and audits', async () => {
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
                instruction: 'Track current interest.',
                currentValue: 'High',
                confidence: 0.9,
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
                detail: 'Summarize the partner meeting.',
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
                title: 'Sequoia is engaged',
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
            actions: {
              items: [
                {
                  id: 'act-investor-1',
                  ownerEntityId: 'investor:sequoia',
                  actionType: 'follow_up_email_draft',
                  title: 'Draft investor follow-up',
                  detail: 'Summarize the partner meeting.',
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
            queueArtifacts: { items: [], total: 0 },
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
              queueArtifactCount: 0,
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

    render(<ContextLensScreen config={config} />);

    await waitFor(() => {
      expect(screen.getByText('sequoia · investor')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Load summary' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open queue' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open queue' }));
    expect(focusActionTraceMock).toHaveBeenLastCalledWith({
      actionId: 'act-investor-1',
      aiFieldId: 'af-investor-1',
      openAudit: false,
    });

    const openAuditButtons = screen.getAllByRole('button', { name: 'Open audit' });
    fireEvent.click(openAuditButtons[0] as HTMLElement);
    expect(focusActionTraceMock).toHaveBeenLastCalledWith({
      actionId: 'act-investor-1',
      aiFieldId: 'af-investor-1',
      openAudit: true,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open action' }));
    expect(focusActionTraceMock).toHaveBeenLastCalledWith({
      actionId: 'act-investor-1',
      aiFieldId: 'af-investor-1',
      openAudit: false,
    });
  });
});

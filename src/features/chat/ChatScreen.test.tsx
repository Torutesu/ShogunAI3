import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatScreen } from './ChatScreen';

const runRuntimeActionMock = vi.fn();
const focusEntityMock = vi.fn();
const focusActionTraceMock = vi.fn();
const seedActionDraftMock = vi.fn();
const openContextTargetMock = vi.fn();
const openNativeDetailForEntityIdMock = vi.fn();
const nativeDetailDescriptorForEntityIdMock = vi.fn((entityId: string) => {
  const normalized = String(entityId || '').trim();
  if (normalized.startsWith('workspace:')) {
    return { kind: 'workspace', id: normalized.slice('workspace:'.length), label: 'Open Workspace Detail' };
  }
  if (normalized.startsWith('meeting:')) {
    return { kind: 'meeting', id: normalized.slice('meeting:'.length), label: 'Open Meeting Detail' };
  }
  return null;
});

vi.mock('@/shared/ipc/runtime-actions', () => ({
  runRuntimeAction: (...args: unknown[]) => runRuntimeActionMock(...args),
}));

vi.mock('@/shared/context/entity-focus', () => ({
  focusEntity: (...args: unknown[]) => focusEntityMock(...args),
}));

vi.mock('@/shared/context/ai-field-focus', () => ({
  focusAiField: vi.fn(),
}));

vi.mock('@/shared/context/action-trace-focus', () => ({
  focusActionTrace: (...args: unknown[]) => focusActionTraceMock(...args),
}));

vi.mock('@/shared/context/action-draft', () => ({
  seedActionDraft: (...args: unknown[]) => seedActionDraftMock(...args),
}));

vi.mock('@/shared/context/context-target-navigation', () => ({
  nativeDetailDescriptorForEntityId: (entityId: string) => nativeDetailDescriptorForEntityIdMock(entityId),
  openContextTarget: (...args: unknown[]) => openContextTargetMock(...args),
  openMeetingDetail: vi.fn(),
  openNativeDetailForEntityId: (...args: unknown[]) => openNativeDetailForEntityIdMock(...args),
}));

describe('ChatScreen', () => {
  beforeEach(() => {
    runRuntimeActionMock.mockReset();
    focusEntityMock.mockReset();
    focusActionTraceMock.mockReset();
    seedActionDraftMock.mockReset();
    openContextTargetMock.mockReset();
    openNativeDetailForEntityIdMock.mockReset();
    nativeDetailDescriptorForEntityIdMock.mockClear();

    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'stats.get') {
        return Promise.resolve({ ok: true, data: { memoryTotal: 12 } });
      }
      if (actionKey === 'settings.load') {
        return Promise.resolve({
          ok: true,
          data: {
            settings: {
              sections: {
                llm: { model: 'gpt-test' },
                privacy: { allowChatServerMemoryAssembly: true },
              },
            },
          },
        });
      }
      if (actionKey === 'context.recent.get') {
        return Promise.resolve({
          ok: true,
          data: {
            recentAiFields: {
              items: [
                {
                  id: 'af-aurora-1',
                  ownerEntityId: 'workspace:apollo',
                  fieldName: 'next_action',
                  instruction: 'Track the next Apollo action',
                  currentValue: 'Draft diligence follow-up',
                  evidenceEventIds: ['meeting:apollo-sync', 'mem-apollo-1'],
                  createdAt: Date.now() - 20 * 60 * 1000,
                  lastUpdatedAt: Date.now() - 10 * 60 * 1000,
                },
              ],
              total: 1,
            },
            recentActions: { items: [], total: 0 },
            recentQueueArtifacts: {
              items: [
                {
                  id: 'queue-1',
                  createdAt: Date.now() - 5 * 60 * 1000,
                  payload: {
                    title: 'Queue Apollo CRM update',
                    detail: 'Push diligence summary into the workspace.',
                    owner_entity_id: 'workspace:apollo',
                    source_action_id: 'act-queue-1',
                  },
                  provenance: {
                    sourceAction: {
                      id: 'act-queue-1',
                      status: 'approved',
                      riskLevel: 'medium',
                      title: 'Queue Apollo CRM update',
                    },
                    latestAudit: {
                      eventType: 'approved',
                      detail: 'Approved in review',
                    },
                  },
                },
              ],
              total: 1,
            },
            recentMeetings: [],
          },
        });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    (window as any).__SHOGUN_SHELL_ACTIVE_CHAT__ = null;
    (window as any).SHOGUN_RUNTIME = {
      pushToast: vi.fn(),
      setActiveScreen: vi.fn(),
      openSettingsPane: vi.fn(),
      getActiveChat: () => null,
    };
  });

  it('attaches queue artifacts from shared context and routes open actions through desktop handlers', async () => {
    render(<ChatScreen />);

    await waitFor(() => {
      expect(
        screen.getAllByText((_, element) => element?.textContent?.includes('12 memories indexed') ?? false)
          .length,
      ).toBeGreaterThan(0);
    });

    const contextButton = screen.getAllByRole('button').find((button) => button.textContent?.trim() === 'Context');
    expect(contextButton).toBeTruthy();
    fireEvent.click(contextButton as HTMLElement);

    await waitFor(() => {
      expect(screen.getByText('Queue Apollo CRM update')).toBeInTheDocument();
    });

    expect((window as any).SHOGUN_RUNTIME.pushToast).toHaveBeenCalledWith(
      'Attached 2 recent shared context items',
      'success',
    );
    const queueTitle = screen.getByText('Queue Apollo CRM update');
    const queueCard = queueTitle.closest('.memory-context-hit');
    expect(queueCard).toBeTruthy();
    const queueCardScope = within(queueCard as HTMLElement);

    fireEvent.click(queueCardScope.getByRole('button', { name: 'Open' }));
    expect(focusEntityMock).toHaveBeenCalledWith('workspace:apollo');
    expect(focusActionTraceMock).toHaveBeenCalledWith({
      actionId: 'act-queue-1',
      aiFieldId: 'af-aurora-1',
      openAudit: false,
    });
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');

    fireEvent.click(queueCardScope.getByRole('button', { name: 'Open Workspace Detail' }));
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('workspace:apollo');
  });

  it('seeds a shared action draft from the composer and attached context', async () => {
    render(<ChatScreen />);

    await waitFor(() => {
      expect(
        screen.getAllByText((_, element) => element?.textContent?.includes('12 memories indexed') ?? false).length,
      ).toBeGreaterThan(0);
    });

    const contextButton = screen.getAllByRole('button').find((button) => button.textContent?.trim() === 'Context');
    fireEvent.click(contextButton as HTMLElement);

    await waitFor(() => {
      expect(screen.getByText('Queue Apollo CRM update')).toBeInTheDocument();
    });
    expect(screen.getByText('workspace:apollo / next_action')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Message…'), {
      target: { value: 'Draft the Apollo follow-up with diligence summary and owner.' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Action type' }), {
      target: { value: 'update_crm' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Action risk' }), {
      target: { value: 'high' },
    });

    fireEvent.click(screen.getByRole('button', { name: /To Action/i }));

    expect(seedActionDraftMock).toHaveBeenCalledWith({
      ownerEntityId: 'workspace:apollo',
      actionType: 'update_crm',
      title: 'Draft the Apollo follow-up with diligence summary and owner.',
      detail: 'Draft the Apollo follow-up with diligence summary and owner.',
      riskLevel: 'high',
      sourceAiFieldId: 'af-aurora-1',
      evidenceEventIds: ['meeting:apollo-sync', 'mem-apollo-1', 'af-aurora-1', 'act-queue-1'],
    });
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');
    expect((window as any).SHOGUN_RUNTIME.pushToast).toHaveBeenCalledWith(
      'Seeded update_crm as an action draft',
      'success',
    );
  });

  it('refreshes memory totals and settings-derived chat behavior from desktop events', async () => {
    let memoryTotal = 12;
    let model = 'gpt-test';
    let allowServerMemoryAssembly = true;

    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'stats.get') {
        return Promise.resolve({ ok: true, data: { memoryTotal } });
      }
      if (actionKey === 'settings.load') {
        return Promise.resolve({
          ok: true,
          data: {
            settings: {
              sections: {
                llm: { model },
                privacy: { allowChatServerMemoryAssembly: allowServerMemoryAssembly },
              },
            },
          },
        });
      }
      if (actionKey === 'context.recent.get') {
        return Promise.resolve({
          ok: true,
          data: {
            recentAiFields: { items: [], total: 0 },
            recentActions: { items: [], total: 0 },
            recentQueueArtifacts: { items: [], total: 0 },
            recentMeetings: [],
          },
        });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(<ChatScreen />);

    await waitFor(() => {
      expect(
        screen.getAllByText((_, element) => element?.textContent?.includes('12 memories indexed') ?? false)
          .length,
      ).toBeGreaterThan(0);
    });

    memoryTotal = 24;
    window.dispatchEvent(new CustomEvent('shogun-memory-index-changed'));

    await waitFor(() => {
      expect(
        screen.getAllByText((_, element) => element?.textContent?.includes('24 memories indexed') ?? false)
          .length,
      ).toBeGreaterThan(0);
    });

    model = 'gpt-updated';
    allowServerMemoryAssembly = false;
    window.dispatchEvent(new CustomEvent('shogun-settings-refresh'));

    await waitFor(() => {
      expect(
        screen.getAllByText((_, element) => element?.textContent?.includes('gpt-updated · 24 memories indexed') ?? false)
          .length,
      ).toBeGreaterThan(0);
    });
  });
});

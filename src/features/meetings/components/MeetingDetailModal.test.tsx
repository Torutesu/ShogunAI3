import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetingDetailModal } from './MeetingDetailModal';

const runRuntimeActionMock = vi.fn();
const focusEntityMock = vi.fn();
const focusActionTraceMock = vi.fn();
const openContextTargetMock = vi.fn();
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
  openContextTarget: (...args: unknown[]) => openContextTargetMock(...args),
  openNativeDetailForEntityId: (...args: unknown[]) => openNativeDetailForEntityIdMock(...args),
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
}));

vi.mock('./MeetingAiFieldPanel', () => ({
  MeetingAiFieldPanel: () => <div>Meeting AI Field Panel</div>,
}));

describe('MeetingDetailModal', () => {
  beforeEach(() => {
    runRuntimeActionMock.mockReset();
    focusEntityMock.mockReset();
    focusActionTraceMock.mockReset();
    openContextTargetMock.mockReset();
    openNativeDetailForEntityIdMock.mockReset();
    (window as any).SHOGUN_RUNTIME = { setActiveScreen: vi.fn() };
  });

  it('shows owner summary context for the meeting detail entity', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
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
      <MeetingDetailModal
        meetingDetail={{
          meeting: { id: 'mtg-1', title: 'Aurora sync', started_at: 0, ended_at: 0 },
          segments: [],
          loading: false,
          filter: '',
        }}
        setMeetingDetail={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('OWNER SUMMARY')).toBeInTheDocument();
    });
    expect(screen.getByText('Latest action: Draft meeting follow-up [approved]')).toBeInTheDocument();
    expect(screen.getByText('Latest queue: Send meeting follow-up draft')).toBeInTheDocument();
    expect(screen.getByText('Latest audit: Approved after meeting review')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Meeting Detail' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open queued action' }));
    expect(focusEntityMock).toHaveBeenCalledWith('meeting:mtg-1');
    expect(focusActionTraceMock).toHaveBeenCalledWith({
      actionId: 'act-queue-1',
      aiFieldId: 'af-1',
      openAudit: false,
    });
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('actions');
  });

  it('routes the owner summary entity button through shared navigation', async () => {
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
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
      <MeetingDetailModal
        meetingDetail={{
          meeting: { id: 'mtg-1', title: 'Aurora sync', started_at: 0, ended_at: 0 },
          segments: [],
          loading: false,
          filter: '',
        }}
        setMeetingDetail={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Entity Context' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Entity Context' }));
    expect(openContextTargetMock).toHaveBeenCalledWith({ targetId: 'meeting:mtg-1' });
  });

  it('closes the modal before opening cross-owner native detail from the latest queue row', async () => {
    const setMeetingDetailMock = vi.fn();

    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'context.owner_summary.get') {
        return Promise.resolve({
          ok: true,
          data: {
            ownerEntityId: 'meeting:mtg-1',
            entityContext: null,
            aiFields: { items: [], total: 0 },
            actions: { items: [], total: 0 },
            queueArtifacts: {
              items: [
                {
                  id: 'sch-1',
                  createdAt: 0,
                  payload: {
                    title: 'Open Apollo workspace follow-up',
                    owner_entity_id: 'workspace:apollo',
                  },
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
      return Promise.resolve({ ok: true, data: {} });
    });

    render(
      <MeetingDetailModal
        meetingDetail={{
          meeting: { id: 'mtg-1', title: 'Aurora sync', started_at: 0, ended_at: 0 },
          segments: [],
          loading: false,
          filter: '',
        }}
        setMeetingDetail={setMeetingDetailMock}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Open Workspace Detail' }));
    expect(setMeetingDetailMock).toHaveBeenCalledWith(null);
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('workspace:apollo');
  });
});

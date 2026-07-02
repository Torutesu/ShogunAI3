import { beforeEach, describe, expect, it } from 'vitest';

import { handleMockCommand } from './handler';
import {
  MOCK_AI_FIELDS_LS,
  MOCK_CONTEXT_ACTIONS_LS,
  MOCK_CONTEXT_ACTION_AUDIT_LS,
} from './settings';

describe('mock handler context layer parity', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('scopes recent context lists by owner entity id', () => {
    window.localStorage.setItem(
      MOCK_AI_FIELDS_LS,
      JSON.stringify([
        {
          id: 'af-meeting',
          ownerEntityId: 'meeting:mtg-77',
          fieldName: 'next_action',
          instruction: 'Track meeting follow-up',
          currentValue: 'Send recap',
        },
        {
          id: 'af-workspace',
          ownerEntityId: 'workspace:apollo',
          fieldName: 'blocker',
          instruction: 'Track workspace blocker',
          currentValue: 'Need diligence answers',
        },
      ]),
    );
    window.localStorage.setItem(
      MOCK_CONTEXT_ACTIONS_LS,
      JSON.stringify([
        {
          id: 'act-meeting',
          ownerEntityId: 'meeting:mtg-77',
          actionType: 'follow_up_email_draft',
          title: 'Draft recap',
          detail: '',
          status: 'approved',
          riskLevel: 'medium',
        },
        {
          id: 'act-workspace',
          ownerEntityId: 'workspace:apollo',
          actionType: 'create_task',
          title: 'Create workspace task',
          detail: '',
          status: 'proposed',
          riskLevel: 'medium',
        },
      ]),
    );

    const result = handleMockCommand('shogun_context_recent_get', {
      ownerEntityId: 'meeting:mtg-77',
      limit: 5,
    });

    expect(result).toMatchObject({
      ownerEntityId: 'meeting:mtg-77',
      recentAiFields: { total: 1 },
      recentActions: { total: 1 },
    });
    expect((result as any).recentAiFields.items[0].ownerEntityId).toBe('meeting:mtg-77');
    expect((result as any).recentActions.items[0].ownerEntityId).toBe('meeting:mtg-77');
  });

  it('includes queue artifact provenance in recent context payloads', () => {
    const result = handleMockCommand('shogun_context_recent_get', {
      ownerEntityId: 'workspace:demo',
      limit: 5,
    });

    expect((result as any).recentQueueArtifacts.items[0].payload.source_action_id).toBe('act-queue');
    expect((result as any).recentQueueArtifacts.items[0].provenance.sourceAction.id).toBe('act-queue');
  });

  it('normalizes legacy queue_crm_update action proposals to update_crm', () => {
    const result = handleMockCommand('shogun_context_action_propose', {
      id: 'act-crm-legacy',
      ownerEntityId: 'company:aurora',
      actionType: 'queue_crm_update',
      title: 'Queue Aurora CRM update',
    });

    expect(result).toMatchObject({
      item: {
        id: 'act-crm-legacy',
        actionType: 'update_crm',
      },
    });
  });

  it('includes matching queue artifacts and latest audits in owner summaries', () => {
    window.localStorage.setItem(
      MOCK_CONTEXT_ACTIONS_LS,
      JSON.stringify([
        {
          id: 'act-queue',
          ownerEntityId: 'workspace:demo',
          actionType: 'create_task',
          title: 'Queue task',
          detail: '',
          status: 'approved',
          riskLevel: 'medium',
        },
      ]),
    );
    window.localStorage.setItem(
      MOCK_CONTEXT_ACTION_AUDIT_LS,
      JSON.stringify([
        {
          id: 'audit-1',
          actionId: 'act-queue',
          eventType: 'status_changed',
          actor: 'user',
          fromStatus: 'proposed',
          toStatus: 'approved',
          detail: 'Approved in review',
          createdAt: 10,
        },
      ]),
    );

    const result = handleMockCommand('shogun_owner_context_summary', {
      ownerEntityId: 'workspace:demo',
      limit: 5,
    });

    expect((result as any).queueArtifacts.total).toBe(1);
    expect((result as any).latestAudits[0].latestAudit.detail).toBe('Approved in review');
    expect((result as any).summary.queueArtifactCount).toBe(1);
  });

  it('emits app navigation events for desktop surface routing in mock mode', async () => {
    const detail = await new Promise<Record<string, unknown>>((resolve) => {
      const onNavigate = (event: Event) => {
        window.removeEventListener('shogun-app-navigate', onNavigate);
        resolve((event as CustomEvent<Record<string, unknown>>).detail);
      };
      window.addEventListener('shogun-app-navigate', onNavigate);
      handleMockCommand('app_navigate', {
        screen: 'entity_context',
        entityId: 'company:aurora',
      });
    });

    expect(detail).toEqual({
      screen: 'entity_context',
      entityId: 'company:aurora',
    });
  });

  it('emits auto-start meeting events in mock mode when a video-detect session starts', async () => {
    const detail = await new Promise<Record<string, unknown>>((resolve) => {
      const onAutoStarted = (event: Event) => {
        window.removeEventListener('shogun-video-meeting-auto-started', onAutoStarted);
        resolve((event as CustomEvent<Record<string, unknown>>).detail);
      };
      window.addEventListener('shogun-video-meeting-auto-started', onAutoStarted);
      handleMockCommand('shogun_meeting_start', {
        source: 'video_detect_auto_start',
        meeting_id: 'mtg-auto-1',
        title: 'Google Meet · Google Chrome',
        provider: 'google_meet',
        system_started: false,
        screen_capture_granted: false,
        auto_started: true,
      });
    });

    expect(detail).toEqual({
      meeting_id: 'mtg-auto-1',
      provider: 'google_meet',
      url: 'https://meet.google.com/mock-room',
      title: 'Google Meet · Google Chrome',
      app: 'Google Chrome',
      mic_started: false,
      system_started: false,
      screen_capture_granted: false,
      auto_started: true,
    });
  });

  it('returns draft-shaped data for custom agent runs in mock mode', () => {
    const result = handleMockCommand('shogun_agent_run_now', {
      agentId: 'custom-follow-up',
      memoryAssembly: null,
    });

    expect(result).toMatchObject({
      agentId: 'custom-follow-up',
      ok: true,
      custom: true,
      title: 'Draft · custom-follow-up',
      summary: 'Draft created for custom-follow-up',
    });
    expect((result as any).content).toContain('Generated for custom-follow-up');
  });

  it('returns queue navigation payloads for executed task actions in mock mode', () => {
    window.localStorage.setItem(
      MOCK_CONTEXT_ACTIONS_LS,
      JSON.stringify([
        {
          id: 'act-queue-1',
          ownerEntityId: 'workspace:apollo',
          actionType: 'create_task',
          title: 'Queue Apollo task',
          detail: 'Track diligence follow-up',
          status: 'approved',
          riskLevel: 'medium',
          sourceAiFieldId: 'af-apollo-1',
          evidenceEventIds: [],
          executionResult: null,
          executedAt: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    );

    const result = handleMockCommand('shogun_context_action_execute', {
      id: 'act-queue-1',
    });

    expect((result as any).navigation).toMatchObject({
      screen: 'actions',
      queueId: expect.stringMatching(/^sch_/),
      sourceActionId: 'act-queue-1',
      entityId: 'workspace:apollo',
      aiFieldId: 'af-apollo-1',
    });
  });

  it('returns chat navigation payloads for executed draft actions in mock mode', () => {
    window.localStorage.setItem(
      MOCK_CONTEXT_ACTIONS_LS,
      JSON.stringify([
        {
          id: 'act-draft-1',
          ownerEntityId: 'company:aurora',
          actionType: 'follow_up_email_draft',
          title: 'Draft Aurora follow-up',
          detail: 'Mention the open diligence item.',
          status: 'approved',
          riskLevel: 'medium',
          sourceAiFieldId: null,
          evidenceEventIds: [],
          executionResult: null,
          executedAt: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    );

    const result = handleMockCommand('shogun_context_action_execute', {
      id: 'act-draft-1',
    });

    expect((result as any).navigation).toMatchObject({
      screen: 'chat',
      newChat: true,
      assembleMemory: true,
      memoryAssemblyQuery: 'company:aurora',
      memoryAssemblyLimit: 14,
      memoryAssemblySemantic: true,
    });
    expect(String((result as any).navigation?.text || '')).toContain('Draft Aurora follow-up');
  });

  it('rejects unsupported context action types in mock mode', () => {
    expect(() => handleMockCommand('shogun_context_action_propose', {
      ownerEntityId: 'company:aurora',
      actionType: 'send_email_now',
      title: 'Send it directly',
    })).toThrow(/Unsupported action type: send_email_now/);
  });
});

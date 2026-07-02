import { beforeEach, describe, expect, it, vi } from 'vitest';

const openNativeDetailForEntityIdMock = vi.fn();

vi.mock('@/shared/context/context-target-navigation', async () => {
  const actual = await vi.importActual<typeof import('@/shared/context/context-target-navigation')>('@/shared/context/context-target-navigation');
  return {
    ...actual,
    openNativeDetailForEntityId: (entityId: string) => openNativeDetailForEntityIdMock(entityId),
  };
});

import {
  buildSharedContextBlock,
  buildSharedContextHits,
  contextHitEntityId,
  contextHitNativeDetailKind,
  inferActionEvidenceIdsFromChatContext,
  inferActionOwnerEntityIdFromChatContext,
  inferSourceAiFieldIdFromChatContext,
  openNativeDetailForContextHit,
} from './ChatScreen';

describe('ChatScreen context-hit helpers', () => {
  beforeEach(() => {
    openNativeDetailForEntityIdMock.mockReset();
  });

  it('derives entity ids for ai field, action, and meeting hits', () => {
    expect(contextHitEntityId({ provenance: 'ai_field', ownerEntityId: 'workspace:apollo' })).toBe('workspace:apollo');
    expect(contextHitEntityId({ provenance: 'action', ownerEntityId: 'company:aurora' })).toBe('company:aurora');
    expect(contextHitEntityId({ provenance: 'queue_artifact', ownerEntityId: 'workspace:apollo' })).toBe('workspace:apollo');
    expect(contextHitEntityId({ provenance: 'meeting', meetingId: 'mtg-1' })).toBe('meeting:mtg-1');
    expect(contextHitEntityId({ provenance: 'timeline', targetId: 'mem-1' })).toBeNull();
  });

  it('derives native detail kinds for meeting and workspace hits', () => {
    expect(contextHitNativeDetailKind({ provenance: 'meeting', meetingId: 'mtg-1' })).toBe('meeting');
    expect(contextHitNativeDetailKind({ provenance: 'action', ownerEntityId: 'workspace:apollo' })).toBe('workspace');
    expect(contextHitNativeDetailKind({ provenance: 'queue_artifact', ownerEntityId: 'workspace:apollo' })).toBe('workspace');
    expect(contextHitNativeDetailKind({ provenance: 'ai_field', ownerEntityId: 'company:aurora' })).toBeNull();
  });

  it('opens native detail targets for meeting and workspace hits', () => {
    expect(openNativeDetailForContextHit({ provenance: 'meeting', meetingId: 'mtg-1' })).toBeUndefined();
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('meeting:mtg-1');

    openNativeDetailForEntityIdMock.mockReset();

    expect(openNativeDetailForContextHit({ provenance: 'action', ownerEntityId: 'workspace:apollo' })).toBeUndefined();
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('workspace:apollo');

    openNativeDetailForEntityIdMock.mockReset();

    expect(openNativeDetailForContextHit({ provenance: 'queue_artifact', ownerEntityId: 'workspace:apollo' })).toBeUndefined();
    expect(openNativeDetailForEntityIdMock).toHaveBeenCalledWith('workspace:apollo');
  });

  it('ignores hits without a native entity target', () => {
    expect(openNativeDetailForContextHit({ provenance: 'timeline', targetId: 'mem-1' })).toBe(false);
    expect(openNativeDetailForEntityIdMock).not.toHaveBeenCalled();
  });

  it('includes recent queue artifacts in chat shared-context blocks and hits', () => {
    const payload = {
      recentAiFields: { items: [], total: 0 },
      recentActions: { items: [], total: 0 },
      recentQueueArtifacts: {
        items: [
          {
            id: 'queue-1',
            createdAt: 1719622800000,
            payload: {
              title: 'Queue Apollo CRM update',
              detail: 'Push diligence summary into the workspace.',
              owner_entity_id: 'workspace:apollo',
              source_action_id: 'act-queue-1',
            },
          },
        ],
        total: 1,
      },
      recentMeetings: [],
    };

    const block = buildSharedContextBlock('', payload);
    expect(block).toContain('[queue_artifact] Queue Apollo CRM update');
    expect(block).toContain('workspace:apollo');
    expect(block).toContain('action:act-queue-1');

    const hits = buildSharedContextHits(payload);
    expect(hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provenance: 'queue_artifact',
          title: 'Queue Apollo CRM update',
          ownerEntityId: 'workspace:apollo',
          actionId: 'act-queue-1',
        }),
      ]),
    );
  });

  it('infers action owner ids from attached chat context and falls back to workspace:chat', () => {
    expect(
      inferActionOwnerEntityIdFromChatContext(
        [{ provenance: 'queue_artifact', ownerEntityId: 'workspace:apollo' }],
        '',
      ),
    ).toBe('workspace:apollo');

    expect(
      inferActionOwnerEntityIdFromChatContext(
        null,
        '[ai_field] company:aurora / next_action: Send follow-up',
      ),
    ).toBe('company:aurora');

    expect(inferActionOwnerEntityIdFromChatContext(null, '')).toBe('workspace:chat');
  });

  it('infers source ai field ids and evidence ids from attached chat context', () => {
    const hits = [
      {
        provenance: 'ai_field',
        ownerEntityId: 'company:aurora',
        fieldId: 'af-aurora-1',
        evidenceIds: ['meeting:aurora-sync', 'mem-123'],
      },
      {
        provenance: 'queue_artifact',
        ownerEntityId: 'company:aurora',
        actionId: 'act-queue-1',
        id: 'queue-1',
      },
      {
        provenance: 'meeting',
        meetingId: 'mtg-77',
      },
    ];

    expect(inferSourceAiFieldIdFromChatContext(hits, 'company:aurora')).toBe('af-aurora-1');
    expect(inferSourceAiFieldIdFromChatContext(hits, 'workspace:apollo')).toBe('af-aurora-1');
    expect(inferActionEvidenceIdsFromChatContext(hits)).toEqual([
      'meeting:aurora-sync',
      'mem-123',
      'af-aurora-1',
      'act-queue-1',
      'meeting:mtg-77',
    ]);
  });
});

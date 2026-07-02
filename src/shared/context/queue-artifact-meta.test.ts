import { describe, expect, it } from 'vitest';

import {
  queueArtifactAuditDetail,
  queueArtifactAuditDetailFromSources,
  queueArtifactNativeDetailState,
  queueArtifactOwnerEntityId,
  queueArtifactSourceActionId,
  queueArtifactDetail,
  queueArtifactTitle,
} from './queue-artifact-meta';

describe('queueArtifactMeta', () => {
  it('reads owner, source action, and title from payload fields', () => {
    const item = {
      id: 'queue-1',
      payload: {
        title: 'Queue Apollo update',
        owner_entity_id: 'workspace:apollo',
        source_action_id: 'act-queue-1',
      },
    };

    expect(queueArtifactOwnerEntityId(item)).toBe('workspace:apollo');
    expect(queueArtifactSourceActionId(item)).toBe('act-queue-1');
    expect(queueArtifactTitle(item)).toBe('Queue Apollo update');
    expect(queueArtifactDetail(item)).toBe('');
  });

  it('falls back to provenance action ids and hides redundant native detail buttons', () => {
    const sameOwnerItem = {
      id: 'queue-1',
      payload: {
        title: 'Queue Apollo update',
        owner_entity_id: 'workspace:apollo',
      },
      provenance: {
        sourceAction: {
          id: 'act-queue-1',
        },
      },
    };

    expect(queueArtifactSourceActionId(sameOwnerItem)).toBe('act-queue-1');
    expect(queueArtifactAuditDetail({
      provenance: {
        latestAudit: {
          detail: 'Approved in review',
        },
      },
    })).toBe('Approved in review');
    expect(
      queueArtifactAuditDetailFromSources(
        { payload: { title: 'Queue Apollo update' } },
        {
          latestAudit: {
            detail: 'Executed action via queue_only',
          },
        },
      ),
    ).toBe('Executed action via queue_only');
    expect(
      queueArtifactNativeDetailState(sameOwnerItem, {
        currentEntityId: 'workspace:apollo',
      }),
    ).toMatchObject({
      ownerEntityId: 'workspace:apollo',
      showNativeDetail: false,
      nativeDetailDescriptor: {
        kind: 'workspace',
        id: 'apollo',
        label: 'Open Workspace Detail',
      },
    });

    expect(
      queueArtifactNativeDetailState(
        {
          payload: {
            owner_entity_id: 'meeting:mtg-1',
          },
        },
        {
          currentEntityId: 'workspace:apollo',
        },
      ),
    ).toMatchObject({
      ownerEntityId: 'meeting:mtg-1',
      showNativeDetail: true,
      nativeDetailDescriptor: {
        kind: 'meeting',
        id: 'mtg-1',
        label: 'Open Meeting Detail',
      },
    });
  });
});

import { describe, expect, it } from 'vitest';

import { buildEntitySignals, getEntitySignalLabel } from './entity-kind-signals';
import type { EntityContextRecord } from '@/shared/domain/context-layer';

function createBundle(): EntityContextRecord {
  return {
    entityId: 'workspace:founder-sales',
    entityLabel: 'Founder sales',
    lang: 'ja',
    rollup: null,
    recentSummaries: [
      {
        targetKind: 'workspace',
        targetId: 'workspace:founder-sales',
        title: 'Pipeline review',
        keyPoints: [],
        sourceType: 'memory',
        priority: 'medium',
        model: 'test',
        schemaVersion: 1,
        generatedAt: Date.now(),
      },
    ],
    aiFields: [
      {
        id: 'field-1',
        ownerEntityId: 'workspace:founder-sales',
        fieldName: 'blocker',
        instruction: 'Track the main blocker across this workspace',
        currentValue: 'Waiting on pricing review',
        confidence: 0.9,
        evidenceEventIds: [],
        createdAt: Date.now(),
        lastUpdatedAt: Date.now(),
      },
      {
        id: 'field-2',
        ownerEntityId: 'workspace:founder-sales',
        fieldName: 'next_action',
        instruction: 'Track the clearest next move for this workspace',
        currentValue: 'Send revised enterprise package',
        confidence: 0.9,
        evidenceEventIds: [],
        createdAt: Date.now(),
        lastUpdatedAt: Date.now(),
      },
    ],
    actions: [
      {
        id: 'action-1',
        ownerEntityId: 'workspace:founder-sales',
        actionType: 'create_task',
        title: 'Prepare revised enterprise package',
        detail: 'Build the next outbound package for the lane',
        status: 'approved',
        riskLevel: 'medium',
        sourceAiFieldId: null,
        evidenceEventIds: [],
        executionResult: null,
        executedAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  };
}

describe('entity kind signals', () => {
  it('returns workspace-specific signal labels', () => {
    expect(getEntitySignalLabel('workspace-next')).toBe('Next action');
  });

  it('builds workspace-specific signal cards', () => {
    const signals = buildEntitySignals('workspace', createBundle());

    expect(signals.map((item) => item.id)).toEqual([
      'workspace-blocker',
      'workspace-next',
      'workspace-activity',
    ]);
    expect(signals[0]).toMatchObject({
      value: 'Waiting on pricing review',
      ctaKind: 'open_field',
    });
    expect(signals[2]).toMatchObject({
      value: '1 queued',
      ctaKind: 'open_action',
    });
  });

  it('builds task-specific signal cards', () => {
    const bundle: EntityContextRecord = {
      entityId: 'task:onboarding-followup',
      entityLabel: 'Onboarding follow-up',
      lang: 'ja',
      rollup: null,
      recentSummaries: [],
      aiFields: [
        {
          id: 'field-status',
          ownerEntityId: 'task:onboarding-followup',
          fieldName: 'status',
          instruction: 'Track the latest status and state transition for this task.',
          currentValue: 'Waiting on legal review',
          confidence: 0.9,
          evidenceEventIds: [],
          createdAt: Date.now(),
          lastUpdatedAt: Date.now(),
        },
        {
          id: 'field-owner',
          ownerEntityId: 'task:onboarding-followup',
          fieldName: 'owner',
          instruction: 'Track who currently owns this task and whether handoff is needed.',
          currentValue: 'Mika',
          confidence: 0.9,
          evidenceEventIds: [],
          createdAt: Date.now(),
          lastUpdatedAt: Date.now(),
        },
      ],
      actions: [],
    };

    const signals = buildEntitySignals('task', bundle);

    expect(signals.map((item) => item.id)).toEqual([
      'task-status',
      'task-owner',
      'task-blocker',
    ]);
    expect(signals[0]).toMatchObject({ value: 'Waiting on legal review' });
    expect(signals[1]).toMatchObject({ value: 'Mika' });
  });
});

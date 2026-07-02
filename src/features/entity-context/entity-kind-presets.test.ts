import { describe, expect, it } from 'vitest';

import {
  getActionStarterForEntityKind,
  getFieldStartersForEntityKind,
  inferEntityKind,
} from './entity-kind-presets';

describe('entity kind presets', () => {
  it('infers workspace ids as workspace entities', () => {
    expect(inferEntityKind('workspace:apollo')).toBe('workspace');
  });

  it('returns workspace field starters', () => {
    const starters = getFieldStartersForEntityKind('workspace');

    expect(starters.map((item) => item.fieldName)).toEqual(['blocker', 'next_action', 'open_task']);
  });

  it('returns a workspace action starter', () => {
    expect(getActionStarterForEntityKind('workspace')).toMatchObject({
      actionType: 'create_task',
      titleTemplate: 'Create workspace task',
      riskLevel: 'medium',
    });
  });

  it('returns task-specific starters', () => {
    expect(getFieldStartersForEntityKind('task').map((item) => item.fieldName)).toEqual([
      'status',
      'owner',
      'blocker',
    ]);
    expect(getActionStarterForEntityKind('task')).toMatchObject({
      actionType: 'create_task',
      titleTemplate: 'Capture task follow-up',
      riskLevel: 'medium',
    });
  });
});

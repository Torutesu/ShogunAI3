import { describe, expect, it } from 'vitest';

import { normalizeRuntimeActionData } from './runtime-actions';

describe('normalizeRuntimeActionData', () => {
  it('normalizes legacy actionType values recursively inside runtime payloads', () => {
    const result = normalizeRuntimeActionData({
      recentActions: {
        items: [
          {
            id: 'act-1',
            actionType: 'queue_crm_update',
          },
        ],
      },
      ownerSummary: {
        actions: {
          items: [
            {
              id: 'act-2',
              actionType: 'update_crm',
            },
          ],
        },
      },
      actionType: 'queue_crm_update',
    });

    expect(result).toEqual({
      recentActions: {
        items: [
          {
            id: 'act-1',
            actionType: 'update_crm',
          },
        ],
      },
      ownerSummary: {
        actions: {
          items: [
            {
              id: 'act-2',
              actionType: 'update_crm',
            },
          ],
        },
      },
      actionType: 'update_crm',
    });
  });
});

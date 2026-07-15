import { describe, expect, it } from 'vitest';

import { ShogunMorningBrief } from './morning-brief';

describe('ShogunMorningBrief', () => {
  it('maps read-only MCP memory search tools to native desktop actions', () => {
    const resolved = ShogunMorningBrief.resolveNextAction(
      {
        mcp_tool: {
          tool_name: 'shogun.memory_search',
          arguments: { query: 'aurora security', limit: 5 },
        },
      },
      {
        id: 'item-1',
        what: 'Review Aurora blockers',
        why_now: 'Investor call is today',
        related_context: [{ title: 'Aurora notes' }],
        category: 'prep',
        priority: 1,
        time_hint: '09:00',
      },
    );

    expect(resolved).toMatchObject({
      skip: false,
      key: 'memory.search',
      payload: {
        query: 'aurora security',
        limit: 5,
        brief_item: {
          id: 'item-1',
          what: 'Review Aurora blockers',
          why_now: 'Investor call is today',
          category: 'prep',
          priority: 1,
          time_hint: '09:00',
        },
      },
    });
  });

  it('keeps native write-capable brief actions on their existing runtime keys', () => {
    const resolved = ShogunMorningBrief.resolveNextAction(
      {
        mcp_tool: {
          tool_name: 'shogun.start_focus_session',
          arguments: { duration_minutes: 90, task: 'lp_v2_copy' },
        },
      },
      {
        id: 'item-2',
        what: 'Finish LP copy',
        why_now: 'Focus block reserved',
      },
    );

    expect(resolved).toMatchObject({
      skip: false,
      key: 'shogun.start_focus_session',
      payload: {
        duration_minutes: 90,
        task: 'lp_v2_copy',
      },
    });
  });
});

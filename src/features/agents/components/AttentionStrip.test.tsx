import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AttentionStrip } from './AttentionStrip';
import type { AgentDemo } from '../types';

const NOW_MS = 1_700_000_000_000;

function makeAgent(overrides: Partial<AgentDemo> = {}): AgentDemo {
  return {
    id: 'agent-1',
    name: 'Inbox triage',
    icon: 'mail',
    status: 'scheduled',
    trigger: 'every 1 hour',
    triggerSince: '2024-01-01',
    description: 'Triages inbox',
    tools: [],
    lastRunMs: NOW_MS - 26 * 60 * 60_000,
    nextRunMs: NOW_MS + 60 * 60_000,
    recentRuns: [],
    paused: false,
    ...overrides,
  };
}

describe('AttentionStrip', () => {
  it('uses the attention overflow action instead of a stub toast', () => {
    const onShowAllAttention = vi.fn();
    render(
      <AttentionStrip
        agents={[
          makeAgent({ id: 'a-1', name: 'A-1' }),
          makeAgent({ id: 'a-2', name: 'A-2' }),
          makeAgent({ id: 'a-3', name: 'A-3' }),
          makeAgent({ id: 'a-4', name: 'A-4' }),
        ]}
        nowMs={NOW_MS}
        onView={vi.fn()}
        onRunNow={vi.fn()}
        onShowAllAttention={onShowAllAttention}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /\+1 more/i }));
    expect(onShowAllAttention).toHaveBeenCalledOnce();
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AgentRunHistoryDrawer } from './AgentRunHistoryDrawer';
import type { AgentDemo } from '../types';

const openMemoryItemMock = vi.fn();

vi.mock('@/features/memory/lib/runtime', () => ({
  openMemoryItem: (...args: unknown[]) => openMemoryItemMock(...args),
}));

const NOW_MS = 1_700_000_000_000;

function makeAgent(overrides: Partial<AgentDemo> = {}): AgentDemo {
  return {
    id: 'inbox-triage',
    name: 'Inbox triage',
    icon: 'mail',
    status: 'running',
    trigger: 'every 2 hours',
    triggerSince: '2026-04-12',
    description: 'Sorts Gmail',
    tools: [],
    lastRunMs: NOW_MS - 2 * 60 * 60_000,
    nextRunMs: NOW_MS + 30 * 60_000,
    recentRuns: [
      {
        id: 'run-1',
        atMs: NOW_MS - 2 * 60 * 60_000,
        t: '14:31',
        msg: 'Read 3 emails',
        level: 'success',
        durationMs: 1200,
        tools: ['gmail', 'memory'],
        input: 'Sweep Gmail inbox',
        output: 'Drafted one reply.',
        source: 'custom_agent_background',
        memoryTouched: [{ id: 'm_1779381', title: 'Yuito · Re: All-Strategy' }],
      },
    ],
    ...overrides,
  };
}

describe('AgentRunHistoryDrawer', () => {
  it('opens the real Memory surface for touched memory items', () => {
    openMemoryItemMock.mockReset();

    render(
      <AgentRunHistoryDrawer
        agent={makeAgent()}
        nowMs={NOW_MS}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /14:31/i }));
    fireEvent.click(screen.getByRole('button', { name: /\[open\]/i }));

    expect(openMemoryItemMock).toHaveBeenCalledWith({
      memoryId: 'm_1779381',
      view: 'river',
    });
  });

  it('shows the native run source in the history drawer', () => {
    render(
      <AgentRunHistoryDrawer
        agent={makeAgent()}
        nowMs={NOW_MS}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('background')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /14:31/i }));
    expect(screen.getAllByText('background').length).toBeGreaterThan(0);
  });

  it('opens run output in Chat when the expanded run exposes output', () => {
    const onOpenRunOutput = vi.fn();

    render(
      <AgentRunHistoryDrawer
        agent={makeAgent()}
        nowMs={NOW_MS}
        onClose={vi.fn()}
        onOpenRunOutput={onOpenRunOutput}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /14:31/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Open in Chat' }));

    expect(onOpenRunOutput).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'inbox-triage' }),
      expect.objectContaining({ id: 'run-1', output: 'Drafted one reply.' }),
    );
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EditAgentModal } from './EditAgentModal';
import type { AgentDemo } from '../types';

function makeAgent(overrides: Partial<AgentDemo> = {}): AgentDemo {
  return {
    id: 'custom-1',
    name: 'Aurora watcher',
    icon: 'memory',
    status: 'scheduled',
    trigger: 'every 1 hour',
    triggerSince: '2026-06-30',
    description: 'Tracks Aurora',
    tools: [{ name: 'memory', icon: 'memory' }],
    lastRunMs: null,
    nextRunMs: null,
    recentRuns: [],
    isCustom: true,
    prompt: 'Review Aurora memory.',
    ...overrides,
  };
}

describe('EditAgentModal', () => {
  it('lets custom agents update prompt and tools', () => {
    const onSave = vi.fn();

    render(
      <EditAgentModal
        agent={makeAgent()}
        onSave={onSave}
        onDelete={null}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByDisplayValue('Review Aurora memory.'), {
      target: { value: 'Review Aurora memory and draft the next follow-up.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /github/i }));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(onSave).toHaveBeenCalledWith({
      name: 'Aurora watcher',
      description: 'Tracks Aurora',
      trigger: 'every 1 hour',
      prompt: 'Review Aurora memory and draft the next follow-up.',
      tools: [
        { name: 'memory', icon: 'memory' },
        { name: 'github', icon: 'github' },
      ],
    });
  });

  it('shows delete for custom agents when provided', () => {
    const onDelete = vi.fn();

    render(
      <EditAgentModal
        agent={makeAgent()}
        onSave={vi.fn()}
        onDelete={onDelete}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /delete agent/i }));
    expect(onDelete).toHaveBeenCalledOnce();
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { NewAgentModal } from './NewAgentModal';

describe('NewAgentModal', () => {
  it('creates a local custom agent draft with prompt and selected tools', () => {
    const onCreate = vi.fn();

    render(
      <NewAgentModal
        open
        onClose={vi.fn()}
        onCreate={onCreate}
        onOpenPlayground={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Customer blocker watcher'), {
      target: { value: 'Aurora watcher' },
    });
    fireEvent.change(screen.getByPlaceholderText('Tracks one workstream and drafts the next step.'), {
      target: { value: 'Tracks Aurora follow-ups' },
    });
    fireEvent.change(
      screen.getByPlaceholderText(
        'Review recent memory for company:aurora, extract blockers, and draft the next follow-up with evidence.',
      ),
      {
        target: { value: 'Review Aurora memory and draft the next follow-up with evidence.' },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: /github/i }));
    fireEvent.click(screen.getByRole('button', { name: /create agent/i }));

    expect(onCreate).toHaveBeenCalledWith({
      name: 'Aurora watcher',
      description: 'Tracks Aurora follow-ups',
      prompt: 'Review Aurora memory and draft the next follow-up with evidence.',
      trigger: 'every 1 hour',
      tools: [
        { name: 'memory', icon: 'memory' },
        { name: 'github', icon: 'github' },
      ],
    });
  });

  it('keeps create disabled until the required fields are filled', () => {
    render(
      <NewAgentModal
        open
        onClose={vi.fn()}
        onCreate={vi.fn()}
        onOpenPlayground={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /create agent/i })).toBeDisabled();
  });
});

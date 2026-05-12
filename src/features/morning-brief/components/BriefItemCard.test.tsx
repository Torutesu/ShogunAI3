import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BriefItemCard } from './BriefItemCard';
import type { BriefItem, ContextItem } from '../types';

function makeItem(overrides: Partial<BriefItem> = {}): BriefItem {
  return {
    what: 'Prepare for Q3 review',
    why_now: 'Meeting starts in 30 minutes',
    ...overrides,
  };
}

describe('BriefItemCard', () => {
  it('renders item title (what)', () => {
    const item = makeItem({ what: 'Fix the CI pipeline' });
    render(<BriefItemCard item={item} index={0} onAction={vi.fn()} onContext={vi.fn()} />);
    expect(screen.getByText('Fix the CI pipeline')).toBeInTheDocument();
  });

  it('renders why_now text', () => {
    const item = makeItem({ why_now: 'Deadline is today' });
    render(<BriefItemCard item={item} index={0} onAction={vi.fn()} onContext={vi.fn()} />);
    expect(screen.getByText('Deadline is today')).toBeInTheDocument();
  });

  it('shows numbered prefix "01" for index 0', () => {
    const item = makeItem();
    render(<BriefItemCard item={item} index={0} onAction={vi.fn()} onContext={vi.fn()} />);
    expect(screen.getByText('01')).toBeInTheDocument();
  });

  it('shows numbered prefix "05" for index 4', () => {
    const item = makeItem();
    render(<BriefItemCard item={item} index={4} onAction={vi.fn()} onContext={vi.fn()} />);
    expect(screen.getByText('05')).toBeInTheDocument();
  });

  it('shows numbered prefix "10" for index 9', () => {
    const item = makeItem();
    render(<BriefItemCard item={item} index={9} onAction={vi.fn()} onContext={vi.fn()} />);
    expect(screen.getByText('10')).toBeInTheDocument();
  });

  it('calls onAction with the item when CTA button is clicked', () => {
    const item = makeItem({ next_action: { label: 'Open doc' } });
    const onAction = vi.fn();
    render(<BriefItemCard item={item} index={0} onAction={onAction} onContext={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open doc' }));
    expect(onAction).toHaveBeenCalledOnce();
    expect(onAction).toHaveBeenCalledWith(item);
  });

  it('CTA shows "Next" as default label when next_action has no label', () => {
    const item = makeItem(); // no next_action — makeItem default has none
    render(<BriefItemCard item={item} index={0} onAction={vi.fn()} onContext={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Next' })).toBeInTheDocument();
  });

  it('calls onContext with correct context item when chip clicked', () => {
    const ctx: ContextItem[] = [
      { type: 'document', title: 'Design Spec', uri: 'https://example.com/doc' },
    ];
    const item = makeItem({ related_context: ctx });
    const onContext = vi.fn();
    render(<BriefItemCard item={item} index={0} onAction={vi.fn()} onContext={onContext} />);
    fireEvent.click(screen.getByRole('button', { name: /Design Spec/i }));
    expect(onContext).toHaveBeenCalledOnce();
    expect(onContext).toHaveBeenCalledWith(ctx[0]);
  });

  it('renders up to 3 context chips even when more than 3 provided', () => {
    const ctx: ContextItem[] = [
      { type: 'document', title: 'Doc 1' },
      { type: 'person', title: 'Alice' },
      { type: 'email', title: 'Email thread' },
      { type: 'commit', title: 'Fix bug commit' },
    ];
    const item = makeItem({ related_context: ctx });
    render(<BriefItemCard item={item} index={0} onAction={vi.fn()} onContext={vi.fn()} />);
    const chips = document.querySelectorAll('.mb-chip');
    expect(chips.length).toBe(3);
  });

  it('renders exactly as many chips as provided when 2 context items', () => {
    const ctx: ContextItem[] = [
      { type: 'document', title: 'Doc A' },
      { type: 'calendar', title: 'Meeting' },
    ];
    const item = makeItem({ related_context: ctx });
    render(<BriefItemCard item={item} index={0} onAction={vi.fn()} onContext={vi.fn()} />);
    const chips = document.querySelectorAll('.mb-chip');
    expect(chips.length).toBe(2);
  });

  it('renders no chips section when related_context is empty', () => {
    const item = makeItem({ related_context: [] });
    const { container } = render(<BriefItemCard item={item} index={0} onAction={vi.fn()} onContext={vi.fn()} />);
    expect(container.querySelector('.mb-chips')).not.toBeInTheDocument();
  });

  it('renders no chips section when related_context is not provided', () => {
    const item = makeItem(); // makeItem default has no related_context
    const { container } = render(<BriefItemCard item={item} index={0} onAction={vi.fn()} onContext={vi.fn()} />);
    expect(container.querySelector('.mb-chips')).not.toBeInTheDocument();
  });

  it('renders time_hint when provided', () => {
    const item = makeItem({ time_hint: '09:00' });
    render(<BriefItemCard item={item} index={0} onAction={vi.fn()} onContext={vi.fn()} />);
    expect(screen.getByText('09:00')).toBeInTheDocument();
  });

  it('does not render time_hint element when null', () => {
    const item = makeItem({ time_hint: null });
    const { container } = render(<BriefItemCard item={item} index={0} onAction={vi.fn()} onContext={vi.fn()} />);
    expect(container.querySelector('.mb-time-hint')).not.toBeInTheDocument();
  });
});

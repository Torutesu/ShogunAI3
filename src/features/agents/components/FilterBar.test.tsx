import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FilterBar } from './FilterBar';
import { FILTER_OPTIONS } from '../lib/metadata';

describe('FilterBar', () => {
  const defaultCounts: Record<string, number> = {
    all: 4,
    running: 1,
    scheduled: 2,
    paused: 0,
    error: 1,
  };

  it('renders a button for each FILTER_OPTIONS entry', () => {
    render(<FilterBar active="all" onChange={vi.fn()} counts={defaultCounts} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBe(FILTER_OPTIONS.length);
  });

  it('shows count badge in each pill', () => {
    render(<FilterBar active="all" onChange={vi.fn()} counts={defaultCounts} />);
    expect(screen.getByText('all (4)')).toBeInTheDocument();
    expect(screen.getByText('running (1)')).toBeInTheDocument();
    expect(screen.getByText('scheduled (2)')).toBeInTheDocument();
    expect(screen.getByText('paused (0)')).toBeInTheDocument();
    expect(screen.getByText('error (1)')).toBeInTheDocument();
  });

  it('shows 0 for filter ids missing from counts', () => {
    render(<FilterBar active="all" onChange={vi.fn()} counts={{}} />);
    expect(screen.getByText('all (0)')).toBeInTheDocument();
    expect(screen.getByText('running (0)')).toBeInTheDocument();
  });

  it('calls onChange with correct id when a pill is clicked', () => {
    const onChange = vi.fn();
    render(<FilterBar active="all" onChange={onChange} counts={defaultCounts} />);
    fireEvent.click(screen.getByText('running (1)'));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith('running');
  });

  it('calls onChange with "paused" when paused pill clicked', () => {
    const onChange = vi.fn();
    render(<FilterBar active="all" onChange={onChange} counts={defaultCounts} />);
    fireEvent.click(screen.getByText('paused (0)'));
    expect(onChange).toHaveBeenCalledWith('paused');
  });

  it('calls onChange with "error" when error pill clicked', () => {
    const onChange = vi.fn();
    render(<FilterBar active="all" onChange={onChange} counts={defaultCounts} />);
    fireEvent.click(screen.getByText('error (1)'));
    expect(onChange).toHaveBeenCalledWith('error');
  });

  it('renders a disabled search input', () => {
    render(<FilterBar active="all" onChange={vi.fn()} counts={defaultCounts} />);
    const input = screen.getByRole('textbox');
    expect(input).toBeDisabled();
  });

  it('does not call onChange when search input is clicked (it is disabled)', () => {
    const onChange = vi.fn();
    render(<FilterBar active="all" onChange={onChange} counts={defaultCounts} />);
    fireEvent.click(screen.getByRole('textbox'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

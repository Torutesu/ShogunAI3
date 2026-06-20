import { describe, it, expect, vi } from 'vitest';
import type { ComponentProps } from 'react';
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

  const renderFilterBar = (props: Partial<ComponentProps<typeof FilterBar>> = {}) => render(
    <FilterBar
      active="all"
      onChange={vi.fn()}
      counts={defaultCounts}
      search=""
      onSearchChange={vi.fn()}
      {...props}
    />,
  );

  it('renders a button for each FILTER_OPTIONS entry', () => {
    renderFilterBar();
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBe(FILTER_OPTIONS.length);
  });

  it('shows count badge in each pill', () => {
    renderFilterBar();
    expect(screen.getByText('all (4)')).toBeInTheDocument();
    expect(screen.getByText('running (1)')).toBeInTheDocument();
    expect(screen.getByText('scheduled (2)')).toBeInTheDocument();
    expect(screen.getByText('paused (0)')).toBeInTheDocument();
    expect(screen.getByText('error (1)')).toBeInTheDocument();
  });

  it('shows 0 for filter ids missing from counts', () => {
    renderFilterBar({ counts: {} });
    expect(screen.getByText('all (0)')).toBeInTheDocument();
    expect(screen.getByText('running (0)')).toBeInTheDocument();
  });

  it('calls onChange with correct id when a pill is clicked', () => {
    const onChange = vi.fn();
    renderFilterBar({ onChange });
    fireEvent.click(screen.getByText('running (1)'));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith('running');
  });

  it('calls onChange with "paused" when paused pill clicked', () => {
    const onChange = vi.fn();
    renderFilterBar({ onChange });
    fireEvent.click(screen.getByText('paused (0)'));
    expect(onChange).toHaveBeenCalledWith('paused');
  });

  it('calls onChange with "error" when error pill clicked', () => {
    const onChange = vi.fn();
    renderFilterBar({ onChange });
    fireEvent.click(screen.getByText('error (1)'));
    expect(onChange).toHaveBeenCalledWith('error');
  });

  it('renders an enabled search input', () => {
    renderFilterBar();
    const input = screen.getByRole('textbox');
    expect(input).toBeEnabled();
  });

  it('calls onSearchChange when search input changes', () => {
    const onSearchChange = vi.fn();
    renderFilterBar({ onSearchChange });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'gmail' } });
    expect(onSearchChange).toHaveBeenCalledWith('gmail');
  });
});

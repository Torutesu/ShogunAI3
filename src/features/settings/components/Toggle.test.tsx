import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { Toggle } from './Toggle';

describe('Toggle', () => {
  it('renders a div with class s-toggle', () => {
    const { container } = render(<Toggle on={false} onClick={vi.fn()} />);
    expect(container.querySelector('.s-toggle')).toBeInTheDocument();
  });

  it('renders the knob element inside', () => {
    const { container } = render(<Toggle on={false} onClick={vi.fn()} />);
    expect(container.querySelector('.s-toggle-knob')).toBeInTheDocument();
  });

  it('sets data-on="1" when on=true', () => {
    const { container } = render(<Toggle on={true} onClick={vi.fn()} />);
    const toggle = container.querySelector('.s-toggle');
    expect(toggle).toHaveAttribute('data-on', '1');
  });

  it('sets data-on="0" when on=false', () => {
    const { container } = render(<Toggle on={false} onClick={vi.fn()} />);
    const toggle = container.querySelector('.s-toggle');
    expect(toggle).toHaveAttribute('data-on', '0');
  });

  it('calls onClick when the toggle is clicked', () => {
    const onClick = vi.fn();
    const { container } = render(<Toggle on={false} onClick={onClick} />);
    fireEvent.click(container.querySelector('.s-toggle')!);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('calls onClick when clicked in on state', () => {
    const onClick = vi.fn();
    const { container } = render(<Toggle on={true} onClick={onClick} />);
    fireEvent.click(container.querySelector('.s-toggle')!);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not call onClick when not clicked', () => {
    const onClick = vi.fn();
    render(<Toggle on={false} onClick={onClick} />);
    expect(onClick).not.toHaveBeenCalled();
  });
});

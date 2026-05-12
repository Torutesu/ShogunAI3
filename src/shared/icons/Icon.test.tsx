import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Icon } from './Icon';

describe('Icon', () => {
  it('renders an SVG element', () => {
    const { container } = render(<Icon name="dashboard" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
  });

  it('has correct viewBox', () => {
    const { container } = render(<Icon name="dashboard" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
  });

  it('uses default size of 16', () => {
    const { container } = render(<Icon name="memory" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '16');
    expect(svg).toHaveAttribute('height', '16');
  });

  it('honors size prop', () => {
    const { container } = render(<Icon name="memory" size={32} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '32');
    expect(svg).toHaveAttribute('height', '32');
  });

  it('applies the ico base class', () => {
    const { container } = render(<Icon name="chat" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveClass('ico');
  });

  it('appends extra className', () => {
    const { container } = render(<Icon name="chat" className="dim" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveClass('ico');
    expect(svg).toHaveClass('dim');
  });

  it('renders children for a known name (dashboard has 4 rects)', () => {
    const { container } = render(<Icon name="dashboard" />);
    const svg = container.querySelector('svg');
    expect(svg?.querySelectorAll('rect').length).toBe(4);
  });

  it('renders empty SVG (no children) for unknown name', () => {
    const { container } = render(<Icon name="not-a-real-icon" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg?.children.length).toBe(0);
  });

  it('renders multiple known icons correctly', () => {
    const names = ['memory', 'chat', 'agents', 'work', 'settings', 'search'];
    for (const name of names) {
      const { container } = render(<Icon name={name} />);
      const svg = container.querySelector('svg');
      expect(svg?.children.length).toBeGreaterThan(0);
    }
  });

  it('sets stroke attributes for style', () => {
    const { container } = render(<Icon name="check" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('fill', 'none');
    expect(svg).toHaveAttribute('stroke', 'currentColor');
    expect(svg).toHaveAttribute('stroke-width', '1.5');
  });
});

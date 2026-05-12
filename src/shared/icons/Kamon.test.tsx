import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Kamon } from './Kamon';

describe('Kamon', () => {
  it('renders an img element', () => {
    const { container } = render(<Kamon />);
    const img = container.querySelector('img');
    expect(img).toBeInTheDocument();
  });

  it('src points to KAMON asset path', () => {
    const { container } = render(<Kamon />);
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toContain('/assets/mark.png');
  });

  it('has alt text "Shogun AI"', () => {
    const { container } = render(<Kamon />);
    const img = container.querySelector('img');
    expect(img).toHaveAttribute('alt', 'Shogun AI');
  });

  it('uses default size of 28', () => {
    const { container } = render(<Kamon />);
    const img = container.querySelector('img');
    expect(img).toHaveAttribute('width', '28');
    expect(img).toHaveAttribute('height', '28');
  });

  it('honors size prop', () => {
    const { container } = render(<Kamon size={48} />);
    const img = container.querySelector('img');
    expect(img).toHaveAttribute('width', '48');
    expect(img).toHaveAttribute('height', '48');
  });

  it('applies kamon-img base class', () => {
    const { container } = render(<Kamon />);
    const img = container.querySelector('img');
    expect(img).toHaveClass('kamon-img');
  });

  it('appends extra className', () => {
    const { container } = render(<Kamon className="my-logo" />);
    const img = container.querySelector('img');
    expect(img).toHaveClass('kamon-img');
    expect(img).toHaveClass('my-logo');
  });

  it('accepts color prop without throwing (API compat)', () => {
    expect(() => render(<Kamon color="red" />)).not.toThrow();
  });

  it('is not draggable', () => {
    const { container } = render(<Kamon />);
    const img = container.querySelector('img');
    expect(img).toHaveAttribute('draggable', 'false');
  });
});

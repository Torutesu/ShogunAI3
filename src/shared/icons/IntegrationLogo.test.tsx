import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { IntegrationLogo } from './IntegrationLogo';
import * as integrationConnectors from '@/shared/lib/integration-connectors';

describe('IntegrationLogo — fallback (no connector / no file)', () => {
  it('renders a container div', () => {
    const { container } = render(<IntegrationLogo />);
    expect(container.querySelector('div.s-intg-icon')).toBeInTheDocument();
  });

  it('renders plug icon as fallback when no slug given', () => {
    const { container } = render(<IntegrationLogo />);
    // plug icon renders an svg inside the fallback div
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(container.querySelector('img')).not.toBeInTheDocument();
  });

  it('applies default size to container', () => {
    const { container } = render(<IntegrationLogo />);
    const div = container.querySelector('div.s-intg-icon') as HTMLElement;
    expect(div.style.width).toBe('30px');
    expect(div.style.height).toBe('30px');
  });

  it('honors size prop on container', () => {
    const { container } = render(<IntegrationLogo size={50} />);
    const div = container.querySelector('div.s-intg-icon') as HTMLElement;
    expect(div.style.width).toBe('50px');
    expect(div.style.height).toBe('50px');
  });

  it('is aria-hidden when no title', () => {
    const { container } = render(<IntegrationLogo />);
    const div = container.querySelector('div.s-intg-icon');
    expect(div?.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows title attribute when title prop provided (fallback path)', () => {
    const { container } = render(<IntegrationLogo title="Gmail" />);
    const div = container.querySelector('div.s-intg-icon');
    expect(div).toHaveAttribute('title', 'Gmail');
  });

  it('appends extra className to container', () => {
    const { container } = render(<IntegrationLogo className="extra" />);
    const div = container.querySelector('div.s-intg-icon');
    expect(div).toHaveClass('extra');
  });
});

describe('IntegrationLogo — brand image (slug with matching connector)', () => {
  // Spy on ShogunIntegrationConnectors.getIconFile to return a fake file path
  const spy = vi.spyOn(integrationConnectors.ShogunIntegrationConnectors, 'getIconFile');

  beforeEach(() => {
    spy.mockReturnValue('official/gmail.png');
  });

  afterEach(() => {
    spy.mockReset();
  });

  it('renders a brand img when slug returns a file', () => {
    const { container } = render(<IntegrationLogo slug="gmail" />);
    const img = container.querySelector('img');
    expect(img).toBeInTheDocument();
    expect(img?.getAttribute('src')).toContain('official/gmail.png');
  });

  it('applies brand class to container', () => {
    const { container } = render(<IntegrationLogo slug="gmail" />);
    const div = container.querySelector('div.s-intg-icon');
    expect(div).toHaveClass('s-intg-icon-brand');
  });

  it('sets role="img" and aria-label when title provided', () => {
    const { container } = render(<IntegrationLogo slug="gmail" title="Gmail Logo" />);
    const div = container.querySelector('div.s-intg-icon-brand');
    expect(div).toHaveAttribute('role', 'img');
    expect(div).toHaveAttribute('aria-label', 'Gmail Logo');
  });

  it('falls back aria-label to slug when no title', () => {
    const { container } = render(<IntegrationLogo slug="gmail" />);
    const div = container.querySelector('div.s-intg-icon-brand');
    expect(div).toHaveAttribute('aria-label', 'gmail');
  });

  it('img has empty alt (decorative)', () => {
    const { container } = render(<IntegrationLogo slug="gmail" />);
    const img = container.querySelector('img');
    expect(img).toHaveAttribute('alt', '');
  });
});

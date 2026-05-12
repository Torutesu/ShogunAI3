import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Row } from './Row';

describe('Row', () => {
  it('renders the title', () => {
    render(<Row title="Auto Sync" />);
    expect(screen.getByText('Auto Sync')).toBeInTheDocument();
  });

  it('renders title inside .s-row-title element', () => {
    const { container } = render(<Row title="Auto Sync" />);
    expect(container.querySelector('.s-row-title')).toHaveTextContent('Auto Sync');
  });

  it('renders description when provided', () => {
    render(<Row title="Auto Sync" desc="Syncs every hour" />);
    expect(screen.getByText('Syncs every hour')).toBeInTheDocument();
  });

  it('does not render desc element when desc is omitted', () => {
    const { container } = render(<Row title="Auto Sync" />);
    expect(container.querySelector('.s-row-desc')).not.toBeInTheDocument();
  });

  it('renders children', () => {
    render(<Row title="Theme"><button>Toggle</button></Row>);
    expect(screen.getByRole('button', { name: 'Toggle' })).toBeInTheDocument();
  });

  it('applies s-row class to root', () => {
    const { container } = render(<Row title="Auto Sync" />);
    expect(container.querySelector('.s-row')).toBeInTheDocument();
  });

  it('applies "last" class when last=true', () => {
    const { container } = render(<Row title="Last Row" last={true} />);
    expect(container.querySelector('.s-row')).toHaveClass('last');
  });

  it('does not apply "last" class when last=false', () => {
    const { container } = render(<Row title="Non-Last Row" last={false} />);
    const row = container.querySelector('.s-row');
    expect(row).not.toHaveClass('last');
  });

  it('does not apply "last" class when last is omitted', () => {
    const { container } = render(<Row title="Default" />);
    const row = container.querySelector('.s-row');
    expect(row).not.toHaveClass('last');
  });

  it('accepts ReactNode as title', () => {
    render(<Row title={<span data-testid="icon-title">Icon Title</span>} />);
    expect(screen.getByTestId('icon-title')).toBeInTheDocument();
  });

  it('accepts ReactNode as desc', () => {
    render(<Row title="Foo" desc={<em>Italic description</em>} />);
    expect(screen.getByText('Italic description')).toBeInTheDocument();
  });
});

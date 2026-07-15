import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentCard } from './AgentCard';
import type { AgentDemo } from '../types';

const NOW_MS = 1_700_000_000_000;

function makeAgent(overrides: Partial<AgentDemo> = {}): AgentDemo {
  return {
    id: 'inbox-triage',
    name: 'Inbox Triage',
    icon: 'mail',
    status: 'scheduled',
    trigger: 'every 1 hour',
    triggerSince: '2024-01-01',
    description: 'Triages your inbox automatically.',
    tools: [{ name: 'Gmail', icon: 'mail' }],
    lastRunMs: NOW_MS - 3600_000,
    nextRunMs: NOW_MS + 3600_000,
    recentRuns: [],
    paused: false,
    ...overrides,
  };
}

function defaultProps(agent: AgentDemo, overrides: Record<string, unknown> = {}) {
  return {
    agent,
    expanded: false,
    onToggle: vi.fn(),
    nowMs: NOW_MS,
    onOpenHistory: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    running: false,
    onRunNow: vi.fn(),
    onTogglePause: vi.fn(),
    ...overrides,
  };
}

describe('AgentCard', () => {
  it('renders the agent name', () => {
    const agent = makeAgent({ name: 'Meeting Notes' });
    render(<AgentCard {...defaultProps(agent)} />);
    expect(screen.getByText('Meeting Notes')).toBeInTheDocument();
  });

  it('renders the agent description', () => {
    const agent = makeAgent({ description: 'Takes notes during meetings.' });
    render(<AgentCard {...defaultProps(agent)} />);
    expect(screen.getByText('Takes notes during meetings.')).toBeInTheDocument();
  });

  it('renders tool labels', () => {
    const agent = makeAgent({ tools: [{ name: 'Gmail', icon: 'mail' }, { name: 'Memory', icon: 'memory' }] });
    render(<AgentCard {...defaultProps(agent)} />);
    expect(screen.getByText('Gmail')).toBeInTheDocument();
    expect(screen.getByText('Memory')).toBeInTheDocument();
  });

  it('calls onToggle when the expand button is clicked', () => {
    const agent = makeAgent();
    const onToggle = vi.fn();
    render(<AgentCard {...defaultProps(agent, { onToggle })} />);
    fireEvent.click(screen.getByRole('button', { name: /expand agent/i }));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('shows "Collapse agent" aria-label when expanded=true', () => {
    const agent = makeAgent();
    render(<AgentCard {...defaultProps(agent, { expanded: true })} />);
    expect(screen.getByRole('button', { name: /collapse agent/i })).toBeInTheDocument();
  });

  it('shows trigger section when expanded', () => {
    const agent = makeAgent({ trigger: 'every 1 hour' });
    render(<AgentCard {...defaultProps(agent, { expanded: true })} />);
    expect(screen.getByText('TRIGGER')).toBeInTheDocument();
    expect(screen.getByText(/every 1 hour/)).toBeInTheDocument();
  });

  it('does not show trigger section when collapsed', () => {
    const agent = makeAgent();
    render(<AgentCard {...defaultProps(agent, { expanded: false })} />);
    expect(screen.queryByText('TRIGGER')).not.toBeInTheDocument();
  });

  it('shows "Running…" in Run now button when running=true', () => {
    const agent = makeAgent();
    render(<AgentCard {...defaultProps(agent, { expanded: true, running: true })} />);
    expect(screen.getByText(/Running…/)).toBeInTheDocument();
  });

  it('shows "Run now" in Run now button when running=false', () => {
    const agent = makeAgent();
    render(<AgentCard {...defaultProps(agent, { expanded: true, running: false })} />);
    expect(screen.getByText(/Run now/)).toBeInTheDocument();
  });

  it('Run now button is disabled when running=true', () => {
    const agent = makeAgent();
    render(<AgentCard {...defaultProps(agent, { expanded: true, running: true })} />);
    const btn = screen.getByRole('button', { name: /Running…/i });
    expect(btn).toBeDisabled();
  });

  it('calls onRunNow when "Run now" is clicked', () => {
    const agent = makeAgent();
    const onRunNow = vi.fn();
    render(<AgentCard {...defaultProps(agent, { expanded: true, running: false, onRunNow })} />);
    fireEvent.click(screen.getByText(/Run now/));
    expect(onRunNow).toHaveBeenCalledOnce();
  });

  it('calls onTogglePause when Pause/Resume button clicked', () => {
    const agent = makeAgent({ paused: false });
    const onTogglePause = vi.fn();
    render(<AgentCard {...defaultProps(agent, { expanded: true, onTogglePause })} />);
    fireEvent.click(screen.getByText(/Pause/));
    expect(onTogglePause).toHaveBeenCalledOnce();
  });

  it('shows Resume when agent is paused', () => {
    const agent = makeAgent({ paused: true });
    render(<AgentCard {...defaultProps(agent, { expanded: true })} />);
    expect(screen.getByText(/Resume/)).toBeInTheDocument();
  });

  it('calls onEdit with agent id when Edit clicked', () => {
    const agent = makeAgent({ id: 'daily-digest' });
    const onEdit = vi.fn();
    render(<AgentCard {...defaultProps(agent, { expanded: true, onEdit })} />);
    fireEvent.click(screen.getByText(/Edit/));
    expect(onEdit).toHaveBeenCalledWith('daily-digest');
  });

  it('shows delete for custom agents and calls onDelete', () => {
    const agent = makeAgent({ isCustom: true });
    const onDelete = vi.fn();
    render(<AgentCard {...defaultProps(agent, { expanded: true, onDelete })} />);
    fireEvent.click(screen.getByText(/Delete/));
    expect(onDelete).toHaveBeenCalledWith('inbox-triage');
  });

  it('surfaces error status when last run has level=error', () => {
    const agent = makeAgent({
      status: 'scheduled',
      recentRuns: [{
        id: 'r1', atMs: NOW_MS - 1000, t: '10:00', msg: 'Failed',
        level: 'error', durationMs: 100, tools: [], input: '', output: '',
        memoryTouched: [],
      }],
    });
    render(<AgentCard {...defaultProps(agent)} />);
    // The status sub-line should reflect "error"
    expect(screen.getByText(/error/)).toBeInTheDocument();
  });
});

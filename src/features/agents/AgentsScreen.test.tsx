import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentsScreen } from './AgentsScreen';

const runRuntimeActionMock = vi.fn();
const pushToastMock = vi.fn();
const invokeMock = vi.fn();
const openChatWithSeedMock = vi.fn();

vi.mock('@/shared/ipc/runtime-actions', () => ({
  runRuntimeAction: (...args: unknown[]) => runRuntimeActionMock(...args),
}));

vi.mock('@/shared/ipc/ipc-client', () => ({
  ShogunIpcClient: {
    createIpcClient: () => ({
      invoke: (...args: unknown[]) => invokeMock(...args),
    }),
  },
}));

vi.mock('@/shared/context/chat-composer-seed', () => ({
  openChatWithSeed: (...args: unknown[]) => openChatWithSeedMock(...args),
}));

describe('AgentsScreen', () => {
  beforeEach(() => {
    runRuntimeActionMock.mockReset();
    pushToastMock.mockReset();
    invokeMock.mockReset();
    openChatWithSeedMock.mockReset();
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'settings.load') {
        return Promise.resolve({
          ok: true,
          data: {
            settings: {
              sections: {
                agents: {
                  customAgents: [
                    {
                      id: 'custom-test-agent',
                      name: 'Aurora watcher',
                      icon: 'memory',
                      status: 'scheduled',
                      trigger: 'every 1 hour',
                      triggerSince: '2026-06-30',
                      description: 'Tracks Aurora follow-ups',
                      tools: [{ name: 'memory', icon: 'memory' }],
                      lastRunMs: null,
                      nextRunMs: null,
                      recentRuns: [],
                      paused: false,
                      isCustom: true,
                      prompt: 'Review Aurora memory and draft the next follow-up with evidence.',
                    },
                  ],
                  customAgentOverrides: {},
                },
                privacy: {
                  allowChatServerMemoryAssembly: true,
                },
              },
            },
          },
        });
      }
      if (actionKey === 'settings.save') {
        return Promise.resolve({ ok: true, data: { settings: { sections: {} } } });
      }
      if (actionKey === 'agent.run_now') {
        return Promise.resolve({
          ok: true,
          data: {
            agentId: 'custom-test-agent',
            summary: 'Draft created for Aurora watcher',
            content: '# Draft\n\nFollow up with Aurora.',
          },
        });
      }
      return Promise.resolve({ ok: true, data: {} });
    });
    invokeMock.mockImplementation((command: string, payload?: any) => {
      if (command === 'mcp_setup_list_tools') {
        return Promise.resolve({
          ok: true,
          data: {
            total: 1,
            sections: [
              {
                groupId: 'context',
                count: 1,
                items: [
                  { name: 'shogun.search_context', description: 'Search shared context.', sampleArgs: { query: 'unlikely-query-token', limit: 3 } },
                ],
              },
            ],
          },
        });
      }
      if (command === 'mcp_setup_preview_tool') {
        return Promise.resolve({
          ok: true,
          data: {
            text: JSON.stringify(payload?.args || {}),
          },
        });
      }
      return Promise.resolve({ ok: true, data: {} });
    });
    (window as any).SHOGUN_RUNTIME = {
      pushToast: pushToastMock,
      setActiveScreen: vi.fn(),
    };
    window.localStorage.clear();
  });

  it('runs a custom agent through the native agent.run_now action', async () => {
    render(<AgentsScreen />);

    const card = await screen.findByText('Aurora watcher');
    const cardRoot = card.closest('[id^="agent-card-"]');
    expect(cardRoot).not.toBeNull();

    fireEvent.click(within(cardRoot as HTMLElement).getByRole('button', { name: /expand agent/i }));
    fireEvent.click(within(cardRoot as HTMLElement).getByRole('button', { name: /run now/i }));

    await waitFor(() => {
      expect(runRuntimeActionMock).toHaveBeenCalledWith(
        'agent.run_now',
        {
          agentId: expect.stringMatching(/^custom-/),
          memoryAssembly: { query: 'Aurora watcher', limit: 14, semantic: true },
        },
        { silentError: true },
      );
    });

    await waitFor(() => {
      expect(within(cardRoot as HTMLElement).getByText('Draft created for Aurora watcher')).toBeInTheDocument();
    });
    expect(pushToastMock).toHaveBeenCalledWith(
      'Draft created for Aurora watcher',
      'success',
      expect.objectContaining({
        action: expect.objectContaining({
          label: 'Open in Chat',
          onClick: expect.any(Function),
        }),
      }),
    );
    const toastAction = pushToastMock.mock.calls.find(
      ([message]) => message === 'Draft created for Aurora watcher',
    )?.[2]?.action;
    expect(toastAction).toBeTruthy();
    toastAction.onClick();
    expect(openChatWithSeedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        newChat: true,
        assembleMemory: true,
        memoryAssemblyQuery: 'Aurora watcher',
        text: expect.stringContaining('Agent output:\n# Draft\n\nFollow up with Aurora.'),
      }),
    );
    expect(screen.getAllByText('Draft created for Aurora watcher').length).toBeGreaterThan(0);
  });

  it('adds native agent run events into live activity', async () => {
    render(<AgentsScreen />);

    window.dispatchEvent(
      new CustomEvent('shogun-agents-runs-changed', {
        detail: {
          agentId: 'custom-test-agent',
          atMs: 1710000000000,
          ok: false,
          summary: 'Draft failed for Aurora watcher',
          source: 'custom_agent_event:memory',
        },
      }),
    );

    await waitFor(() => {
      expect(screen.getAllByText('Draft failed for Aurora watcher').length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText('live').length).toBeGreaterThan(0);
    expect(screen.getByText('event:memory')).toBeInTheDocument();
  });

  it('opens the MCP console drawer and runs a read-only preview', async () => {
    render(<AgentsScreen />);

    fireEvent.click(screen.getByRole('button', { name: /mcp console/i }));

    expect(await screen.findByText('Read-only SHOGUN MCP console')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Run preview' })[0] as HTMLElement);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('mcp_setup_preview_tool', {
        toolName: 'shogun.search_context',
        args: { query: 'unlikely-query-token', limit: 3 },
      });
    });

    expect(await screen.findByText('{"query":"unlikely-query-token","limit":3}')).toBeInTheDocument();
  });

  it('refreshes agent settings from desktop events before running a custom agent', async () => {
    let allowServerMemoryAssembly = true;
    let customAgentName = 'Aurora watcher';

    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'settings.load') {
        return Promise.resolve({
          ok: true,
          data: {
            settings: {
              sections: {
                agents: {
                  customAgents: [
                    {
                      id: 'custom-test-agent',
                      name: customAgentName,
                      icon: 'memory',
                      status: 'scheduled',
                      trigger: 'every 1 hour',
                      triggerSince: '2026-06-30',
                      description: 'Tracks Aurora follow-ups',
                      tools: [{ name: 'memory', icon: 'memory' }],
                      lastRunMs: null,
                      nextRunMs: null,
                      recentRuns: [],
                      paused: false,
                      isCustom: true,
                      prompt: 'Review Aurora memory and draft the next follow-up with evidence.',
                    },
                  ],
                  customAgentOverrides: {},
                },
                privacy: {
                  allowChatServerMemoryAssembly: allowServerMemoryAssembly,
                },
              },
            },
          },
        });
      }
      if (actionKey === 'settings.save') {
        return Promise.resolve({ ok: true, data: { settings: { sections: {} } } });
      }
      if (actionKey === 'agent.run_now') {
        return Promise.resolve({
          ok: true,
          data: {
            agentId: 'custom-test-agent',
            summary: 'Draft created for refreshed agent',
            content: '# Draft\n\nFollow up with refreshed settings.',
          },
        });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(<AgentsScreen />);

    await screen.findByText('Aurora watcher');

    allowServerMemoryAssembly = false;
    customAgentName = 'Aurora watcher refreshed';
    window.dispatchEvent(new CustomEvent('shogun-settings-refresh'));

    const refreshedCard = await screen.findByText('Aurora watcher refreshed');
    const cardRoot = refreshedCard.closest('[id^="agent-card-"]');
    expect(cardRoot).not.toBeNull();

    fireEvent.click(within(cardRoot as HTMLElement).getByRole('button', { name: /expand agent/i }));
    fireEvent.click(within(cardRoot as HTMLElement).getByRole('button', { name: /run now/i }));

    await waitFor(() => {
      expect(runRuntimeActionMock).toHaveBeenCalledWith(
        'agent.run_now',
        {
          agentId: expect.stringMatching(/^custom-/),
          memoryAssembly: null,
        },
        { silentError: true },
      );
    });
  });
});

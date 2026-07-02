import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const openChatWithSeedMock = vi.fn();
const jumpToMemorySearchMock = vi.fn();
const jumpToMemoryTimelineMock = vi.fn();
const openMeetingDetailMock = vi.fn();
const openNativeDetailForEntityIdMock = vi.fn();
const focusEntityMock = vi.fn();
const focusAiFieldMock = vi.fn();
const focusActionTraceMock = vi.fn();
const openQueueArtifactInActionsMock = vi.fn();

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

vi.mock('@/shared/context/context-target-navigation', () => ({
  jumpToMemorySearch: (...args: unknown[]) => jumpToMemorySearchMock(...args),
  jumpToMemoryTimeline: (...args: unknown[]) => jumpToMemoryTimelineMock(...args),
  openMeetingDetail: (...args: unknown[]) => openMeetingDetailMock(...args),
  openNativeDetailForEntityId: (...args: unknown[]) => openNativeDetailForEntityIdMock(...args),
}));

vi.mock('@/shared/context/entity-focus', () => ({
  focusEntity: (...args: unknown[]) => focusEntityMock(...args),
}));

vi.mock('@/shared/context/ai-field-focus', () => ({
  focusAiField: (...args: unknown[]) => focusAiFieldMock(...args),
}));

vi.mock('@/shared/context/action-trace-focus', () => ({
  focusActionTrace: (...args: unknown[]) => focusActionTraceMock(...args),
}));

vi.mock('@/shared/context/open-queue-artifact', () => ({
  openQueueArtifactInActions: (...args: unknown[]) => openQueueArtifactInActionsMock(...args),
}));

import { McpToolConsolePanel } from './McpToolConsolePanel';

describe('McpToolConsolePanel', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    openChatWithSeedMock.mockReset();
    jumpToMemorySearchMock.mockReset();
    jumpToMemoryTimelineMock.mockReset();
    openMeetingDetailMock.mockReset();
    openNativeDetailForEntityIdMock.mockReset();
    focusEntityMock.mockReset();
    focusAiFieldMock.mockReset();
    focusActionTraceMock.mockReset();
    openQueueArtifactInActionsMock.mockReset();
    (window as any).SHOGUN_RUNTIME = {
      setActiveScreen: vi.fn(),
      pushToast: vi.fn(),
    };
  });

  it('runs a preview and opens Chat with the preview context', async () => {
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
                  {
                    name: 'shogun.search_context',
                    description: 'Search shared context.',
                    sampleArgs: { query: 'unlikely-query-token', limit: 3 },
                  },
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
            text: '{"items":[],"total":0}',
          },
        });
      }
      return Promise.resolve({ ok: true, data: payload || {} });
    });

    render(<McpToolConsolePanel />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Run edited args' })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run edited args' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Ask Chat' })).toBeEnabled();
    });
    expect(screen.getByText((content) => content.includes('"items":[],"total":0'))).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Ask Chat' }));

    expect(openChatWithSeedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        assembleMemory: false,
        newChat: true,
        text: expect.stringContaining('Tool: shogun.search_context'),
      }),
    );
    expect(openChatWithSeedMock.mock.calls[0]?.[0]?.text).toContain('{"items":[],"total":0}');
  });

  it('opens supported read-only MCP tools in native app views', async () => {
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
                  {
                    name: 'shogun.search_context',
                    description: 'Search shared context.',
                    sampleArgs: { query: 'aurora blockers', limit: 3 },
                  },
                ],
              },
            ],
          },
        });
      }
      return Promise.resolve({ ok: true, data: payload || {} });
    });

    render(<McpToolConsolePanel />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open Memory Search' })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open Memory Search' }));

    expect(jumpToMemorySearchMock).toHaveBeenCalledWith('aurora blockers', 'search');
  });

  it('routes owner/entity context tools to the closest native application surface', async () => {
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
                  {
                    name: 'shogun.owner_context_summary',
                    description: 'Read owner context.',
                    sampleArgs: { ownerEntityId: 'investor:sequoia', limit: 3 },
                  },
                ],
              },
            ],
          },
        });
      }
      return Promise.resolve({ ok: true, data: payload || {} });
    });

    render(<McpToolConsolePanel />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open Related Surface' })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open Related Surface' }));

    expect(focusEntityMock).toHaveBeenCalledWith('investor:sequoia');
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('fundraising');
  });

  it('routes recent context and meeting list tools back into desktop surfaces', async () => {
    invokeMock.mockImplementation((command: string, payload?: any) => {
      if (command === 'mcp_setup_list_tools') {
        return Promise.resolve({
          ok: true,
          data: {
            total: 1,
            sections: [
              {
                groupId: 'meetings',
                count: 1,
                items: [
                  {
                    name: 'shogun.meetings_list',
                    description: 'List meetings.',
                    sampleArgs: { limit: 3 },
                  },
                ],
              },
            ],
          },
        });
      }
      return Promise.resolve({ ok: true, data: payload || {} });
    });

    const firstRender = render(<McpToolConsolePanel />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open Meetings' })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open Meetings' }));
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('meetings');
    firstRender.unmount();

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
                  {
                    name: 'shogun.get_recent_context',
                    description: 'Get recent shared context.',
                    sampleArgs: { limit: 3 },
                  },
                ],
              },
            ],
          },
        });
      }
      return Promise.resolve({ ok: true, data: payload || {} });
    });

    render(<McpToolConsolePanel title="Reloaded" />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open Home' })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open Home' }));
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('home');
  });

  it('opens concrete preview results when a preview returns timeline hits', async () => {
    invokeMock.mockImplementation((command: string, payload?: any) => {
      if (command === 'mcp_setup_list_tools') {
        return Promise.resolve({
          ok: true,
          data: {
            total: 1,
            sections: [
              {
                groupId: 'memory',
                count: 1,
                items: [
                  {
                    name: 'shogun.memory_search',
                    description: 'Search memory.',
                    sampleArgs: { query: 'aurora', limit: 3 },
                  },
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
            text: JSON.stringify({
              hits: [
                {
                  id: 'mem-42',
                  title: 'Aurora note',
                  content_type: 'memory',
                },
              ],
              total: 1,
            }),
          },
        });
      }
      return Promise.resolve({ ok: true, data: payload || {} });
    });

    render(<McpToolConsolePanel />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Run preview' })[0]).toBeEnabled();
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Run preview' })[0] as HTMLElement);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open memory · Aurora note' })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open memory · Aurora note' }));

    expect(jumpToMemoryTimelineMock).toHaveBeenCalledWith({
      memoryId: 'mem-42',
      query: 'Aurora note',
      view: 'river',
    });
  });

  it('opens concrete preview results when a preview returns AI fields', async () => {
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
                  {
                    name: 'shogun.search_context',
                    description: 'Search shared context.',
                    sampleArgs: { query: 'security blocker', limit: 3 },
                  },
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
            text: JSON.stringify({
              timeline: { hits: [], total: 0 },
              aiFields: {
                items: [
                  {
                    id: 'af-1',
                    ownerEntityId: 'company:aurora',
                  },
                ],
                total: 1,
              },
              actions: { items: [], total: 0 },
              queueArtifacts: { items: [], total: 0 },
            }),
          },
        });
      }
      return Promise.resolve({ ok: true, data: payload || {} });
    });

    render(<McpToolConsolePanel />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Run preview' })[0]).toBeEnabled();
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Run preview' })[0] as HTMLElement);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open AI field · af-1' })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open AI field · af-1' }));

    expect(focusAiFieldMock).toHaveBeenCalledWith('af-1');
    expect(focusEntityMock).toHaveBeenCalledWith('company:aurora');
    expect((window as any).SHOGUN_RUNTIME.setActiveScreen).toHaveBeenCalledWith('ai_fields');
  });

  it('lists multiple preview deep-link candidates when several results are available', async () => {
    invokeMock.mockImplementation((command: string, payload?: any) => {
      if (command === 'mcp_setup_list_tools') {
        return Promise.resolve({
          ok: true,
          data: {
            total: 1,
            sections: [
              {
                groupId: 'memory',
                count: 1,
                items: [
                  {
                    name: 'shogun.memory_search',
                    description: 'Search memory.',
                    sampleArgs: { query: 'aurora', limit: 3 },
                  },
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
            text: JSON.stringify({
              hits: [
                {
                  id: 'mem-42',
                  title: 'Aurora note',
                  content_type: 'memory',
                },
                {
                  id: 'meeting:mtg-7',
                  title: 'Aurora sync',
                  content_type: 'meeting',
                },
              ],
              total: 2,
            }),
          },
        });
      }
      return Promise.resolve({ ok: true, data: payload || {} });
    });

    render(<McpToolConsolePanel />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Run preview' })[0]).toBeEnabled();
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Run preview' })[0] as HTMLElement);

    expect(await screen.findByText('Preview result deep links')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open meeting · Aurora sync' }));

    expect(openMeetingDetailMock).toHaveBeenCalledWith('mtg-7');
  });
});

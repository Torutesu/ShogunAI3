import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const invokeMock = vi.fn();

vi.mock('@/shared/ipc/ipc-client', () => ({
  ShogunIpcClient: {
    createIpcClient: () => ({
      invoke: (...args: unknown[]) => invokeMock(...args),
    }),
  },
}));

import { McpClaudeSection } from './McpClaudeSection';

describe('McpClaudeSection', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    (window as any).SHOGUN_RUNTIME = {
      pushToast: vi.fn(),
    };
  });

  it('loads Claude Desktop MCP status and verifies the configured bridge', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'mcp_setup_detect') {
        return Promise.resolve({
          ok: true,
          data: {
            claudeConfigPath: '/Users/test/Library/Application Support/Claude/claude_desktop_config.json',
            claudeConfigExists: true,
            claudeInstalled: true,
            binaryPath: '/Applications/SHOGUN.app/Contents/MacOS/shogun-mcp',
            binaryFound: true,
            shogunConfigured: true,
            configuredCommand: '/Applications/SHOGUN.app/Contents/MacOS/shogun-mcp',
            configValid: true,
          },
        });
      }
      if (command === 'mcp_setup_list_tools') {
        return Promise.resolve({
          ok: true,
          data: {
            total: 3,
            sections: [
              {
                groupId: 'context',
                count: 2,
                items: [
                  { name: 'shogun.search_context', description: 'Search shared context.', sampleArgs: { query: 'unlikely-query-token', limit: 3 } },
                  { name: 'shogun.get_recent_context', description: 'Read recent shared context.', sampleArgs: { limit: 3 } },
                ],
              },
              {
                groupId: 'meetings',
                count: 1,
                items: [
                  { name: 'shogun.meetings_list', description: 'List meetings.', sampleArgs: { limit: 3 } },
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
      if (command === 'mcp_setup_verify') {
        return Promise.resolve({
          ok: true,
          data: {
            ok: true,
            command: '/Applications/SHOGUN.app/Contents/MacOS/shogun-mcp',
          },
        });
      }
      if (command === 'mcp_setup_complete') {
        return Promise.resolve({ ok: true, data: { complete: true } });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(<McpClaudeSection />);

    expect(await screen.findByText('SHOGUN configured')).toBeInTheDocument();
    expect(screen.getByDisplayValue('/Applications/SHOGUN.app/Contents/MacOS/shogun-mcp')).toBeInTheDocument();
    expect(await screen.findByText('3 tools available across meetings, memory, context, and kioku.')).toBeInTheDocument();
    expect(screen.getAllByText('shogun.search_context').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Editable preview args (JSON object)')).toHaveValue('{\n  "query": "unlikely-query-token",\n  "limit": 3\n}');
    fireEvent.click(screen.getAllByRole('button', { name: 'Run preview' })[0] as HTMLElement);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('mcp_setup_preview_tool', {
        toolName: 'shogun.search_context',
        args: { query: 'unlikely-query-token', limit: 3 },
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('mcp_setup_verify', {});
    });

    expect(await screen.findByText('Verified')).toBeInTheDocument();
    expect(screen.getByText('{"items":[],"total":0}')).toBeInTheDocument();
    expect((window as any).SHOGUN_RUNTIME.pushToast).toHaveBeenCalledWith(
      'Claude Desktop MCP connection looks good',
      'success',
    );
  });

  it('runs the selected MCP preview with edited JSON args', async () => {
    invokeMock.mockImplementation((command: string, payload?: any) => {
      if (command === 'mcp_setup_detect') {
        return Promise.resolve({
          ok: true,
          data: {
            claudeConfigPath: '/Users/test/Library/Application Support/Claude/claude_desktop_config.json',
            claudeConfigExists: true,
            claudeInstalled: true,
            binaryPath: '/Applications/SHOGUN.app/Contents/MacOS/shogun-mcp',
            binaryFound: true,
            shogunConfigured: true,
            configuredCommand: '/Applications/SHOGUN.app/Contents/MacOS/shogun-mcp',
            configValid: true,
          },
        });
      }
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

    render(<McpClaudeSection />);

    const argsEditor = await screen.findByLabelText('Editable preview args (JSON object)');
    fireEvent.change(argsEditor, {
      target: {
        value: '{\n  "query": "board deck",\n  "limit": 2\n}',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run edited args' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('mcp_setup_preview_tool', {
        toolName: 'shogun.search_context',
        args: { query: 'board deck', limit: 2 },
      });
    });

    expect(await screen.findByText('{"query":"board deck","limit":2}')).toBeInTheDocument();
  });

  it('saves a repaired Claude Desktop config with the edited binary path', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'mcp_setup_detect') {
        return Promise.resolve({
          ok: true,
          data: {
            claudeConfigPath: '/Users/test/Library/Application Support/Claude/claude_desktop_config.json',
            claudeConfigExists: false,
            claudeInstalled: true,
            binaryPath: null,
            binaryFound: false,
            shogunConfigured: false,
            configuredCommand: null,
            configValid: true,
          },
        });
      }
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
      if (command === 'mcp_setup_write_config') {
        return Promise.resolve({
          ok: true,
          data: {
            written: true,
            configPath: '/Users/test/Library/Application Support/Claude/claude_desktop_config.json',
            backupPath: null,
            command: '/tmp/shogun-mcp',
          },
        });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(<McpClaudeSection />);

    const input = await screen.findByPlaceholderText('/path/to/shogun-mcp');
    fireEvent.change(input, {
      target: { value: '/tmp/shogun-mcp' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save to Claude' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('mcp_setup_write_config', {
        binaryPath: '/tmp/shogun-mcp',
      });
    });

    expect((window as any).SHOGUN_RUNTIME.pushToast).toHaveBeenCalledWith(
      'Saved SHOGUN MCP config for Claude Desktop',
      'success',
    );
  });
});

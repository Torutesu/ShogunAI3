import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { PaneIntegrations } from './PaneIntegrations';
import { SettingsHydrationContext } from '../types';

const runRuntimeActionMock = vi.fn();

vi.mock('@/shared/ipc/runtime-actions', () => ({
  runRuntimeAction: (...args: unknown[]) => runRuntimeActionMock(...args),
}));

vi.mock('./PaneIntegrations/AuditLogSection', () => ({
  AuditLogSection: () => <div data-testid="audit-log-section" />,
}));

vi.mock('./PaneIntegrations/McpClaudeSection', () => ({
  McpClaudeSection: () => <div data-testid="mcp-claude-section" />,
}));

vi.mock('./PaneIntegrations/OAuthNotConfiguredModal', () => ({
  OAuthNotConfiguredModal: ({ onClose }: { onClose: () => void }) => (
    <button type="button" onClick={onClose}>OAuth not configured</button>
  ),
}));

function renderPane(options?: {
  sections?: Record<string, any>;
  refreshSections?: (() => Promise<void>) | null;
  executeActionImpl?: (key: string, payload?: any, options?: any) => Promise<any>;
}) {
  const executeAction = vi.fn(
    options?.executeActionImpl || (async () => ({ ok: true, data: {} })),
  );
  (window as any).SHOGUN_RUNTIME = {
    executeAction,
    requestWriteAction: vi.fn(),
    pushToast: vi.fn(),
  };
  render(
    <SettingsHydrationContext.Provider
      value={{
        sections: options?.sections || {},
        refreshSections: options?.refreshSections || null,
      }}
    >
      <PaneIntegrations />
    </SettingsHydrationContext.Provider>,
  );
  return { executeAction, pushToast: (window as any).SHOGUN_RUNTIME.pushToast as ReturnType<typeof vi.fn> };
}

describe('PaneIntegrations', () => {
  beforeEach(() => {
    runRuntimeActionMock.mockReset();
    localStorage.clear();
    delete (window as any).SHOGUN_RUNTIME;
  });

  it('reloads integration settings when the desktop settings refresh event is dispatched', async () => {
    const refreshSections = vi.fn(async () => {});
    let integrationSettings = {
      googleCalendarAutoSync: false,
      googleCalendarSyncIntervalMins: 15,
    };

    const { executeAction } = renderPane({
      sections: {},
      refreshSections,
      executeActionImpl: async (key: string, payload?: any) => {
        if (key === 'settings.load') {
          return {
            ok: true,
            data: {
              settings: {
                sections: {
                  integrations: integrationSettings,
                },
              },
            },
          };
        }
        if (key === 'integrations.credentials_status') {
          return {
            ok: true,
            data: { configured: false, tokenRefreshReady: false, provider: payload?.provider || '' },
          };
        }
        return { ok: true, data: {} };
      },
    });

    const autoSyncCheckbox = await screen.findByLabelText('Background sync to Memory');
    const intervalInput = screen.getByRole('spinbutton');

    expect(autoSyncCheckbox).not.toBeChecked();
    expect(intervalInput).toHaveValue(15);

    integrationSettings = {
      googleCalendarAutoSync: true,
      googleCalendarSyncIntervalMins: 30,
    };

    fireEvent(
      window,
      new CustomEvent('shogun-settings-refresh', {
        detail: { reason: 'test-integrations-refresh' },
      }),
    );

    await waitFor(() => {
      expect(autoSyncCheckbox).toBeChecked();
      expect(intervalInput).toHaveValue(30);
    });

    expect(refreshSections).toHaveBeenCalled();
    expect(executeAction).toHaveBeenCalledWith(
      'settings.load',
      {},
      expect.objectContaining({ silentError: true }),
    );
  });

  it('refreshes the Gmail status immediately after a successful OAuth connect', async () => {
    let gmailConfigured = false;

    runRuntimeActionMock.mockImplementation((actionKey: string, payload?: any) => {
      if (actionKey === 'oauth.google.start') {
        if (payload?.provider === 'gmail') gmailConfigured = true;
        return Promise.resolve({ ok: true, data: { started: true } });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    const { executeAction, pushToast } = renderPane({
      sections: {
        integrations: {
          googleCalendarAutoSync: false,
          googleCalendarSyncIntervalMins: 15,
        },
      },
      executeActionImpl: async (key: string, payload?: any) => {
        if (key === 'settings.load') {
          return {
            ok: true,
            data: {
              settings: {
                sections: {
                  integrations: {
                    googleCalendarAutoSync: false,
                    googleCalendarSyncIntervalMins: 15,
                  },
                },
              },
            },
          };
        }
        if (key === 'integrations.credentials_status') {
          const provider = String(payload?.provider || '');
          return {
            ok: true,
            data: {
              configured: provider === 'gmail' ? gmailConfigured : false,
              tokenRefreshReady: provider === 'gmail' ? gmailConfigured : false,
            },
          };
        }
        return { ok: true, data: {} };
      },
    });

    const gmailHeading = await screen.findByText('Gmail');
    const gmailCard = gmailHeading.closest('.s-card');
    expect(gmailCard).not.toBeNull();

    await waitFor(() => {
      expect(within(gmailCard as HTMLElement).getByText('No token · import via agent')).toBeInTheDocument();
    });

    fireEvent.click(within(gmailCard as HTMLElement).getByRole('button', { name: /Connect/ }));

    await waitFor(() => {
      expect(runRuntimeActionMock).toHaveBeenCalledWith(
        'oauth.google.start',
        { provider: 'gmail' },
        { silentError: true },
      );
    });

    await waitFor(() => {
      expect(within(gmailCard as HTMLElement).getByText('Keychain · configured')).toBeInTheDocument();
      expect(within(gmailCard as HTMLElement).getByText('Refresh: client+refresh token')).toBeInTheDocument();
    });

    expect(pushToast).toHaveBeenCalledWith('Connected to Gmail', 'success');
    expect(executeAction).toHaveBeenCalledWith(
      'integrations.credentials_status',
      { provider: 'gmail' },
      expect.objectContaining({ silentError: true }),
    );
  });
});

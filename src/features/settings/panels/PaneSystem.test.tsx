import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PaneSystem } from './PaneSystem';
import { SettingsHydrationContext } from '../types';

function mountPane(
  sections: Record<string, any>,
  executeActionImpl?: (key: string, payload?: any, options?: any) => Promise<any>,
) {
  const executeAction = vi.fn(
    executeActionImpl
      || (async (key: string) => {
        if (key === 'notifications.status') {
          return { ok: true, data: { granted: true, promptable: false, state: 'Granted' } };
        }
        return { ok: true, data: {} };
      }),
  );
  const pushToast = vi.fn();
  (window as any).SHOGUN_RUNTIME = {
    executeAction,
    requestWriteAction: vi.fn(),
    pushToast,
  };
  render(
    <SettingsHydrationContext.Provider value={{ sections, refreshSections: null }}>
      <PaneSystem />
    </SettingsHydrationContext.Provider>,
  );
  return { executeAction, pushToast };
}

describe('PaneSystem', () => {
  beforeEach(() => {
    delete (window as any).SHOGUN_RUNTIME;
  });

  it('loads native notification status and shows enabled state', async () => {
    const { executeAction } = mountPane({
      system: { startup: true, notif: true, sound: false },
    });

    await waitFor(() => {
      expect(executeAction).toHaveBeenCalledWith(
        'notifications.status',
        {},
        expect.objectContaining({ silentError: true }),
      );
    });

    expect(await screen.findByText('Enabled')).toBeInTheDocument();
    expect(
      screen.getByText('macOS notifications are enabled (Granted).'),
    ).toBeInTheDocument();
  });

  it('requests native notification permission from the system pane', async () => {
    const { executeAction, pushToast } = mountPane(
      { system: { startup: true, notif: true, sound: false } },
      async (key: string) => {
        if (key === 'notifications.status') {
          return { ok: true, data: { granted: false, promptable: true, state: 'Prompt' } };
        }
        if (key === 'notifications.request') {
          return { ok: true, data: { granted: true, state: 'Granted' } };
        }
        return { ok: true, data: {} };
      },
    );

    const button = await screen.findByRole('button', { name: 'Enable Notifications' });
    fireEvent.click(button);

    await waitFor(() => {
      expect(executeAction).toHaveBeenCalledWith(
        'notifications.request',
        {},
        expect.objectContaining({ silentError: true }),
      );
    });

    expect(pushToast).toHaveBeenCalledWith('Notifications enabled', 'success');
    expect(await screen.findByText('Enabled')).toBeInTheDocument();
  });

  it('opens macOS notification settings when permission is denied and not promptable', async () => {
    const { executeAction, pushToast } = mountPane(
      { system: { startup: true, notif: true, sound: false } },
      async (key: string) => {
        if (key === 'notifications.status') {
          return { ok: true, data: { granted: false, promptable: false, state: 'Denied' } };
        }
        if (key === 'permissions.manage') {
          return { ok: true, data: { opened: true } };
        }
        return { ok: true, data: {} };
      },
    );

    const button = await screen.findByRole('button', { name: 'Open Notification Settings' });
    fireEvent.click(button);

    await waitFor(() => {
      expect(executeAction).toHaveBeenCalledWith(
        'permissions.manage',
        { target: 'notifications', source: 'settings.system.notifications' },
        expect.objectContaining({ silentError: true }),
      );
    });

    expect(pushToast).toHaveBeenCalledWith('Opened macOS notification settings', 'info');
  });
});

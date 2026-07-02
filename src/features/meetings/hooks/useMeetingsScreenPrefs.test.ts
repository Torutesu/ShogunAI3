import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useMeetingsScreenPrefs } from './useMeetingsScreenPrefs';

const runRuntimeActionMock = vi.fn();

vi.mock('@/shared/ipc/runtime-actions', () => ({
  runRuntimeAction: (...args: unknown[]) => runRuntimeActionMock(...args),
}));

function settingsResponse({
  allowChatServerMemoryAssembly = true,
  autoStartOnCalendar = false,
}: {
  allowChatServerMemoryAssembly?: boolean;
  autoStartOnCalendar?: boolean;
}) {
  return {
    ok: true,
    data: {
      settings: {
        sections: {
          privacy: {
            allowChatServerMemoryAssembly,
          },
          meetings: {
            autoStartOnCalendar,
          },
        },
      },
    },
  };
}

describe('useMeetingsScreenPrefs', () => {
  beforeEach(() => {
    runRuntimeActionMock.mockReset();
  });

  it('reloads meetings prefs from desktop settings refresh and privacy events', async () => {
    let allowChatServerMemoryAssembly = true;
    let autoStartOnCalendar = false;

    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'settings.load') {
        return Promise.resolve(settingsResponse({
          allowChatServerMemoryAssembly,
          autoStartOnCalendar,
        }));
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    const { result } = renderHook(() => useMeetingsScreenPrefs());

    await waitFor(() => {
      expect(result.current.allowServerMemoryAssembly).toBe(true);
      expect(result.current.autoStartOnCalendar).toBe(false);
      expect(result.current.autoStartOnCalendarRef.current).toBe(false);
    });

    allowChatServerMemoryAssembly = false;
    autoStartOnCalendar = true;

    act(() => {
      window.dispatchEvent(new CustomEvent('shogun-settings-refresh'));
    });

    await waitFor(() => {
      expect(result.current.allowServerMemoryAssembly).toBe(false);
      expect(result.current.autoStartOnCalendar).toBe(true);
      expect(result.current.autoStartOnCalendarRef.current).toBe(true);
    });

    allowChatServerMemoryAssembly = true;

    act(() => {
      window.dispatchEvent(new CustomEvent('shogun-privacy-settings-changed'));
    });

    await waitFor(() => {
      expect(result.current.allowServerMemoryAssembly).toBe(true);
      expect(result.current.autoStartOnCalendar).toBe(true);
    });
  });
});

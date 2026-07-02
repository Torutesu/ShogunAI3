import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('ShogunIpcClient Tauri bridge', () => {
  const originalTauriInternals = (window as any).__TAURI_INTERNALS__;
  const originalClient = (window as any).ShogunIpcClient;

  beforeEach(() => {
    vi.resetModules();
    delete (window as any).ShogunIpcClient;
    (window as any).__TAURI_INTERNALS__ = { invoke: vi.fn() };
  });

  afterEach(() => {
    if (originalTauriInternals === undefined) {
      delete (window as any).__TAURI_INTERNALS__;
    } else {
      (window as any).__TAURI_INTERNALS__ = originalTauriInternals;
    }

    if (originalClient === undefined) {
      delete (window as any).ShogunIpcClient;
    } else {
      (window as any).ShogunIpcClient = originalClient;
    }

    vi.resetModules();
    vi.doUnmock('@tauri-apps/api/event');
  });

  it('bridges video-meeting-auto-started into a DOM custom event', async () => {
    const listeners = new Map<string, (event: { payload?: unknown }) => void>();

    vi.doMock('@tauri-apps/api/event', () => ({
      listen: vi.fn((eventName: string, callback: (event: { payload?: unknown }) => void) => {
        listeners.set(eventName, callback);
        return Promise.resolve(() => {});
      }),
    }));

    await import('./ipc-client');
    await Promise.resolve();

    const domSpy = vi.fn();
    window.addEventListener('shogun-video-meeting-auto-started', domSpy as EventListener);

    try {
      const bridge = listeners.get('video-meeting-auto-started');
      expect(bridge).toBeTypeOf('function');

      bridge?.({
        payload: {
          meeting_id: 'mtg-auto-1',
          title: 'Google Meet · Google Chrome',
          system_started: true,
        },
      });

      expect(domSpy).toHaveBeenCalledTimes(1);
      const event = domSpy.mock.calls[0]?.[0] as CustomEvent;
      expect(event.detail).toEqual({
        meeting_id: 'mtg-auto-1',
        title: 'Google Meet · Google Chrome',
        system_started: true,
      });
    } finally {
      window.removeEventListener('shogun-video-meeting-auto-started', domSpy as EventListener);
    }
  });

  it('bridges meeting-stopped into a DOM custom event', async () => {
    const listeners = new Map<string, (event: { payload?: unknown }) => void>();

    vi.doMock('@tauri-apps/api/event', () => ({
      listen: vi.fn((eventName: string, callback: (event: { payload?: unknown }) => void) => {
        listeners.set(eventName, callback);
        return Promise.resolve(() => {});
      }),
    }));

    await import('./ipc-client');
    await Promise.resolve();

    const domSpy = vi.fn();
    window.addEventListener('shogun-meeting-stopped', domSpy as EventListener);

    try {
      const bridge = listeners.get('meeting-stopped');
      expect(bridge).toBeTypeOf('function');

      bridge?.({
        payload: {
          meeting_id: 'mtg-stop-1',
          reason: 'manual_stop',
          meeting: { title: 'Weekly Sync' },
        },
      });

      expect(domSpy).toHaveBeenCalledTimes(1);
      const event = domSpy.mock.calls[0]?.[0] as CustomEvent;
      expect(event.detail).toEqual({
        meeting_id: 'mtg-stop-1',
        reason: 'manual_stop',
        meeting: { title: 'Weekly Sync' },
      });
    } finally {
      window.removeEventListener('shogun-meeting-stopped', domSpy as EventListener);
    }
  });
});

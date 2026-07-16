import { useCallback, useEffect, useMemo, useState } from 'react';
import { tauriInvokeSilent } from '../lib/tauri-invoke';
import type { ScreenContextProbeData } from '../types';

declare const window: Window & {
  __TAURI_INTERNALS__?: { invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> };
};

export interface UseScreenContextProbeOptions {
  enabled?: boolean;
  intervalMs?: number;
}

function hasDesktopRuntime() {
  return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__?.invoke;
}

function errorLabel(value: unknown) {
  return value instanceof Error ? value.message : String(value);
}

export function useScreenContextProbe(options: UseScreenContextProbeOptions = {}) {
  const enabled = options.enabled ?? true;
  const intervalMs = options.intervalMs ?? 3000;
  const desktop = useMemo(() => hasDesktopRuntime(), []);
  const [probe, setProbe] = useState<ScreenContextProbeData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!desktop) return null;
    setBusy(true);
    setErr(null);
    try {
      const out = await tauriInvokeSilent<ScreenContextProbeData>('shogun_screen_context_probe', {
        payload: {},
      });
      if (!out) {
        throw new Error('Screen context probe returned no data');
      }
      setProbe(out);
      return out;
    } catch (e: unknown) {
      setErr(errorLabel(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, [desktop]);

  useEffect(() => {
    if (!desktop || !enabled) return undefined;
    // Skip probing while the window is hidden — this poll runs the whole
    // session, so not hammering the backend in the background matters.
    const tick = () => { if (!document.hidden) void refresh(); };
    tick();
    const timer = window.setInterval(tick, intervalMs);
    // Refresh promptly when the user returns instead of waiting a full interval.
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [desktop, enabled, intervalMs, refresh]);

  return {
    desktop,
    probe,
    capturedAtMs: probe?.capturedAtMs ?? null,
    err,
    busy,
    refresh,
  };
}

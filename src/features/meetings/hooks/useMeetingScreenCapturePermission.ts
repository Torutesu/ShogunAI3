import { useCallback, useEffect, useRef, useState } from 'react';
import { runRuntimeActionM } from '@/shared/ipc/runtime-actions';

function isNativeDesktop() {
  return !!(typeof window !== 'undefined' && (window as any).__TAURI__);
}

function readScreenCaptureGranted(data: any): boolean | null {
  if (!data || typeof data !== 'object') return null;
  const perms = data.permissions;
  if (perms && typeof perms === 'object') {
    if (typeof perms.screenCaptureGranted === 'boolean') return perms.screenCaptureGranted;
  }
  if (typeof data.screenCaptureGranted === 'boolean') return data.screenCaptureGranted;
  return null;
}

/** Poll `capture.status` while a backend meeting note is open (macOS desktop). */
export function useMeetingScreenCapturePermission(enabled: boolean) {
  const [screenCaptureGranted, setScreenCaptureGranted] = useState<boolean | null>(null);
  const prevGrantedRef = useRef<boolean | null>(null);

  const refresh = useCallback(async function refresh() {
    if (!isNativeDesktop()) {
      setScreenCaptureGranted(true);
      return true;
    }
    const r = await runRuntimeActionM('capture.status', {}, { silentError: true });
    const granted = r && r.ok ? readScreenCaptureGranted(r.data) : null;
    if (granted != null) {
      setScreenCaptureGranted(granted);
    }
    return granted === true;
  }, []);

  useEffect(function () {
    if (!enabled || !isNativeDesktop()) {
      setScreenCaptureGranted(isNativeDesktop() ? null : true);
      return undefined;
    }
    let cancelled = false;
    const tick = async function () {
      if (cancelled) return;
      await refresh();
    };
    void tick();
    const id = window.setInterval(tick, 3000);
    return function () {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [enabled, refresh]);

  const grantedChangedToTrue =
    prevGrantedRef.current === false && screenCaptureGranted === true;
  useEffect(function () {
    prevGrantedRef.current = screenCaptureGranted;
  }, [screenCaptureGranted]);

  return {
    screenCaptureGranted,
    refresh,
    grantedChangedToTrue,
    isNativeDesktop: isNativeDesktop(),
  };
}

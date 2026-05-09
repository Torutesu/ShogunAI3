/**
 * Typed wrapper for window.__TAURI_INTERNALS__.invoke.
 *
 * Each tab calls Tauri IPC directly. This helper centralises the access,
 * type-checks the call site, and throws a clear error when running outside
 * of Tauri (e.g. in a browser dev-server or during unit tests).
 */

declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
  }
}

/**
 * Invoke a Tauri IPC command and return the typed result.
 *
 * @throws Error when `window.__TAURI_INTERNALS__` is not available.
 */
export function tauriInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) {
    return Promise.reject(new Error("Tauri IPC unavailable"));
  }
  return invoke(cmd, args) as Promise<T>;
}

/**
 * Like `tauriInvoke`, but silently returns `null` instead of throwing when
 * Tauri is not available. Useful for polling tabs that should simply stay
 * empty in browser/test environments.
 */
export function tauriInvokeSilent<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) {
    return Promise.resolve(null);
  }
  return invoke(cmd, args) as Promise<T>;
}

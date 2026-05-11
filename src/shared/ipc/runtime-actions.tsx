// Shared runtime action helpers. Each function is a thin wrapper over
// window.SHOGUN_RUNTIME's methods. The historical A/M/B/no-suffix
// variants all do the same thing (invoke executeAction) — the suffix
// was a Babel-in-browser remnant from when each screen file had its
// own copy. They remain as aliases for grep-friendly migration.

function getRuntime(): any | null {
  if (typeof window === 'undefined') return null;
  const r = (window as any).SHOGUN_RUNTIME;
  return r && typeof r.executeAction === 'function' ? r : null;
}

export function runRuntimeAction(key: string, payload?: any, options?: any): Promise<any> {
  const rt = getRuntime();
  if (!rt) return Promise.resolve({ ok: false });
  return rt.executeAction(key, payload || {}, options || {});
}

export const runRuntimeActionA = runRuntimeAction;
export const runRuntimeActionB = runRuntimeAction;
export const runRuntimeActionM = runRuntimeAction;

export function requestWriteActionA(
  actionKey: string,
  payload: any,
  title: string,
  description: string,
): void {
  const rt = getRuntime();
  if (!rt || typeof rt.requestWriteAction !== 'function') return;
  rt.requestWriteAction(actionKey, payload, title, description);
}

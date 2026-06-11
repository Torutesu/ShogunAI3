// Shared runtime action helper: a thin wrapper over
// window.SHOGUN_RUNTIME.executeAction.

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

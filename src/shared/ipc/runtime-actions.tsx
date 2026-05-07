// Shared runtime action helpers for non-module hi-fi screens.
export function runRuntimeActionB(key: string, payload?: any, options?: any): Promise<any> {
  const rt = (window as any).SHOGUN_RUNTIME;
  if (!rt || !rt.executeAction) {
    return Promise.resolve({ ok: false });
  }
  return rt.executeAction(key, payload || {}, options || {});
}

// Phase 2 Step 7.4: local copy of runRuntimeAction for the settings-screen feature.
// Step 12 will consolidate all copies into @/shared/ipc/runtime.

export function runRuntimeAction(
  key: string,
  payload?: Record<string, unknown>,
  options?: Record<string, unknown>,
): Promise<any> {
  const rt = (window as any).SHOGUN_RUNTIME;
  if (!rt || !rt.executeAction) return Promise.resolve({ ok: false });
  return rt.executeAction(key, payload || {}, options || {});
}

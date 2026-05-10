// Phase 2 Step 10: local copy of runRuntimeActionA for settings feature.
// Will be consolidated into @/shared/ipc/runtime in a future step.

export function runRuntimeActionA(
  key: string,
  payload?: Record<string, unknown>,
  options?: Record<string, unknown>,
): Promise<any> {
  const rt = (window as any).SHOGUN_RUNTIME;
  if (!rt || !rt.executeAction) return Promise.resolve({ ok: false });
  return rt.executeAction(key, payload || {}, options || {});
}

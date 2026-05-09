// Phase 2 Step 6: local copy of runRuntimeActionA.
// Duplicates the helper in screens-c.tsx and settings-modal.tsx.
// Step 7+ / Step 12 will consolidate all three into @/shared/ipc/runtime.

export function runRuntimeActionA(
  key: string,
  payload?: Record<string, unknown>,
  options?: Record<string, unknown>,
): Promise<any> {
  const rt = (window as any).SHOGUN_RUNTIME;
  if (!rt || !rt.executeAction) return Promise.resolve({ ok: false });
  return rt.executeAction(key, payload || {}, options || {});
}

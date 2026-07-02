// Shared runtime action helper: a thin wrapper over
// window.SHOGUN_RUNTIME.executeAction.
import { normalizeContextActionType } from '@/shared/context/action-types';

function getRuntime(): any | null {
  if (typeof window === 'undefined') return null;
  const r = (window as any).SHOGUN_RUNTIME;
  return r && typeof r.executeAction === 'function' ? r : null;
}

export function normalizeRuntimeActionData<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeRuntimeActionData(item)) as T;
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const record = value as Record<string, unknown>;
  const nextEntries = Object.entries(record).map(([key, child]) => {
    if (key === 'actionType') {
      return [key, normalizeContextActionType(child as string | null | undefined)];
    }
    return [key, normalizeRuntimeActionData(child)];
  });
  return Object.fromEntries(nextEntries) as T;
}

export function runRuntimeAction(key: string, payload?: any, options?: any): Promise<any> {
  const rt = getRuntime();
  if (!rt) return Promise.resolve({ ok: false });
  return rt.executeAction(key, payload || {}, options || {}).then((result: any) => {
    if (!result || typeof result !== 'object' || !('data' in result)) return result;
    return {
      ...result,
      data: normalizeRuntimeActionData(result.data),
    };
  });
}

import { useState, useEffect, useCallback } from 'react';
import type { MorningBriefV2, MorningBriefV1, BriefItem, ContextItem } from '../types';

interface ShogunRuntime {
  executeAction: (
    key: string,
    payload: Record<string, unknown>,
    options?: { silentError?: boolean; successMessage?: string },
  ) => Promise<{ ok: boolean; data?: unknown }>;
}

interface ShogunMorningBriefAPI {
  buildBriefGetPayload: () => Record<string, unknown>;
  unwrapBriefGetRegistryResult: (
    result: unknown,
  ) => { ok: boolean; brief?: MorningBriefV2 | MorningBriefV1 };
  resolveNextAction: (
    nextAction: NonNullable<BriefItem['next_action']>,
    item: BriefItem,
  ) => { skip?: boolean; key: string; payload: Record<string, unknown> };
}

interface BriefTelemetryAPI {
  EVENTS: {
    BRIEF_RENDERED: string;
    NEXT_ACTION_CLICK: string;
  };
  log: (event: string, payload: Record<string, unknown>) => void;
}

function getRuntime(): ShogunRuntime | null {
  if (typeof window === 'undefined') return null;
  const r = (window as unknown as { SHOGUN_RUNTIME?: ShogunRuntime }).SHOGUN_RUNTIME;
  return r && typeof r.executeAction === 'function' ? r : null;
}

function getMorningBriefApi(): ShogunMorningBriefAPI | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { ShogunMorningBrief?: ShogunMorningBriefAPI }).ShogunMorningBrief ?? null;
}

function getBriefTelemetry(): BriefTelemetryAPI | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { BriefTelemetry?: BriefTelemetryAPI }).BriefTelemetry ?? null;
}

async function runtimeInvoke(
  key: string,
  payload: Record<string, unknown>,
  options: { silentError?: boolean; successMessage?: string } = {},
): Promise<{ ok: boolean; data?: unknown }> {
  const rt = getRuntime();
  if (!rt) return { ok: false };
  return rt.executeAction(key, payload, options);
}

export interface UseMorningBriefResult {
  brief: MorningBriefV2 | null;
  legacyV1: MorningBriefV1 | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  onAction: (item: BriefItem) => Promise<void>;
  onContext: (ctx: ContextItem) => Promise<void>;
}

export function useMorningBrief(): UseMorningBriefResult {
  const [brief, setBrief] = useState<MorningBriefV2 | null>(null);
  const [legacyV1, setLegacyV1] = useState<MorningBriefV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const SB = getMorningBriefApi();
    if (!SB) {
      setError('ShogunMorningBrief not loaded');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const payload = SB.buildBriefGetPayload();
    const res = await runtimeInvoke('brief.get', payload, { silentError: true });
    const unwrapped = SB.unwrapBriefGetRegistryResult(res);
    if (!unwrapped.ok || !unwrapped.brief) {
      setError('Could not load Morning Brief');
      setBrief(null);
      setLegacyV1(null);
      setLoading(false);
      return;
    }
    const b = unwrapped.brief;
    if (b.version === '2.0') {
      setBrief(b as MorningBriefV2);
      setLegacyV1(null);
      const tel = getBriefTelemetry();
      if (tel) {
        tel.log(tel.EVENTS.BRIEF_RENDERED, {
          version: '2.0',
          items: ((b as MorningBriefV2).items?.length) || 0,
        });
      }
    } else {
      setBrief(null);
      setLegacyV1(b as MorningBriefV1);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const onAction = useCallback(async (item: BriefItem) => {
    const SB = getMorningBriefApi();
    if (!SB || !item || !item.next_action) return;
    const spec = SB.resolveNextAction(item.next_action, item);
    if (spec.skip) return;
    const tel = getBriefTelemetry();
    if (tel) {
      tel.log(tel.EVENTS.NEXT_ACTION_CLICK, {
        item_id: item.id,
        key: spec.key,
      });
    }
    await runtimeInvoke(spec.key, spec.payload, {
      successMessage: item.next_action.label || 'Done',
      silentError: true,
    });
  }, []);

  const onContext = useCallback(async (c: ContextItem) => {
    const q = c.title || c.uri || '';
    await runtimeInvoke(
      'memory.search',
      { query: q, limit: 15, source: 'morning_brief_context' },
      { successMessage: 'Search started', silentError: true },
    );
  }, []);

  return { brief, legacyV1, loading, error, reload, onAction, onContext };
}

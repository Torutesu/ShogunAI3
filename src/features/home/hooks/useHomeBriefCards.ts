import React, { useEffect, useState } from 'react';
import { BriefTelemetry } from '@/shared/lib/brief-telemetry';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';
import { resolveUserTimeZoneId } from '../lib/runtime';

function readUiLang(): string {
  if (typeof document === 'undefined' || !document.body) return 'en';
  return document.body.getAttribute('data-lang') || 'en';
}

function dispatchHighPriorityCount(memoryDigest: Record<string, unknown> | null): void {
  if (!memoryDigest) return;
  try {
    const highlights = Array.isArray(memoryDigest.highlights) ? memoryDigest.highlights : [];
    const nowMs = Date.now();
    const highCount = highlights.filter(
      (h: Record<string, unknown>) => (h.userPriority || h.priority) === 'high'
        && !h.acknowledgedAt
        && !(typeof h.snoozeUntil === 'number' && h.snoozeUntil > nowMs),
    ).length;
    window.dispatchEvent(new CustomEvent('shogun-memory-high-count', { detail: { count: highCount } }));
  } catch {
    /* ignore */
  }
}

/** Loads morning brief + memory digest cards for the home screen. */
export function useHomeBriefCards(): {
  morningBrief: Record<string, unknown> | null;
  memoryDigest: Record<string, unknown> | null;
  setMorningBrief: React.Dispatch<React.SetStateAction<Record<string, unknown> | null>>;
  setMemoryDigest: React.Dispatch<React.SetStateAction<Record<string, unknown> | null>>;
} {
  const [morningBrief, setMorningBrief] = useState<Record<string, unknown> | null>(null);
  const [memoryDigest, setMemoryDigest] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const lang = readUiLang();
      const res = await runRuntimeAction(
        'brief.get',
        { span: 'today', source: 'home', user_tz: resolveUserTimeZoneId(), lang },
        { silentError: true },
      );
      if (cancelled) return;
      if (!res.ok || !res.data) {
        setMorningBrief(null);
        setMemoryDigest(null);
        return;
      }
      const inner = res.data as Record<string, unknown>;
      if (inner.memory_digest && typeof inner.memory_digest === 'object') {
        const digest = { ...(inner.memory_digest as Record<string, unknown>) };
        if (typeof inner.memoryReadPath === 'string' && !digest.read_path) {
          digest.read_path = inner.memoryReadPath;
        }
        setMemoryDigest(digest);
        dispatchHighPriorityCount(digest);
      }
      if (inner.skipped || !inner.brief) {
        setMorningBrief(null);
        return;
      }
      const brief = inner.brief as Record<string, unknown>;
      setMorningBrief(brief);
      if (BriefTelemetry) {
        const items = Array.isArray(brief.items) ? brief.items : [];
        BriefTelemetry.log(BriefTelemetry.EVENTS.BRIEF_RENDERED, { itemCount: items.length });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return { morningBrief, memoryDigest, setMorningBrief, setMemoryDigest };
}

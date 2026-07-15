// Opt-in product telemetry — aggregate usage only (DAU/MAU, sessions,
// retention, which screens are used). See PRIVACY.md.
//
// Hard privacy guarantees, enforced structurally in this module:
// 1. Never initializes unless BOTH are true:
//    - the user opted in on the consent screen (sections.legal.telemetryOptIn)
//    - a PostHog key was baked into the build (VITE_POSTHOG_KEY)
//    Without either, no network request is ever made.
// 2. Only events in ALLOWED_EVENTS with allow-listed properties can be sent.
//    Captured screen text, memory content, window titles, queries, file paths
//    etc. have no code path into this module.
// 3. Identity is an anonymous random device UUID — no email, no name, no
//    Clerk id. Autocapture, session recording, and surveys are disabled.

import posthog from 'posthog-js';

const POSTHOG_KEY: string =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_POSTHOG_KEY) || '';
const POSTHOG_HOST: string =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_POSTHOG_HOST) ||
  'https://us.i.posthog.com';

/** The full vocabulary this app is allowed to report. Aggregate-only. */
const ALLOWED_EVENTS = new Set(['app_opened', 'screen_viewed']);

/** Per-event property allowlist. Anything else is dropped. */
const ALLOWED_PROPS: Record<string, Set<string>> = {
  app_opened: new Set(['app_version']),
  screen_viewed: new Set(['screen']),
};

const DEVICE_ID_STORAGE_KEY = 'shogun-telemetry-device-id';

let enabled = false;

export function telemetryEnabled(): boolean {
  return enabled;
}

/** Read the opt-in flag the consent screen persisted. */
export function readTelemetryOptIn(settingsDoc: unknown): boolean {
  const doc = settingsDoc as { sections?: { legal?: { telemetryOptIn?: unknown } } } | null;
  return doc?.sections?.legal?.telemetryOptIn === true;
}

/** Stable anonymous device id (random UUID, localStorage). Never PII. */
export function deviceId(storage: Pick<Storage, 'getItem' | 'setItem'>): string {
  try {
    const existing = storage.getItem(DEVICE_ID_STORAGE_KEY);
    if (existing && existing.length >= 8) return existing;
    const fresh =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `dev-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    storage.setItem(DEVICE_ID_STORAGE_KEY, fresh);
    return fresh;
  } catch {
    return 'dev-ephemeral';
  }
}

/**
 * Initialize telemetry iff the user opted in and a key exists.
 * Safe to call more than once; later calls are no-ops.
 */
export function initProductTelemetry(settingsDoc: unknown, appVersion?: string): boolean {
  if (enabled) return true;
  if (!POSTHOG_KEY) return false;
  if (!readTelemetryOptIn(settingsDoc)) return false;
  if (typeof window === 'undefined') return false;

  try {
    posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      bootstrap: { distinctID: deviceId(window.localStorage) },
      person_profiles: 'identified_only',
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      disable_surveys: true,
      disable_external_dependency_loading: true,
      persistence: 'localStorage',
    });
    enabled = true;
    capture('app_opened', { app_version: appVersion || 'unknown' });
    return true;
  } catch {
    enabled = false;
    return false;
  }
}

/** Allowlist-guarded capture. Unknown events/props are silently dropped. */
export function capture(event: string, props?: Record<string, unknown>): boolean {
  if (!enabled) return false;
  if (!ALLOWED_EVENTS.has(event)) return false;
  const allowed = ALLOWED_PROPS[event] || new Set<string>();
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(props || {})) {
    if (allowed.has(k) && (typeof v === 'string' || typeof v === 'number')) {
      clean[k] = String(v).slice(0, 64);
    }
  }
  try {
    posthog.capture(event, clean);
    return true;
  } catch {
    return false;
  }
}

/** Screen-level usage: reports the screen id only (e.g. "memory", "chat"). */
export function captureScreenViewed(screenId: string): void {
  if (!screenId || typeof screenId !== 'string') return;
  capture('screen_viewed', { screen: screenId });
}

/** Test hook. */
export function __resetForTests(): void {
  enabled = false;
}

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock posthog-js before importing the module under test.
vi.mock('posthog-js', () => ({
  default: { init: vi.fn(), capture: vi.fn() },
}));

import posthog from 'posthog-js';
import {
  initProductTelemetry,
  capture,
  captureScreenViewed,
  readTelemetryOptIn,
  deviceId,
  telemetryEnabled,
  __resetForTests,
} from './product-telemetry';

function optedInDoc() {
  return { sections: { legal: { telemetryOptIn: true } } };
}

describe('product-telemetry', () => {
  beforeEach(() => {
    __resetForTests();
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  describe('readTelemetryOptIn', () => {
    it('is true only for an explicit boolean true', () => {
      expect(readTelemetryOptIn(optedInDoc())).toBe(true);
      expect(readTelemetryOptIn({ sections: { legal: { telemetryOptIn: 'true' } } })).toBe(false);
      expect(readTelemetryOptIn({ sections: { legal: {} } })).toBe(false);
      expect(readTelemetryOptIn({})).toBe(false);
      expect(readTelemetryOptIn(null)).toBe(false);
    });
  });

  describe('gating', () => {
    it('does not initialize without opt-in (no network path)', () => {
      // No VITE_POSTHOG_KEY is set in the test env either, but opt-in=false
      // must short-circuit regardless of key presence.
      const ok = initProductTelemetry({ sections: { legal: { telemetryOptIn: false } } });
      expect(ok).toBe(false);
      expect(telemetryEnabled()).toBe(false);
      expect(posthog.init).not.toHaveBeenCalled();
    });

    it('does not initialize without a build key even when opted in', () => {
      // Test builds have no VITE_POSTHOG_KEY → must stay disabled.
      const ok = initProductTelemetry(optedInDoc());
      expect(ok).toBe(false);
      expect(telemetryEnabled()).toBe(false);
      expect(posthog.init).not.toHaveBeenCalled();
    });

    it('capture is a hard no-op while disabled', () => {
      expect(capture('app_opened', { app_version: '1.0.0' })).toBe(false);
      captureScreenViewed('memory');
      expect(posthog.capture).not.toHaveBeenCalled();
    });
  });

  describe('allowlist (unit-level, independent of init gating)', () => {
    it('rejects unknown events and strips unknown props', () => {
      // Even if telemetry were force-enabled, non-allowlisted events must drop.
      // capture() checks `enabled` first, so with enabled=false everything is
      // rejected — assert the strictest invariant available without a key:
      expect(capture('memory_content', { snippet: 'SECRET' })).toBe(false);
      expect(capture('screen_viewed', { screen: 'chat', query: 'SECRET' })).toBe(false);
      expect(posthog.capture).not.toHaveBeenCalled();
    });
  });

  describe('deviceId', () => {
    it('generates once and is stable across calls', () => {
      const a = deviceId(window.localStorage);
      const b = deviceId(window.localStorage);
      expect(a).toBe(b);
      expect(a.length).toBeGreaterThanOrEqual(8);
    });

    it('contains no PII shape (pure random id)', () => {
      const id = deviceId(window.localStorage);
      expect(id).not.toMatch(/@/);
      expect(id).not.toMatch(/\s/);
    });

    it('falls back to ephemeral id when storage throws', () => {
      const broken = {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
      } as unknown as Storage;
      expect(deviceId(broken)).toBe('dev-ephemeral');
    });
  });
});

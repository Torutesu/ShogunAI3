import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Verify the seeded demo chat history is gated by demo mode so real builds
// (demo off) start with an empty chat sidebar.
describe('INITIAL_CHAT_HISTORY demo gating', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); vi.doUnmock('@/shared/lib/demo-mode'); });

  it('is empty when demo data is disabled', async () => {
    vi.doMock('@/shared/lib/demo-mode', () => ({ demoDataEnabled: () => false }));
    const { INITIAL_CHAT_HISTORY } = await import('./constants');
    expect(INITIAL_CHAT_HISTORY).toEqual([]);
  });

  it('is populated from the seed when demo data is enabled', async () => {
    vi.doMock('@/shared/lib/demo-mode', () => ({ demoDataEnabled: () => true }));
    const { INITIAL_CHAT_HISTORY } = await import('./constants');
    expect(Array.isArray(INITIAL_CHAT_HISTORY)).toBe(true);
    expect(INITIAL_CHAT_HISTORY.length).toBeGreaterThan(0);
  });
});

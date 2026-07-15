import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('web env helpers', () => {
  it('trims required env vars', async () => {
    vi.stubEnv('ADMIN_API_KEY', '  secret  ');
    const mod = await import('../src/lib/web-config');
    expect(mod.getRequiredEnv('ADMIN_API_KEY')).toBe('secret');
  });

  it('returns null for blank required env vars', async () => {
    vi.stubEnv('DATABASE_URL', '   ');
    const mod = await import('../src/lib/web-config');
    expect(mod.getRequiredEnv('DATABASE_URL')).toBeNull();
  });
});


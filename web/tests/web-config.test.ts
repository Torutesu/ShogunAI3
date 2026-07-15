import { describe, expect, it, vi } from 'vitest';

describe('web config helpers', () => {
  it('normalizes the app base URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.shogun.ai/');
    const mod = await import('../src/lib/web-config');
    expect(mod.getAppBaseUrl()).toBe('https://app.shogun.ai');
    vi.unstubAllEnvs();
  });

  it('returns null for missing download url', async () => {
    vi.stubEnv('NEXT_PUBLIC_DMG_DOWNLOAD_URL', '');
    const mod = await import('../src/lib/web-config');
    expect(mod.getDmgDownloadUrl()).toBeNull();
    vi.unstubAllEnvs();
  });

  it('builds allowed lp origins from defaults and env', async () => {
    vi.stubEnv('NEXT_PUBLIC_LP_ORIGIN', 'https://lp.example.com/');
    const mod = await import('../src/lib/web-config');
    expect(mod.getAllowedLpOrigins()).toEqual([
      'https://shogunai.lovable.app',
      'https://lp.example.com',
    ]);
    vi.unstubAllEnvs();
  });
});

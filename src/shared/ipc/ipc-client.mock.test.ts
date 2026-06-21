import { describe, it, expect, beforeEach } from 'vitest';
import { ShogunMorningBrief } from '@/shared/lib/morning-brief';
import type { IpcSuccessEnvelope, SettingsLoadResponse, SettingsSaveResponse } from '@/shared/ipc/types/common';
import { MOCK_SETTINGS_LS } from '@/shared/ipc/mock/settings';
import '@/shared/ipc/ipc-client';

function createMockClient() {
  const { ShogunIpcClient } = window as any;
  return ShogunIpcClient.createIpcClient({ transport: 'mock' });
}

describe('ShogunIpcClient mock transport', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('app_settings_load returns { settings, echo, stub:false } envelope', async () => {
    const client = createMockClient();
    const res = (await client.invoke('app_settings_load', { probe: 1 })) as IpcSuccessEnvelope<SettingsLoadResponse>;
    expect(res.ok).toBe(true);
    expect(res.data.stub).toBe(false);
    expect(res.data.echo).toEqual({ probe: 1 });
    expect(res.data.settings).toBeDefined();
    expect(res.data.settings.sections).toBeDefined();
  });

  it('app_settings_save round-trips section patches via localStorage', async () => {
    const client = createMockClient();
    const saveRes = (await client.invoke('app_settings_save', {
      section: 'general',
      name: 'Test User',
    })) as IpcSuccessEnvelope<SettingsSaveResponse>;
    expect(saveRes.ok).toBe(true);
    expect(saveRes.data.stub).toBe(false);

    const loadRes = await client.invoke('app_settings_load', {});
    expect(loadRes.ok).toBe(true);
    expect(loadRes.data.settings.sections.general.name).toBe('Test User');

    const raw = localStorage.getItem(MOCK_SETTINGS_LS);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.general.name).toBe('Test User');
  });

  it('shogun_brief_get returns wrapped brief with items and memory_digest', async () => {
    const direct = ShogunMorningBrief.mockBriefGetResponse({ forceV2: true }) as {
      skipped: boolean;
      brief: { items: unknown[] } | null;
      memory_digest: { graph_supplemented?: boolean; read_path?: string };
      memoryReadPath: string;
    };
    expect(direct.skipped).toBe(false);
    expect(Array.isArray(direct.brief?.items)).toBe(true);
    expect(direct.memory_digest?.graph_supplemented).toBe(true);
    expect(direct.memoryReadPath).toBe('graph');

    const client = createMockClient();
    const res = await client.invoke('shogun_brief_get', { forceV2: true, echo: 'x' });
    expect(res.ok).toBe(true);
    const data = res.data as {
      skipped?: boolean;
      brief?: { items?: unknown[] };
      memory_digest?: { graph_supplemented?: boolean };
    };
    expect(data.skipped).toBe(false);
    expect(Array.isArray(data.brief?.items)).toBe(true);
    expect(data.memory_digest?.graph_supplemented).toBe(true);
  });

  it('mock google oauth start configures drive too', async () => {
    const client = createMockClient();
    const startRes = await client.invoke('oauth.google.start', { provider: 'google_drive' });
    expect(startRes.ok).toBe(true);

    const statusRes = await client.invoke('integrations.credentials_status', { provider: 'google_drive' });
    expect(statusRes.ok).toBe(true);
    expect(statusRes.data.configured).toBe(true);

    const syncRes = await client.invoke('drive.sync', { maxFiles: 10 });
    expect(syncRes.ok).toBe(true);
    expect(syncRes.data.ingested).toBeGreaterThan(0);
  });
});

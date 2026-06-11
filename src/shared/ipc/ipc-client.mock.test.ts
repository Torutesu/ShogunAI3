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

  it('shogun_brief_get returns v2 brief with items array', async () => {
    const direct = ShogunMorningBrief.mockBriefGetResponse({ forceV2: true }) as {
      version: string;
      items: unknown[];
    };
    expect(direct.version).toBe('2.0');
    expect(Array.isArray(direct.items)).toBe(true);

    const client = createMockClient();
    const res = await client.invoke('shogun_brief_get', { forceV2: true, echo: 'x' });
    expect(res.ok).toBe(true);
    const data = res.data as { version?: string; items?: unknown[] };
    expect(data.version).toBe('2.0');
    expect(Array.isArray(data.items)).toBe(true);
  });
});

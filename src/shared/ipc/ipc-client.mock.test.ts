import { describe, it, expect, beforeEach, vi } from 'vitest';
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
    const startRes = await client.invoke('shogun_oauth_google_start', { provider: 'google_drive' });
    expect(startRes.ok).toBe(true);

    const statusRes = await client.invoke('app_integration_credentials_status', { provider: 'google_drive' });
    expect(statusRes.ok).toBe(true);
    expect(statusRes.data.configured).toBe(true);

    const syncRes = await client.invoke('shogun_drive_sync', { maxFiles: 10 });
    expect(syncRes.ok).toBe(true);
    expect(syncRes.data.ingested).toBeGreaterThan(0);
  });

  it('dispatches action-layer refresh events for action and queue mutations', async () => {
    const client = createMockClient();
    const refreshSpy = vi.fn();
    window.addEventListener('shogun-action-layer-refresh', refreshSpy as EventListener);

    try {
      const proposeRes = await client.invoke('shogun_context_action_propose', {
        ownerEntityId: 'company:aurora',
        actionType: 'create_task',
        title: 'Create onboarding task',
      });
      expect(proposeRes.ok).toBe(true);

      const queueRes = await client.invoke('shogun_schedule_action', {
        owner_entity_id: 'company:aurora',
        title: 'Queued follow-up',
      });
      expect(queueRes.ok).toBe(true);

      expect(refreshSpy).toHaveBeenCalledTimes(2);
      expect((refreshSpy.mock.calls[0]?.[0] as CustomEvent).detail.reason).toBe('action-proposed');
      expect((refreshSpy.mock.calls[1]?.[0] as CustomEvent).detail.reason).toBe('queue.tasks.append');
    } finally {
      window.removeEventListener('shogun-action-layer-refresh', refreshSpy as EventListener);
    }
  });

  it('dispatches auto-start meeting events from the mock IPC transport', async () => {
    const client = createMockClient();
    const autoStartSpy = vi.fn();
    window.addEventListener(
      'shogun-video-meeting-auto-started',
      autoStartSpy as EventListener,
    );

    try {
      const res = await client.invoke('shogun_meeting_start', {
        source: 'video_detect_auto_start',
        meeting_id: 'mtg-auto-1',
        title: 'Google Meet · Google Chrome',
        provider: 'google_meet',
        system_started: false,
        screen_capture_granted: false,
        auto_started: true,
      });

      expect(res.ok).toBe(true);
      expect(autoStartSpy).toHaveBeenCalledTimes(1);
      const event = autoStartSpy.mock.calls[0]?.[0] as CustomEvent;
      expect(event.detail).toEqual({
        meeting_id: 'mtg-auto-1',
        provider: 'google_meet',
        url: 'https://meet.google.com/mock-room',
        title: 'Google Meet · Google Chrome',
        app: 'Google Chrome',
        mic_started: false,
        system_started: false,
        screen_capture_granted: false,
        auto_started: true,
      });
    } finally {
      window.removeEventListener(
        'shogun-video-meeting-auto-started',
        autoStartSpy as EventListener,
      );
    }
  });

  it('dispatches meetings-changed events from the mock IPC transport when a meeting stops', async () => {
    const client = createMockClient();
    const meetingsChangedSpy = vi.fn();
    const meetingStoppedSpy = vi.fn();
    window.addEventListener('shogun-meetings-changed', meetingsChangedSpy as EventListener);
    window.addEventListener('shogun-meeting-stopped', meetingStoppedSpy as EventListener);

    try {
      const res = await client.invoke('shogun_meeting_stop', {
        meeting_id: 'mtg-stop-1',
      });

      expect(res.ok).toBe(true);
      expect(meetingStoppedSpy).toHaveBeenCalledTimes(1);
      expect((meetingStoppedSpy.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
        meeting_id: 'mtg-stop-1',
        reason: 'manual_stop',
        meeting: {
          id: 'mtg-stop-1',
          started_at: expect.any(Number),
          ended_at: expect.any(Number),
          app_bundle_id: 'com.shogun.mock',
          template_id: null,
          title: 'Mock meeting mtg-stop-1',
          participants: [],
          state: 'completed',
          client_storage_key: null,
        },
      });
      expect(meetingsChangedSpy).toHaveBeenCalledTimes(1);
      const event = meetingsChangedSpy.mock.calls[0]?.[0] as CustomEvent;
      expect(event.detail).toEqual({
        meeting_id: 'mtg-stop-1',
      });
    } finally {
      window.removeEventListener('shogun-meetings-changed', meetingsChangedSpy as EventListener);
      window.removeEventListener('shogun-meeting-stopped', meetingStoppedSpy as EventListener);
    }
  });
});

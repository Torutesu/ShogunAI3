/** Global meeting recording HUD — `MainApp` listens for `shogun-meeting-hud`. */

export type MeetingHudPhase = 'begin' | 'tick' | 'end';

export interface MeetingHudDetail {
  active?: boolean;
  hudPhase?: MeetingHudPhase;
  title?: string;
  startedAt?: number;
  storageKey?: string | null;
  backend?: boolean;
  backendMeetingId?: string | null;
  micRunning?: boolean;
  systemRunning?: boolean;
  deepgramConfigured?: boolean;
  systemMode?: string | null;
}

export function emitMeetingHud(detail: MeetingHudDetail) {
  try {
    window.dispatchEvent(new CustomEvent('shogun-meeting-hud', { detail: detail || {} }));
  } catch (_e) {
    /* ignore */
  }
}

export function clearMeetingHud() {
  emitMeetingHud({ active: false, hudPhase: 'end' });
}

export function meetingHudStatusLabel(hud: MeetingHudDetail | null | undefined): string {
  if (!hud) return '';
  if (!hud.backend) return 'Recording';
  if (hud.micRunning === false) return 'Starting…';
  if (hud.systemRunning) return 'Mic · Remote';
  if (hud.deepgramConfigured === false) return 'Mic · STT off';
  return 'Mic only';
}

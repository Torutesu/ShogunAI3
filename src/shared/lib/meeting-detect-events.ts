/** Video / calendar meeting detection — prompt banner + deferred overlay open. */

export interface MeetingDetectDetail {
  title?: string;
  eventId?: string;
  meeting_id?: string | null;
  provider?: string;
  url?: string | null;
  auto_started?: boolean;
  source?: string;
  startMs?: number;
  endMs?: number;
  timeLabel?: string;
  /** When true, open overlay and start recording after user accepts or auto-accept. */
  autoRecord?: boolean;
  openNotes?: boolean;
}

let pendingDetect: MeetingDetectDetail | null = null;

export function stashPendingMeetingDetect(detail: MeetingDetectDetail | null) {
  pendingDetect = detail;
}

export function takePendingMeetingDetect(): MeetingDetectDetail | null {
  const p = pendingDetect;
  pendingDetect = null;
  return p;
}

export function dispatchMeetingDetected(detail: MeetingDetectDetail) {
  try {
    window.dispatchEvent(new CustomEvent('shogun-meeting-detected', { detail: detail || {} }));
  } catch (_e) {
    /* ignore */
  }
}

export function meetingProviderLabel(provider?: string | null): string {
  const p = String(provider || '').toLowerCase();
  if (p === 'zoom') return 'Zoom';
  if (p === 'google_meet' || p.indexOf('meet') !== -1) return 'Google Meet';
  return 'Video call';
}

export function formatMeetingTimeLabel(detail: MeetingDetectDetail | null | undefined): string {
  if (!detail) return '';
  if (detail.timeLabel) return detail.timeLabel;
  const fmt = (ms: number) =>
    new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (detail.startMs != null && detail.endMs != null) {
    return `${fmt(detail.startMs)} – ${fmt(detail.endMs)}`;
  }
  if (detail.startMs != null) return fmt(detail.startMs);
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function normalizeVideoMeetingPayload(p: Record<string, unknown>): MeetingDetectDetail {
  const url = String(p.url || p.meetingUrl || '').toLowerCase();
  const raw = String(p.provider || p.app || '').toLowerCase();
  let provider = 'google_meet';
  if (url.indexOf('zoom.us') !== -1 || url.indexOf('zoomgov.com') !== -1) provider = 'zoom';
  else if (url.indexOf('meet.google') !== -1) provider = 'google_meet';
  else if (raw === 'zoom' || raw.indexOf('zoom') !== -1) provider = 'zoom';
  else if (raw.indexOf('meet') !== -1 || raw.indexOf('google') !== -1) provider = 'google_meet';

  const titleRaw = String(p.title || p.summary || '').trim();
  const title =
    titleRaw && titleRaw.toLowerCase() !== 'unknown'
      ? titleRaw
      : meetingProviderLabel(provider);

  return {
    title,
    eventId: String(p.eventId || p.meeting_id || p.id || `video-${Date.now()}`),
    meeting_id: (p.meeting_id as string | null | undefined) ?? null,
    auto_started: !!p.auto_started,
    provider,
    source: 'native',
    url: (p.url as string | null | undefined) || (p.meetingUrl as string | null | undefined) || null,
  };
}

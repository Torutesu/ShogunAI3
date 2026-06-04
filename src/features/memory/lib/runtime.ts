import { ShogunHighlight } from '@/shared/lib/highlight';

/** Mirrors desktop `derive_provenance_from_source` when API omits `provenance`. */
export function deriveLocalProvenance(source: any): string {
  const s = String(source || '');
  if (s === 'capture_sampler' || s === 'capture_ax') return 'screen';
  if (s === 'google_calendar' || s === 'gmail') return 'connector';
  if (s === 'meeting' || s.startsWith('meetings')) return 'meeting';
  return 'user';
}

/** Collapse a raw `sources` row value into a filter bucket. */
export function memoryProviderKey(sourceRaw: any): string {
  const s = String(sourceRaw || '').toLowerCase();
  if (s === 'capture_sampler' || s === 'capture_ax') return 'screen';
  if (s === 'gmail') return 'gmail';
  if (s === 'google_calendar') return 'google_calendar';
  if (s === 'slack') return 'slack';
  if (s === 'notion') return 'notion';
  if (s === 'github') return 'github';
  if (s === 'meeting' || s.startsWith('meetings')) return 'meeting';
  return 'manual';
}

export const MEMORY_PROVIDER_META: Record<string, { en: string; jp: string; color: string }> = {
  screen:          { en: 'Screen',   jp: '画面',   color: 'var(--text-mute)' },
  meeting:         { en: 'Meeting',  jp: '会議',   color: 'var(--success)' },
  gmail:           { en: 'Gmail',    jp: 'メール', color: '#D93025' },
  google_calendar: { en: 'Calendar', jp: '予定',   color: '#1A73E8' },
  slack:           { en: 'Slack',    jp: 'Slack',  color: '#4A154B' },
  notion:          { en: 'Notion',   jp: 'Notion', color: 'var(--text)' },
  github:          { en: 'GitHub',   jp: 'GitHub', color: 'var(--text-mute)' },
  manual:          { en: 'Manual',   jp: '手動',   color: 'var(--text-dim)' },
};

export function memoryProvenanceLabel(prov: any): { en: string; jp: string } {
  const p = prov || 'user';
  if (p === 'screen') return { en: 'Screen', jp: '画面' };
  if (p === 'connector') return { en: 'Connector', jp: '連携' };
  if (p === 'meeting') return { en: 'Meeting', jp: '会議' };
  return { en: 'User', jp: '手動' };
}

export function memoryHitToRiverEvent(hit: any): any {
  const ts = hit.created_at != null ? Number(hit.created_at) : Date.now();
  const d = new Date(ts);
  const hRaw = d.getHours() + d.getMinutes() / 60;
  const h = Math.max(6, Math.min(22, hRaw));
  const t = d.toTimeString().slice(0, 5);
  const rawSrc = String(hit.source || '').toLowerCase();
  let src = 'note';
  if (rawSrc === 'meetings' || (Array.isArray(hit.kinds) && hit.kinds.indexOf('audio') >= 0)) src = 'meet';
  else if (rawSrc === 'chat') src = 'chat';
  else if (rawSrc === 'work') src = 'code';
  else if (rawSrc === 'google_calendar') src = 'meet';
  else if (rawSrc === 'gmail') src = 'mail';
  const provenance = hit.provenance || deriveLocalProvenance(hit.source);
  const meetingTag = hit.meeting_id ? ' · 会議中' : '';
  return {
    ts,
    t,
    h,
    src,
    title: (hit.title || 'Memory') + meetingTag,
    snippet: hit.snippet || '',
    titleHighlight: typeof hit.title_highlight === 'string' ? hit.title_highlight : null,
    snippetHighlight: typeof hit.snippet_highlight === 'string' ? hit.snippet_highlight : null,
    memoryId: hit.id,
    provenance,
    sourceRaw: hit.source || '',
    entityId: hit.entity_id != null ? String(hit.entity_id) : null,
    meetingId: hit.meeting_id != null ? String(hit.meeting_id) : null,
    big: false,
  };
}

/** Parse a window/app identifier out of the AX snippet dump. */
export function extractWindowLabel(snippet: any): string {
  const s = String(snippet || '');
  const winMatch = s.match(/^window=([^\n]{1,80})/m);
  if (winMatch && winMatch[1] != null) {
    const w = winMatch[1].trim();
    const parts = w.split(/\s*[—·]\s*/);
    return parts.slice(0, 2).join(' · ').slice(0, 60);
  }
  const titleMatch = s.match(/^title=([^\n]{1,80})/m);
  if (titleMatch && titleMatch[1] != null) return titleMatch[1].trim().slice(0, 60);
  const roleDesc = s.match(/^roleDesc=([^\n]{1,40})/m);
  if (roleDesc && roleDesc[1] != null) return `AX · ${roleDesc[1].trim()}`;
  return 'Screen capture';
}

/** Collapse consecutive capture_ax / capture_sampler events with the same
 *  window label into a single "session" card. */
export function clusterScreenSessions(events: any[], gapMs = 15 * 60 * 1000): any[] {
  if (!Array.isArray(events) || events.length === 0) return events;
  const out: any[] = [];
  let current: any = null;
  for (const e of events) {
    const raw = String(e.sourceRaw || '').toLowerCase();
    const isScreen = raw === 'capture_ax' || raw === 'capture_sampler';
    if (!isScreen) {
      if (current) { out.push(current); current = null; }
      out.push(e);
      continue;
    }
    const label = extractWindowLabel(e.snippet);
    if (current && current.clusterLabel === label && Math.abs(e.ts - current.ts) <= gapMs) {
      current.clusterCount += 1;
      current.clusterStart = Math.min(current.clusterStart, e.ts);
      current.clusterEnd = Math.max(current.clusterEnd, e.ts);
      if ((e.snippet || '').length > (current.snippet || '').length) {
        current.snippet = e.snippet;
      }
    } else {
      if (current) out.push(current);
      current = {
        ...e,
        title: `Session · ${label}`,
        clusterLabel: label,
        clusterCount: 1,
        clusterStart: e.ts,
        clusterEnd: e.ts,
      };
    }
  }
  if (current) out.push(current);
  return out;
}

/** Shared FTS5 highlight renderer. */
export const renderHighlighted = (text: any): any =>
  (ShogunHighlight && ShogunHighlight.renderHighlighted)
    ? ShogunHighlight.renderHighlighted(text)
    : (text || '');

export function mergeIndexHitsIntoRiver(res: any, setEvents: any, setScrubIdx: any): void {
  if (!res || !res.ok || !res.data) return;
  const hits = res.data.hits;
  if (!Array.isArray(hits) || hits.length === 0) {
    setEvents([]);
    setScrubIdx(0);
    return;
  }
  const mapped = hits.map(memoryHitToRiverEvent);
  setEvents(mapped);
  setScrubIdx(0);
}

/** Jump to Chat with composer text + one-shot `memoryAssembly` preset. */
export function openMemoryEntryInChat(entry: any, options?: any): void {
  const opts = options || {};
  const allowAsm = opts.allowServerMemoryAssembly !== false;
  const title = String(entry.title || '').trim() || 'Memory';
  const snippet = String(entry.snippet || '');
  const lead = opts.userLead != null ? String(opts.userLead) : 'この記憶について手伝ってください。';
  const text = lead + '\n\n**' + title + '**\n\n' + snippet.slice(0, 2000);
  const memQ = String(opts.memoryAssemblyQuery != null ? opts.memoryAssemblyQuery : title).slice(0, 480);
  const limRaw = opts.memoryAssemblyLimit != null ? Number(opts.memoryAssemblyLimit) : 14;
  const limit = Number.isFinite(limRaw) ? Math.min(80, Math.max(1, Math.floor(limRaw))) : 14;
  const semantic = opts.memoryAssemblySemantic !== false;
  if (opts.newChat && typeof (window as any).SHOGUN_RUNTIME?.createNewChat === 'function') {
    (window as any).SHOGUN_RUNTIME.createNewChat();
  }
  const detail: any = {
    text,
    webSearch: !!opts.webSearch,
    assembleMemory: allowAsm,
    autoSend: !!opts.autoSend,
  };
  if (allowAsm) {
    detail.memoryAssemblyPreset = { query: memQ, limit, semantic };
  } else {
    detail.clearMemoryAssemblyPreset = true;
  }
  const dispatch = () => window.dispatchEvent(new CustomEvent('shogun-chat-composer-seed', { detail }));
  (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('chat');
  // ScreenChat mounts on demand — defer so its composer-seed listener is attached before dispatch.
  setTimeout(dispatch, 0);
}

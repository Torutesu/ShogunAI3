import * as ReactDOM from 'react-dom';
import { buildMeetingChatSeed, openChatWithSeed } from '@/shared/context/chat-composer-seed';
import { focusActionTrace } from '@/shared/context/action-trace-focus';
import {
  openContextTarget,
  openNativeDetailForEntityId,
} from '@/shared/context/context-target-navigation';
import { focusEntity } from '@/shared/context/entity-focus';
import { openQueueArtifactInActions } from '@/shared/context/open-queue-artifact';
import { OwnerSummaryCard } from '@/shared/context/OwnerSummaryCard';
import { Icon } from '@/shared/icons';
import { MeetingAiFieldPanel } from './MeetingAiFieldPanel';

export interface MeetingDetailModalProps {
  meetingDetail: any;
  setMeetingDetail: (v: any) => void;
}

export function MeetingDetailModal({ meetingDetail, setMeetingDetail }: MeetingDetailModalProps) {
  if (!meetingDetail) return null;

  const m = meetingDetail.meeting || {};
  const started = Number(m.started_at) || 0;
  const ended = Number(m.ended_at) || 0;
  const durMs = Math.max(0, ended - started);
  const durMin = Math.floor(durMs / 60000);
  const durSec = Math.floor((durMs % 60000) / 1000);
  const durationLabel = durMs > 0
    ? (durMin > 0 ? durMin + 'm ' + String(durSec).padStart(2, '0') + 's' : durSec + 's')
    : '—';
  const date = started > 0 ? new Date(started) : null;
  const dateLabel = date
    ? date.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';
  const segs = Array.isArray(meetingDetail.segments) ? meetingDetail.segments : [];
  const filter = String(meetingDetail.filter || '').toLowerCase();
  const visible = filter
    ? segs.filter((s: any) => String(s.text || '').toLowerCase().indexOf(filter) !== -1)
    : segs;
  const speakers = Array.from(new Set(segs.map((s: any) => String(s.speaker || ''))));
  // Palette cycles so each speaker gets a stable color.
  const palette = ['var(--gold)', 'var(--success)', '#8ea8ff', '#c97d9e', '#f0a04b', '#7aa98f'];
  const colorForSpeaker = (speaker: any) => {
    const idx = speakers.indexOf(String(speaker || ''));
    return idx >= 0 ? palette[idx % palette.length] : 'var(--text-mute)';
  };
  const labelFor = (speaker: any) => {
    const raw = String(speaker || '');
    if (/^speaker_\d+$/.test(raw)) {
      const n = parseInt(raw.slice(8), 10);
      return Number.isFinite(n) ? `Speaker ${n + 1}` : raw;
    }
    return raw || 'Unknown';
  };
  const fmtMs = (ms: any) => {
    const secs = Math.max(0, Math.floor(Number(ms) / 1000));
    const mm = Math.floor(secs / 60);
    const ss = secs % 60;
    return `${mm}:${String(ss).padStart(2, '0')}`;
  };
  const transcriptSnippet = segs
    .slice(0, 4)
    .map((seg: any) => {
      const speaker = labelFor(seg?.speaker);
      const text = String(seg?.text || '').trim();
      if (!text) return '';
      return speaker ? `${speaker}: ${text}` : text;
    })
    .filter(Boolean)
    .join('\n');
  const close = () => setMeetingDetail(null);
  const ownerEntityId = m.id ? `meeting:${String(m.id)}` : '';
  const openChat = () => {
    if (!m.id) return;
    openChatWithSeed(buildMeetingChatSeed({
      meetingId: String(m.id),
      title: m.title,
      startedAt: m.started_at,
      speakerCount: speakers.length,
      segmentCount: segs.length,
      transcriptSnippet,
    }));
  };

  return ReactDOM.createPortal(
    <div
      style={{
        position:'fixed', inset:0, zIndex:1095,
        background:'color-mix(in srgb, var(--bg) 78%, transparent)',
        backdropFilter:'blur(4px)',
        display:'flex', alignItems:'center', justifyContent:'center',
        padding:20,
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width:'min(780px, 100%)',
          maxHeight:'min(80vh, 720px)',
          background:'var(--surface)',
          border:'1px solid var(--border-hi)',
          borderRadius:16,
          boxShadow:'0 30px 60px -16px rgba(0,0,0,0.6)',
          display:'flex', flexDirection:'column',
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={{padding:'18px 22px 14px', borderBottom:'1px solid var(--border)'}}>
          <div className="row" style={{gap:10, alignItems:'center', marginBottom:6}}>
            <Icon name="calendar" size={14} className="gold"/>
            <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)', letterSpacing:'0.12em'}}>IMPORTED MEETING</span>
            <span style={{flex:1}}/>
            <button
              type="button"
              onClick={openChat}
              style={{
                height: 28,
                padding: '0 10px',
                borderRadius: 999,
                border: '1px solid var(--border)',
                background: 'var(--surface-2)',
                color: 'var(--text)',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                fontWeight: 500,
              }}
            >
              <Icon name="sparkles" size={12}/>
              <span>Ask Chat</span>
            </button>
            <button
              type="button"
              aria-label="Close"
              onClick={close}
              style={{width:24, height:24, borderRadius:6, border:0, background:'transparent', color:'var(--text-mute)', cursor:'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center'}}
            >
              <Icon name="x" size={14}/>
            </button>
          </div>
          <div style={{fontSize:17, fontWeight:500, lineHeight:1.3}}>
            {m.title || 'Imported recording'}
          </div>
          <div className="t-mono" style={{fontSize:10, color:'var(--text-dim)', marginTop:6, letterSpacing:'0.06em'}}>
            {dateLabel} · {durationLabel} · {segs.length} {segs.length === 1 ? 'segment' : 'segments'} · {speakers.length} {speakers.length === 1 ? 'speaker' : 'speakers'}
          </div>
          <input
            type="text"
            value={meetingDetail.filter || ''}
            onChange={(e) => setMeetingDetail((prev: any) => (prev ? { ...prev, filter: e.target.value } : prev))}
            placeholder="Filter transcript…"
            style={{
              marginTop:12, width:'100%',
              padding:'8px 12px', borderRadius:8,
              border:'1px solid var(--border)', background:'var(--bg)', color:'var(--text)',
              fontSize:13, fontFamily:'inherit',
            }}
          />
        </div>
        <div style={{flex:1, overflowY:'auto', padding:'14px 22px 20px'}}>
          {ownerEntityId ? (
            <OwnerSummaryCard
              entityId={ownerEntityId}
              hideNativeDetail
              onOpenQueueNativeDetail={(queueOwnerEntityId) => {
                close();
                openNativeDetailForEntityId(queueOwnerEntityId);
              }}
              onOpenQueueArtifact={(options) => {
                focusEntity(ownerEntityId);
                openQueueArtifactInActions(options);
                close();
              }}
              onOpenEntityContext={() => {
                openContextTarget({ targetId: ownerEntityId });
                close();
              }}
              onOpenAiFields={() => {
                focusEntity(ownerEntityId);
                (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('ai_fields');
                close();
              }}
              onOpenActions={(options) => {
                focusEntity(ownerEntityId);
                const actionId = String(options?.actionId || '').trim();
                if (actionId) {
                  focusActionTrace({
                    actionId,
                    aiFieldId: String(options?.aiFieldId || '').trim() || null,
                    openAudit: options?.openAudit === true,
                  });
                }
                (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('actions');
                close();
              }}
            />
          ) : null}
          {meetingDetail.loading ? (
            <div style={{padding:24, color:'var(--text-dim)', fontSize:13, textAlign:'center'}}>
              Loading transcript…
            </div>
          ) : segs.length === 0 ? (
            <div style={{padding:24, color:'var(--text-dim)', fontSize:13, textAlign:'center'}}>
              No transcript segments for this recording.
            </div>
          ) : visible.length === 0 ? (
            <div style={{padding:24, color:'var(--text-dim)', fontSize:13, textAlign:'center'}}>
              No segments match the filter.
            </div>
          ) : (
            <div style={{display:'flex', flexDirection:'column', gap:10}}>
              {visible.map(function (seg: any, i: any) {
                const color = colorForSpeaker(seg.speaker);
                return (
                  <div
                    key={seg.segment_id || seg.id || i}
                    style={{
                      display:'grid',
                      gridTemplateColumns:'minmax(100px, 120px) 1fr',
                      columnGap:12, rowGap:4,
                      padding:'6px 0',
                      borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                    }}
                  >
                    <div style={{display:'flex', flexDirection:'column', gap:2}}>
                      <span style={{
                        fontSize:12, fontWeight:500,
                        color,
                        overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                      }}>
                        {labelFor(seg.speaker)}
                      </span>
                      <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)'}}>
                        {fmtMs(seg.start_ms)} – {fmtMs(seg.end_ms)}
                      </span>
                    </div>
                    <div style={{fontSize:13, lineHeight:1.55, color:'var(--text)', whiteSpace:'pre-wrap'}}>
                      {seg.text || '—'}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <MeetingAiFieldPanel meetingDetail={meetingDetail} onNavigateAway={close} />
      </div>
    </div>,
    document.body,
  );
}

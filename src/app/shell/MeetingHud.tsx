import React from 'react';
import { Icon } from '@/shared/icons';
import { meetingHudStatusLabel, type MeetingHudDetail } from '@/shared/lib/meeting-hud-events';

interface MeetingHudProps {
  meetingHud: MeetingHudDetail | null;
  meetingHudTick: number;
  onDismiss: () => void;
}

function fmtHudElapsed(startedAt: number, _tick: number): string {
  if (!startedAt) return '';
  const ms = Date.now() - startedAt;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export function MeetingHud({ meetingHud, meetingHudTick, onDismiss }: MeetingHudProps): React.ReactElement | null {
  if (!meetingHud) return null;
  const statusLabel = meetingHudStatusLabel(meetingHud);
  const micOn = meetingHud.backend ? meetingHud.micRunning !== false : true;
  const remoteOn = !!(meetingHud.backend && meetingHud.systemRunning);

  return (
    <div className="shogun-meeting-hud-host" role="status" aria-live="polite">
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 10,
          padding: '7px 6px 7px 14px',
          borderRadius: 999,
          border: '1px solid var(--border-hi)',
          background: 'color-mix(in srgb, var(--surface) 92%, #0a0a0a)',
          boxShadow: '0 8px 28px rgba(0,0,0,0.45)',
          maxWidth: '100%',
          width: '100%',
          justifyContent: 'center',
          boxSizing: 'border-box',
        }}
      >
        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', flexShrink: 0 }} aria-hidden="true">
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: 999,
              background: micOn ? 'var(--success)' : 'var(--text-dim)',
              animation: micOn ? 'mtgStripDotPulse 1.25s ease-in-out infinite' : undefined,
            }}
          />
          {meetingHud.backend && (
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: 999,
                background: remoteOn ? 'var(--success)' : 'var(--gold)',
                animation: remoteOn ? 'mtgStripDotPulse 1.25s ease-in-out infinite' : undefined,
                animationDelay: '0.2s',
              }}
            />
          )}
          {!meetingHud.backend && [1, 2].map((i) => (
            <span
              key={i}
              style={{
                width: 5,
                height: 5,
                borderRadius: 999,
                background: 'var(--success)',
                animation: 'mtgStripDotPulse 1.25s ease-in-out infinite',
                animationDelay: `${i * 0.2}s`,
              }}
            />
          ))}
        </span>
        <span
          style={{
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            flex: '1 1 auto',
            gap: 1,
          }}
        >
          <span
            style={{
              fontSize: 14,
              fontWeight: 500,
              letterSpacing: '-0.02em',
              color: 'var(--text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontFamily: 'var(--font-sans, system-ui, sans-serif)',
            }}
          >
            {meetingHud.title || 'Untitled'}
          </span>
          {statusLabel && (
            <span
              style={{
                fontSize: 10,
                color: 'var(--text-mute)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {statusLabel}
            </span>
          )}
        </span>
        <span
          className="t-mono"
          style={{ fontSize: 11, color: 'var(--text-mute)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}
        >
          {fmtHudElapsed(meetingHud.startedAt || 0, meetingHudTick)}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Stop recording"
          title="録音を終了"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            borderRadius: 999,
            border: 'none',
            background: 'transparent',
            color: 'var(--text-mute)',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <Icon name="x" size={14} />
        </button>
      </div>
    </div>
  );
}

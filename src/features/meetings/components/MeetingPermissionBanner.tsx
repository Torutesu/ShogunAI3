import React from 'react';
import { Icon } from '@/shared/icons';

export interface MeetingPermissionBannerProps {
  /** Mic is running but remote / system audio is not captured. */
  recordingWithoutRemote?: boolean;
  busy?: boolean;
  onOpenSettings: () => void;
  onRequestAccess: () => void;
  onMicOnly: () => void;
}

export function MeetingPermissionBanner({
  recordingWithoutRemote,
  busy,
  onOpenSettings,
  onRequestAccess,
  onMicOnly,
}: MeetingPermissionBannerProps): React.ReactElement {
  const title = recordingWithoutRemote
    ? '相手の声が録音されていません'
    : '相手の声の録音には画面収録の許可が必要です';
  const desc = recordingWithoutRemote
    ? 'マイクのみ録音中です。Meet / Zoom の相手の声を文字起こしするには、Shogun AI に画面収録を許可してください。'
    : 'リモート参加者の音声は macOS の画面収録（Screen Recording）権限で取得します。許可後、再度録音を開始してください。';

  return (
    <div
      role="alert"
      style={{
        position: 'relative',
        zIndex: 9,
        margin: '0 auto 16px',
        maxWidth: 'min(640px, calc(100% - 48px))',
        padding: '12px 14px',
        borderRadius: 'var(--radius-md)',
        border: '1px solid color-mix(in srgb, var(--gold) 35%, var(--border-hi))',
        background: 'color-mix(in srgb, var(--gold) 8%, var(--surface))',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <span
          aria-hidden="true"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: 8,
            flexShrink: 0,
            background: 'color-mix(in srgb, var(--gold) 18%, transparent)',
            color: 'var(--gold)',
          }}
        >
          <Icon name="shield" size={14} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>{title}</div>
          <div style={{ fontSize: 12, lineHeight: 1.45, color: 'var(--text-mute)' }}>{desc}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={onOpenSettings}
            >
              システム設定を開く
              <Icon name="arrowUpRight" size={12} />
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy}
              onClick={onRequestAccess}
            >
              許可をリクエスト
            </button>
            {!recordingWithoutRemote && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={busy}
                onClick={onMicOnly}
              >
                マイクのみ録音
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

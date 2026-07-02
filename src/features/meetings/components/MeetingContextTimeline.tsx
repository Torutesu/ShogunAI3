import { Icon } from '@/shared/icons';

export interface MeetingContextTimelineProps {
  items: any[];
  loading?: boolean;
  emptyHint?: string;
  onOpenMemory?: (item: any) => void;
  onAskChat?: (item: any) => void;
  onOpenMeetingContext?: (item: any) => void;
  onOpenMeetingActions?: (item: any) => void;
}

export function MeetingContextTimeline({
  items,
  loading,
  emptyHint,
  onOpenMemory,
  onAskChat,
  onOpenMeetingContext,
  onOpenMeetingActions,
}: MeetingContextTimelineProps) {
  if (loading) {
    return (
      <div style={{ padding: '12px 4px', fontSize: 12, color: 'var(--text-mute)' }}>
        文脈タイムラインを読み込み中…
      </div>
    );
  }
  if (!items || items.length === 0) {
    return (
      <div style={{ padding: '12px 4px', fontSize: 12, color: 'var(--text-mute)', lineHeight: 1.5 }}>
        {emptyHint || '録音中の画面キャプチャと文字起こしが、同じ時間軸でここに並びます。'}
      </div>
    );
  }
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        maxHeight: 420,
        overflowY: 'auto',
        padding: '4px 2px',
      }}
    >
      {items.map(function (item, idx) {
        const kind = item.kind || 'transcript';
        const isCapture = kind === 'capture';
        const label = item.offset_label || '--:--';
        const title = item.title || (isCapture ? 'Screen' : 'Transcript');
        const text = item.text || '';
        const speaker = item.speaker;
        const canOpenMemory = isCapture && !!String(item.memory_id || '').trim() && !!onOpenMemory;
        const canAskChat = !!text && !!onAskChat;
        const canOpenMeetingContext = !!onOpenMeetingContext;
        const canOpenMeetingActions = !!onOpenMeetingActions;
        return (
          <div
            key={(item.memory_id || '') + '-' + idx}
            style={{
              display: 'grid',
              gridTemplateColumns: '52px 1fr',
              gap: 10,
              alignItems: 'start',
              padding: '8px 10px',
              borderRadius: 10,
              border: '1px solid var(--border)',
              background: isCapture
                ? 'color-mix(in srgb, var(--text-mute) 6%, transparent)'
                : 'color-mix(in srgb, var(--gold) 8%, transparent)',
            }}
          >
            <div style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums', color: 'var(--text-mute)', paddingTop: 2 }}>
              {label}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: '0.04em',
                    textTransform: 'uppercase',
                    color: isCapture ? 'var(--text-mute)' : 'var(--gold)',
                  }}
                >
                  {isCapture ? 'Screen' : (speaker || 'Speech')}
                </span>
                {item.live && (
                  <span style={{ fontSize: 10, color: 'var(--success)' }}>LIVE</span>
                )}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.45, wordBreak: 'break-word' }}>
                {isCapture ? (title + (text ? '\n' + text : '')) : text}
              </div>
              {(canOpenMemory || canAskChat || canOpenMeetingContext || canOpenMeetingActions) ? (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                  {canOpenMemory ? (
                    <button
                      type="button"
                      onClick={() => onOpenMemory?.(item)}
                      style={{
                        height: 24,
                        padding: '0 8px',
                        borderRadius: 999,
                        border: '1px solid var(--border-hi)',
                        background: 'var(--surface)',
                        color: 'var(--text)',
                        fontSize: 11,
                        cursor: 'pointer',
                      }}
                    >
                      Open Memory
                    </button>
                  ) : null}
                  {canOpenMeetingContext ? (
                    <button
                      type="button"
                      onClick={() => onOpenMeetingContext?.(item)}
                      style={{
                        height: 24,
                        padding: '0 8px',
                        borderRadius: 999,
                        border: '1px solid var(--border-hi)',
                        background: 'var(--surface)',
                        color: 'var(--text)',
                        fontSize: 11,
                        cursor: 'pointer',
                      }}
                    >
                      Open Meeting Detail
                    </button>
                  ) : null}
                  {canOpenMeetingActions ? (
                    <button
                      type="button"
                      onClick={() => onOpenMeetingActions?.(item)}
                      style={{
                        height: 24,
                        padding: '0 8px',
                        borderRadius: 999,
                        border: '1px solid var(--border-hi)',
                        background: 'var(--surface)',
                        color: 'var(--text)',
                        fontSize: 11,
                        cursor: 'pointer',
                      }}
                    >
                      Actions
                    </button>
                  ) : null}
                  {canAskChat ? (
                    <button
                      type="button"
                      onClick={() => onAskChat?.(item)}
                      style={{
                        height: 24,
                        padding: '0 8px',
                        borderRadius: 999,
                        border: '1px solid var(--border-hi)',
                        background: 'var(--surface)',
                        color: 'var(--text)',
                        fontSize: 11,
                        cursor: 'pointer',
                      }}
                    >
                      Ask Chat
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function MeetingContextTimelineHeader() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
      <Icon name="layers" size={14} />
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>文脈タイムライン</span>
      <span style={{ fontSize: 11, color: 'var(--text-mute)' }}>画面と発言を同じ時刻軸で表示</span>
    </div>
  );
}

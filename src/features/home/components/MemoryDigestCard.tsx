import { Icon } from '@/shared/icons';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';
import { smartSnoozePresets } from '../lib/runtime';

export interface MemoryDigestCardProps {
  memoryDigest: any;
  setMemoryDigest: (fn: (prev: any) => any) => void;
  expandedHighlightId: any;
  setExpandedHighlightId: (v: any) => void;
  entityRollupCache: Record<string, any>;
  setEntityRollupCache: (fn: (prev: any) => any) => void;
}

export function MemoryDigestCard({
  memoryDigest,
  setMemoryDigest,
  expandedHighlightId,
  setExpandedHighlightId,
  entityRollupCache,
  setEntityRollupCache,
}: MemoryDigestCardProps) {
  if (!memoryDigest) return null;

  const hasContent =
    (memoryDigest.highlights && memoryDigest.highlights.length > 0) ||
    memoryDigest.week_rollup ||
    memoryDigest.day_rollup;

  if (!hasContent) return null;

  return (
    <div className="card" style={{ width: '100%', maxWidth: 760, marginInline: 'auto', padding: 24, marginTop: 18, background: 'var(--surface)', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="row" style={{ alignItems: 'baseline', gap: 12 }}>
        <div className="t-mono gold" style={{ textTransform: 'none', letterSpacing: '0.02em' }}>
          <span className="en-only">Memory digest</span>
          <span className="jp">メモリのハイライト</span>
        </div>
        <span className="spacer" />
      </div>

      {memoryDigest.day_rollup && (
        <div style={{ borderLeft: '2px solid var(--gold)', paddingLeft: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-mute)', letterSpacing: '0.12em' }}>
            <span className="en-only">TODAY</span>
            <span className="jp">今日</span>
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3 }}>{memoryDigest.day_rollup.title}</div>
          {Array.isArray(memoryDigest.day_rollup.keyPoints) && (
            <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 3 }}>
              {memoryDigest.day_rollup.keyPoints.slice(0, 4).map((k: any, i: number) => (
                <li key={i} style={{ fontSize: 12, color: 'var(--text-mute)', lineHeight: 1.5 }}>{k}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {memoryDigest.week_rollup && (
        <div style={{ borderLeft: '2px solid var(--border-hi)', paddingLeft: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-mute)', letterSpacing: '0.12em' }}>
            <span className="en-only">THIS WEEK</span>
            <span className="jp">今週</span>
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3 }}>{memoryDigest.week_rollup.title}</div>
          {Array.isArray(memoryDigest.week_rollup.keyPoints) && (
            <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 3 }}>
              {memoryDigest.week_rollup.keyPoints.slice(0, 4).map((k: any, i: number) => (
                <li key={i} style={{ fontSize: 12, color: 'var(--text-mute)', lineHeight: 1.5 }}>{k}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {(() => {
        const nowMs = Date.now();
        const unreadHighlights = Array.isArray(memoryDigest.highlights)
          ? memoryDigest.highlights.filter((h: any) =>
              !h.acknowledgedAt && !(h.snoozeUntil && h.snoozeUntil > nowMs),
            )
          : [];
        if (unreadHighlights.length === 0) return null;
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-mute)', letterSpacing: '0.12em' }}>
                <span className="en-only">NEEDS ATTENTION</span>
                <span className="jp">要確認</span>
              </div>
              <span className="spacer" />
              <button
                type="button"
                style={{
                  padding: '2px 0', border: 'none', background: 'transparent',
                  color: 'var(--text-dim)', fontSize: 10, cursor: 'pointer',
                  fontFamily: 'inherit', textDecoration: 'underline',
                }}
                title="Mark all shown items as read"
                onClick={async () => {
                  const items = unreadHighlights.map((h: any) => ({
                    targetId: h.targetId, targetKind: h.targetKind || 'item',
                  }));
                  if (items.length === 0) return;
                  setMemoryDigest((prev: any) => prev ? {
                    ...prev,
                    highlights: (prev.highlights || []).map((h: any) => ({
                      ...h, acknowledgedAt: h.acknowledgedAt || Date.now(),
                    })),
                  } : prev);
                  window.dispatchEvent(new CustomEvent('shogun-memory-high-count', { detail: { count: 0 } }));
                  await runRuntimeAction('memory.summary.acknowledge', {
                    items, acknowledged: true,
                  }, { silentError: true });
                }}
              >Mark all read</button>
            </div>
            {unreadHighlights.slice(0, 5).map((h: any) => {
              const expanded = expandedHighlightId === h.targetId;
              const allPoints = Array.isArray(h.keyPoints) ? h.keyPoints : [];
              const ent = h.entityId
                ? (entityRollupCache[h.entityId] || null)
                : null;
              const toggleExpand = () => {
                if (expanded) {
                  setExpandedHighlightId(null);
                  return;
                }
                setExpandedHighlightId(h.targetId);
                if (h.entityId && !entityRollupCache[h.entityId]) {
                  setEntityRollupCache((prev: any) => ({ ...prev, [h.entityId]: { rollup: null, loading: true } }));
                  const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
                  runRuntimeAction('memory.rollup.entity.get', {
                    entityId: h.entityId, entityLabel: h.entityId, lang,
                  }, { silentError: true }).then((res: any) => {
                    const rollup = res?.ok && res.data?.rollup ? res.data.rollup : null;
                    setEntityRollupCache((prev: any) => ({ ...prev, [h.entityId]: { rollup, loading: false } }));
                  }).catch(() => {
                    setEntityRollupCache((prev: any) => ({ ...prev, [h.entityId]: { rollup: null, loading: false } }));
                  });
                }
              };
              return (
                <div
                  key={h.targetId}
                  role="button"
                  tabIndex={0}
                  onClick={toggleExpand}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(); } }}
                  style={{
                    borderLeft: (h.userPriority || h.priority) === 'high' ? '2px solid var(--gold)' : '2px solid var(--border)',
                    paddingLeft: 12,
                    display: 'flex', flexDirection: 'column', gap: expanded ? 8 : 3,
                    cursor: 'pointer',
                    transition: 'gap 120ms',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, lineHeight: 1.35, wordBreak: 'break-word', flex: 1, minWidth: 0 }}>{h.title}</div>
                    <span className="t-mono" style={{ fontSize: 9, color: 'var(--text-dim)' }}>{expanded ? '−' : '+'}</span>
                  </div>
                  {!expanded && allPoints[0] && (
                    <div style={{ fontSize: 11, color: 'var(--text-mute)', lineHeight: 1.5 }}>{allPoints[0]}</div>
                  )}
                  {expanded && (
                    <>
                      {allPoints.length > 0 && (
                        <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 3 }}>
                          {allPoints.map((p: any, i: number) => (
                            <li key={i} style={{ fontSize: 12, color: i === 0 ? 'var(--text)' : 'var(--text-mute)', lineHeight: 1.5 }}>{p}</li>
                          ))}
                        </ul>
                      )}
                      {h.reason && (
                        <div style={{ fontSize: 10, color: 'var(--text-dim)', fontStyle: 'italic' }}>{h.reason}</div>
                      )}
                      <div className="t-mono" style={{ fontSize: 9, color: 'var(--text-dim)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <span>{(h.sourceType || '').toUpperCase()}</span>
                        {h.entityId && <span title={h.entityId}>· entity {String(h.entityId).slice(0, 16)}…</span>}
                      </div>
                      {h.entityId && ent && (
                        <div style={{ marginTop: 4, padding: '8px 10px', background: 'color-mix(in srgb, var(--surface-2) 80%, var(--bg))', borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <div className="t-mono" style={{ fontSize: 9, color: 'var(--text-mute)', letterSpacing: '0.1em' }}>RELATED · 関連</div>
                          {ent.loading && (
                            <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                              <span className="en-only">Loading related items…</span>
                              <span className="jp">関連アイテムを読み込み中…</span>
                            </div>
                          )}
                          {ent.rollup && (
                            <>
                              <div style={{ fontSize: 12, fontWeight: 500 }}>{ent.rollup.title}</div>
                              {Array.isArray(ent.rollup.keyPoints) && ent.rollup.keyPoints.length > 0 && (
                                <ul style={{ margin: 0, paddingLeft: 14, display: 'flex', flexDirection: 'column', gap: 2 }}>
                                  {ent.rollup.keyPoints.slice(0, 4).map((k: any, i: number) => (
                                    <li key={i} style={{ fontSize: 11, color: 'var(--text-mute)', lineHeight: 1.5 }}>{k}</li>
                                  ))}
                                </ul>
                              )}
                            </>
                          )}
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                        <button
                          type="button"
                          onClick={async (e) => {
                            e.stopPropagation();
                            await runRuntimeAction('memory.summary.acknowledge', {
                              items: [{ targetId: h.targetId, targetKind: h.targetKind || 'item' }],
                              acknowledged: true,
                            }, { silentError: true });
                            setMemoryDigest((prev: any) => prev ? {
                              ...prev,
                              highlights: (prev.highlights || []).map((x: any) => x.targetId === h.targetId ? { ...x, acknowledgedAt: Date.now() } : x),
                            } : prev);
                          }}
                          style={{ padding: '2px 0', border: 'none', background: 'transparent', color: 'var(--text-dim)', fontSize: 10, cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline' }}
                        >Mark read</button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            window.dispatchEvent(new Event('shogun-jump-memory-timeline'));
                            (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('memory');
                          }}
                          style={{ padding: '2px 0', border: 'none', background: 'transparent', color: 'var(--text-dim)', fontSize: 10, cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline' }}
                        >Open in Memory</button>
                        {[
                          { label: '1h', label_jp: '1時間', compute: (now: number) => now + 60 * 60 * 1000 },
                          { label: 'Tomorrow 9am', label_jp: '明日9時', compute: (now: number) => smartSnoozePresets(new Date(now)).tomorrowMorning },
                          { label: 'Next Monday', label_jp: '来週月曜', compute: (now: number) => smartSnoozePresets(new Date(now)).nextMondayMorning },
                        ].map((opt) => (
                          <button
                            key={opt.label}
                            type="button"
                            onClick={async (e) => {
                              e.stopPropagation();
                              const untilMs = opt.compute(Date.now());
                              setMemoryDigest((prev: any) => prev ? {
                                ...prev,
                                highlights: (prev.highlights || []).map((x: any) => x.targetId === h.targetId ? { ...x, snoozeUntil: untilMs } : x),
                              } : prev);
                              await runRuntimeAction('memory.summary.snooze', {
                                targetId: h.targetId, targetKind: h.targetKind || 'item', untilMs,
                              }, { silentError: true });
                            }}
                            style={{ padding: '2px 0', border: 'none', background: 'transparent', color: 'var(--text-dim)', fontSize: 10, cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline' }}
                            title={`Snooze for ${opt.label}`}
                          >
                            <span className="en-only">Snooze · {opt.label}</span>
                            <span className="jp">後で · {opt.label_jp}</span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        );
      })()}

      <div style={{ display: 'flex', gap: 8, alignSelf: 'stretch', alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          style={{ fontSize: 11 }}
          onClick={() => {
            window.dispatchEvent(new Event('shogun-jump-memory-timeline'));
            (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('memory');
          }}
        >
          <span className="en-only">Open Memory</span>
          <span className="jp">メモリを開く</span>
          <Icon name="arrowRight" size={12} />
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          style={{ fontSize: 11 }}
          title="Copy this digest as Markdown (for weekly status notes, journals, etc.)"
          onClick={async () => {
            const md = (() => {
              const lines: string[] = [];
              const day = memoryDigest && memoryDigest.day_rollup;
              const week = memoryDigest && memoryDigest.week_rollup;
              const highlights = (memoryDigest && memoryDigest.highlights) || [];
              if (day) {
                lines.push(`## Today — ${day.title || ''}`.trim());
                (day.keyPoints || []).forEach((k: any) => lines.push(`- ${k}`));
                lines.push('');
              }
              if (week) {
                lines.push(`## This week — ${week.title || ''}`.trim());
                (week.keyPoints || []).forEach((k: any) => lines.push(`- ${k}`));
                lines.push('');
              }
              const unread = highlights.filter((h: any) => !h.acknowledgedAt);
              if (unread.length > 0) {
                lines.push('## Needs attention');
                unread.slice(0, 8).forEach((h: any) => {
                  const tag = (h.userPriority || h.priority || '').toUpperCase();
                  lines.push(`- **[${tag}] ${h.title}**${h.keyPoints && h.keyPoints[0] ? ` — ${h.keyPoints[0]}` : ''}`);
                });
                lines.push('');
              }
              if (lines.length === 0) lines.push('_(empty digest)_');
              return lines.join('\n').trimEnd() + '\n';
            })();
            try {
              if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(md);
                (window as any).SHOGUN_RUNTIME?.pushToast?.('Digest copied as Markdown', 'success');
              } else {
                (window as any).SHOGUN_RUNTIME?.pushToast?.('Clipboard unavailable', 'warn');
              }
            } catch (_) {
              (window as any).SHOGUN_RUNTIME?.pushToast?.('Copy failed', 'error');
            }
          }}
        >
          <Icon name="file" size={12} />
          <span className="en-only">Copy as Markdown</span>
          <span className="jp">Markdown でコピー</span>
        </button>
      </div>
    </div>
  );
}

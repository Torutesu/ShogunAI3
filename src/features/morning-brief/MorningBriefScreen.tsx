import { useMorningBrief } from './hooks/useMorningBrief';
import { BriefItemCard } from './components/BriefItemCard';
import { POSTURE_LABEL, formatFocusBlocks } from './lib/posture';

export function MorningBriefScreen() {
  const { brief, legacyV1, loading, error, reload, onAction, onContext } = useMorningBrief();

  if (loading) {
    return (
      <div className="content-inner morning-brief-root" style={{ padding: '80px 40px' }}>
        <div className="t-mono" style={{ color: 'var(--text-mute)' }}>
          Loading Morning Brief…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="content-inner morning-brief-root" style={{ padding: '80px 40px' }}>
        <div style={{ color: 'var(--danger, #A65D5D)', marginBottom: 16 }}>{error}</div>
        <button type="button" className="btn btn-sm btn-secondary" onClick={reload}>
          Retry
        </button>
      </div>
    );
  }

  if (legacyV1) {
    const sections = Array.isArray(legacyV1.sections) ? legacyV1.sections : [];
    return (
      <div
        className="content-inner morning-brief-root"
        style={{ maxWidth: 720, margin: '0 auto', padding: '80px 40px 64px' }}
      >
        <div className="t-mono" style={{ marginBottom: 12 }}>
          Morning Brief <span style={{ color: 'var(--text-dim)' }}>v1</span>
        </div>
        <h1 style={{ fontSize: 28, fontWeight: 600, margin: '0 0 24px' }}>Legacy format</h1>
        {sections.length === 0 ? (
          <div style={{ color: 'var(--text-mute)' }}>
            No sections yet. Enable v2 in Settings → Morning Brief or add{' '}
            <code>?brief=v2</code> to the URL.
          </div>
        ) : (
          sections.map((s, i) => (
            <div key={i} className="mb-card morning-brief-card" style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>{s.title}</div>
              <div style={{ color: 'var(--text-mute)', fontSize: 14, lineHeight: 1.5 }}>
                {s.body}
              </div>
            </div>
          ))
        )}
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          style={{ marginTop: 16 }}
          onClick={reload}
        >
          Refresh
        </button>
      </div>
    );
  }

  if (!brief) return null;

  const summary = brief.summary || {};
  const items = Array.isArray(brief.items) ? brief.items : [];
  const deferred = Array.isArray(brief.deferred) ? brief.deferred : [];
  const focusLine = formatFocusBlocks(summary.focus_blocks);
  const dateLabel = brief.date || '';
  const postureKey = summary.posture || 'focus';
  const postureLabel = (POSTURE_LABEL as Record<string, string>)[postureKey] || postureKey;

  return (
    <div
      className="content-inner morning-brief-root"
      style={{ maxWidth: 640, margin: '0 auto', padding: '56px 40px 64px' }}
    >
      <div className="mb-header">
        <div className="mb-header-top">
          <span className="mb-title-icon" aria-hidden>
            {'⚔'}
          </span>
          <div>
            <div className="t-mono mb-header-kicker">Morning Brief</div>
            <h1 className="mb-header-date">{dateLabel}</h1>
          </div>
          <span className="spacer" />
          <button type="button" className="btn btn-sm btn-ghost" onClick={reload}>
            Refresh
          </button>
        </div>
      </div>

      <div className="mb-card morning-brief-card mb-summary">
        <div className="mb-headline">{summary.headline}</div>
        <div className="mb-summary-meta">
          <span className="mb-posture">{postureLabel}</span>
          {summary.total_meeting_minutes != null ? (
            <span className="t-mono mb-meta-muted">
              · {summary.total_meeting_minutes} min meetings
            </span>
          ) : null}
        </div>
        {focusLine ? (
          <div className="mb-focus-line">
            Focus: <span className="gold">{focusLine}</span>
          </div>
        ) : null}
      </div>

      <div className="mb-items" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {items.map((item, i) => (
          <BriefItemCard
            key={item.id || i}
            item={item}
            index={i}
            onAction={onAction}
            onContext={onContext}
          />
        ))}
      </div>

      {deferred.length > 0 ? (
        <div className="mb-deferred" style={{ marginTop: 24 }}>
          <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 8 }}>
            DEFERRED · {deferred.length}
          </div>
          <div className="mb-card morning-brief-card" style={{ padding: 16 }}>
            <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-mute)', fontSize: 13 }}>
              {deferred.map((d) => (
                <li key={d.id} style={{ marginBottom: 6 }}>
                  {d.snippet}
                  {d.reason ? (
                    <span
                      className="t-mono"
                      style={{ fontSize: 10, marginLeft: 8, color: 'var(--text-dim)' }}
                    >
                      ({d.reason})
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 20 }}>
        Tip: open with <code>?brief=v2</code> to force AMC v2 in the browser mock.
      </div>
    </div>
  );
}

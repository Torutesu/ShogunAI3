/* global Icon, React, BriefTelemetry */
const { useState, useEffect, useCallback } = React;

function runRuntimeMB(actionKey, payload, options) {
  if (!window.SHOGUN_RUNTIME || !window.SHOGUN_RUNTIME.executeAction) {
    return Promise.resolve({ ok: false });
  }
  return window.SHOGUN_RUNTIME.executeAction(actionKey, payload || {}, options || {});
}

const POSTURE_LABEL = {
  focus: "Focus",
  "meeting-heavy": "Meeting-heavy",
  recovery: "Recovery",
  launch: "Launch",
};

const CONTEXT_ICON = {
  document: "note",
  person: "users",
  decision: "check",
  slack_thread: "chat",
  email: "mail",
  commit: "terminal",
  calendar: "calendar",
};

function contextIconName(type) {
  return CONTEXT_ICON[type] || "file";
}

function formatFocusBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  return blocks
    .map((b) => {
      const h = Math.round((b.duration_minutes || 0) / 60);
      const hm = h > 0 ? `${h}h` : `${b.duration_minutes || 0}m`;
      return `${b.start}-${b.end} (${hm})`;
    })
    .join(" · ");
}

/** @param {{ item: object, index: number, onAction: Function, onContext: Function }} props */
function BriefItemCard({ item, index, onAction, onContext }) {
  const num = String(index + 1).padStart(2, "0");
  const ctx = Array.isArray(item.related_context) ? item.related_context.slice(0, 3) : [];

  return (
    <div className="mb-card morning-brief-card">
      <div className="mb-item-head">
        <span className="mb-item-num">{num}</span>
        <div className="mb-item-head-text">
          {item.time_hint ? (
            <div className="t-mono mb-time-hint">{item.time_hint}</div>
          ) : null}
          <div className="mb-what">{item.what}</div>
        </div>
      </div>
      <div className="mb-why">{item.why_now}</div>
      {ctx.length > 0 ? (
        <div className="mb-chips">
          {ctx.map((c, i) => (
            <button
              key={i}
              type="button"
              className="mb-chip"
              onClick={() => onContext(c)}
              title={c.uri || ""}
            >
              <Icon name={contextIconName(c.type)} size={12} />
              <span>{c.title}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="mb-cta-row">
        <button
          type="button"
          className="btn btn-sm btn-secondary mb-cta"
          onClick={() => onAction(item)}
        >
          {item.next_action && item.next_action.label ? item.next_action.label : "Next"}
        </button>
      </div>
    </div>
  );
}

function ScreenMorningBrief() {
  const SB = window.ShogunMorningBrief;
  const [brief, setBrief] = useState(null);
  const [legacyV1, setLegacyV1] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!SB) {
      setError("ShogunMorningBrief not loaded");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const payload = SB.buildBriefGetPayload();
    const res = await runRuntimeMB("brief.get", payload, { silentError: true });
    const unwrapped = SB.unwrapBriefGetRegistryResult(res);
    if (!unwrapped.ok || !unwrapped.brief) {
      setError("Could not load Morning Brief");
      setBrief(null);
      setLegacyV1(null);
      setLoading(false);
      return;
    }
    const b = unwrapped.brief;
    if (b.version === "2.0") {
      setBrief(b);
      setLegacyV1(null);
      if (window.BriefTelemetry) {
        window.BriefTelemetry.log(window.BriefTelemetry.EVENTS.BRIEF_RENDERED, {
          version: "2.0",
          items: (b.items && b.items.length) || 0,
        });
      }
    } else {
      setBrief(null);
      setLegacyV1(b);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onAction = async (item) => {
    if (!SB || !item || !item.next_action) return;
    const spec = SB.resolveNextAction(item.next_action);
    if (spec.skip) return;
    if (window.BriefTelemetry) {
      window.BriefTelemetry.log(window.BriefTelemetry.EVENTS.NEXT_ACTION_CLICK, {
        item_id: item.id,
        key: spec.key,
      });
    }
    await runRuntimeMB(spec.key, spec.payload, {
      successMessage: item.next_action.label || "Done",
    });
  };

  const onContext = async (c) => {
    const q = c.title || c.uri || "";
    await runRuntimeMB(
      "memory.search",
      { query: q, limit: 15, source: "morning_brief_context" },
      { successMessage: "Search started", silentError: true },
    );
  };

  if (loading) {
    return (
      <div className="content-inner morning-brief-root" style={{ padding: "80px 40px" }}>
        <div className="t-mono" style={{ color: "var(--text-mute)" }}>
          Loading Morning Brief…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="content-inner morning-brief-root" style={{ padding: "80px 40px" }}>
        <div style={{ color: "var(--danger, #A65D5D)", marginBottom: 16 }}>{error}</div>
        <button type="button" className="btn btn-sm btn-secondary" onClick={load}>
          Retry
        </button>
      </div>
    );
  }

  if (legacyV1) {
    const sections = Array.isArray(legacyV1.sections) ? legacyV1.sections : [];
    return (
      <div className="content-inner morning-brief-root" style={{ maxWidth: 720, margin: "0 auto", padding: "80px 40px 64px" }}>
        <div className="t-mono" style={{ marginBottom: 12 }}>
          Morning Brief <span style={{ color: "var(--text-dim)" }}>v1</span>
        </div>
        <h1 style={{ fontSize: 28, fontWeight: 600, margin: "0 0 24px" }}>Legacy format</h1>
        {sections.length === 0 ? (
          <div style={{ color: "var(--text-mute)" }}>No sections yet. Enable v2 in Settings → Morning Brief or add <code>?brief=v2</code> to the URL.</div>
        ) : (
          sections.map((s, i) => (
            <div key={i} className="mb-card morning-brief-card" style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>{s.title}</div>
              <div style={{ color: "var(--text-mute)", fontSize: 14, lineHeight: 1.5 }}>{s.body}</div>
            </div>
          ))
        )}
        <button type="button" className="btn btn-sm btn-ghost" style={{ marginTop: 16 }} onClick={load}>
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
  const dateLabel = brief.date || "";
  const postureKey = summary.posture || "focus";
  const postureLabel = POSTURE_LABEL[postureKey] || postureKey;

  return (
    <div className="content-inner morning-brief-root" style={{ maxWidth: 640, margin: "0 auto", padding: "56px 40px 64px" }}>
      <div className="mb-header">
        <div className="mb-header-top">
          <span className="mb-title-icon" aria-hidden>
            {"\u2694"}
          </span>
          <div>
            <div className="t-mono mb-header-kicker">Morning Brief</div>
            <h1 className="mb-header-date">{dateLabel}</h1>
          </div>
          <span className="spacer" />
          <button type="button" className="btn btn-sm btn-ghost" onClick={load}>
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

      <div className="mb-items" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {items.map((item, i) => (
          <BriefItemCard key={item.id || i} item={item} index={i} onAction={onAction} onContext={onContext} />
        ))}
      </div>

      {deferred.length > 0 ? (
        <div className="mb-deferred" style={{ marginTop: 24 }}>
          <div className="t-mono" style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 8 }}>
            DEFERRED · {deferred.length}
          </div>
          <div className="mb-card morning-brief-card" style={{ padding: 16 }}>
            <ul style={{ margin: 0, paddingLeft: 18, color: "var(--text-mute)", fontSize: 13 }}>
              {deferred.map((d) => (
                <li key={d.id} style={{ marginBottom: 6 }}>
                  {d.snippet}
                  {d.reason ? (
                    <span className="t-mono" style={{ fontSize: 10, marginLeft: 8, color: "var(--text-dim)" }}>
                      ({d.reason})
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <div className="t-mono" style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 20 }}>
        Tip: open with <code>?brief=v2</code> to force AMC v2 in the browser mock.
      </div>
    </div>
  );
}

window.ScreenMorningBrief = ScreenMorningBrief;

import * as ReactDOM from 'react-dom';
import { Icon } from '@/shared/icons';
import { msToLocal, msToRelative } from '@/features/memory-debug/lib/format';
import { useScreenContextProbe } from '@/features/memory-debug/hooks/useScreenContextProbe';
import type { SamplerCoverageAppData, SamplerCoverageIssueData } from '@/features/memory-debug/types';

export interface ContextPanelProps {
  open: boolean;
  anchor: { left: number; bottom: number; width: number };
  onClose: () => void;
  onOpenSettings: (pane: string) => void;
}

function focusKey(focus: {
  appName?: string | null;
  bundleId?: string | null;
  windowTitle?: string | null;
} | null | undefined) {
  if (!focus) return "";
  return [
    focus.appName || "",
    focus.bundleId || "",
    focus.windowTitle || "",
  ].join("\u{1f}");
}

function focusLabel(focus: {
  appName?: string | null;
  bundleId?: string | null;
  windowTitle?: string | null;
} | null | undefined) {
  if (!focus) return "—";
  const parts = [focus.appName || "", focus.windowTitle || ""].filter(Boolean);
  return parts.length ? parts.join(" — ") : "—";
}

function axReasonLabel(reason: string | null | undefined) {
  switch (reason) {
    case 'accessibility_untrusted':
      return 'Accessibility off';
    case 'focused_element_unavailable':
      return 'No focused control';
    case 'focused_element_fields_empty':
      return 'No focused text';
    case 'focused_tree_fallback':
      return 'Tree fallback';
    case 'secure_text_field':
      return 'Secure field skipped';
    case 'focused_element_snapshot':
    case 'browser_preview':
    case undefined:
    case null:
      return null;
    default:
      return 'Limited AX detail';
  }
}

function pct(part: number | null | undefined, total: number | null | undefined) {
  if (!part || !total) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}

function qualityBreakdown(row: {
  strongTextReadable?: number;
  partialTextReadable?: number;
  weakTextReadable?: number;
}) {
  return `strong ${row.strongTextReadable ?? 0} · partial ${row.partialTextReadable ?? 0} · weak ${row.weakTextReadable ?? 0}`;
}

function qualityRateBreakdown(row: {
  total?: number;
  strongTextReadable?: number;
  weakTextReadable?: number;
}) {
  return `strong ${pct(row.strongTextReadable, row.total)} · weak ${pct(row.weakTextReadable, row.total)}`;
}

function signalKeysLabel(keys: string[] | null | undefined) {
  return keys?.length ? `keys ${keys.join(', ')}` : '';
}

function appCoverageLabel(row: SamplerCoverageAppData) {
  if (row.actionableSamples > 0) {
    const reason = row.latestActionableReason
      ? `${row.latestActionableReason}${row.latestActionableAxReason ? ` · ${row.latestActionableAxReason}` : ''}`
      : 'actionable';
    const keys = signalKeysLabel(row.latestActionableAxTextSignalKeys);
    return `${row.actionableSamples} action · ${row.unreadable} unreadable · ${reason}${keys ? ` · ${keys}` : ''}`;
  }
  const fallback =
    row.focusOnly > 0
      ? `${row.focusOnly} focus only`
      : row.empty > 0
        ? `${row.empty} empty`
        : row.skipped > 0
          ? `${row.skipped} skipped`
          : row.latestReason;
  const detail = row.latestTextChars != null ? `${row.latestTextChars} chars` : fallback;
  if (row.unreadable > 0) {
    return `${row.textReadable}/${row.total} readable · ${qualityBreakdown(row)} · ${row.unreadable} unreadable expected`;
  }
  return `${row.textReadable}/${row.total} readable · ${qualityBreakdown(row)} · ${detail ?? "no detail"}`;
}

function issueCoverageLabel(row: SamplerCoverageIssueData) {
  const where = row.latestAppName
    ? ` · ${row.latestAppName}${row.latestWindowTitle ? ` / ${row.latestWindowTitle}` : ''}`
    : '';
  const readable = `${row.textReadable}/${row.total} readable · ${qualityBreakdown(row)}`;
  const priority = row.actionable ? 'Action needed' : 'Expected';
  const reason = `${row.reason}${row.axReason ? ` · ${row.axReason}` : ''}`;
  const keys = signalKeysLabel(row.latestAxTextSignalKeys);
  return `${priority}: ${row.recommendedAction} (${row.severity.toUpperCase()} · ${reason} · ${readable} · ${row.unreadable} unreadable${keys ? ` · ${keys}` : ''}${where})`;
}

export function ContextPanel(props: ContextPanelProps) {
  const { desktop, probe, capturedAtMs, busy, err, refresh } = useScreenContextProbe({
    enabled: props.open,
    intervalMs: 3000,
  });
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 420;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 720;
  const panelWidth = Math.min(
    Math.max(props.anchor.width, 320),
    Math.max(240, viewportWidth - 24),
  );
  const panelMaxHeight = Math.max(240, viewportHeight - props.anchor.bottom - 12);

  const capture = probe?.captureStatus ?? null;
  const context = probe?.hummingbirdContext ?? null;
  const health = probe?.screenContextHealth ?? null;
  const decision = probe?.lastSamplerDecision ?? null;
  const coverage = probe?.samplerCoverage ?? null;
  const coverageApps = (coverage?.byApp ?? []).slice(0, 3);
  const weakCoverageApps = (coverage?.byApp ?? [])
    .filter((row) => row.weakTextReadable > 0)
    .slice()
    .sort((a, b) => {
      const weakRateA = a.total ? a.weakTextReadable / a.total : 0;
      const weakRateB = b.total ? b.weakTextReadable / b.total : 0;
      return weakRateB - weakRateA
        || b.weakTextReadable - a.weakTextReadable
        || a.appName.localeCompare(b.appName);
    })
    .slice(0, 3);
  const topIssue = coverage?.byIssue?.[0] ?? null;
  const unreadableSamples = coverage ? Math.max(coverage.total - coverage.textReadable, 0) : 0;
  const actionableIssueCount = coverage?.byIssue.filter((row) => row.actionable).length ?? 0;
  const axSignalKeys = context?.axTextSignalKeys ?? health?.axTextSignalKeys ?? [];
  const axSignalQuality = context?.axTextSignalQuality ?? health?.axTextSignalQuality ?? null;
  const axReason = axReasonLabel(context?.axDiagnostics?.reason);
  const captureFocus = capture?.frontmostFocus ?? null;
  const contextFocus = context?.frontmostFocus ?? null;
  const focusMismatch =
    !!captureFocus &&
    !!contextFocus &&
    focusKey(captureFocus) !== focusKey(contextFocus);
  const statusLabel =
    health?.label ??
    (focusMismatch ? 'Focus mismatch detected' : 'Focus aligned');
  const statusMessage =
    health?.message ??
    (focusMismatch
      ? 'Capture and Hummingbird disagree on the current frontmost app.'
      : 'Capture and Hummingbird agree on the current frontmost app.');
  const statusColor =
    health?.state === 'error'
      ? 'var(--danger)'
      : health?.state === 'warn'
        ? 'var(--warning)'
        : 'var(--text)';

  if (!props.open) return null;
  return ReactDOM.createPortal(
    <>
      <div
        role="presentation"
        style={{ position: 'fixed', inset: 0, zIndex: 1078 }}
        onMouseDown={props.onClose}
      />
      <div
        className="context-panel"
        style={{
          left: props.anchor.left,
          bottom: props.anchor.bottom,
          width: panelWidth,
          maxHeight: panelMaxHeight,
          overflowY: 'auto',
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="context-panel-title">Data and Privacy</div>
        <div className="context-awareness-card">
          <button type="button" className="context-awareness-close" onClick={props.onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
          <div className="context-awareness-heading">Context Awareness</div>
          <div className="context-panel-body-copy">
            SHOGUN AI remembers your work across apps, no integrations needed.
          </div>
          <div style={{
            marginTop: 10,
            paddingTop: 10,
            borderTop: '1px solid var(--border)',
            display: 'grid',
            gap: 6,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>Live context</div>
              <button
                type="button"
                className="context-link-btn"
                style={{ marginTop: 0 }}
                onClick={() => { void refresh(); }}
              >
                {busy ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.45, color: 'var(--text)' }}>
              {desktop ? (
                probe ? (
                  <>
                    <div>Frontmost: {focusLabel(contextFocus ?? captureFocus)}</div>
                    <div style={{ color: 'var(--text-mute)' }}>
                      {context?.enabled ? 'Context pipeline on' : 'Context pipeline off'}
                      {capture?.paused ? ' · capture paused' : ''}
                      {capture?.eventsPerMinute != null ? ` · ${capture.eventsPerMinute} events/min` : ''}
                      {context?.axSnapshotSource ? ` · AX ${context.axSnapshotSource}` : ''}
                      {context?.axTextSignalPresent ? ` · ${context.axTextChars} chars` : ''}
                      {axSignalKeys.length ? ` · signals ${axSignalKeys.join(', ')}` : ''}
                      {axSignalQuality ? ` · quality ${axSignalQuality}` : ''}
                      {axReason ? ` · ${axReason}` : ''}
                    </div>
                    {decision ? (
                      <div style={{ color: 'var(--text-mute)' }}>
                        Last sampler: {decision.outcome} · {decision.reason}
                        {decision.axReason ? ` · ${decision.axReason}` : ''}
                      </div>
                    ) : null}
                    {coverage ? (
                      <div style={{
                        marginTop: 8,
                        paddingTop: 8,
                        borderTop: '1px solid var(--border)',
                        display: 'grid',
                        gap: 5,
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                          <span style={{ color: 'var(--text-mute)' }}>Text coverage</span>
                          <span>
                            {coverage.textReadable}/{coverage.total} readable ({pct(coverage.textReadable, coverage.total)})
                          </span>
                        </div>
                        <div style={{ color: 'var(--text-mute)', fontSize: 11 }}>
                          {qualityBreakdown(coverage)}
                        </div>
                        <div style={{ color: 'var(--text-mute)', fontSize: 11 }}>
                          {qualityRateBreakdown(coverage)}
                        </div>
                        <div style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                          gap: 6,
                          color: 'var(--text-mute)',
                          fontSize: 11,
                        }}>
                          <span>Focus only {coverage.focusOnly}</span>
                          <span>Empty {coverage.empty}</span>
                          <span>Skipped {coverage.skipped}</span>
                        </div>
                        <div style={{ color: 'var(--text-mute)', fontSize: 11 }}>
                          Action needed {actionableIssueCount} · Unreadable {unreadableSamples}
                        </div>
                        {coverageApps.length > 0 ? (
                          <div style={{ display: 'grid', gap: 3, color: 'var(--text-mute)', fontSize: 11 }}>
                            {coverageApps.map((row) => (
                              <div
                                key={`${row.appName}-${row.bundleId ?? ''}`}
                                style={{
                                  display: 'grid',
                                  gridTemplateColumns: 'minmax(72px, 0.8fr) minmax(0, 1.4fr)',
                                  gap: 8,
                                }}
                              >
                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {row.appName}
                                </span>
                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {appCoverageLabel(row)}
                                </span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        {weakCoverageApps.length > 0 ? (
                          <div
                            style={{
                              color: 'var(--text-mute)',
                              fontSize: 11,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            Weak apps: {weakCoverageApps.map((row) => `${row.appName} ${pct(row.weakTextReadable, row.total)}`).join(' · ')}
                          </div>
                        ) : null}
                        {topIssue ? (
                          <div
                            style={{
                              color: 'var(--text-mute)',
                              fontSize: 11,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            Top issue: {issueCoverageLabel(topIssue)}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    <div style={{ color: statusColor }}>
                      {statusLabel}
                    </div>
                    <div style={{ color: 'var(--text-mute)' }}>
                      {statusMessage}
                      {capturedAtMs ? ` · ${msToLocal(capturedAtMs)} · ${msToRelative(capturedAtMs)}` : ''}
                    </div>
                  </>
                ) : (
                  <div style={{ color: 'var(--text-mute)' }}>{busy ? 'Reading live context…' : 'Live context not loaded yet.'}</div>
                )
              ) : (
                <div style={{ color: 'var(--text-mute)' }}>Desktop runtime required for live context probes.</div>
              )}
            </div>
            {err ? (
              <div style={{ fontSize: 11, color: 'var(--danger)' }}>{err}</div>
            ) : null}
          </div>
          <button type="button" className="context-link-btn" onClick={() => { props.onOpenSettings('privacy'); props.onClose(); }}>
            Learn more <Icon name="arrowUpRight" size={14} />
          </button>
        </div>
        <button type="button" className="context-panel-row" onClick={() => { props.onOpenSettings('privacy'); props.onClose(); }}>
          <span>Pause Context Awareness</span>
          <Icon name="chevronRight" size={14} />
        </button>
        <button type="button" className="context-panel-row" onClick={() => { props.onOpenSettings('data'); props.onClose(); }}>
          <span>Delete Data</span>
          <Icon name="chevronRight" size={14} />
        </button>
        <div className="context-panel-foot">
          <button type="button" className="context-manage-btn" onClick={() => { props.onOpenSettings('privacy'); props.onClose(); }}>
            Manage
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}

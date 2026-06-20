import { useState } from 'react';
import { msToLocal, msToRelative } from '../lib/format';
import { useScreenContextProbe } from '../hooks/useScreenContextProbe';
import type { SamplerCoverageAppData } from '../types';

function boolLabel(value: boolean | null | undefined) {
  if (value == null) return "—";
  return value ? "yes" : "no";
}

function valueLabel(value: string | null | undefined) {
  if (value == null) return "—";
  const trimmed = value.trim();
  return trimmed || "—";
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
  partialTextReadable?: number;
  weakTextReadable?: number;
}) {
  return `strong ${pct(row.strongTextReadable, row.total)} · partial ${pct(row.partialTextReadable, row.total)} · weak ${pct(row.weakTextReadable, row.total)}`;
}

function signalKeysLabel(keys: string[] | null | undefined) {
  return keys?.length ? `keys ${keys.join(", ")}` : "";
}

function appActionLabel(row: SamplerCoverageAppData) {
  if (row.actionableSamples > 0) {
    const reason = row.latestActionableReason
      ? `${row.latestActionableReason}${row.latestActionableAxReason ? ` · ${row.latestActionableAxReason}` : ''}`
      : "actionable";
    const source = row.latestActionableAxSource ? ` · ${row.latestActionableAxSource}` : '';
    const keys = signalKeysLabel(row.latestActionableAxTextSignalKeys);
    return `ACTION · ${row.actionableSamples} samples · ${reason}${source}${keys ? ` · ${keys}` : ''}`;
  }
  if (row.unreadable > 0) {
    return `EXPECTED · ${row.unreadable} unreadable`;
  }
  return "OK";
}

function weakAppRankingRows(rows: SamplerCoverageAppData[], limit: number) {
  return rows
    .filter((row) => row.weakTextReadable > 0)
    .slice()
    .sort((a, b) => {
      const weakRateA = a.total ? a.weakTextReadable / a.total : 0;
      const weakRateB = b.total ? b.weakTextReadable / b.total : 0;
      return weakRateB - weakRateA
        || b.weakTextReadable - a.weakTextReadable
        || b.actionableSamples - a.actionableSamples
        || a.appName.localeCompare(b.appName);
    })
    .slice(0, limit);
}

function auditJsonForCopy(probe: ReturnType<typeof useScreenContextProbe>["probe"]) {
  if (!probe) return "";
  const context = probe.hummingbirdContext;
  const weakAppRanking = weakAppRankingRows(probe.samplerCoverage.byApp, 8)
    .map((row) => ({
      appName: row.appName,
      bundleId: row.bundleId,
      weakRate: pct(row.weakTextReadable, row.total),
      weakTextReadable: row.weakTextReadable,
      total: row.total,
      latestActionableReason: row.latestActionableReason,
      latestActionableAxTextSignalKeys: row.latestActionableAxTextSignalKeys,
      latestActionableRecommendedAction: row.latestActionableRecommendedAction,
    }));
  return JSON.stringify({
    capturedAtMs: probe.capturedAtMs,
    capturedAtLocal: msToLocal(probe.capturedAtMs),
    frontmostFocus: probe.frontmostFocus,
    health: probe.screenContextHealth,
    captureStatus: {
      paused: probe.captureStatus.paused,
      permissions: probe.captureStatus.permissions,
      inputTapRunning: probe.captureStatus.inputTapRunning,
      eventsPerMinute: probe.captureStatus.eventsPerMinute,
      frontmostFocus: probe.captureStatus.frontmostFocus,
    },
    ax: {
      source: context.axSnapshotSource,
      diagnostics: context.axDiagnostics,
      textSignalPresent: context.axTextSignalPresent,
      textSignalKeys: context.axTextSignalKeys,
      textSignalQuality: context.axTextSignalQuality,
      textChars: context.axTextChars,
      lineCount: context.axLineCount,
      snapshotPreview: context.axSnapshot ? context.axSnapshot.slice(0, 800) : "",
      snapshotChars: context.axSnapshot.length,
    },
    weakAppRanking,
    samplerCoverage: probe.samplerCoverage,
    lastSamplerDecision: probe.lastSamplerDecision,
  }, null, 2);
}

export function TabContextProbe() {
  const { desktop, probe, capturedAtMs, err, busy, refresh } = useScreenContextProbe();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const capture = probe?.captureStatus ?? null;
  const context = probe?.hummingbirdContext ?? null;
  const health = probe?.screenContextHealth ?? null;
  const decision = probe?.lastSamplerDecision ?? null;
  const coverage = probe?.samplerCoverage ?? null;
  const topIssue = coverage?.byIssue?.[0] ?? null;
  const unreadableSamples = coverage ? Math.max(coverage.total - coverage.textReadable, 0) : 0;
  const actionableIssueCount = coverage?.byIssue.filter((row) => row.actionable).length ?? 0;
  const weakAppRanking = weakAppRankingRows(coverage?.byApp ?? [], 8);
  const nextWeakTarget = weakAppRanking[0] ?? null;
  const recentDecisions = coverage?.recent?.slice(0, 20) ?? [];
  const axDiagnostics = context?.axDiagnostics ?? null;
  const axSnapshot = (context?.axSnapshot || '').trim();
  const verdictLabel = health?.label ?? 'Screen context';
  const verdictClass =
    health?.state === "ok"
      ? "on"
      : health?.state === "warn"
        ? "warn"
        : "error";
  const verdictMessage =
    health?.message ??
    (capture?.permissions?.accessibilityTrusted === false
      ? 'Accessibility permission is not granted, so AX snapshots stay empty.'
      : axSnapshot
        ? 'AX snapshot captured from the focused control.'
        : (capture?.frontmostFocus?.appName || context?.frontmostApp)
          ? 'Accessibility is allowed, but the focused control returned no AX text.'
          : 'No frontmost focus snapshot is available.');

  if (!desktop) {
    return (
      <div className="mdbg-pane">
        <div className="mdbg-empty">Desktop runtime required for screen-context probes.</div>
      </div>
    );
  }

  if (err) {
    return (
      <div className="mdbg-pane">
        <div className="mdbg-err">{err}</div>
        <button onClick={refresh}>Retry</button>
      </div>
    );
  }

  if (!capture && !context) {
    return <div className="mdbg-pane">Loading…</div>;
  }

  const copyAuditJson = async () => {
    if (!probe) return;
    try {
      await navigator.clipboard.writeText(auditJsonForCopy(probe));
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1600);
    } catch {
      setCopyState("error");
      window.setTimeout(() => setCopyState("idle"), 2200);
    }
  };

  return (
    <div className="mdbg-pane">
      <div className="mdbg-header-row">
        <button onClick={refresh} disabled={busy}>
          {busy ? "Refreshing…" : "Refresh now"}
        </button>
        <button onClick={() => { void copyAuditJson(); }} disabled={!probe}>
          {copyState === "copied" ? "Copied audit JSON" : copyState === "error" ? "Copy failed" : "Copy audit JSON"}
        </button>
        <span className="mdbg-timestamp">
          snapshot: {msToLocal(capturedAtMs ?? undefined)} · {msToRelative(capturedAtMs)}
        </span>
      </div>
      <div style={{ marginBottom: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span className={`mdbg-badge mdbg-badge-${verdictClass}`}>
          {verdictLabel}
        </span>
        <span className="mdbg-snip" style={{ flex: 1, minWidth: 0 }}>
          {verdictMessage}
        </span>
      </div>

      <h3>Audit summary</h3>
      <table className="mdbg-table" style={{ marginBottom: 12 }}>
        <tbody>
          <tr>
            <td>sample window</td>
            <td>{coverage?.total ?? 0} recent samples</td>
          </tr>
          <tr>
            <td>readable rate</td>
            <td>
              {coverage?.textReadable ?? 0} / {coverage?.total ?? 0} ({pct(coverage?.textReadable, coverage?.total)})
            </td>
          </tr>
          <tr>
            <td>strong rate</td>
            <td>{pct(coverage?.strongTextReadable, coverage?.total)}</td>
          </tr>
          <tr>
            <td>weak rate</td>
            <td>{pct(coverage?.weakTextReadable, coverage?.total)}</td>
          </tr>
          <tr>
            <td>unreadable samples</td>
            <td>{unreadableSamples}</td>
          </tr>
          <tr>
            <td>actionable issues</td>
            <td>{actionableIssueCount}</td>
          </tr>
          <tr>
            <td>top issue</td>
            <td>
              {topIssue
                ? `${topIssue.actionable ? "ACTION" : "EXPECTED"} · ${topIssue.severity.toUpperCase()} · ${topIssue.reason}${topIssue.axReason ? ` · ${topIssue.axReason}` : ''} · ${topIssue.unreadable} unreadable${topIssue.latestAxTextSignalKeys.length ? ` · ${signalKeysLabel(topIssue.latestAxTextSignalKeys)}` : ''} · ${topIssue.recommendedAction}`
                : "—"}
            </td>
          </tr>
          <tr>
            <td>next weak target</td>
            <td>
              {nextWeakTarget
                ? `${nextWeakTarget.appName} · weak ${pct(nextWeakTarget.weakTextReadable, nextWeakTarget.total)} · ${nextWeakTarget.weakTextReadable}/${nextWeakTarget.total}${nextWeakTarget.latestActionableAxTextSignalKeys.length ? ` · ${signalKeysLabel(nextWeakTarget.latestActionableAxTextSignalKeys)}` : ''}`
                : "—"}
            </td>
          </tr>
          <tr>
            <td>latest app</td>
            <td>{valueLabel(context?.frontmostApp ?? capture?.frontmostFocus?.appName ?? null)}</td>
          </tr>
        </tbody>
      </table>

      <div className="mdbg-grid-2">
        <div>
          <h3>Capture status</h3>
          <table className="mdbg-table">
            <tbody>
              <tr>
                <td>paused</td>
                <td>{boolLabel(capture?.paused)}</td>
              </tr>
              <tr>
                <td>events/min</td>
                <td>{capture?.eventsPerMinute ?? "—"}</td>
              </tr>
              <tr>
                <td>input tap</td>
                <td>{boolLabel(capture?.inputTapRunning)}</td>
              </tr>
              <tr>
                <td>accessibility</td>
                <td>{boolLabel(capture?.permissions?.accessibilityTrusted)}</td>
              </tr>
              <tr>
                <td>screen capture</td>
                <td>{boolLabel(capture?.permissions?.screenCaptureGranted)}</td>
              </tr>
              <tr>
                <td>input monitoring</td>
                <td>{boolLabel(capture?.permissions?.inputMonitoringGranted)}</td>
              </tr>
              <tr>
                <td>frontmost app</td>
                <td>{valueLabel(capture?.frontmostFocus?.appName ?? null)}</td>
              </tr>
              <tr>
                <td>frontmost bundle</td>
                <td>{valueLabel(capture?.frontmostFocus?.bundleId ?? null)}</td>
              </tr>
              <tr>
                <td>frontmost window</td>
                <td>{valueLabel(capture?.frontmostFocus?.windowTitle ?? null)}</td>
              </tr>
              <tr>
                <td>title source</td>
                <td>{valueLabel(capture?.frontmostFocus?.windowTitleSource ?? null)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div>
          <h3>Frontmost focus</h3>
          <table className="mdbg-table">
            <tbody>
              <tr>
                <td>app</td>
                <td>{valueLabel(context?.frontmostApp ?? context?.frontmostFocus?.appName ?? null)}</td>
              </tr>
              <tr>
                <td>bundle</td>
                <td>{valueLabel(context?.frontmostBundleId ?? context?.frontmostFocus?.bundleId ?? null)}</td>
              </tr>
              <tr>
                <td>window</td>
                <td>{valueLabel(context?.frontmostWindowTitle ?? context?.frontmostFocus?.windowTitle ?? null)}</td>
              </tr>
              <tr>
                <td>title source</td>
                <td>{valueLabel(context?.frontmostFocus?.windowTitleSource ?? null)}</td>
              </tr>
              <tr>
                <td>mode</td>
                <td>{valueLabel(context?.mode ?? null)}</td>
              </tr>
              <tr>
                <td>AX source</td>
                <td>{valueLabel(context?.axSnapshotSource ?? health?.axSnapshotSource ?? null)}</td>
              </tr>
              <tr>
                <td>AX reason</td>
                <td>{valueLabel(axDiagnostics?.reason ?? health?.axDiagnosticReason ?? null)}</td>
              </tr>
              <tr>
                <td>AX text signal</td>
                <td>{boolLabel(context?.axTextSignalPresent ?? health?.axTextSignalPresent)}</td>
              </tr>
              <tr>
                <td>AX signal keys</td>
                <td>{valueLabel((context?.axTextSignalKeys ?? health?.axTextSignalKeys ?? []).join(", "))}</td>
              </tr>
              <tr>
                <td>AX signal quality</td>
                <td>{valueLabel(context?.axTextSignalQuality ?? health?.axTextSignalQuality ?? null)}</td>
              </tr>
              <tr>
                <td>AX text chars</td>
                <td>{context?.axTextChars ?? health?.axTextChars ?? "—"}</td>
              </tr>
              <tr>
                <td>AX lines</td>
                <td>{context?.axLineCount ?? health?.axLineCount ?? "—"}</td>
              </tr>
              <tr>
                <td>AX focused</td>
                <td>{boolLabel(axDiagnostics?.focusedElementPresent)}</td>
              </tr>
              <tr>
                <td>AX role</td>
                <td>{valueLabel(axDiagnostics?.focusedRole ?? null)}</td>
              </tr>
              <tr>
                <td>enabled</td>
                <td>{boolLabel(context?.enabled)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <h3>Last sampler decision</h3>
      <table className="mdbg-table" style={{ marginBottom: 12 }}>
        <tbody>
          <tr>
            <td>time</td>
            <td>{decision ? `${msToLocal(decision.capturedAtMs)} · ${msToRelative(decision.capturedAtMs)}` : "—"}</td>
          </tr>
          <tr>
            <td>outcome</td>
            <td>{valueLabel(decision?.outcome ?? null)}</td>
          </tr>
          <tr>
            <td>reason</td>
            <td>{valueLabel(decision?.reason ?? null)}</td>
          </tr>
          <tr>
            <td>app</td>
            <td>{valueLabel(decision?.appName ?? null)}</td>
          </tr>
          <tr>
            <td>bundle</td>
            <td>{valueLabel(decision?.bundleId ?? null)}</td>
          </tr>
          <tr>
            <td>window</td>
            <td>{valueLabel(decision?.windowTitle ?? null)}</td>
          </tr>
          <tr>
            <td>AX source</td>
            <td>{valueLabel(decision?.axSource ?? null)}</td>
          </tr>
          <tr>
            <td>AX reason</td>
            <td>{valueLabel(decision?.axReason ?? null)}</td>
          </tr>
          <tr>
            <td>text chars</td>
            <td>{decision?.textChars ?? "—"}</td>
          </tr>
          <tr>
            <td>spatial</td>
            <td>{boolLabel(decision?.spatialPresent)}</td>
          </tr>
        </tbody>
      </table>

      <h3>Text capture coverage</h3>
      <table className="mdbg-table" style={{ marginBottom: 12 }}>
        <tbody>
          <tr>
            <td>recent samples</td>
            <td>{coverage?.total ?? 0}</td>
          </tr>
          <tr>
            <td>AX text readable</td>
            <td>
              {coverage?.textReadable ?? 0} / {coverage?.total ?? 0} ({pct(coverage?.textReadable, coverage?.total)})
            </td>
          </tr>
          <tr>
            <td>AX text quality</td>
            <td>
              {qualityBreakdown(coverage ?? {})}
              {` · ${qualityRateBreakdown(coverage ?? {})}`}
            </td>
          </tr>
          <tr>
            <td>strong rate</td>
            <td>{pct(coverage?.strongTextReadable, coverage?.total)}</td>
          </tr>
          <tr>
            <td>weak rate</td>
            <td>{pct(coverage?.weakTextReadable, coverage?.total)}</td>
          </tr>
          <tr>
            <td>focus only</td>
            <td>{coverage?.focusOnly ?? 0}</td>
          </tr>
          <tr>
            <td>AX empty</td>
            <td>{coverage?.empty ?? 0}</td>
          </tr>
          <tr>
            <td>skipped</td>
            <td>{coverage?.skipped ?? 0}</td>
          </tr>
        </tbody>
      </table>

      <div className="mdbg-grid-2">
        <div>
          <h3>By app</h3>
          <table className="mdbg-table">
            <thead>
              <tr>
                <th>app</th>
                <th>readable</th>
                <th>action</th>
                <th>latest</th>
              </tr>
            </thead>
            <tbody>
              {(coverage?.byApp ?? []).map((row) => (
                <tr key={`${row.appName}-${row.bundleId ?? ''}`}>
                  <td>{row.appName}</td>
                  <td>
                    {row.textReadable}/{row.total} ({pct(row.textReadable, row.total)})
                    {` · ${qualityBreakdown(row)}`}
                    {` · ${qualityRateBreakdown(row)}`}
                    {row.unreadable ? ` · ${row.unreadable} unreadable` : ''}
                  </td>
                  <td>
                    {appActionLabel(row)}
                    {row.latestActionableRecommendedAction ? ` · ${row.latestActionableRecommendedAction}` : ''}
                  </td>
                  <td>
                    {valueLabel(row.latestAxSource ?? row.latestReason)}
                    {row.latestTextChars != null ? ` · ${row.latestTextChars} chars` : ''}
                  </td>
                </tr>
              ))}
              {coverage && coverage.byApp.length === 0 ? (
                <tr>
                  <td colSpan={4}>No sampler history yet.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div>
          <h3>By AX source</h3>
          <table className="mdbg-table">
            <thead>
              <tr>
                <th>source</th>
                <th>samples</th>
                <th>readable</th>
              </tr>
            </thead>
            <tbody>
              {(coverage?.bySource ?? []).map((row) => (
                <tr key={row.source}>
                  <td>{row.source}</td>
                  <td>{row.total}</td>
                  <td>
                    {row.textReadable} ({pct(row.textReadable, row.total)})
                    {` · ${qualityBreakdown(row)}`}
                    {` · ${qualityRateBreakdown(row)}`}
                  </td>
                </tr>
              ))}
              {coverage && coverage.bySource.length === 0 ? (
                <tr>
                  <td colSpan={3}>No AX source history yet.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <h3>Weak signal ranking</h3>
      <table className="mdbg-table" style={{ marginBottom: 12 }}>
        <thead>
          <tr>
            <th>app</th>
            <th>weak rate</th>
            <th>weak samples</th>
            <th>action</th>
            <th>latest</th>
          </tr>
        </thead>
        <tbody>
          {weakAppRanking.map((row) => (
            <tr key={`${row.appName}-${row.bundleId ?? ''}-weak`}>
              <td>{row.appName}</td>
              <td>{pct(row.weakTextReadable, row.total)}</td>
              <td>{row.weakTextReadable}/{row.total}</td>
              <td>
                {appActionLabel(row)}
                {row.latestActionableRecommendedAction ? ` · ${row.latestActionableRecommendedAction}` : ''}
              </td>
              <td>
                {valueLabel(row.latestAxSource ?? row.latestReason)}
                {row.latestActionableAxTextSignalKeys.length ? ` · ${signalKeysLabel(row.latestActionableAxTextSignalKeys)}` : ''}
                {row.latestTextChars != null ? ` · ${row.latestTextChars} chars` : ''}
              </td>
            </tr>
          ))}
          {coverage && weakAppRanking.length === 0 ? (
            <tr>
              <td colSpan={5}>No weak text signal apps in the recent window.</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <h3>Capture issues</h3>
      <table className="mdbg-table" style={{ marginBottom: 12 }}>
        <thead>
          <tr>
            <th>reason</th>
            <th>samples</th>
            <th>readable</th>
            <th>unreadable</th>
            <th>action</th>
            <th>latest</th>
          </tr>
        </thead>
        <tbody>
          {(coverage?.byIssue ?? []).map((row) => (
            <tr key={`${row.reason}-${row.axReason ?? ''}-${row.latestAtMs ?? ''}`}>
              <td>
                {row.reason}
                {row.axReason ? ` · ${row.axReason}` : ''}
              </td>
              <td>{row.total}</td>
              <td>
                {row.textReadable} ({pct(row.textReadable, row.total)})
                {` · ${qualityBreakdown(row)}`}
              </td>
              <td>{row.unreadable}</td>
              <td>{row.actionable ? "ACTION" : "EXPECTED"} · {row.severity.toUpperCase()} · {row.recommendedAction}</td>
              <td>
                {valueLabel(row.latestAppName)}
                {row.latestWindowTitle ? ` · ${row.latestWindowTitle}` : ''}
                {row.latestAxSource ? ` · ${row.latestAxSource}` : ''}
                {row.latestAxTextSignalKeys.length ? ` · ${signalKeysLabel(row.latestAxTextSignalKeys)}` : ''}
                {row.latestAtMs ? ` · ${msToRelative(row.latestAtMs)}` : ''}
              </td>
            </tr>
          ))}
          {coverage && coverage.byIssue.length === 0 ? (
            <tr>
              <td colSpan={6}>No capture issues in the recent window.</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <h3>Recent sampler decisions</h3>
      <table className="mdbg-table" style={{ marginBottom: 12 }}>
        <thead>
          <tr>
            <th>time</th>
            <th>app</th>
            <th>outcome</th>
            <th>AX</th>
            <th>text</th>
          </tr>
        </thead>
        <tbody>
          {recentDecisions.map((row) => (
            <tr key={`${row.capturedAtMs}-${row.appName ?? ''}-${row.reason}`}>
              <td>{msToRelative(row.capturedAtMs)}</td>
              <td>
                {valueLabel(row.appName)}
                {row.windowTitle ? ` · ${row.windowTitle}` : ''}
              </td>
              <td>{row.outcome} · {row.reason}</td>
              <td>
                {valueLabel(row.axSource)}
                {row.axReason ? ` · ${row.axReason}` : ''}
              </td>
              <td>
                {row.textChars != null ? `${row.textChars} chars` : "—"}
                {row.axTextSignalQuality ? ` · ${row.axTextSignalQuality}` : ''}
                {row.axTextSignalKeys.length ? ` · keys ${row.axTextSignalKeys.join(", ")}` : ''}
              </td>
            </tr>
          ))}
          {coverage && recentDecisions.length === 0 ? (
            <tr>
              <td colSpan={5}>No sampler decisions yet.</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <h3>AX snapshot</h3>
      <pre className="mdbg-pre">{axSnapshot || "—"}</pre>
    </div>
  );
}

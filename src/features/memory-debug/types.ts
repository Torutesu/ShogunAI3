/**
 * Shared types for the memory-debug feature.
 */

export interface QueryHit {
  id: string;
  provenance: string;
  title: string | null;
  snippet: string | null;
}

export interface FrontmostFocusData {
  appName: string;
  bundleId: string | null;
  windowTitle: string | null;
  windowTitleSource: string | null;
}

export interface QueryResult {
  hits: QueryHit[];
  draft_block: string;
  brief_block: string;
  reply_block: string;
}

export interface SliData {
  successRate: number | null;
  p95LatencyMs: number | null;
  backlog: number | null;
  done: number | null;
  failed: number | null;
}

export interface SliThreshold {
  successLt: number;
  p95Gt: number;
  backlogGt: number;
}

export interface SliThresholds {
  bad: SliThreshold;
  warn: SliThreshold;
}

export interface KiokuQueueStats {
  captures_pending?: number;
  captures_running?: number;
  captures_done?: number;
  captures_failed?: number;
  captures_expired?: number;
  jobs_queued?: number;
  jobs_running?: number;
  jobs_done?: number;
  jobs_failed?: number;
  jobs_expired?: number;
  oldest_pending_capture_ms?: number | null;
}

export interface KiokuCostStats {
  spent_usd?: number;
  monthly_cap_usd?: number;
  status?: string;
  cap_action?: string;
  extraction_model?: string;
  fallback_model?: string;
}

export interface KiokuNodeKindRow {
  kind: string;
  count: number;
}

export interface KiokuEdgeTypeRow {
  edge_type: string;
  count: number;
}

export interface KiokuGraphStats {
  mem_items_active?: number;
  mem_items_retired?: number;
  mem_items_total?: number;
  captures_total?: number;
  edges_active?: number;
  edges_total?: number;
  by_node_kind?: KiokuNodeKindRow[];
  by_edge_type?: KiokuEdgeTypeRow[];
}

export interface KiokuRulesStats {
  count?: number;
  titles?: string[];
}

export interface KiokuDebugStats {
  now_ms?: number;
  flags?: {
    read_path?: string;
    worker_enabled?: boolean;
    capture_to_mem_captures?: boolean;
    meeting_extraction_enabled?: boolean;
  };
  summary?: {
    jobs_queued?: number;
    jobs_running?: number;
    jobs_done?: number;
    jobs_failed?: number;
    job_completion_rate?: number | null;
    edges_active?: number;
    mem_items_active?: number;
    edge_density?: number;
  };
  queue?: KiokuQueueStats;
  cost?: KiokuCostStats;
  graph?: KiokuGraphStats;
  rules?: KiokuRulesStats;
}

export interface RecentCall {
  ts_ms: number;
  route: string;
  query_preview: string | null;
  hits_count: number;
  elapsed_ms: number;
  status: string | { Err?: string } | null;
  provenance_counts: {
    screen: number;
    connector: number;
    meeting: number;
    user: number;
  };
  block_chars: number;
  limit: number;
  semantic: boolean;
  assembled_block: string | null;
}

export interface RecentCallsResult {
  calls: RecentCall[];
}

export interface SyncSourceStatus {
  last_sync_ms: number | null;
  last_ingested: number | null;
  last_error: string | null;
  last_duration_ms: number | null;
  credentials_present: boolean;
  auto_enabled: boolean;
}

export interface SyncHealthData {
  google_calendar: SyncSourceStatus;
  gmail: SyncSourceStatus;
}

export interface CaptureStatusData {
  paused: boolean;
  permissions: {
    accessibilityTrusted: boolean;
    screenCaptureGranted: boolean;
    inputMonitoringGranted: boolean;
  };
  inputTapRunning: boolean;
  eventsPerMinute: number;
  frontmostFocus: FrontmostFocusData | null;
}

export interface HummingbirdContextData {
  enabled: boolean;
  mode: string;
  frontmostApp: string | null;
  frontmostBundleId: string | null;
  frontmostWindowTitle: string | null;
  frontmostFocus: FrontmostFocusData | null;
  axSnapshot: string;
  axSnapshotSource: string;
  axDiagnostics: AxDiagnosticsData;
  axTextSignalPresent: boolean;
  axTextChars: number;
  axLineCount: number;
  stub: boolean;
  note?: string;
}

export interface AxDiagnosticsData {
  trusted: boolean | null;
  focusedElementPresent: boolean;
  focusedRole: string | null;
  focusedWindowTitle: string | null;
  snapshotPresent: boolean;
  treePresent: boolean;
  reason: string;
}

export interface ScreenContextHealthData {
  state: "ok" | "warn" | "error";
  label: string;
  message: string;
  accessibilityTrusted: boolean | null;
  axSnapshotPresent: boolean;
  axTextSignalPresent: boolean;
  axTextChars: number | null;
  axLineCount: number | null;
  frontmostApp: string | null;
  frontmostBundleId: string | null;
  windowTitle: string | null;
  windowTitleSource: string | null;
  axSnapshotSource: string | null;
  axDiagnosticReason: string | null;
}

export interface SamplerDecisionData {
  capturedAtMs: number;
  outcome: string;
  reason: string;
  appName: string | null;
  bundleId: string | null;
  windowTitle: string | null;
  axSource: string | null;
  axReason: string | null;
  textChars: number | null;
  spatialPresent: boolean;
}

export interface SamplerCoverageAppData {
  appName: string;
  bundleId: string | null;
  total: number;
  textReadable: number;
  unreadable: number;
  actionableSamples: number;
  focusOnly: number;
  empty: number;
  skipped: number;
  latestAtMs: number | null;
  latestOutcome: string | null;
  latestReason: string | null;
  latestAxSource: string | null;
  latestTextChars: number | null;
  latestActionableAtMs: number | null;
  latestActionableReason: string | null;
  latestActionableAxReason: string | null;
  latestActionableAxSource: string | null;
  latestActionableRecommendedAction: string | null;
}

export interface SamplerCoverageSourceData {
  source: string;
  total: number;
  textReadable: number;
  empty: number;
}

export interface SamplerCoverageIssueData {
  reason: string;
  axReason: string | null;
  severity: "info" | "warn" | "error";
  recommendedAction: string;
  total: number;
  textReadable: number;
  unreadable: number;
  actionable: boolean;
  latestAtMs: number | null;
  latestAppName: string | null;
  latestBundleId: string | null;
  latestWindowTitle: string | null;
  latestAxSource: string | null;
}

export interface SamplerCoverageData {
  total: number;
  textReadable: number;
  focusOnly: number;
  empty: number;
  skipped: number;
  byApp: SamplerCoverageAppData[];
  bySource: SamplerCoverageSourceData[];
  byIssue: SamplerCoverageIssueData[];
  recent: SamplerDecisionData[];
}

export interface ScreenContextProbeData {
  capturedAtMs: number;
  frontmostFocus: FrontmostFocusData | null;
  captureStatus: CaptureStatusData;
  hummingbirdContext: HummingbirdContextData;
  screenContextHealth: ScreenContextHealthData;
  lastSamplerDecision: SamplerDecisionData | null;
  samplerCoverage: SamplerCoverageData;
  stub: boolean;
  echo?: Record<string, unknown>;
}

export interface DbSourceRow {
  source: string;
  rows: number;
  with_embed: number;
}

export interface DbProvenanceRow {
  provenance: string;
  rows: number;
}

export interface DbStatsData {
  total: number;
  fts_total: number;
  fts_integrity: boolean;
  db_bytes: number;
  earliest_ms: number | null;
  latest_ms: number | null;
  by_source: DbSourceRow[];
  by_provenance: DbProvenanceRow[];
}

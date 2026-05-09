/**
 * Shared types for the memory-debug feature.
 */

export interface QueryHit {
  id: string;
  provenance: string;
  title: string | null;
  snippet: string | null;
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

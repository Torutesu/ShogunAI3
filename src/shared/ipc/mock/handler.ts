import { ShogunMorningBrief } from "@/shared/lib/morning-brief";
import { SHOGUN_DEMO_SEED } from "@/shared/lib/demo-seed";
import { ShogunIntegrationConnectors } from "@/shared/lib/integration-connectors";
import {
  MOCK_MEMORY_INDEX_LS,
  mergeMockSettingsSection,
  readMockLlmKeyConfigured,
  readMockSettingsSections,
  writeMockLlmKeyConfigured,
} from "./settings";

export type MockGlobal = typeof globalThis & {
  localStorage?: Storage;
  __shogunMockOverrides?: Record<string, (payload: unknown) => unknown>;
  window?: Window & { location?: Location };
};

export type MockContext = {
  global?: MockGlobal;
  createError?: (code: string, message: string, details?: unknown) => Error & {
    code: string;
    details: unknown;
  };
};

function resolveGlobal(global?: MockGlobal): MockGlobal {
  return global ?? (typeof window !== "undefined" ? window : globalThis);
}

function defaultCreateError(code: string, message: string, details?: unknown) {
  const err = new Error(message) as Error & { code: string; details: unknown };
  err.code = code;
  err.details = details ?? null;
  return err;
}

/** Browser mock IPC: raw command payload aligned with Tauri success values. */
export function handleMockCommand(
  command: string,
  payload: unknown,
  ctx?: MockContext,
): unknown {
  const g = resolveGlobal(ctx?.global);
  const createError = ctx?.createError ?? defaultCreateError;

const echo: any = payload || {};
const DEMO = SHOGUN_DEMO_SEED || null;


function nowIso() {
  return new Date().toISOString();
}

function mockFrontmostFocus() {
  return {
    appName: "Mock App",
    bundleId: "com.example.MockApp",
    windowTitle: "Preview document",
    windowTitleSource: "mock",
  };
}

function clampLimit(raw: any, fallback: number) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(80, Math.max(1, Math.floor(n)));
}

function mockKiokuReadPath(g: MockGlobal): "graph" | "legacy" {
  const sections = readMockSettingsSections(g);
  const graph = sections.kioku_graph as Record<string, unknown> | undefined;
  const raw =
    graph && typeof graph.read_path === "string"
      ? String(graph.read_path).toLowerCase()
      : "graph";
  return raw === "graph" ? "graph" : "legacy";
}

function scoreMemoryHit(hit: any, queryLower: string) {
  if (!queryLower) return 0;
  const title = String(hit && hit.title ? hit.title : "").toLowerCase();
  const snippet = String(hit && hit.snippet ? hit.snippet : "").toLowerCase();
  let score = 0;
  if (title.includes(queryLower)) score += 10;
  if (snippet.includes(queryLower)) score += 6;
  const terms = queryLower.split(/\s+/).filter((s): s is string => Boolean(s));
  for (let i = 0; i < terms.length; i += 1) {
    const t = terms[i] as string;
    if (title.includes(t)) score += 2;
    if (snippet.includes(t)) score += 1;
  }
  return score;
}

function readMemoryIndex() {
  try {
    if (!g.localStorage) {
      return DEMO && Array.isArray(DEMO.memoryHits) ? DEMO.memoryHits.slice() : [];
    }
    const raw = g.localStorage.getItem(MOCK_MEMORY_INDEX_LS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
    const seed = DEMO && Array.isArray(DEMO.memoryHits) ? DEMO.memoryHits.slice() : [];
    g.localStorage.setItem(MOCK_MEMORY_INDEX_LS, JSON.stringify(seed));
    return seed;
  } catch (_) {
    return DEMO && Array.isArray(DEMO.memoryHits) ? DEMO.memoryHits.slice() : [];
  }
}

function writeMemoryIndex(items: any[]) {
  try {
    if (!g.localStorage) return;
    g.localStorage.setItem(MOCK_MEMORY_INDEX_LS, JSON.stringify(Array.isArray(items) ? items : []));
  } catch (_) {
    /* ignore */
  }
}

function normalizeMemoryHit(hit: any, fallbackId: string) {
  const source = String((hit && hit.source) || "note");
  return {
    id: String((hit && hit.id) || fallbackId || ("mock-" + Date.now())),
    title: String((hit && hit.title) || "Untitled memory"),
    snippet: String((hit && hit.snippet) || ""),
    source: source,
    provenance: String((hit && hit.provenance) || source),
    kinds: Array.isArray(hit && hit.kinds) ? hit.kinds.slice(0, 8) : ["input"],
    ts: String((hit && hit.ts) || nowIso()),
    entity_id: hit && hit.entity_id != null ? String(hit.entity_id) : null,
  };
}

function searchMemoryIndex(query: string, limit: any, semantic: boolean) {
  const items = readMemoryIndex().map((h: any, i: number) => normalizeMemoryHit(h, "mock-seed-" + i));
  const q = String(query || "").trim().toLowerCase();
  let filtered = items;
  if (q) {
    filtered = items.filter((h: any) => scoreMemoryHit(h, q) > 0);
  }
  if (semantic && q) {
    filtered = filtered
      .slice()
      .sort((a: any, b: any) => scoreMemoryHit(b, q) - scoreMemoryHit(a, q));
  }
  const lim = clampLimit(limit, 40);
  return {
    hits: filtered.slice(0, lim),
    total: filtered.length,
  };
}

function buildMemoryAssemblyBlock(memoryAssembly: any) {
  if (!memoryAssembly || typeof memoryAssembly !== "object") return null;
  const q = String(memoryAssembly.query || "").trim();
  if (!q) return null;
  const limit = clampLimit(memoryAssembly.limit, 12);
  const semantic = memoryAssembly.semantic !== false;
  const res = searchMemoryIndex(q, limit, semantic);
  const lines = res.hits.map((h: any, idx: number) => {
    const label = h.provenance || h.source || "memory";
    return `${idx + 1}. [${label}] ${h.title}: ${h.snippet}`;
  });
  return {
    query: q,
    limit: limit,
    semantic: semantic,
    total: res.total,
    hits: res.hits,
    text: lines.length
      ? lines.join("\n")
      : "(no relevant local memory hits)",
  };
}

if (command === "shogun_brief_get" && ShogunMorningBrief) {
  return (ShogunMorningBrief as any).mockBriefGetResponse(echo);
}

if (command === "shogun_kioku_brief_signals") {
  return {
    decision_graph_hits: [],
    related_kioku_hits: [],
    stub: false,
    echo,
  };
}

if (command === "shogun_kioku_edge_type_proposals") {
  return {
    proposals: [],
    stub: false,
    echo,
  };
}
if (command === "shogun_kioku_edge_type_review") {
  return {
    updated: 0,
    edge_type: (echo && echo.edge_type) || "",
    status: (echo && echo.status) || 0,
    stub: false,
    echo,
  };
}
if (command === "shogun_kioku_backup_db") {
  return {
    source_path: "/mock/memory.db",
    dest_path: "/mock/memory.db.backup-2026-04-27-000000",
    bytes: 0,
    completed_at_ms: Date.now(),
    stub: true,
    echo,
  };
}
if (command === "shogun_kioku_stage5_dry_run") {
  return {
    generated_at_ms: Date.now(),
    soft_retire: {
      matching_rows: 0,
      already_retired: 0,
      oldest_created_at_ms: null,
      newest_created_at_ms: null,
      embedding_blob_count: 0,
    },
    ttl_expired: {
      rows_with_raw_to_clean: 0,
      raw_path_files_to_unlink: 0,
      raw_text_rows_to_null: 0,
    },
    physical_delete: { eligible_rows: 0, cascade_edges: 0, orphaned_summaries: 0 },
    storage: { db_size_before_bytes: 0, raw_path_bytes: 0 },
    legacy_sources: ["capture_sampler", "capture_ax"],
    grace_days: 30,
    stub: false,
    echo,
  };
}
if (command === "shogun_kioku_stage5_apply") {
  return {
    applied_at_ms: Date.now(),
    actions: { soft_retire: null, cleanup_ttl: null, physical_delete: null, vacuum: null },
    stub: false,
    echo,
  };
}
if (command === "shogun_kioku_debug_stats") {
  return {
    queue: {
      captures_pending: 0,
      captures_running: 0,
      captures_done: 0,
      captures_failed: 0,
      captures_expired: 0,
      captures_skipped: 0,
      jobs_queued: 0,
      jobs_running: 0,
      jobs_done: 0,
      jobs_failed: 0,
      jobs_expired: 0,
      oldest_pending_capture_ms: null,
    },
    cost: {
      month_start_ms: 0,
      spent_usd: 0,
      monthly_cap_usd: 10,
      cap_action: "pause_extraction",
      fallback_model: "claude-haiku-4-5",
      extraction_model: "claude-haiku-4-5",
      status: "Proceed",
    },
    graph: {
      mem_items_total: 0,
      mem_items_active: 0,
      mem_items_retired: 0,
      edges_total: 0,
      edges_active: 0,
      captures_total: 0,
      by_node_kind: [],
      by_edge_type: [],
    },
    rules: { count: 0, titles: [] },
    flags: {
      read_path: "graph",
      capture_to_mem_captures: true,
      worker_enabled: true,
      meeting_extraction_enabled: true,
    },
    summary: {
      jobs_queued: 0,
      jobs_running: 0,
      jobs_done: 0,
      jobs_failed: 0,
      job_completion_rate: null,
      edges_active: 0,
      mem_items_active: 0,
      edge_density: 0,
    },
    meeting_pipeline: { captures: 0 },
    now_ms: Date.now(),
    stub: false,
    echo,
  };
}
if (command === "shogun_kioku_extraction_requeue") {
  return {
    requeued: 0,
    only_billing: !!(echo && echo.only_billing !== false),
    stub: false,
    echo,
  };
}
if (command === "shogun_kioku_pipeline_smoke") {
  return {
    ok: false,
    worker_enabled: false,
    meeting_extraction_enabled: true,
    capture_to_mem_captures: false,
    llm_key_configured: false,
    queued_jobs: 0,
    failed_jobs: 0,
    failed_billing_jobs: 0,
    billing_blocked: false,
    meeting_captures: 0,
    read_path: mockKiokuReadPath(g),
    stub: true,
    echo,
  };
}

const notImpl = (message: string) => ({
  notImplemented: true,
  message: message,
  stub: false,
  echo: echo,
});

// Phase 2.1.4 T6 — Test-only seam. Playwright specs set
// `window.__shogunMockOverrides[command] = (payload) => envelope` to
// dial in mirror_status / list_devices / etc. Override convention is the
// app.jsx envelope `{ ok, data }`; ipc-client unwraps to inner data here
// (the surrounding `invoke()` re-wraps it). See tests/e2e/_helpers/mirror-mock.js.
if (
  typeof g !== "undefined" &&
  g.__shogunMockOverrides &&
  typeof g.__shogunMockOverrides[command] === "function"
) {
  const result: any = g.__shogunMockOverrides[command](echo);
  return result && result.ok === true && Object.prototype.hasOwnProperty.call(result, "data")
    ? result.data
    : result;
}

switch (command) {
  case "app_integration_connect":
  case "app_integration_toggle":
  case "app_integration_import_credentials":
  case "app_integration_credentials_status":
  case "shogun_google_calendar_sync":
  case "shogun_gmail_sync":
  case "shogun_slack_sync":
  case "shogun_notion_sync":
  case "shogun_github_sync":
  case "shogun_linear_sync":
  case "shogun_drive_sync":
  case "shogun_zoom_sync":
  case "shogun_outlook_sync":
  case "shogun_figma_sync":
  case "shogun_claude_sync":
  case "shogun_apple_calendar_sync":
  case "shogun_apple_reminders_sync": {
    const C = ShogunIntegrationConnectors;
    if (C && typeof C.mockIntegrationPayload === "function") {
      const payload = C.mockIntegrationPayload(command, echo);
      if (payload) return payload;
    }
    return notImpl("Integration mock unavailable.");
  }
  case "shogun_draft": {
    const asb = buildMemoryAssemblyBlock(echo && echo.memoryAssembly);
    let memNote = "";
    if (asb) {
      memNote =
        "\n\n_Local Memory context (assembled)_\n\n" +
        asb.text +
        "\n";
    }
    return {
      content:
        "# Draft\n\n_Mock Markdown from browser transport. Tauri uses your LLM key._\n" + memNote,
      title: echo.target ? `Draft · ${echo.target}` : "Draft",
      stub: false,
      echo: echo,
    };
  }
  case "shogun_schedule_action":
    return {
      scheduled: true,
      id: "sch-mock",
      stub: false,
      echo: echo,
    };
  case "shogun_open_pack":
    return {
      ok: true,
      data: {
        opened: true,
        path: "(browser mock) packs/example",
        stub: false,
        echo: echo,
      },
    };
  case "shogun_start_focus_session":
    return {
      ok: true,
      data: {
        started: true,
        ends_at_ms: Date.now() + 25 * 60 * 1000,
        state_path: "(browser mock) active_focus.json",
        focus_markdown: "(browser mock) FOCUS.md",
        stub: false,
        echo: echo,
      },
    };
  case "shogun_draft_reply": {
    const emailFmt =
      echo &&
      (echo.format === "email" || echo.draftKind === "email" || echo.channel === "email");
    const src = String((echo && echo.sourceText) || "").trim();
    const meetTitle = String((echo && echo.meetingTitle) || "Meeting").trim();
    const content = emailFmt
      ? `# 件名: ${meetTitle} · フォローアップ\n\nチームの皆様\n\n先ほどの打ち合わせの共有です。下記メモをベースにご確認ください。\n\n---\n\n${src || "（本文なし）"}\n\n---\n\n_Desktop + API キーで本番の下書き生成に接続されます。_`
      : "# Draft reply (browser mock)\n\nUse Tauri + LLM key for Brief-aware drafts.\n";
    return {
      ok: true,
      data: {
        content,
        title: emailFmt ? `Email draft · ${meetTitle}` : "Reply draft · mock",
        stub: false,
        echo: echo,
      },
    };
  }
  case "app_capture_pause":
    return {
      paused: true,
      honestPreferenceOnly: true,
      message:
        "Capture sampling paused. No new focus events will be recorded until you resume.",
      stub: false,
      echo: echo,
    };
  case "app_capture_resume":
    return {
      paused: false,
      honestPreferenceOnly: true,
      message:
        "Capture resumed. macOS records app focus, AX context, and input events locally (no screenshots).",
      stub: false,
      echo: echo,
    };
  case "shogun_capture_live_events":
    return {
      events: [],
      eventsPerMinute: 0,
      stub: false,
      echo: echo,
    };
  case "shogun_capture_status": {
    const focus = mockFrontmostFocus();
    return {
      paused: false,
      permissions: {
        accessibilityTrusted: false,
        screenCaptureGranted: false,
        inputMonitoringGranted: false,
      },
      inputTapRunning: false,
      eventsPerMinute: 0,
      frontmostFocus: focus,
      stub: false,
      echo: echo,
    };
  }
  case "shogun_screen_context_probe": {
    const focus = mockFrontmostFocus();
    const captureStatus = {
      paused: false,
      permissions: {
        accessibilityTrusted: false,
        screenCaptureGranted: false,
        inputMonitoringGranted: false,
      },
      inputTapRunning: false,
      eventsPerMinute: 0,
      frontmostFocus: focus,
      stub: false,
    };
    const hummingbirdContext = {
      enabled: true,
      mode: "any_app",
      frontmostApp: focus.appName,
      frontmostBundleId: focus.bundleId,
      frontmostWindowTitle: focus.windowTitle,
      frontmostFocus: focus,
      axSnapshot: "role=AXWindow\ntitle=Preview document",
      axSnapshotSource: "mock",
      axDiagnostics: {
        trusted: null,
        focusedElementPresent: false,
        focusedRole: null,
        focusedWindowTitle: focus.windowTitle,
        snapshotPresent: true,
        treePresent: false,
        reason: "browser_preview",
      },
      axTextSignalPresent: true,
      axTextSignalKeys: ["title"],
      axTextSignalQuality: "weak",
      axTextChars: 39,
      axLineCount: 2,
      stub: true,
    };
    const screenContextHealth = {
      state: "error",
      label: "Screen context blocked",
      message: "Desktop runtime is not available in browser preview.",
      accessibilityTrusted: false,
      axSnapshotPresent: true,
      axTextSignalPresent: true,
      axTextSignalKeys: ["title"],
      axTextSignalQuality: "weak",
      axTextChars: 39,
      axLineCount: 2,
      frontmostApp: focus.appName,
      frontmostBundleId: focus.bundleId,
      windowTitle: focus.windowTitle,
      windowTitleSource: focus.windowTitleSource,
      axSnapshotSource: "mock",
      axDiagnosticReason: "browser_preview",
    };
    const lastSamplerDecision = {
      capturedAtMs: Date.now(),
      outcome: "skipped",
      reason: "browser_preview",
      appName: focus.appName,
      bundleId: focus.bundleId,
      windowTitle: focus.windowTitle,
      axSource: "mock",
      axReason: "browser_preview",
      axTextSignalKeys: ["title"],
      axTextSignalQuality: "weak",
      textChars: 39,
      spatialPresent: false,
    };
    const samplerCoverage = {
      total: 1,
      textReadable: 1,
      strongTextReadable: 0,
      partialTextReadable: 0,
      weakTextReadable: 1,
      focusOnly: 0,
      empty: 0,
      skipped: 1,
      byApp: [{
        appName: focus.appName,
        bundleId: focus.bundleId,
        total: 1,
        textReadable: 1,
        strongTextReadable: 0,
        partialTextReadable: 0,
        weakTextReadable: 1,
        unreadable: 0,
        actionableSamples: 0,
        focusOnly: 0,
        empty: 0,
        skipped: 1,
        latestAtMs: lastSamplerDecision.capturedAtMs,
        latestOutcome: lastSamplerDecision.outcome,
        latestReason: lastSamplerDecision.reason,
        latestAxSource: lastSamplerDecision.axSource,
        latestTextChars: lastSamplerDecision.textChars,
        latestActionableAtMs: null,
        latestActionableReason: null,
        latestActionableAxReason: null,
        latestActionableAxSource: null,
        latestActionableAxTextSignalKeys: [],
        latestActionableRecommendedAction: null,
      }],
      bySource: [{
        source: "mock",
        total: 1,
        textReadable: 1,
        strongTextReadable: 0,
        partialTextReadable: 0,
        weakTextReadable: 1,
        empty: 0,
      }],
      byIssue: [{
        reason: "browser_preview",
        axReason: "browser_preview",
        severity: "info",
        recommendedAction: "Browser preview uses mock data; validate live AX capture in the desktop app.",
        total: 1,
        textReadable: 1,
        strongTextReadable: 0,
        partialTextReadable: 0,
        weakTextReadable: 1,
        unreadable: 0,
        actionable: false,
        latestAtMs: lastSamplerDecision.capturedAtMs,
        latestAppName: focus.appName,
        latestBundleId: focus.bundleId,
        latestWindowTitle: focus.windowTitle,
        latestAxSource: lastSamplerDecision.axSource,
        latestAxTextSignalKeys: lastSamplerDecision.axTextSignalKeys,
      }],
      recent: [lastSamplerDecision],
    };
    return {
      capturedAtMs: Date.now(),
      frontmostFocus: focus,
      captureStatus: captureStatus,
      hummingbirdContext: hummingbirdContext,
      screenContextHealth: screenContextHealth,
      lastSamplerDecision: lastSamplerDecision,
      samplerCoverage: samplerCoverage,
      stub: false,
      echo: echo,
    };
  }
  case "app_onboarding_complete":
    mergeMockSettingsSection("onboarding", { complete: true }, g);
    mergeMockSettingsSection("capture", { paused: false }, g);
    return { complete: true, stub: false, echo: echo };
  case "shogun_memory_search": {
    const q = String((echo && echo.query) || "");
    const semantic = !!(echo && echo.semantic);
    const scope = String((echo && echo.scope) || "").toLowerCase();
    const readPath = mockKiokuReadPath(g);
    const result = searchMemoryIndex(q, echo && echo.limit, semantic);
    let hits = result.hits;
    if (scope === "timeline") {
      hits = hits.map((h: any) => ({ ...h, content_type: "memory" }));
    }
    const out: Record<string, unknown> = {
      hits,
      total: result.total,
      semanticRerank: semantic,
      read_path: readPath,
      echo: echo,
      stub: false,
    };
    if (scope === "timeline") {
      out.scope = "timeline";
    }
    return out;
  }
  case "shogun_memory_fetch":
    return {
      items: readMemoryIndex().map((h: any, i: number) => normalizeMemoryHit(h, "mock-fetch-" + i)),
      echo: echo,
      stub: false,
    };
  case "shogun_memory_ingest":
    {
      const cur = readMemoryIndex().map((h: any, i: number) => normalizeMemoryHit(h, "mock-cur-" + i));
      const id = String((echo && echo.id) || ("mock-" + Date.now()));
      const item = normalizeMemoryHit(
        {
          id: id,
          title: (echo && echo.title) || "Quick memory",
          snippet: (echo && echo.snippet) || "",
          source: (echo && echo.source) || "note",
          provenance: (echo && echo.provenance) || (echo && echo.source) || "note",
          kinds: echo && echo.kinds,
          entity_id: echo && echo.entity_id,
          ts: nowIso(),
        },
        id,
      );
      cur.unshift(item);
      writeMemoryIndex(cur);
    }
    return {
      ingested: true,
      echo: echo,
      stub: false,
    };
  case "shogun_memory_delete":
    {
      const id = String((echo && echo.id) || "").trim();
      if (id) {
        const cur = readMemoryIndex().map((h: any, i: number) => normalizeMemoryHit(h, "mock-del-" + i));
        const next = cur.filter((h: any) => String(h.id) !== id);
        writeMemoryIndex(next);
      }
    }
    return {
      deleted: true,
      echo: echo,
      stub: false,
    };
  case "shogun_memory_embed_backfill": {
    const lim = echo && echo.limit != null ? Number(echo.limit) : 40;
    const clamped = Number.isFinite(lim) ? Math.min(200, Math.max(1, Math.floor(lim))) : 40;
    return {
      embedded: 0,
      failed: 0,
      remaining: 0,
      attempted: clamped,
      cancelled: false,
      echo: echo,
      stub: false,
    };
  }
  case "shogun_memory_embed_backfill_cancel":
    return {
      requested: true,
      echo: echo,
      stub: false,
    };
  case "shogun_memory_debug_gate":
    return { available: false, reason: "mock_browser" };
  case "shogun_memory_debug_recent_calls":
    return { calls: [], capacity: 50 };
  case "shogun_memory_debug_query":
    return {
      hits: [],
      draft_block: "",
      brief_block: "",
      reply_block: "",
      query: (echo && echo.query) || "",
      limit: (echo && echo.limit) || 12,
      semantic: !!(echo && echo.semantic),
    };
  case "shogun_memory_debug_stats":
    return {
      total: 0,
      fts_total: 0,
      fts_integrity: true,
      by_source: [],
      by_provenance: [],
      earliest_ms: null,
      latest_ms: null,
      db_bytes: 0,
    };
  case "shogun_memory_debug_sync_status":
    return {
      google_calendar: { last_sync_ms: null, last_ingested: null, last_error: null, last_duration_ms: null, credentials_present: false, auto_enabled: false },
      gmail: { last_sync_ms: null, last_ingested: null, last_error: null, last_duration_ms: null, credentials_present: false, auto_enabled: false },
    };
  case "shogun_memory_summary_get":
    return {
      summary: {
        targetKind: "item",
        targetId: String((echo && echo.targetId) || "m_stub"),
        title: "Stub summary",
        keyPoints: ["This is a mocked summary"],
        sourceType: "mail",
        priority: "medium",
        reason: "mock",
        model: "mock",
        schemaVersion: 1,
        generatedAt: Date.now(),
      },
      cached: false,
    };
  case "shogun_memory_summary_batch":
    return {
      ok: ((echo && echo.items) || []).map((it: any) => ({
        targetKind: "item",
        targetId: String((it && it.id) || "m_stub"),
        title: `Stub: ${(it && it.title) || "untitled"}`,
        keyPoints: ["mock point"],
        sourceType: "mail",
        priority: "medium",
        reason: "mock",
        model: "mock",
        schemaVersion: 1,
        generatedAt: Date.now(),
      })),
      failed: [],
      heuristicUsed: 0,
    };
  case "shogun_memory_summary_invalidate":
    return { deleted: true };
  case "shogun_entity_query":
    return {
      entities: DEMO && Array.isArray(DEMO.entities) ? DEMO.entities : [],
      echo: echo,
      stub: false,
    };
  case "shogun_stats": {
    const empty = {
      eventsToday: "0",
      memoriesToday: "0",
      memoryTotal: 0,
      memoriesLast24h: 0,
      memories: "0",
      disk: "0 B",
      historyDays: "0 days",
      usagePercent: 0,
      appCoverage: [],
      echo: echo,
      stub: false,
    };
    const base: any =
      DEMO && DEMO.stats && typeof DEMO.stats === "object"
        ? Object.assign({}, DEMO.stats, { echo: echo, stub: false })
        : empty;
    if (echo && echo.stage === "capture") {
      base.settings = {
        sections: {
          capture: {
            axRichCapture: false,
            sampleIntervalSecs: 8,
            axMinIntervalSecs: 0,
            paused: false,
          },
          integrations: {
            googleCalendarAutoSync: false,
            googleCalendarSyncIntervalMins: 15,
          },
        },
      };
    }
    if (echo && echo.section === "storage") {
      base.memories = base.memories || String(base.memoryTotal || 0);
    }
    const liveTotal = readMemoryIndex().length;
    base.memoryTotal = liveTotal;
    base.memories = String(liveTotal);
    return base;
  }
  case "shogun_chat_complete": {
    const msgs = (echo && echo.messages) || [];
    const last = msgs[msgs.length - 1];
    const userText =
      last && last.role === "user" ? String(last.content || "") : "";
    const preview = userText.length > 120 ? userText.slice(0, 120) + "…" : userText;
    const ws =
      echo && echo.webSearch
        ? "\n\n[Web research mode: on — desktop app adds a system hint; live browse still requires a search API or pasted URLs.]"
        : "";
    let ma = "";
    const asb = buildMemoryAssemblyBlock(echo && echo.memoryAssembly);
    if (asb) {
      ma =
        "\n\n[Local Memory context assembled]\n" +
        asb.text +
        "\n\n(query: " +
        JSON.stringify(asb.query.slice(0, 100)) +
        ", limit: " +
        asb.limit +
        ", semantic: " +
        asb.semantic +
        ", hits: " +
        asb.total +
        ")";
    }
    return {
      message:
        "[Demo — set an API key in the desktop app for real completions.]\n\nYou asked: " +
        (preview || "(empty)") +
        "\n\nFor **Kitazawa / Aurora**, a sensible next step is to pin the beta scope (DPIA + onboarding) and keep investor slides to three proof points until metrics land." +
        ws +
        ma,
      memoryAssembly: asb
        ? {
            query: asb.query,
            limit: asb.limit,
            semantic: asb.semantic,
            total: asb.total,
            hits: asb.hits,
            read_path: mockKiokuReadPath(g),
          }
        : null,
      memoryReadPath: mockKiokuReadPath(g),
      liveScreenContextIncluded: echo?.includeScreenContext !== false,
      liveScreenContextChars: echo?.includeScreenContext === false ? 0 : 219,
      stub: false,
      echo: echo,
    };
  }
  case "app_open_hummingbird":
    return {
      opened: true,
      stub: false,
      echo: echo,
    };
  case "app_create_share_link": {
    const mode = (echo && echo.mode) || "private";
    const rt = echo && echo.resourceType;
    let url = null;
    let shareId = null;
    const origin =
      typeof g.window !== "undefined" &&
      g.window.location &&
      g.window.location.origin
        ? g.window.location.origin
        : "https://shogun.app";
    if (rt === "meeting_note" && echo && echo.storageKey) {
      const raw = String(echo.storageKey).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
      shareId = raw || "mtg-local";
      const access = mode === "public" ? "view" : "restricted";
      url = `${origin}/share/mtg/${encodeURIComponent(shareId)}?access=${access}`;
    } else if (echo && echo.chatId != null) {
      shareId = "chat-" + String(echo.chatId);
      url = `${origin}/share/chat/${encodeURIComponent(shareId)}`;
    }
    return {
      exported: true,
      path: "/mock/shogun-share-export.md",
      url: url || undefined,
      shareId: shareId || undefined,
      stub: false,
      echo: echo,
    };
  }
  case "app_settings_load":
    return {
      settings: { sections: readMockSettingsSections(g) },
      echo: echo,
      stub: false,
    };
  case "legal_docs_load":
    // Stub markdown so the consent modal renders in browser/E2E mode.
    // The Tauri build reads real bundled docs in src-tauri/legal_docs.rs.
    return {
      terms:
        "# Terms of Service\n\nMock terms for browser preview and tests.\n",
      privacy:
        "# Privacy Policy\n\nMock privacy policy for browser preview and tests.\n",
      lang: (echo && echo.lang) || "en",
      stub: true,
      echo: echo,
    };
  case "app_settings_save": {
    if (echo && echo.section) {
      const section = echo.section;
      const { section: _s, ...rest } = echo;
      mergeMockSettingsSection(section, rest, g);
    }
    return {
      saved: true,
      stub: false,
      echo: echo,
    };
  }
  case "app_llm_api_key_set": {
    const hasKey = String((echo && echo.apiKey) || "").trim().length > 0;
    writeMockLlmKeyConfigured(hasKey, g);
    return { saved: true, stub: false, echo: echo };
  }
  case "app_llm_api_key_status":
    return {
      configured: readMockLlmKeyConfigured(g),
      echo: echo,
      stub: false,
    };
  case "app_llm_api_key_clear":
    writeMockLlmKeyConfigured(false, g);
    return { cleared: true, echo: echo, stub: false };
  case "app_permissions_manage":
    return {
      opened: true,
      note: "Opened System Settings for the requested privacy pane when supported.",
      stub: false,
      echo: echo,
    };
  case "app_privacy_pick_app":
    return {
      cancelled: true,
      stub: false,
      note: "Native .app picker is available in the macOS desktop build.",
      echo: echo,
    };
  case "app_diagnostics_report":
    return {
      reportId: "diag-mock",
      path: "/mock/diagnostics.json",
      summary: {
        capture: {},
        macosAccessibilityTrusted: null,
        integrations: {
          google_calendar: {
            configured: false,
            tokenRefreshReady: false,
          },
          calendarAutoSync: {
            autoSyncEnabled: false,
            autoSyncIntervalMins: 15,
          },
        },
      },
      stub: false,
      echo: echo,
    };
  case "app_frontend_error_report":
    return { logged: true, stub: false, echo: echo };
  case "app_updates_check":
    return { available: false, stub: true, echo: echo };
  case "app_updates_download_install":
    return { installed: true, stub: true, echo: echo };
  case "app_delete_data_range":
    return {
      deleted: true,
      range: echo.range || "",
      stub: false,
      echo: echo,
    };
  case "app_delete_all_data":
    return { deleted: true, stub: false, echo: echo };
  case "app_delete_account":
    return {
      deleted: true,
      note: "Local data cleared. No cloud account is associated with this build.",
      stub: false,
      echo: echo,
    };
  case "auth_clerk_config":
    return {
      enabled: false,
      publishableKey: "",
      frontendApi: "",
      clerkJsUrl: "",
      redirectUrl: "shogun-ai://clerk-callback",
      stub: true,
      echo: echo,
    };
  case "auth_open_browser_sign_in":
    return {
      opened: true,
      stub: true,
      message: "Mock: set CLERK_* in .env and run the desktop app to open the real sign-in URL.",
      echo: echo,
    };
  case "auth_open_browser_sign_up":
    return {
      opened: true,
      stub: true,
      message: "Mock: set CLERK_* in .env and run the desktop app for sign-up.",
      echo: echo,
    };
  case "billing_config":
    return {
      enabled: false,
      webAppUrl: "",
      stub: true,
      echo: echo,
    };
  case "billing_open_url":
    return {
      opened: true,
      url: echo && echo.url ? echo.url : "",
      stub: true,
      echo: echo,
    };
  case "mcp_setup_detect":
    return {
      claudeConfigPath: "~/Library/Application Support/Claude/claude_desktop_config.json",
      claudeConfigExists: false,
      claudeInstalled: false,
      binaryPath: null,
      binaryFound: false,
      shogunConfigured: false,
      stub: true,
      echo: echo,
    };
  case "mcp_setup_write_config":
    return { written: true, stub: true, echo: echo };
  case "mcp_setup_verify":
    return { ok: false, reason: "config_missing", stub: true, echo: echo };
  case "mcp_setup_complete":
    mergeMockSettingsSection("onboarding", { mcpComplete: true }, g);
    return { complete: true, stub: true, echo: echo };
  case "mcp_setup_open_claude_config":
  case "mcp_setup_open_claude_app":
    return { opened: true, stub: true, echo: echo };
  case "auth_status":
    return {
      clerk: {
        enabled: false,
        publishableKey: "",
        frontendApi: "",
        clerkJsUrl: "",
        redirectUrl: "shogun-ai://clerk-callback",
      },
      snapshot: null,
      stub: true,
      echo: echo,
    };
  case "auth_session_save":
    return { saved: true, stub: true, echo: echo };
  case "auth_sign_out":
    return { signedOut: true, stub: true, echo: echo };
  case "auth_biometric_status":
    return {
      supported: false,
      enrolled: false,
      platform: "mock",
      biometryType: "none",
      stub: true,
      echo: echo,
    };
  case "auth_biometric_authenticate":
    return { ok: true, stub: true, echo: echo };
  case "shogun_meeting_enhance": {
    const notes = String((echo && echo.notes) || "").trim();
    const tx = String((echo && echo.transcript) || "").trim();
    const title = String((echo && echo.title) || "Meeting").trim();
    const minutesMarkdown = [
      "## AI 議事録（Hi-Fi モック）",
      "",
      "### 要約",
      "録音の文字起こしとあなたのメモを統合したドラフトです。デスクトップアプリではモデルが本番生成します。",
      "",
      "### メモより",
      notes ? notes.slice(0, 1200) : "（メモなし）",
      "",
      "### 文字起こしより",
      tx ? tx.slice(0, 2000) : "（文字起こしなし — 録音を反映すると精度が上がります）",
      "",
      "### 次のアクション",
      "- [ ] フォローアップを確認",
      "",
      "_Meeting: " + title + "_",
    ].join("\n");
    return {
      minutesMarkdown: minutesMarkdown,
      stub: true,
      echo: echo,
    };
  }
  case "shogun_meeting_recipe_run": {
    const rid = String((echo && echo.recipe_id) || "rec-coach-me");
    const notes = String((echo && echo.notes) || "").trim();
    const tx = String((echo && echo.transcript) || "").trim();
    const body = notes || tx;
    if (!body) {
      return { text: "", stub: true, recipe_id: rid, echo: echo };
    }
    return {
      recipe_id: rid,
      meeting_id: String((echo && echo.meeting_id) || ""),
      text: "## Recipe (Hi-Fi mock)\n\n" + body.slice(0, 2000) + "\n\n_Desktop uses your LLM key for full recipe output._",
      stub: true,
      echo: echo,
    };
  }
  case "shogun_oauth_google_start": {
    // Mock: simulate a successful in-app OAuth flow without the actual
    // browser round-trip. Real backend launches a localhost server +
    // system browser; the mock just returns metadata immediately.
    const C = ShogunIntegrationConnectors;
    const hasAccess = true;
    const hasRefresh = true;
    const hasClient = true;
    const scopes = [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
    ];
    const googleProviders = ["gmail", "google_calendar", "google_drive"];
    for (const slug of googleProviders) {
      if (slug === "google_calendar") {
        C?.writeGcalMock?.({
          configured: hasAccess,
          tokenRefreshReady: hasRefresh && hasClient,
          importedAt: Date.now(),
        });
      } else if (slug === "gmail") {
        C?.writeGmailMock?.({
          configured: hasAccess,
          tokenRefreshReady: hasRefresh && hasClient,
          importedAt: Date.now(),
        });
      } else if (slug === "google_drive") {
        C?.writeGDriveMock?.({
          configured: hasAccess,
          tokenRefreshReady: hasRefresh && hasClient,
          importedAt: Date.now(),
        });
      }
    }
    return {
      ok: true,
      provider: (echo && echo.provider) || "gmail",
      scopes,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      refreshTokenPresent: true,
    };
  }
  case "shogun_memory_export":
    return { exported: 0, path: "/mock/memory.shogun-memory.jsonl", stub: true, echo };
  case "shogun_memory_import": {
    const confirmToken = "REPLACE";
    if ((echo && echo.confirm) !== confirmToken) {
      throw createError(
        "INVALID_INPUT",
        `import requires explicit ${confirmToken} confirmation`,
      );
    }
    return { imported: 0, path: "/mock/memory.shogun-memory.jsonl", stub: true, echo };
  }
  case "mirror_register":
    return { device_id: "mock_device_id_stub", stub: true };
  case "mirror_unlock":
    return { stub: true };
  case "mirror_status":
    return { enabled: false, queue_depth: 0, last_sync_at: null, last_error: null, locked: true, device_id: null, stub: true };
  case "mirror_sync_now":
    return { synced_count: 0, stub: true };
  case "mirror_disable":
    return { stub: true };
  case "mirror_reset_stuck":
    return { reset: 0, stub: true };
  case "mirror_search_blobs":
    return { hits: [
      { blob_id: "stub_blob_1", device_id: "stub_device_other", id: "stub_mem_1", title: "Stub mirror result", snippet: "Mock cloud hit", source_field: "google.com", kinds_json: "[\"screen\"]", created_at: 1715000000000, similarity: 0.85, source: "mirror-other", device_name: "Stub iMac" },
    ], stub: true };
  case "mirror_list_devices":
    return { devices: [
      { device_id: "stub_device_self", blob_count: 42, latest_stored_at: "2026-05-06T12:00:00Z", is_this_device: true, device_name: "This Mac" },
      { device_id: "stub_device_other", blob_count: 17, latest_stored_at: "2026-05-05T08:30:00Z", is_this_device: false, device_name: "Stub iMac" },
    ], truncated: false, stub: true };
  case "mirror_rename_device":
    return { device: { device_id: echo?.device_id || "stub_device", device_name: echo?.new_name || "Renamed Stub", registered_at: "2026-04-01T00:00:00Z" }, stub: true };
  case "mirror_delete_device":
    return { tombstoned_blobs: 5, stub: true };
  case "shogun_oauth_google_app_status":
    return { configured: false, stub: true, echo: echo };
  case "shogun_oauth_google_app_set":
    return { saved: true, configured: true, stub: true, echo: echo };
  case "shogun_agent_run_now": {
    const agentId = String((echo && (echo.agentId || echo.agent_id)) || "").trim();
    return {
      agentId: agentId,
      ok: true,
      ingested: agentId === "inbox-triage" ? 3 : 2,
      summary: agentId ? agentId + " completed (mock)" : "done",
      stub: true,
      echo: echo,
    };
  }
  case "shogun_hummingbird_context": {
    const focus = mockFrontmostFocus();
    return {
      enabled: true,
      mode: "any_app",
      frontmostApp: focus.appName,
      frontmostBundleId: focus.bundleId,
      frontmostWindowTitle: focus.windowTitle,
      frontmostFocus: focus,
      axSnapshot: "role=AXWindow\ntitle=Preview document",
      axSnapshotSource: "mock",
      axDiagnostics: {
        trusted: null,
        focusedElementPresent: false,
        focusedRole: null,
        focusedWindowTitle: focus.windowTitle,
        snapshotPresent: true,
        treePresent: false,
        reason: "browser_preview",
      },
      axTextSignalPresent: true,
      axTextSignalKeys: ["title"],
      axTextSignalQuality: "weak",
      axTextChars: 39,
      axLineCount: 2,
      stub: true,
      echo: echo,
    };
  }
  default:
    return {
      stub: true,
      mock: true,
      echo: echo,
      command: command,
    };
}
}

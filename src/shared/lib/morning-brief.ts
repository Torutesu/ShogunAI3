import { ShogunUserTimezone } from './user-timezone';
import { readMockSettingsSections } from '@/shared/ipc/mock/settings';

function wantsV2(payload: any) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.forceV2 === true) return true;
  const v = payload.version || payload.briefVersion;
  return v === "2" || v === "2.0";
}

function pad2(n: any) {
  return String(n).padStart(2, "0");
}

function resolveUserTz(payload: any) {
  if (payload && payload.user_tz && String(payload.user_tz).trim()) {
    return String(payload.user_tz).trim();
  }
  const U = ShogunUserTimezone;
  if (U && typeof U.getTimeZone === "function") {
    try {
      const t = U.getTimeZone();
      if (t && String(t).trim()) return String(t).trim();
    } catch (_e) {
      /* ignore */
    }
  }
  try {
    const t = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (t && String(t).trim()) return String(t).trim();
  } catch (_e2) {
    /* ignore */
  }
  return "UTC";
}

/** Browser mock aligned with `src-tauri/src/brief.rs` (Unicode escapes = Rust source). */
function morningBriefV2Mock(payload: any) {
  const now = new Date();
  const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const generated_at = now.toISOString();
  const user_tz = resolveUserTz(payload);

  return {
    version: "2.0",
    generated_at: generated_at,
    user_tz: user_tz,
    date: date,
    summary: {
      headline:
        "Kitazawa Tech · Aurora beta prep + 2 investor touchpoints (sample brief)",
      posture: "meeting-heavy",
      total_meeting_minutes: 120,
      focus_blocks: [{ start: "13:00", end: "15:00", duration_minutes: 120 }],
    },
    items: [
      {
        id: "item_01",
        priority: 1,
        category: "meeting",
        what:
          "10:00 Investor sync — Jordan Blake / Northline Partners (fictive)",
        why_now:
          "Last week you promised the adoption slide and DPIA one-pager before this call.",
        related_context: [
          {
            type: "document",
            title: "収益モデルv2",
            uri: "shogun://doc/revenue-v2",
          },
          {
            type: "document",
            title: "前回議事録",
            uri: "shogun://doc/minutes-last",
          },
          {
            type: "document",
            title: "競合比較スライド",
            uri: "shogun://doc/comp-deck",
          },
        ],
        next_action: {
          verb: "開く",
          label: "資料パックを開く",
          type: "open",
          mcp_tool: {
            tool_name: "shogun.open_pack",
            arguments: { pack_id: "investor_tanaka_apr18" },
          },
          estimated_minutes: 5,
        },
        time_hint: "10:00-11:00",
        source: { type: "calendar", upstream_ids: ["cal_evt_stub_1"] },
        confidence: 0.92,
      },
      {
        id: "item_02",
        priority: 2,
        category: "prep",
        what:
          "13:00-15:00 Focus Block — SHOGUN LP v2 コピー差し替え",
        why_now:
          "前回Dream Cycleで未完了タスク。今日の集中枠に割り当て済み。",
        related_context: [
          { type: "document", title: "LP v1", uri: "shogun://doc/lp-v1" },
          {
            type: "document",
            title: "コピーメモ",
            uri: "shogun://doc/copy-notes",
          },
        ],
        next_action: {
          verb: "開始する",
          label: "作業セッション開始",
          type: "execute",
          mcp_tool: {
            tool_name: "shogun.start_focus_session",
            arguments: { duration_minutes: 120, task: "lp_v2_copy" },
          },
          estimated_minutes: 120,
        },
        time_hint: "13:00-15:00",
        source: { type: "dream_cycle", upstream_ids: ["dc_task_lp_v2"] },
        confidence: 0.78,
      },
    ],
    deferred: [
      {
        id: "def_01",
        reason: "low_priority_today",
        snippet:
          "SLCT 問い合わせテンプレ更新（来週締切）",
      },
    ],
    stub: true,
    echo: payload || {},
  };
}

function morningBriefV1Mock(payload: any) {
  return {
    briefVersion: "1",
    sections: [],
    generatedAt: Date.now(),
    stub: true,
    echo: payload || {},
  };
}

function buildBriefGetPayload() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Tokyo";
  const params = new URLSearchParams(window.location.search || "");
  const payload: any = { user_tz: tz };
  if (params.get("brief") === "v2") payload.forceV2 = true;
  const brief = (window as any).__SHOGUN_SETTINGS_BRIEF__;
  if (brief && String(brief.morningBriefVersion) === "2") payload.version = "2.0";
  return payload;
}

function mockKiokuReadPath(): 'graph' | 'legacy' {
  const sections = readMockSettingsSections();
  const graph = sections.kioku_graph as Record<string, unknown> | undefined;
  const raw =
    graph && typeof graph.read_path === 'string'
      ? String(graph.read_path).toLowerCase()
      : 'graph';
  return raw === 'graph' ? 'graph' : 'legacy';
}

function mockMemoryDigest(readPath: 'graph' | 'legacy') {
  return {
    highlights: [
      {
        targetId: 'mock_graph_mem_1',
        targetKind: 'item',
        title: 'Aurora beta scope (sample)',
        keyPoints: ['DPIA checklist and onboarding flow from KIOKU graph retrieval.'],
        priority: 'medium',
        userPriority: 'medium',
        sourceType: 'memory',
        fromGraph: true,
      },
    ],
    week_rollup: null,
    day_rollup: null,
    read_path: readPath,
    graph_supplemented: readPath === 'graph',
  };
}

function normalizeBriefForUi(raw: any) {
  const headline =
    raw?.summary?.headline ?? raw?.headline ?? 'Your day from Memory';
  const posture = raw?.summary?.posture ?? raw?.posture ?? 'focus';
  const items = Array.isArray(raw?.items) ? raw.items : [];
  const deferredCount = Array.isArray(raw?.deferred)
    ? raw.deferred.length
    : Number(raw?.deferred_count ?? 0);
  return {
    headline,
    posture,
    items,
    deferred_count: deferredCount,
    generated_at: raw?.generated_at ?? null,
    patterns: raw?.patterns,
  };
}

function mockBriefGetResponse(payload: any) {
  const raw = wantsV2(payload) ? morningBriefV2Mock(payload) : morningBriefV1Mock(payload);
  const readPath = mockKiokuReadPath();
  const memoryDigest = mockMemoryDigest(readPath);
  const briefUi = normalizeBriefForUi(raw);
  const skipped =
    briefUi.items.length === 0
    && !(Array.isArray(memoryDigest.highlights) && memoryDigest.highlights.length > 0);
  return {
    skipped,
    brief: skipped ? null : briefUi,
    memory_digest: memoryDigest,
    memoryReadPath: readPath,
    stub: raw.stub ?? false,
  };
}

function unwrapBriefGetRegistryResult(registryResult: any) {
  if (!registryResult || !registryResult.ok) return { ok: false, brief: null };
  let x = registryResult.data;
  if (x && typeof x === "object" && "data" in x && x.ok !== undefined && "command" in x) {
    x = x.data;
  }
  return { ok: true, brief: x };
}

function resolveNextAction(nextAction: any, briefItem: any) {
  if (!nextAction || nextAction.type === "ignore") {
    return { skip: true };
  }
  const tool = nextAction.mcp_tool;
  if (tool && tool.tool_name) {
    const base =
      tool.arguments && typeof tool.arguments === "object"
        ? { ...tool.arguments }
        : {};
    if (briefItem && typeof briefItem === "object") {
      base.brief_item = {
        id: briefItem.id,
        what: briefItem.what,
        why_now: briefItem.why_now,
        related_context: briefItem.related_context,
        category: briefItem.category,
        priority: briefItem.priority,
        time_hint: briefItem.time_hint,
      };
    }
    return {
      skip: false,
      key: tool.tool_name,
      payload: base,
    };
  }
  switch (nextAction.type) {
    case "open":
      return {
        skip: false,
        key: "memory.search",
        payload: { query: nextAction.label || "", limit: 20, source: "morning_brief" },
      };
    case "draft":
      return {
        skip: false,
        key: "draft.create",
        payload: { source: "morning_brief", label: nextAction.label, verb: nextAction.verb },
      };
    case "schedule":
      return {
        skip: false,
        key: "schedule.create",
        payload: { source: "morning_brief", label: nextAction.label },
      };
    case "execute":
      return {
        skip: false,
        key: "schedule.create",
        payload: { source: "morning_brief_execute", verb: nextAction.verb, label: nextAction.label },
      };
    default:
      return { skip: true };
  }
}

export const ShogunMorningBrief = {
  wantsV2: wantsV2,
  buildBriefGetPayload: buildBriefGetPayload,
  mockBriefGetResponse: mockBriefGetResponse,
  unwrapBriefGetRegistryResult: unwrapBriefGetRegistryResult,
  resolveNextAction: resolveNextAction,
};


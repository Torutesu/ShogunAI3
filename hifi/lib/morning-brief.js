/* global window */
(function initMorningBrief(global) {
  function wantsV2(payload) {
    if (!payload || typeof payload !== "object") return false;
    if (payload.forceV2 === true) return true;
    const v = payload.version || payload.briefVersion;
    return v === "2" || v === "2.0";
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  /** Browser mock aligned with `src-tauri/src/brief.rs` (Unicode escapes = Rust source). */
  function morningBriefV2Mock(payload) {
    const now = new Date();
    const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    const generated_at = now.toISOString();
    const user_tz =
      (payload && payload.user_tz) ||
      Intl.DateTimeFormat().resolvedOptions().timeZone ||
      "Asia/Tokyo";

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
              title: "\u53ce\u76ca\u30e2\u30c7\u30ebv2",
              uri: "shogun://doc/revenue-v2",
            },
            {
              type: "document",
              title: "\u524d\u56de\u8b70\u4e8b\u9332",
              uri: "shogun://doc/minutes-last",
            },
            {
              type: "document",
              title: "\u7af6\u5408\u6bd4\u8f03\u30b9\u30e9\u30a4\u30c9",
              uri: "shogun://doc/comp-deck",
            },
          ],
          next_action: {
            verb: "\u958b\u304f",
            label: "\u8cc7\u6599\u30d1\u30c3\u30af\u3092\u958b\u304f",
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
            "13:00-15:00 Focus Block \u2014 SHOGUN LP v2 \u30b3\u30d4\u30fc\u5dee\u3057\u66ff\u3048",
          why_now:
            "\u524d\u56deDream Cycle\u3067\u672a\u5b8c\u4e86\u30bf\u30b9\u30af\u3002\u4eca\u65e5\u306e\u96c6\u4e2d\u67a0\u306b\u5272\u308a\u5f53\u3066\u6e08\u307f\u3002",
          related_context: [
            { type: "document", title: "LP v1", uri: "shogun://doc/lp-v1" },
            {
              type: "document",
              title: "\u30b3\u30d4\u30fc\u30e1\u30e2",
              uri: "shogun://doc/copy-notes",
            },
          ],
          next_action: {
            verb: "\u958b\u59cb\u3059\u308b",
            label: "\u4f5c\u696d\u30bb\u30c3\u30b7\u30e7\u30f3\u958b\u59cb",
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
            "SLCT \u554f\u3044\u5408\u308f\u305b\u30c6\u30f3\u30d7\u30ec\u66f4\u65b0\uff08\u6765\u9031\u7de0\u5207\uff09",
        },
      ],
      stub: true,
      echo: payload || {},
    };
  }

  function morningBriefV1Mock(payload) {
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
    const payload = { user_tz: tz };
    if (params.get("brief") === "v2") payload.forceV2 = true;
    const brief = global.__SHOGUN_SETTINGS_BRIEF__;
    if (brief && String(brief.morningBriefVersion) === "2") payload.version = "2.0";
    return payload;
  }

  function mockBriefGetResponse(payload) {
    return wantsV2(payload) ? morningBriefV2Mock(payload) : morningBriefV1Mock(payload);
  }

  function unwrapBriefGetRegistryResult(registryResult) {
    if (!registryResult || !registryResult.ok) return { ok: false, brief: null };
    let x = registryResult.data;
    if (x && typeof x === "object" && "data" in x && x.ok !== undefined && "command" in x) {
      x = x.data;
    }
    return { ok: true, brief: x };
  }

  function resolveNextAction(nextAction, briefItem) {
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

  global.ShogunMorningBrief = {
    wantsV2: wantsV2,
    buildBriefGetPayload: buildBriefGetPayload,
    mockBriefGetResponse: mockBriefGetResponse,
    unwrapBriefGetRegistryResult: unwrapBriefGetRegistryResult,
    resolveNextAction: resolveNextAction,
  };
})(window);

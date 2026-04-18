/**
 * Dry-run composer without Anthropic — templates AMC from candidate shape.
 */
function hhmmFromIso(iso) {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function timeRange(cal) {
  if (!cal?.start) return undefined;
  const a = hhmmFromIso(cal.start);
  const b = cal.end ? hhmmFromIso(cal.end) : undefined;
  if (a && b) return `${a}-${b}`;
  return a;
}

/**
 * @param {object} c preprocessed MorningBriefCandidate
 */
export function composeBriefItemHeuristic(c) {
  const cal = c.raw_data?.calendar_event;
  const email = c.raw_data?.email_thread;
  const weekly = c.raw_data?.weekly_brief;
  const focus = c.raw_data?.focus_block;

  let what =
    cal?.title ||
    email?.subject ||
    (weekly?.stuck_label ? `Focus block — ${weekly.stuck_label}` : null) ||
    "Focus item";
  if (what.length > 40) what = [...what].slice(0, 37).join("") + "…";

  let category = "prep";
  if (cal) category = "meeting";
  else if (c.trigger_source === "email") category = "followup";
  else if (c.trigger_source === "focus_block") category = "prep";

  const top = (c.related_kioku_hits || []).slice(0, 3);
  const related_context = top.map((h) => ({
    type: /** @type {const} */ ("document"),
    title: h.title,
    uri: `shogun://doc/${h.doc_id}`,
    last_touched: h.last_touched,
  }));

  const dg = c.decision_graph_hits?.[0];
  let why_now = "KIOKUとカレンダーを突合。今日動く。";
  if (dg?.summary) {
    const s = dg.summary.slice(0, 56);
    why_now = `${s}。期日は今日。`;
  }
  if (c.same_day_commitment_conflict) {
    why_now = `同日に2件のcommitment。${why_now}`;
  }
  if (typeof c.stuck_days === "number" && c.stuck_days > 0) {
    why_now = `停滞${c.stuck_days}日。${why_now}`;
  }
  if ([...why_now].length > 80) {
    why_now = [...why_now].slice(0, 77).join("") + "…";
  }

  const docIds = top.map((h) => h.doc_id);
  const canOpen = c.available_mcp_tools.includes("shogun.open_pack");
  const canFocus = c.available_mcp_tools.includes("shogun.start_focus_session");
  const canDraft = c.available_mcp_tools.includes("shogun.draft_reply");

  let next_action;
  if (category === "followup" && canDraft) {
    next_action = {
      verb: "確認する",
      label: "ドラフトを確認",
      type: "draft",
      mcp_tool: {
        tool_name: "shogun.draft_reply",
        arguments: { doc_ids: docIds, thread_id: c.candidate_id },
      },
      estimated_minutes: 5,
    };
  } else if (canOpen && docIds.length) {
    next_action = {
      verb: "開く",
      label: "資料パックを開く",
      type: "open",
      mcp_tool: { tool_name: "shogun.open_pack", arguments: { doc_ids: docIds } },
      estimated_minutes: 3,
    };
  } else if (canFocus) {
    next_action = {
      verb: "開始する",
      label: "作業セッション開始",
      type: "focus",
      mcp_tool: {
        tool_name: "shogun.start_focus_session",
        arguments: { label: what },
      },
      estimated_minutes: 25,
    };
  } else {
    next_action = {
      verb: "開く",
      label: "関連ドキュメントを開く",
      type: "other",
      estimated_minutes: 5,
    };
  }

  return {
    category,
    what,
    why_now,
    related_context,
    next_action,
    time_hint: timeRange(cal) || (focus ? timeRange(focus) : undefined),
    source: {
      type: c.trigger_source,
      upstream_ids: [c.candidate_id],
    },
    confidence:
      top.length > 0 ? Math.max(...top.map((h) => h.relevance_score)) : 0.55,
  };
}

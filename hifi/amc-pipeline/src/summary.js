import Anthropic from "@anthropic-ai/sdk";
import { BriefSummaryOutputSchema, getEmitBriefSummaryTool } from "./schemas.js";
import {
  SUMMARY_SYSTEM_PROMPT,
  buildSummaryUserPrompt,
} from "./prompts.js";

function extractToolUse(blocks, name) {
  if (!blocks) return null;
  for (const b of blocks) {
    if (b.type === "tool_use" && b.name === name) return b;
  }
  return null;
}

/**
 * @param {object[]} rankedItems BriefItem with id, what, category, time_hint, priority
 * @param {{ dryRun?: boolean, model?: string, apiKey?: string }} opts
 */
export async function generateSummary(rankedItems, opts = {}) {
  const payload = rankedItems.map((i) => ({
    id: i.id,
    what: i.what,
    category: i.category,
    time_hint: i.time_hint,
    priority: i.priority,
  }));

  if (opts.dryRun) {
    const meetingish = rankedItems.filter((i) =>
      ["meeting", "commitment"].includes(i.category)
    ).length;
    const headline =
      meetingish >= 2
        ? "会議多め、意思決定デイ"
        : rankedItems.length === 0
          ? "静かな一日"
          : "今日の優先を処理";
    return BriefSummaryOutputSchema.parse({
      headline: headline.slice(0, 20),
      posture:
        meetingish >= 2
          ? "meeting-heavy"
          : rankedItems.some((i) => i.category === "prep")
            ? "launch"
            : "focus",
    });
  }

  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing");

  const model =
    opts.model ||
    process.env.ANTHROPIC_SUMMARY_MODEL ||
    process.env.ANTHROPIC_MODEL ||
    "claude-sonnet-4-20250514";

  const client = new Anthropic({ apiKey });
  const tool = getEmitBriefSummaryTool();

  const msg = await client.messages.create({
    model,
    max_tokens: 512,
    system: SUMMARY_SYSTEM_PROMPT,
    tools: [tool],
    tool_choice: { type: "tool", name: "emit_brief_summary" },
    messages: [
      {
        role: "user",
        content: buildSummaryUserPrompt(payload),
      },
    ],
  });

  const tu = extractToolUse(msg.content, "emit_brief_summary");
  if (!tu || typeof tu.input !== "object") {
    throw new Error("emit_brief_summary missing");
  }
  return BriefSummaryOutputSchema.parse(tu.input);
}

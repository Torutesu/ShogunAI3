import Anthropic from "@anthropic-ai/sdk";
import { BriefItemComposerOutputSchema, getEmitBriefItemTool } from "./schemas.js";
import {
  AMC_SYSTEM_PROMPT,
  FEW_SHOT_BLOCK,
  buildUserPromptForCandidate,
} from "./prompts.js";
import { composeBriefItemHeuristic } from "./heuristic.js";

function extractToolUse(blocks, name) {
  if (!blocks) return null;
  for (const b of blocks) {
    if (b.type === "tool_use" && b.name === name) return b;
  }
  return null;
}

/**
 * @param {import('./schemas.js').MorningBriefCandidate} candidate
 * @param {{ dryRun?: boolean, model?: string, apiKey?: string }} opts
 */
export async function composeOneCandidate(candidate, opts = {}) {
  if (opts.dryRun) {
    return composeBriefItemHeuristic(candidate);
  }

  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY missing and dryRun=false");
  }

  const model =
    opts.model ||
    process.env.ANTHROPIC_MODEL ||
    "claude-sonnet-4-20250514";

  const client = new Anthropic({ apiKey });
  const tool = getEmitBriefItemTool();

  const msg = await client.messages.create({
    model,
    max_tokens: 2048,
    system: `${AMC_SYSTEM_PROMPT}\n\n${FEW_SHOT_BLOCK}`,
    tools: [tool],
    tool_choice: { type: "tool", name: "emit_brief_item" },
    messages: [
      {
        role: "user",
        content: buildUserPromptForCandidate(candidate),
      },
    ],
  });

  const tu = extractToolUse(msg.content, "emit_brief_item");
  if (!tu || typeof tu.input !== "object") {
    throw new Error("emit_brief_item tool_use missing in response");
  }

  return BriefItemComposerOutputSchema.parse(tu.input);
}

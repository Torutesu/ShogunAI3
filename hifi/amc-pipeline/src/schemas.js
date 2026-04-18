/**
 * BriefItem / Candidate schemas — single source for Zod parse + Anthropic tool input_schema.
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export const TriggerSourceSchema = z.enum([
  "calendar",
  "email",
  "slack",
  "kioku",
  "decision_graph",
  "signal",
  "focus_block",
  "other",
]);

export const KiokuHitSchema = z.object({
  doc_id: z.string(),
  title: z.string(),
  snippet: z.string().optional(),
  last_touched: z.string().optional(),
  relevance_score: z.number().min(0).max(1),
});

export const DecisionGraphHitSchema = z.object({
  decision_id: z.string(),
  summary: z.string(),
  follow_ups_pending: z.number().int().nonnegative().optional(),
});

export const CalendarEventSchema = z.object({
  id: z.string().optional(),
  title: z.string(),
  start: z.string(),
  end: z.string().optional(),
  attendees: z.array(z.string()).optional(),
  description: z.string().optional(),
});

export const MorningBriefCandidateSchema = z.object({
  candidate_id: z.string(),
  trigger_source: TriggerSourceSchema,
  raw_data: z.record(z.unknown()),
  related_kioku_hits: z.array(KiokuHitSchema).default([]),
  decision_graph_hits: z.array(DecisionGraphHitSchema).default([]),
  available_mcp_tools: z.array(z.string()),
  /** Optional: stuck days from Weekly Brief (preferred over parsing why_now) */
  stuck_days: z.number().int().nonnegative().optional(),
  /** Same-day multiple commitments flag for composer */
  same_day_commitment_conflict: z.boolean().optional(),
});

export const RelatedContextItemSchema = z.object({
  type: z.literal("document"),
  title: z.string(),
  uri: z.string(),
  last_touched: z.string().optional(),
});

export const McpToolCallSchema = z.object({
  tool_name: z.string(),
  arguments: z.record(z.unknown()).optional(),
});

export const NextActionSchema = z.object({
  verb: z.string(),
  label: z.string(),
  type: z.enum(["open", "draft", "focus", "other"]),
  mcp_tool: McpToolCallSchema.optional(),
  estimated_minutes: z.number().nonnegative().optional(),
});

export const BriefItemCategorySchema = z.enum([
  "meeting",
  "commitment",
  "decision",
  "followup",
  "prep",
  "review",
  "signal",
]);

/** LLM / composer output — priority assigned later by ranker */
export const BriefItemComposerOutputSchema = z.object({
  category: BriefItemCategorySchema,
  what: z.string().max(40),
  why_now: z.string().max(80),
  related_context: z.array(RelatedContextItemSchema).max(3),
  next_action: NextActionSchema,
  time_hint: z.string().optional(),
  source: z.object({
    type: TriggerSourceSchema,
    upstream_ids: z.array(z.string()).default([]),
  }),
  confidence: z.number().min(0).max(1),
});

export const BriefItemSchema = BriefItemComposerOutputSchema.extend({
  id: z.string(),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});

export const MorningBriefPostureSchema = z.enum([
  "focus",
  "meeting-heavy",
  "recovery",
  "launch",
]);

export const MorningBriefJsonSchema = z.object({
  version: z.literal(1),
  generated_at: z.string(),
  headline: z.string().max(40),
  posture: MorningBriefPostureSchema,
  items: z.array(BriefItemSchema),
  deferred_count: z.number().int().nonnegative(),
  deferred_preview: z.array(z.string()).max(8).optional(),
});

export const BriefSummaryOutputSchema = z.object({
  headline: z.string().max(20),
  posture: MorningBriefPostureSchema,
});

function anthropicInputSchema(zodSchema, name) {
  const json = zodToJsonSchema(zodSchema, {
    name: name,
    $refStrategy: "none",
  });
  const root = json.definitions?.[name];
  const out = root && typeof root === "object" ? { ...root } : { ...json };
  delete out.$schema;
  return out;
}

/** Anthropic Messages API tool definition */
export function getEmitBriefItemTool() {
  return {
    name: "emit_brief_item",
    description:
      "AMC-compliant BriefItem fragment (no id/priority). Output one actionable item for this candidate.",
    input_schema: anthropicInputSchema(
      BriefItemComposerOutputSchema,
      "BriefItemComposerOutput"
    ),
  };
}

export function getEmitBriefSummaryTool() {
  return {
    name: "emit_brief_summary",
    description:
      "Morning Brief headline (20 chars max) + posture enum for the ranked item list.",
    input_schema: anthropicInputSchema(BriefSummaryOutputSchema, "BriefSummaryOutput"),
  };
}

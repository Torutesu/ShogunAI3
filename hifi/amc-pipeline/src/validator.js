/**
 * AMC compliance validator (spec §7.3) — rule-based flags for metrics + retry hints.
 */
import { BriefItemComposerOutputSchema } from "./schemas.js";

const BANNED_SUBSTRINGS = [
  "かもしれません",
  "と思われます",
  "maybe",
  "perhaps",
  "might be",
  "please prepare",
  "準備してください",
  "です。",
  "ます。",
];

const DESUMASU = /(です|ます)(。|$)/;

/**
 * @param {unknown} item
 * @param {{ allowedTools?: Set<string> }} [opts]
 */
export function validateBriefItemOutput(item, opts = {}) {
  const errors = [];
  const warnings = [];

  const parsed = BriefItemComposerOutputSchema.safeParse(item);
  if (!parsed.success) {
    errors.push(...parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
    return { ok: false, errors, warnings, completeness: false };
  }

  const v = parsed.data;
  const whatLen = [...v.what].length;
  const whyLen = [...v.why_now].length;
  if (whatLen > 40) errors.push(`what length ${whatLen} > 40`);
  if (whyLen > 80) errors.push(`why_now length ${whyLen} > 80`);

  for (const b of BANNED_SUBSTRINGS) {
    if (v.why_now.includes(b) || v.what.includes(b) || v.next_action.label.includes(b)) {
      errors.push(`banned phrase: ${b}`);
    }
  }
  if (DESUMASU.test(v.what) || DESUMASU.test(v.why_now)) {
    warnings.push("desu/masu style in what/why_now");
  }

  if (v.related_context.length > 3) errors.push("related_context > 3");

  const label = v.next_action.label;
  if (!label || label.length < 2) errors.push("next_action.label empty");

  if (v.next_action.mcp_tool) {
    const name = v.next_action.mcp_tool.tool_name;
    if (opts.allowedTools && !opts.allowedTools.has(name)) {
      errors.push(`mcp_tool ${name} not in allowed list`);
    }
  }

  if (v.confidence < 0.5) warnings.push("confidence < 0.5");

  const abstractWhy = /^(重要|要確認|大事)/.test(v.why_now) && v.why_now.length < 25;
  if (abstractWhy) warnings.push("why_now may be too abstract");

  const completeness =
    errors.length === 0 &&
    v.what &&
    v.why_now &&
    v.related_context.length >= 0 &&
    v.next_action.label;

  return { ok: errors.length === 0, errors, warnings, completeness };
}

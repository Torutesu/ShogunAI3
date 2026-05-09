/**
 * Anthropic Claude API model ids (Messages API).
 * Source of truth: https://platform.claude.com/docs/en/about-claude/models/overview
 *
 * Aliases (e.g. claude-opus-4-7) track the latest snapshot; pin a dated id if you need immutability.
 */

/** Quality-first default for per-candidate AMC composition */
export const DEFAULT_COMPOSER_MODEL = "claude-opus-4-7";

/** Latency/cost-friendly default for a single headline + posture call */
export const DEFAULT_SUMMARY_MODEL = "claude-sonnet-4-6";

/**
 * @param {{ model?: string }} [opts]
 */
export function resolveComposerModel(opts = {}) {
  return opts.model || process.env.ANTHROPIC_MODEL || DEFAULT_COMPOSER_MODEL;
}

/**
 * Summary does not inherit ANTHROPIC_MODEL unless ANTHROPIC_SUMMARY_MODEL is unset and you pass opts.model.
 * Set ANTHROPIC_SUMMARY_MODEL explicitly to align with the composer (e.g. both Opus).
 *
 * @param {{ model?: string }} [opts]
 */
export function resolveSummaryModel(opts = {}) {
  if (opts.model) return opts.model;
  if (process.env.ANTHROPIC_SUMMARY_MODEL)
    return process.env.ANTHROPIC_SUMMARY_MODEL;
  return DEFAULT_SUMMARY_MODEL;
}

/**
 * Optional second model if the primary fails with overload (429 / 529).
 */
export function resolveComposerFallbackModel() {
  return process.env.ANTHROPIC_MODEL_FALLBACK || DEFAULT_SUMMARY_MODEL;
}

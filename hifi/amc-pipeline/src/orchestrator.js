import { preprocessCandidate, mergeDuplicateCandidates } from "./preprocess.js";
import { composeOneCandidate } from "./composer.js";
import { validateBriefItemOutput } from "./validator.js";
import { rankAndCap } from "./ranker.js";
import { generateSummary } from "./summary.js";
import { MorningBriefJsonSchema } from "./schemas.js";
import { composeBriefItemHeuristic } from "./heuristic.js";

/**
 * @param {unknown[]} rawCandidates
 * @param {{ dryRun?: boolean, timeZone?: string, mergeDuplicates?: boolean, model?: string }} opts
 */
export async function runMorningBriefPipeline(rawCandidates, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const timeZone = opts.timeZone || "Asia/Tokyo";
  const mergeDuplicates = opts.mergeDuplicates !== false;

  let cleaned = rawCandidates.map((r) => preprocessCandidate(r));
  if (mergeDuplicates) cleaned = mergeDuplicateCandidates(cleaned);

  if (cleaned.length === 0) {
    return { skipped: true, reason: "no_candidates" };
  }

  const composed = await runBatches(cleaned, 5, async (c, idx) => {
    const allowed = new Set(c.available_mcp_tools || []);
    let out;
    try {
      out = await composeOneCandidate(c, { dryRun, model: opts.model });
      if (typeof c._merged_confidence === "number") {
        out = { ...out, confidence: c._merged_confidence };
      }
    } catch {
      out = composeBriefItemHeuristic(c);
    }

    let v = validateBriefItemOutput(out, { allowedTools: allowed });
    if (!v.ok && !dryRun) {
      try {
        out = await composeOneCandidate(c, { dryRun: true });
        v = validateBriefItemOutput(out, { allowedTools: allowed });
      } catch {
        out = composeBriefItemHeuristic(c);
        v = validateBriefItemOutput(out, { allowedTools: allowed });
      }
    }

    const pendingDg = (c.decision_graph_hits || []).some(
      (h) => (h.follow_ups_pending || 0) > 0
    );

    return {
      id: `item_${String(idx + 1).padStart(2, "0")}`,
      candidate_id: c.candidate_id,
      ...out,
      _pending_decision_followup: pendingDg,
      stuck_days: c.stuck_days,
    };
  });

  const ranked = rankAndCap(composed, { timeZone });

  const summary = await generateSummary(ranked.items, { dryRun, model: opts.model });

  const finalItems = ranked.items.map((it, i) => ({
    ...sanitizeBriefItem(it),
    id: `item_${String(i + 1).padStart(2, "0")}`,
  }));

  const brief = MorningBriefJsonSchema.parse({
    version: 1,
    generated_at: new Date().toISOString(),
    headline: summary.headline,
    posture: summary.posture,
    items: finalItems,
    deferred_count: ranked.deferred.length,
    deferred_preview: ranked.deferred.slice(0, 8).map((d) => d.what || d.candidate_id),
  });

  return { skipped: false, brief, deferred: ranked.deferred, validationNotes: composed.map(() => null) };
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @param {(item: T, index: number) => Promise<any>} fn
 */
async function runBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    const part = await Promise.all(chunk.map((it, j) => fn(it, i + j)));
    out.push(...part);
  }
  return out;
}

/**
 * @param {object} it
 */
function sanitizeBriefItem(it) {
  const {
    candidate_id: _cid,
    _pending_decision_followup: _pd,
    stuck_days: _sd,
    ...rest
  } = it;
  return rest;
}

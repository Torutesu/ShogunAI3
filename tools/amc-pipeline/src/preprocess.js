/**
 * Pre-LLM: relevance filter, optional duplicate merge, confidence combine.
 */
import { MorningBriefCandidateSchema } from "./schemas.js";

const RELEVANCE_MIN = 0.5;

/**
 * Combine confidences from merged sources: 1 - Π(1 - p_i)
 * @param {number[]} probs
 */
export function combineConfidence(probs) {
  const clean = probs.filter((p) => typeof p === "number" && p > 0 && p <= 1);
  if (clean.length === 0) return 0.5;
  let prod = 1;
  for (const p of clean) prod *= 1 - p;
  return Math.min(1, Math.max(0, 1 - prod));
}

/**
 * Drop weak KIOKU hits; normalize candidate.
 * @param {unknown} raw
 */
export function preprocessCandidate(raw) {
  const parsed = MorningBriefCandidateSchema.parse(raw);
  const related_kioku_hits = parsed.related_kioku_hits.filter(
    (h) => h.relevance_score >= RELEVANCE_MIN
  );
  return {
    ...parsed,
    related_kioku_hits,
  };
}

/**
 * Calendar-primary merge: same calendar id or same title+start → merge upstream_ids.
 * @param {import('./schemas.js').MorningBriefCandidate[]} candidates
 */
export function mergeDuplicateCandidates(candidates) {
  /** @type {Map<string, import('./schemas.js').MorningBriefCandidate & { _confidence_parts?: number[] }>} */
  const byKey = new Map();

  for (const c of candidates) {
    const cal = c.raw_data?.calendar_event;
    const key =
      cal && typeof cal === "object" && cal.id
        ? `cal:${cal.id}`
        : cal && typeof cal === "object" && cal.title && cal.start
          ? `ts:${String(cal.title)}|${String(cal.start)}`
          : `id:${c.candidate_id}`;

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        ...c,
        _confidence_parts: collectConfidenceParts(c),
      });
      continue;
    }

    const merged = mergeTwoCandidates(existing, c);
    merged._confidence_parts = [
      ...(existing._confidence_parts || []),
      ...collectConfidenceParts(c),
    ];
    byKey.set(key, merged);
  }

  return [...byKey.values()].map((m) => {
    const { _confidence_parts, ...rest } = m;
    const mergedConfidence = combineConfidence(_confidence_parts || []);
    return {
      ...rest,
      /** @type {any} */
      _merged_confidence: mergedConfidence,
    };
  });
}

function collectConfidenceParts(c) {
  const hits = c.related_kioku_hits || [];
  const fromHits = hits.map((h) => h.relevance_score).filter(Boolean);
  if (fromHits.length) return fromHits;
  return [0.55];
}

function mergeTwoCandidates(primary, secondary) {
  const pCal = primary.trigger_source === "calendar";
  const sCal = secondary.trigger_source === "calendar";
  const base = pCal || !sCal ? primary : secondary;
  const other = base === primary ? secondary : primary;

  const upA = base.raw_data?.upstream_ids;
  const upB = other.raw_data?.upstream_ids;
  const mergedUpstream = unique([
    ...(Array.isArray(upA) ? upA : []),
    ...(Array.isArray(upB) ? upB : []),
    other.candidate_id,
  ]);

  return {
    ...base,
    candidate_id: base.candidate_id,
    raw_data: {
      ...base.raw_data,
      upstream_ids: mergedUpstream,
    },
    decision_graph_hits: uniqueById([
      ...base.decision_graph_hits,
      ...other.decision_graph_hits,
    ]),
    related_kioku_hits: mergeKiokuHits(
      base.related_kioku_hits,
      other.related_kioku_hits
    ),
    available_mcp_tools: unique([
      ...base.available_mcp_tools,
      ...other.available_mcp_tools,
    ]),
  };
}

function unique(arr) {
  return [...new Set(arr)];
}

function uniqueById(decisions) {
  const m = new Map();
  for (const d of decisions) m.set(d.decision_id, d);
  return [...m.values()];
}

function mergeKiokuHits(a, b) {
  const m = new Map();
  for (const h of [...a, ...b]) {
    const prev = m.get(h.doc_id);
    if (!prev || h.relevance_score > prev.relevance_score) m.set(h.doc_id, h);
  }
  return [...m.values()].sort((x, y) => y.relevance_score - x.relevance_score);
}

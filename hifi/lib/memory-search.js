/* global window */
/**
 * memory-search.js — Phase 2.1.4 split-architecture search merge.
 *
 * Orchestrates local + cloud search. When cloud_mirror is enabled and unlocked,
 * dispatches BOTH paths in parallel via Promise.all (each wrapped in a
 * timeout-and-rescue helper), dedupes results by id (newer created_at wins),
 * and returns a single ranked list. Cloud path has a 5s timeout — if it errors
 * or times out, falls back to local-only.
 *
 * The IPC layer (`shogun-api.js`) wraps every call in
 *   { ok, kind, command, data, error }
 * where `data` is the underlying payload (e.g. { hits, total, stub? }). This
 * module preserves that envelope: callers like screens-a.jsx already read
 * `res.ok`, `res.data`, `res.data.hits` and we keep that contract intact.
 *
 * See spec docs/superpowers/specs/2026-05-07-mirror-search-and-settings-ui-design.md § 3, § 5.5.
 *
 * Wired in action-registry.js:68 — see register("memory.search", ...).
 */
(function initShogunMemorySearch(global) {
  "use strict";

  const CLOUD_TIMEOUT_MS = 5000;
  const LOCAL_TIMEOUT_MS = 20000; // generous; local should always be fast
  const DEFAULT_LIMIT = 60;
  const DEFAULT_CLOUD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

  /**
   * Race a promise against a timeout. Returns
   *   { ok: true, value }
   * on success or
   *   { ok: false, reason }
   * on timeout / rejection. Never throws.
   */
  async function withTimeout(promise, timeoutMs, reason) {
    let timer = null;
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, reason: reason }), timeoutMs);
    });
    const wrapped = Promise.resolve(promise).then(
      (value) => ({ ok: true, value: value }),
      (err) => ({ ok: false, reason: (err && err.message) ? String(err.message) : String(err) })
    );
    const result = await Promise.race([wrapped, timeoutPromise]);
    if (timer !== null) clearTimeout(timer);
    return result;
  }

  /**
   * Normalize a local hit (shape varies by source — `score` is the local
   * relevance number; we copy it into `similarity` so ranking is uniform).
   */
  function normalizeLocalHit(hit) {
    if (!hit || typeof hit !== "object") return null;
    const sim = (typeof hit.similarity === "number")
      ? hit.similarity
      : (typeof hit.score === "number" ? hit.score : 0);
    return Object.assign({}, hit, {
      source: "local",
      similarity: sim,
    });
  }

  /**
   * Normalize a cloud hit. Cloud already provides `source` (mirror-self |
   * mirror-other), `similarity`, `device_name`, `blob_id`, `device_id`.
   */
  function normalizeCloudHit(hit) {
    if (!hit || typeof hit !== "object") return null;
    return {
      id: hit.id,
      title: hit.title,
      snippet: hit.snippet,
      source_field: hit.source_field,
      kinds_json: hit.kinds_json,
      created_at: hit.created_at,
      similarity: typeof hit.similarity === "number" ? hit.similarity : 0,
      source: hit.source || "mirror-other",
      device_name: hit.device_name,
      blob_id: hit.blob_id,
      device_id: hit.device_id,
    };
  }

  /**
   * Dedupe by id. When two hits share an id:
   *   - newer `created_at` wins (per spec § 7 tiebreaker),
   *   - on tie, local wins (it's the authoritative copy on this device).
   */
  function dedupeById(hits) {
    const byId = new Map();
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      if (!hit || hit.id == null) continue;
      const existing = byId.get(hit.id);
      if (!existing) {
        byId.set(hit.id, hit);
        continue;
      }
      const existingCreated = Number(existing.created_at) || 0;
      const incomingCreated = Number(hit.created_at) || 0;
      if (incomingCreated > existingCreated) {
        byId.set(hit.id, hit);
      } else if (incomingCreated === existingCreated && existing.source !== "local" && hit.source === "local") {
        byId.set(hit.id, hit);
      }
    }
    return Array.from(byId.values());
  }

  /**
   * Sort by similarity desc; missing similarity treated as 0.
   */
  function rankBySimilarity(hits) {
    return hits.slice().sort(function compareHits(a, b) {
      const sa = typeof a.similarity === "number" ? a.similarity : 0;
      const sb = typeof b.similarity === "number" ? b.similarity : 0;
      return sb - sa;
    });
  }

  /**
   * Main entry point. Called by action-registry.js for "memory.search".
   *
   * Preserves the IPC envelope shape that all 30+ existing call sites expect:
   *   { ok, kind, command, data: { hits, total?, ... , cloud_status? }, error }
   *
   * payload: { query, kinds?, limit?, since_ms?, until_ms?, ... }
   * api: object returned by shogun-api.js (has memorySearch + mirror.{status,searchBlobs}).
   */
  async function runMemorySearchMerged(api, payload) {
    const safePayload = payload || {};
    const limit = Number(safePayload.limit) > 0 ? Number(safePayload.limit) : DEFAULT_LIMIT;

    // 1. Check cloud availability (cheap status call). Any error → local-only path.
    let cloudReady = false;
    try {
      const statusRes = await withTimeout(
        api.mirror.status({}),
        CLOUD_TIMEOUT_MS,
        "status-timeout"
      );
      if (statusRes.ok && statusRes.value && statusRes.value.ok && statusRes.value.data) {
        const sd = statusRes.value.data;
        cloudReady = sd.enabled === true && sd.locked === false;
      }
    } catch (_e) {
      cloudReady = false;
    }

    // 2. Cloud disabled / locked / status failed → local only (current behavior).
    if (!cloudReady) {
      const localRes = await api.memorySearch(safePayload);
      if (!localRes || !localRes.ok || !localRes.data) return localRes;
      const hits = Array.isArray(localRes.data.hits) ? localRes.data.hits.map(normalizeLocalHit).filter(Boolean) : [];
      return Object.assign({}, localRes, {
        data: Object.assign({}, localRes.data, {
          hits: hits,
          cloud_status: "disabled",
        }),
      });
    }

    // 3. Compute time range for cloud search. Default: last 30 days.
    const now = Date.now();
    const since_ms = (safePayload.since_ms != null) ? Number(safePayload.since_ms) : (now - DEFAULT_CLOUD_WINDOW_MS);
    const until_ms = (safePayload.until_ms != null) ? Number(safePayload.until_ms) : now;

    // 4. Dispatch local + cloud in parallel.
    const localPromise = api.memorySearch(safePayload);
    const cloudPromise = api.mirror.searchBlobs({
      query: safePayload.query,
      since_ms: since_ms,
      until_ms: until_ms,
    });

    const [localResult, cloudResult] = await Promise.all([
      withTimeout(localPromise, LOCAL_TIMEOUT_MS, "local-timeout"),
      withTimeout(cloudPromise, CLOUD_TIMEOUT_MS, "cloud-timeout"),
    ]);

    // 5. Extract local envelope (canonical for return shape).
    const localEnvelope = (localResult.ok && localResult.value) ? localResult.value : null;

    // If local also failed or returned non-ok, behave like the bare local call would:
    // hand back whatever local returned (caller already handles `!res.ok` paths).
    if (!localEnvelope || !localEnvelope.ok || !localEnvelope.data) {
      // No usable local envelope. If cloud worked, synthesize a minimal-success envelope
      // from the cloud result so the caller still sees hits.
      if (cloudResult.ok && cloudResult.value && cloudResult.value.ok && cloudResult.value.data) {
        const cloudHits = Array.isArray(cloudResult.value.data.hits)
          ? cloudResult.value.data.hits.map(normalizeCloudHit).filter(Boolean)
          : [];
        return {
          ok: true,
          kind: cloudResult.value.kind,
          command: "shogun_memory_search",
          data: {
            hits: rankBySimilarity(cloudHits).slice(0, limit),
            total: cloudHits.length,
            cloud_status: "ok",
            local_status: localResult.ok ? "non-ok" : localResult.reason,
          },
          error: null,
        };
      }
      // Both failed — return the local envelope as-is (preserves error).
      if (localResult.ok) return localEnvelope || { ok: false, error: { code: "MEMORY_SEARCH_FAILED", message: "local search returned empty envelope" } };
      return { ok: false, error: { code: "MEMORY_SEARCH_TIMEOUT", message: localResult.reason } };
    }

    // 6. Local OK. Collect hits from both sides.
    const localHits = Array.isArray(localEnvelope.data.hits)
      ? localEnvelope.data.hits.map(normalizeLocalHit).filter(Boolean)
      : [];

    let cloudHits = [];
    let cloudStatus = "ok";
    if (cloudResult.ok && cloudResult.value && cloudResult.value.ok && cloudResult.value.data) {
      cloudHits = Array.isArray(cloudResult.value.data.hits)
        ? cloudResult.value.data.hits.map(normalizeCloudHit).filter(Boolean)
        : [];
    } else if (!cloudResult.ok) {
      cloudStatus = cloudResult.reason || "cloud-failed";
      try {
        // eslint-disable-next-line no-console
        console.warn("[memory-search] cloud path failed:", cloudResult.reason);
      } catch (_e) { /* ignore */ }
    } else if (cloudResult.value && !cloudResult.value.ok) {
      cloudStatus = (cloudResult.value.error && cloudResult.value.error.message) || "cloud-non-ok";
    }

    // 7. Merge + dedupe + rank + truncate.
    const merged = rankBySimilarity(dedupeById(localHits.concat(cloudHits))).slice(0, limit);

    // 8. Return preserving the local envelope.
    return Object.assign({}, localEnvelope, {
      data: Object.assign({}, localEnvelope.data, {
        hits: merged,
        cloud_status: cloudStatus,
      }),
    });
  }

  // Export.
  global.ShogunMemorySearch = {
    runMemorySearchMerged: runMemorySearchMerged,
    // Exposed for testing / debugging.
    _internals: {
      dedupeById: dedupeById,
      rankBySimilarity: rankBySimilarity,
      normalizeLocalHit: normalizeLocalHit,
      normalizeCloudHit: normalizeCloudHit,
      withTimeout: withTimeout,
      CLOUD_TIMEOUT_MS: CLOUD_TIMEOUT_MS,
      LOCAL_TIMEOUT_MS: LOCAL_TIMEOUT_MS,
      DEFAULT_LIMIT: DEFAULT_LIMIT,
      DEFAULT_CLOUD_WINDOW_MS: DEFAULT_CLOUD_WINDOW_MS,
    },
  };
})(typeof window !== "undefined" ? window : globalThis);

// Phase 2.1.4.1 follow-up #5 — E2E coverage for the `memory.search` merge layer.
//
// Drives `window.SHOGUN_RUNTIME.executeAction('memory.search', ...)` end-to-end
// through `hifi/lib/memory-search.js::runMemorySearchMerged` while overriding
// the underlying Tauri IPC commands (`mirror_status`, `shogun_memory_search`,
// `mirror_search_blobs`) via the `__shogunMockOverrides` seam introduced in
// T6 (see `tests/e2e/_helpers/mirror-mock.js`).
//
// Asserts the merge layer behaves as documented in
// `docs/superpowers/specs/2026-05-07-mirror-search-and-settings-ui-design.md`
// § 3 / § 5.5 and `hifi/lib/memory-search.js`:
//   - cloud-disabled returns local-only with cloud_status="disabled"
//   - cloud-locked returns local-only with cloud_status="locked"
//   - merge dedupes by id (newer created_at wins) + ranks by similarity
//   - kinds filter post-applies to cloud hits
//   - cloud timeout (5s) falls back to local with cloud_status="cloud-timeout"

const { test, expect } = require("@playwright/test");
const { preacceptConsent } = require("./_helpers/preseed-consent");

const HIFI_ENTRY = "/SHOGUN%20Hi-Fi%20UI.html";

async function openHiFi(page) {
  await page.goto(HIFI_ENTRY, { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector(".app", { timeout: 20000 });
  await page.waitForFunction(() => !!window.SHOGUN_RUNTIME, null, {
    timeout: 20000,
  });
}

test.describe("SHOGUN memory.search merge layer", () => {
  test.beforeEach(async ({ page }) => {
    await preacceptConsent(page);
  });

  test("cloud disabled: returns local-only with cloud_status=disabled", async ({
    page,
  }) => {
    await openHiFi(page);
    // Default mock has enabled:false — cloud is disabled. We only need to
    // override the local search to assert it passes through unchanged.
    await page.evaluate(() => {
      window.__shogunMockOverrides = window.__shogunMockOverrides || {};
      window.__shogunMockOverrides.shogun_memory_search = () => ({
        ok: true,
        data: {
          hits: [
            {
              id: "L1",
              title: "Local one",
              snippet: "local snippet 1",
              source: "local-source",
              kinds_json: '["screen"]',
              created_at: 1715000000000,
              score: 0.9,
            },
            {
              id: "L2",
              title: "Local two",
              snippet: "local snippet 2",
              source: "local-source",
              kinds_json: '["screen"]',
              created_at: 1715000001000,
              score: 0.7,
            },
          ],
        },
      });
    });

    const result = await page.evaluate(async () => {
      return window.SHOGUN_RUNTIME.executeAction(
        "memory.search",
        { query: "test", limit: 10 },
        { silentError: true },
      );
    });
    expect(result.ok).toBe(true);
    expect(result.data.cloud_status).toBe("disabled");
    expect(result.data.hits.length).toBe(2);
    // Each hit should carry source="local" after normalizeLocalHit.
    expect(result.data.hits.every((h) => h.source === "local")).toBe(true);
  });

  test("cloud locked: returns local-only with cloud_status=locked", async ({
    page,
  }) => {
    await openHiFi(page);
    await page.evaluate(() => {
      window.__shogunMockOverrides = window.__shogunMockOverrides || {};
      window.__shogunMockOverrides.mirror_status = () => ({
        ok: true,
        data: {
          enabled: true,
          locked: true,
          queue_depth: 0,
          last_sync_at: null,
          last_error: null,
          device_id: "d1",
        },
      });
      window.__shogunMockOverrides.shogun_memory_search = () => ({
        ok: true,
        data: {
          hits: [
            {
              id: "L1",
              title: "x",
              snippet: "y",
              kinds_json: '["screen"]',
              created_at: 1,
              score: 0.5,
            },
          ],
        },
      });
    });

    const result = await page.evaluate(async () => {
      return window.SHOGUN_RUNTIME.executeAction(
        "memory.search",
        { query: "q", limit: 10 },
        { silentError: true },
      );
    });
    expect(result.data.cloud_status).toBe("locked");
    expect(result.data.hits.length).toBe(1);
  });

  test("merge: cloud + local results combine, dedupe by id (newer wins)", async ({
    page,
  }) => {
    await openHiFi(page);
    await page.evaluate(() => {
      window.__shogunMockOverrides = window.__shogunMockOverrides || {};
      window.__shogunMockOverrides.mirror_status = () => ({
        ok: true,
        data: {
          enabled: true,
          locked: false,
          queue_depth: 0,
          last_sync_at: "2026-05-06T12:00:00Z",
          last_error: null,
          device_id: "self",
        },
      });
      window.__shogunMockOverrides.shogun_memory_search = () => ({
        ok: true,
        data: {
          hits: [
            {
              id: "A",
              title: "Local A",
              snippet: "old",
              kinds_json: '["screen"]',
              created_at: 1000,
              score: 0.6,
            },
            {
              id: "B",
              title: "Local B",
              snippet: "b",
              kinds_json: '["screen"]',
              created_at: 2000,
              score: 0.5,
            },
          ],
        },
      });
      window.__shogunMockOverrides.mirror_search_blobs = () => ({
        ok: true,
        data: {
          hits: [
            {
              blob_id: "blob1",
              device_id: "other",
              id: "A",
              title: "Cloud A newer",
              snippet: "new",
              source_field: "src",
              kinds_json: '["screen"]',
              created_at: 3000,
              similarity: 0.8,
              source: "mirror-other",
              device_name: "Other Mac",
            },
            {
              blob_id: "blob2",
              device_id: "other",
              id: "C",
              title: "Cloud C",
              snippet: "c",
              source_field: "src",
              kinds_json: '["screen"]',
              created_at: 1500,
              similarity: 0.4,
              source: "mirror-other",
              device_name: "Other Mac",
            },
          ],
        },
      });
    });

    const result = await page.evaluate(async () => {
      return window.SHOGUN_RUNTIME.executeAction(
        "memory.search",
        { query: "q", limit: 10 },
        { silentError: true },
      );
    });
    expect(result.data.cloud_status).toBe("ok");
    expect(result.data.hits.length).toBe(3);
    const ids = result.data.hits.map((h) => h.id);
    expect(ids).toContain("A");
    expect(ids).toContain("B");
    expect(ids).toContain("C");
    // Cloud A is newer (created_at 3000 vs 1000) → wins dedupe; check the kept
    // hit carries the cloud title and provenance.
    const a = result.data.hits.find((h) => h.id === "A");
    expect(a.title).toBe("Cloud A newer");
    expect(a.source).toBe("mirror-other");
    // Rank by similarity desc: 0.8 (A cloud) > 0.5 (B local) > 0.4 (C cloud).
    expect(result.data.hits[0].id).toBe("A");
  });

  test("merge: kinds filter post-applies to cloud hits", async ({ page }) => {
    await openHiFi(page);
    await page.evaluate(() => {
      window.__shogunMockOverrides = window.__shogunMockOverrides || {};
      window.__shogunMockOverrides.mirror_status = () => ({
        ok: true,
        data: {
          enabled: true,
          locked: false,
          queue_depth: 0,
          last_sync_at: "2026-05-06T12:00:00Z",
          last_error: null,
          device_id: "self",
        },
      });
      window.__shogunMockOverrides.shogun_memory_search = () => ({
        ok: true,
        data: {
          hits: [
            {
              id: "L1",
              title: "Local meeting",
              snippet: "m",
              kinds_json: '["meeting"]',
              created_at: 1,
              score: 0.5,
            },
          ],
        },
      });
      window.__shogunMockOverrides.mirror_search_blobs = () => ({
        ok: true,
        data: {
          hits: [
            {
              blob_id: "b1",
              device_id: "d",
              id: "C1",
              title: "Cloud meeting",
              snippet: "cm",
              kinds_json: '["meeting"]',
              created_at: 2,
              similarity: 0.7,
              source: "mirror-other",
            },
            {
              blob_id: "b2",
              device_id: "d",
              id: "C2",
              title: "Cloud screen",
              snippet: "cs",
              kinds_json: '["screen"]',
              created_at: 3,
              similarity: 0.6,
              source: "mirror-other",
            },
          ],
        },
      });
    });

    const result = await page.evaluate(async () => {
      return window.SHOGUN_RUNTIME.executeAction(
        "memory.search",
        { query: "q", kinds: ["meeting"], limit: 10 },
        { silentError: true },
      );
    });
    expect(result.data.cloud_status).toBe("ok");
    // L1 (meeting) + C1 (meeting) included; C2 (screen) filtered out by
    // filterCloudHitsByKinds before merge.
    expect(result.data.hits.length).toBe(2);
    const ids = result.data.hits.map((h) => h.id);
    expect(ids).toContain("L1");
    expect(ids).toContain("C1");
    expect(ids).not.toContain("C2");
  });

  test("cloud timeout: falls back to local with cloud_status=cloud-timeout", async ({
    page,
  }) => {
    await openHiFi(page);
    // Mock that hangs forever on mirror_search_blobs to trigger the 5s
    // CLOUD_TIMEOUT_MS in memory-search.js.
    await page.evaluate(() => {
      window.__shogunMockOverrides = window.__shogunMockOverrides || {};
      window.__shogunMockOverrides.mirror_status = () => ({
        ok: true,
        data: {
          enabled: true,
          locked: false,
          queue_depth: 0,
          last_sync_at: "2026-05-06T12:00:00Z",
          last_error: null,
          device_id: "self",
        },
      });
      window.__shogunMockOverrides.shogun_memory_search = () => ({
        ok: true,
        data: {
          hits: [
            {
              id: "L1",
              title: "Local",
              snippet: "s",
              kinds_json: '["screen"]',
              created_at: 1,
              score: 0.9,
            },
          ],
        },
      });
      // Promise that never resolves — withTimeout's 5s timer wins the race.
      window.__shogunMockOverrides.mirror_search_blobs = () =>
        new Promise(() => {});
    });

    const start = Date.now();
    const result = await page.evaluate(async () => {
      return window.SHOGUN_RUNTIME.executeAction(
        "memory.search",
        { query: "q", limit: 10 },
        { silentError: true },
      );
    });
    const elapsed = Date.now() - start;
    expect(result.data.cloud_status).toBe("cloud-timeout");
    expect(result.data.hits.length).toBe(1);
    expect(result.data.hits[0].id).toBe("L1");
    // Should resolve in ~5s (CLOUD_TIMEOUT_MS), not 20s (LOCAL_TIMEOUT_MS).
    // Allow generous slack on both ends to keep the test stable on slow CI.
    expect(elapsed).toBeLessThan(8000);
    expect(elapsed).toBeGreaterThan(4000);
  });
});

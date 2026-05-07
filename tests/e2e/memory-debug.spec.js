// tests/e2e/memory-debug.spec.js
const { test, expect } = require("@playwright/test");
const { preacceptConsent } = require("./_helpers/preseed-consent");

const HIFI_ENTRY = "/SHOGUN%20Hi-Fi%20UI.html";

// NOTE: Helper duplicated from tests/e2e/hifi-smoke.spec.js for Phase 0.
// TODO: extract to tests/e2e/_helpers/open-hifi.js once Tasks 1-4 land.
async function openHiFi(page) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto(HIFI_ENTRY, { waitUntil: "load", timeout: 90000 });
    try {
      await page.waitForSelector(".app", { timeout: 20000 });
      await page.waitForFunction(() => !!window.SHOGUN_RUNTIME, null, { timeout: 20000 });
      return;
    } catch (error) {
      if (attempt === 1) throw error;
      await page.waitForTimeout(500);
    }
  }
}

/**
 * Memory Debug screen is a dev-only view not exposed in NAV by default. The runtime
 * exposes a programmatic switch via window.__SHOGUN_GOTO__('memory_debug')
 * if available; fall back to clicking a hidden nav-item if it surfaces in
 * dev builds. Update this helper if the goto mechanism changes.
 */
async function openMemoryDebug(page) {
  const switched = await page.evaluate(() => {
    if (typeof window.__SHOGUN_GOTO__ === "function") {
      window.__SHOGUN_GOTO__("memory_debug");
      return true;
    }
    return false;
  });
  if (!switched) {
    const candidate = page.locator(".sidebar .nav-item").filter({
      hasText: /Memory Debug|Memory DBG|Debugger/i,
    });
    if ((await candidate.count()) > 0) {
      await candidate.first().click();
      return;
    }
    throw new Error(
      "Memory Debug screen is not reachable. Add window.__SHOGUN_GOTO__ in app.jsx or expose a dev nav-item.",
    );
  }
  // Wait for the screen to render
  await page.waitForSelector(".content-memory-debug", { timeout: 10000 });
}

test.describe("Memory Debug", () => {
  test.beforeEach(async ({ page }) => {
    await preacceptConsent(page);
  });

  test("Memory Debug screen mounts with header", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err.message)));

    await openHiFi(page);
    await openMemoryDebug(page);

    await expect(page.getByRole("heading", { name: /Memory Debugger/i })).toBeVisible({
      timeout: 10000,
    });

    expect(consoleErrors).toEqual([]);
  });

  test("Memory Debug exposes telemetry / SLI sections (best-effort)", async ({ page }) => {
    await openHiFi(page);
    await openMemoryDebug(page);

    // The screen renders multiple sections. We only assert that at least
    // one developer-facing label is present, to avoid coupling to layout.
    const body = page.locator(".content-memory-debug");
    await expect(body).toContainText(/SLI|stats|Query Tester|Recent Calls/i);
  });
});

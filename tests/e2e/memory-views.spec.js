// tests/e2e/memory-views.spec.js
const { test, expect } = require("@playwright/test");
const { preacceptConsent } = require("./_helpers/preseed-consent");

const HIFI_ENTRY = "/";

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

async function gotoMemory(page) {
  await page.locator(".sidebar .nav-item").filter({ hasText: "Memory" }).first().click();
  await expect(page.locator(".memory-screen")).toBeVisible({ timeout: 10000 });
}

test.describe("Memory view modes", () => {
  test.beforeEach(async ({ page }) => {
    await preacceptConsent(page);
  });

  test("switches through river, kakejiku, heatmap, digest, and search without errors", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err.message)));

    await openHiFi(page);
    await gotoMemory(page);

    const views = [
      { label: "River", assert: () => expect(page.locator(".memory-scrub-stage").first()).toBeVisible() },
      { label: "Kakejiku", assert: () => expect(page.locator(".memory-screen")).toContainText(/Kakejiku|掛け軸/i) },
      { label: "Heatmap", assert: () => expect(page.locator(".memory-screen")).toContainText(/LESS|MORE|インデックス/i) },
      { label: "Digest", assert: () => expect(page.locator(".memory-screen")).toContainText(/DIGEST|digest/i) },
      { label: "Search", assert: () => expect(page.locator(".memory-screen input, .memory-screen textarea").first()).toBeVisible() },
    ];

    for (const view of views) {
      await page.locator(".memory-screen button").filter({ hasText: view.label }).first().click();
      await view.assert();
    }

    expect(consoleErrors).toEqual([]);
  });
});

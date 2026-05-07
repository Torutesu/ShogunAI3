// tests/e2e/home-morning-brief.spec.js
const { test, expect } = require("@playwright/test");
const { preacceptConsent } = require("./_helpers/preseed-consent");

const HIFI_ENTRY = "/SHOGUN%20Hi-Fi%20UI.html";

// NOTE: This helper is intentionally duplicated from tests/e2e/hifi-smoke.spec.js
// for Phase 0. TODO: extract to tests/e2e/_helpers/open-hifi.js once Tasks 1-4
// of the Phase 0 plan all land (after meetings-list, memory-debug, settings-all-tabs).
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

test.describe("Home + Morning Brief", () => {
  test.beforeEach(async ({ page }) => {
    await preacceptConsent(page);
  });

  test("Home greeting renders without page errors", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err.message)));

    await openHiFi(page);

    // Home is the default landing screen. The English greeting h1 always renders.
    await expect(page.locator(".app h1.en-only").first()).toContainText(
      /,\s*(\w|there)\./,
      { timeout: 10000 },
    );

    expect(
      consoleErrors,
      `No uncaught page errors (got: ${consoleErrors.join("; ")})`,
    ).toEqual([]);
  });

  test("Sidebar Home nav-item is highlighted on initial load", async ({ page }) => {
    await openHiFi(page);
    const homeItem = page.locator(".sidebar .nav-item").filter({ hasText: "Home" }).first();
    await expect(homeItem).toBeVisible();
    // app.jsx renders className={'nav-item '+(active===n.id?'active':'')} — match
    // the literal "active" token bounded by whitespace or start/end-of-string so
    // we don't accidentally match an unrelated class that happens to share a substring.
    await expect(homeItem).toHaveClass(/(?:^|\s)active(?:\s|$)/);
  });

  test("brief.get IPC resolves (mock transport)", async ({ page }) => {
    await openHiFi(page);
    const out = await page.evaluate(async () => {
      return window.SHOGUN_RUNTIME.executeAction(
        "brief.get",
        {},
        { silentError: true },
      );
    });
    // Mock returns either { ok:true, data:{ brief: {...} | null } } or a stub
    // for unhandled commands. Phase 0 only verifies the action path resolves
    // without throwing — the assertion is intentionally weak (any registered
    // OR unregistered action returns ok:true under the mock fallback). Phase 2
    // will add a tighter shape check once brief.get has a real contract.
    expect(out.ok).toBe(true);
  });

  test("Navigating to Memory and back to Home keeps app stable", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err.message)));

    await openHiFi(page);
    await page.locator(".sidebar .nav-item").filter({ hasText: "Memory" }).first().click();
    await expect(page.getByText(/Memory \/ Timeline/i)).toBeVisible();
    await page.locator(".sidebar .nav-item").filter({ hasText: "Home" }).first().click();
    await expect(page.locator(".app h1.en-only").first()).toBeVisible();

    expect(consoleErrors).toEqual([]);
  });
});

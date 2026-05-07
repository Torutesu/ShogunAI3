// tests/e2e/home-morning-brief.spec.js
const { test, expect } = require("@playwright/test");
const { preacceptConsent } = require("./_helpers/preseed-consent");

const HIFI_ENTRY = "/SHOGUN%20Hi-Fi%20UI.html";

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
    // The active nav-item carries an "active" or aria-selected marker in app.jsx;
    // accept either class containing "active" or aria-current.
    await expect(homeItem).toHaveClass(/active|is-active|nav-item--active/);
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
    // Mock returns either { ok:true, data:{ brief: {...} | null } } or
    // { ok:true, data: null }. Accept both — Phase 0 only checks the
    // call path is wired, not content.
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

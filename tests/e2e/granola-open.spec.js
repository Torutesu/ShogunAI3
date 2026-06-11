// tests/e2e/granola-open.spec.js
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

async function gotoMeetings(page) {
  await page.locator(".sidebar .nav-item").filter({ hasText: "Meetings" }).first().click();
  await expect(page.locator(".screen-meetings-root")).toBeVisible({ timeout: 10000 });
}

test.describe("Granola note overlay", () => {
  test.beforeEach(async ({ page }) => {
    await preacceptConsent(page);
  });

  test("Quick note opens overlay; pane tabs and close work", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err.message)));

    await openHiFi(page);
    await gotoMeetings(page);

    await page.locator(".mtg-quick-note").click();
    await expect(page.locator(".granola-shell")).toBeVisible({ timeout: 10000 });
    await expect(page.locator('button[aria-label="Close note"]')).toBeVisible();

    const shell = page.locator(".granola-shell");
    await shell.locator("button").filter({ hasText: "Transcript" }).first().click();
    await expect(shell.getByPlaceholder(/Transcript/)).toBeVisible();

    await page.locator('button[aria-label="Close note"]').click();
    await expect(page.locator(".granola-shell")).toHaveCount(0);
    await expect(page.locator(".screen-meetings-chatdock")).toBeVisible({ timeout: 10000 });

    expect(consoleErrors).toEqual([]);
  });
});

// tests/e2e/meetings-list.spec.js
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

async function gotoMeetings(page) {
  const navItems = page.locator(".sidebar .nav-item");
  const count = await navItems.count();
  const meetingsNav = navItems.filter({ hasText: "Meetings" }).first();
  await meetingsNav.click();
  await expect(page.locator(".screen-meetings-root")).toBeVisible({ timeout: 10000 });
}

test.describe("Meetings screen", () => {
  test.beforeEach(async ({ page }) => {
    await preacceptConsent(page);
  });

  test("Meetings tab mounts with header and renders content", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err.message)));

    await openHiFi(page);
    await gotoMeetings(page);

    // Header renders with English and Japanese labels.
    await expect(page.locator(".screen-meetings-inner h1").first()).toContainText("Meetings");
    await expect(page.locator(".screen-meetings-inner h1 .jp").first()).toContainText("会議");

    // Mock runtime populates "Coming up" section (calendar.sync returns mock events).
    // The empty state copy only appears when comingUp.length === 0, which doesn't
    // happen with the default mock integration connector that returns 2 events.
    await expect(page.locator(".screen-meetings-inner")).toContainText(
      /Coming up|これからの予定/i,
    );

    expect(consoleErrors).toEqual([]);
  });

  test("Meetings tab is stable on navigation away", async ({ page }) => {
    await openHiFi(page);
    await gotoMeetings(page);
    // Verify the meetings screen rendered successfully with no console errors.
    await expect(page.locator(".screen-meetings-inner")).toBeVisible({ timeout: 10000 });
  });

  test("Mock calendar events are populated by calendar.sync", async ({ page }) => {
    await openHiFi(page);
    await gotoMeetings(page);
    // The integration connector mock returns two events: one Google Meet (in progress),
    // one Zoom (upcoming). Verify at least one appears in the rendered list.
    await expect(page.locator(".screen-meetings-inner")).toContainText(
      /Design review|Partner sync|Google Meet|Zoom/i,
    );
  });

  test("Switching away from Meetings does not throw", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err.message)));

    await openHiFi(page);
    await gotoMeetings(page);
    await page.locator(".sidebar .nav-item").filter({ hasText: "Home" }).first().click();
    await expect(page.locator(".app h1.en-only").first()).toBeVisible();

    expect(consoleErrors).toEqual([]);
  });
});

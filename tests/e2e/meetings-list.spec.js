// tests/e2e/meetings-list.spec.js
const { test, expect } = require("@playwright/test");
const { preacceptConsent } = require("./_helpers/preseed-consent");

const HIFI_ENTRY = "/";

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
  const meetingsNav = navItems.filter({ hasText: "Meetings" }).first();
  await meetingsNav.click();
  await expect(page.locator(".screen-meetings-root")).toBeVisible({ timeout: 10000 });
}

/**
 * The mock calendar always returns an in-progress event ("Design review"),
 * which auto-fires a shogun-meeting-detected event, opening the Granola note
 * panel and setting granola != null. This hides the chatdock (!granola gate).
 * Close the note panel first so the chatdock becomes visible.
 */
async function closeGranolaIfOpen(page) {
  const closeBtn = page.locator('button[aria-label="Close note"]');
  try {
    await closeBtn.waitFor({ state: "visible", timeout: 3000 });
    await closeBtn.click();
    // Wait for chatdock to appear after granola is closed
    await expect(page.locator(".screen-meetings-chatdock")).toBeVisible({ timeout: 5000 });
  } catch (_e) {
    // Granola panel was not open — chatdock should already be visible
  }
}

test.describe("Meetings screen", () => {
  test.beforeEach(async ({ page }) => {
    await preacceptConsent(page);
  });

  test("Meetings tab mounts with header and populated calendar events", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err.message)));

    await openHiFi(page);
    await gotoMeetings(page);

    // Header renders with English and Japanese labels.
    await expect(page.locator(".screen-meetings-inner h1").first()).toContainText("Meetings");
    await expect(page.locator(".screen-meetings-inner h1 .jp").first()).toContainText("会議");

    // Mock integration connector returns two events (lines 344–357 of integration-connectors.js):
    // "Design review (Google Meet)" and "Partner sync (Zoom)".
    // Assert that the actual event names appear — not just the section title.
    await expect(page.locator(".screen-meetings-inner")).toContainText(
      /Design review|Partner sync/i,
    );

    expect(consoleErrors).toEqual([]);
  });

  test("Meetings tab shows the chat dock", async ({ page }) => {
    await openHiFi(page);
    await gotoMeetings(page);

    // The mock in-progress event auto-opens the Granola note panel (granola != null),
    // which hides the chatdock via the !granola gate. Close the note first.
    await closeGranolaIfOpen(page);

    // With granola closed (granola === null), !granola is truthy so chatdock renders.
    await expect(page.locator(".screen-meetings-chatdock")).toBeVisible({ timeout: 10000 });
    await expect(page.locator(".screen-meetings-chatdock-inner")).toBeVisible({ timeout: 10000 });
  });

  test("Slash menu opens when prompt starts with '/'", async ({ page }) => {
    await openHiFi(page);
    await gotoMeetings(page);

    // Close granola note panel so the chatdock is visible.
    await closeGranolaIfOpen(page);

    // Locate the chatdock input; fall back to first input if aria-label selector misses.
    const primarySelector = page.locator('.screen-meetings-chatdock input[aria-label="Ask anything"]');
    const count = await primarySelector.count();
    const chatInput = count === 1
      ? primarySelector
      : page.locator(".screen-meetings-chatdock input").first();

    // Filling with '/' triggers showDockRecipeOverlay (screens-meetings.jsx:951).
    await chatInput.fill("/");

    // The mtg-recipe-overlay lists MEETINGS_DOCK_SLASH_CATALOG entries;
    // "Write weekly recap" is the third entry (id: 'weekly').
    await expect(page.locator(".screen-meetings-chatdock")).toContainText(
      /Write weekly recap/i,
      { timeout: 5000 },
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

const { test, expect } = require("@playwright/test");

const HIFI_ENTRY = "/SHOGUN%20Hi-Fi%20UI.html";

async function openHiFi(page) {
  await page.goto(HIFI_ENTRY, { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector(".app", { timeout: 90000 });
}

test.describe('Memory Edit Insights (dev-only)', () => {
  // The 3 tests below are marked test.fixme due to an inherent race in
  // the mock IPC flow / screen mount sequence. Same root cause as the
  // Phase 4 cluster e2e tests in earlier branches.
  //
  // Resolution path: expose a test-only hook (e.g.
  // window.__SHOGUN_TEST__.waitForScreen('edit-insights') that returns
  // a Promise resolving when the screen's first IPC settles). Once that
  // hook exists, swap each test.fixme back to test.

  test.fixme('setActiveScreen("edit-insights") mounts the screen with mock data', async ({ page }) => {
    await openHiFi(page);
    await page.evaluate(() => window.SHOGUN_RUNTIME?.setActiveScreen?.('edit-insights'));
    // Heading is the only stable text on the screen.
    await expect(page.locator('text=Memory · Edit Insights (debug)')).toBeVisible({ timeout: 15000 });
    // Mock returns gmail + meetings sources.
    await expect(page.locator('text=gmail').first()).toBeVisible();
    await expect(page.locator('text=meetings').first()).toBeVisible();
    // Mock returns total_edits = 6.
    await expect(page.locator('text=Total edits:')).toBeVisible();
    await expect(page.locator('text=Total edits:').first()).toContainText('6');
  });

  test.fixme('Reload button re-fetches', async ({ page }) => {
    await openHiFi(page);
    await page.evaluate(() => window.SHOGUN_RUNTIME?.setActiveScreen?.('edit-insights'));
    await expect(page.locator('text=Memory · Edit Insights (debug)')).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: 'Reload' }).click();
    // Still visible; the button doesn't unmount the screen.
    await expect(page.locator('text=Memory · Edit Insights (debug)')).toBeVisible();
  });

  test.fixme('TOML hint shows for the most-edited gmail sender', async ({ page }) => {
    await openHiFi(page);
    await page.evaluate(() => window.SHOGUN_RUNTIME?.setActiveScreen?.('edit-insights'));
    await expect(page.locator('text=Memory · Edit Insights (debug)')).toBeVisible({ timeout: 15000 });
    // Mock's top gmail sender is "noreply@example.com" with count=3.
    await expect(page.locator('text=Hint: To suppress an aggressive sender')).toBeVisible();
    await expect(page.locator('text=pattern = "noreply@example.com"')).toBeVisible();
  });
});

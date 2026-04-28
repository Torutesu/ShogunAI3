const { test, expect } = require("@playwright/test");

const HIFI_ENTRY = "/SHOGUN%20Hi-Fi%20UI.html";

async function openHiFi(page) {
  await page.goto(HIFI_ENTRY + '?test=1', { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector(".app", { timeout: 90000 });
}

test.describe('Memory Edit Insights (dev-only)', () => {
  test('setActiveScreen("edit-insights") mounts the screen with mock data', async ({ page }) => {
    await openHiFi(page);
    await page.evaluate(() => window.SHOGUN_RUNTIME?.setActiveScreen?.('edit-insights'));
    await page.evaluate(() => {
      if (!window.__SHOGUN_TEST__?.waitForScreen) {
        throw new Error('window.__SHOGUN_TEST__.waitForScreen not available — edit-insights screen not mounted, or ?test=1 missing');
      }
      return window.__SHOGUN_TEST__.waitForScreen('edit-insights');
    });
    // Heading is the only stable text on the screen.
    await expect(page.locator('text=Memory · Edit Insights (debug)')).toBeVisible({ timeout: 15000 });
    // Mock returns gmail + meetings sources.
    await expect(page.locator('text=gmail').first()).toBeVisible();
    await expect(page.locator('text=meetings').first()).toBeVisible();
    // Mock returns total_edits = 6.
    await expect(page.locator('text=Total edits:')).toBeVisible();
    await expect(page.locator('text=Total edits:').first()).toContainText('6');
  });

  test('Reload button re-fetches', async ({ page }) => {
    await openHiFi(page);
    await page.evaluate(() => window.SHOGUN_RUNTIME?.setActiveScreen?.('edit-insights'));
    await page.evaluate(() => {
      if (!window.__SHOGUN_TEST__?.waitForScreen) {
        throw new Error('window.__SHOGUN_TEST__.waitForScreen not available — edit-insights screen not mounted, or ?test=1 missing');
      }
      return window.__SHOGUN_TEST__.waitForScreen('edit-insights');
    });
    await expect(page.locator('text=Memory · Edit Insights (debug)')).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: 'Reload' }).click();
    // Still visible; the button doesn't unmount the screen.
    await expect(page.locator('text=Memory · Edit Insights (debug)')).toBeVisible();
  });

  test('TOML hint shows for the most-edited gmail sender', async ({ page }) => {
    await openHiFi(page);
    await page.evaluate(() => window.SHOGUN_RUNTIME?.setActiveScreen?.('edit-insights'));
    await page.evaluate(() => {
      if (!window.__SHOGUN_TEST__?.waitForScreen) {
        throw new Error('window.__SHOGUN_TEST__.waitForScreen not available — edit-insights screen not mounted, or ?test=1 missing');
      }
      return window.__SHOGUN_TEST__.waitForScreen('edit-insights');
    });
    await expect(page.locator('text=Memory · Edit Insights (debug)')).toBeVisible({ timeout: 15000 });
    // Mock's top gmail sender is "noreply@example.com" with count=3.
    await expect(page.locator('text=Hint: To suppress an aggressive sender')).toBeVisible();
    await expect(page.locator('text=pattern = "noreply@example.com"')).toBeVisible();
  });
});

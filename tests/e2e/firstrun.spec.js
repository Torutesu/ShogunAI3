// First-run "aha" flow (spec: docs/superpowers/specs/2026-07-16-first-run-aha-flow-design.md)
//
// Uses the mock capture override hook:
//   window.__SHOGUN_MOCK_CAPTURE__ = { trusted: boolean, events: number }
const { test, expect } = require("@playwright/test");
const { preacceptConsent } = require("./_helpers/preseed-consent");

async function openWithFirstRun(page, capture) {
  await preacceptConsent(page, { skipFirstRun: true });
  await page.addInitScript((cap) => {
    window.__SHOGUN_MOCK_CAPTURE__ = cap;
  }, capture);
  await page.goto("/");
}

test.describe("First-run aha flow", () => {
  test("walks permission → capture counter → first search → main app", async ({ page }) => {
    await openWithFirstRun(page, { trusted: false, events: 0 });

    // Act 1: permission screen shows, with the no-screenshots promise.
    await expect(page.getByTestId("firstrun-permission")).toBeVisible();
    await expect(page.getByTestId("firstrun-permission")).toContainText(/screenshots|スクリーンショット/);

    // User grants Accessibility in System Settings → poller advances to act 2.
    await page.evaluate(() => {
      window.__SHOGUN_MOCK_CAPTURE__ = { trusted: true, events: 0 };
    });
    await expect(page.getByTestId("firstrun-capture")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("firstrun-count")).toHaveText("0");

    // Fragments start arriving → counter climbs, CTA appears at ≥5.
    await page.evaluate(() => {
      window.__SHOGUN_MOCK_CAPTURE__ = { trusted: true, events: 7 };
    });
    await expect(page.getByTestId("firstrun-count")).toHaveText("7", { timeout: 10_000 });
    await page.getByTestId("firstrun-to-search").click();

    // Act 3: search own memory → hits render → aha line → open app.
    await expect(page.getByTestId("firstrun-search")).toBeVisible();
    await page.getByRole("textbox").fill("kickoff");
    await page.getByRole("button", { name: /Search|検索/ }).click();
    await expect(page.getByTestId("firstrun-hits")).toBeVisible({ timeout: 8_000 });
    await page.getByTestId("firstrun-finish").click();

    // Lands in the main app (first-run gone).
    await expect(page.getByTestId("firstrun")).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator(".app")).toBeVisible({ timeout: 10_000 });
  });

  test("skip path reaches the main app without granting permission", async ({ page }) => {
    await openWithFirstRun(page, { trusted: false, events: 0 });
    await expect(page.getByTestId("firstrun-permission")).toBeVisible();
    await page.getByTestId("firstrun-skip").click();
    await expect(page.getByTestId("firstrun")).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator(".app")).toBeVisible({ timeout: 10_000 });
  });

  test("does not reappear once firstRunComplete is persisted", async ({ page }) => {
    await openWithFirstRun(page, { trusted: false, events: 0 });
    await page.getByTestId("firstrun-skip").click();
    await expect(page.locator(".app")).toBeVisible({ timeout: 10_000 });

    // Simulate relaunch: reload the page; the persisted flag must keep the
    // flow closed.
    await page.reload();
    await expect(page.locator(".app")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("firstrun")).toHaveCount(0);
  });
});

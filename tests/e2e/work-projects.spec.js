// tests/e2e/work-projects.spec.js
// Phase 4 Step 3.3 — Work / Projects coverage
//
// Covers: workspace card list renders, create input is present,
// and workspace card actions (More actions menu with Rename/Archive/Delete).
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

async function gotoWork(page) {
  await page.locator(".sidebar .nav-item").filter({ hasText: "Work" }).first().click();
  await expect(page.locator(".page-head h1")).toContainText("Work", { timeout: 10000 });
}

/** Create a workspace with the given name and return the card locator. */
async function createWorkspace(page, name) {
  await page
    .getByPlaceholder("New workspace name / 新規Workspace名")
    .fill(name);
  await page.getByTestId("work-create-workspace").click();
  const card = page.locator(".card").filter({ hasText: name }).first();
  await expect(card).toBeVisible({ timeout: 8000 });
  return card;
}

test.describe("Work — projects", () => {
  test.beforeEach(async ({ page }) => {
    await preacceptConsent(page);
  });

  test("Work tab mounts with page header and create input", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err.message)));

    await openHiFi(page);
    await gotoWork(page);

    // Page header
    await expect(page.locator(".page-head h1")).toContainText("Work");

    // "OPERATIONS LAYER" monospace label
    await expect(page.locator(".content-inner")).toContainText("OPERATIONS LAYER");

    // Create workspace form is always present — input + button
    await expect(
      page.getByPlaceholder("New workspace name / 新規Workspace名"),
    ).toBeVisible();

    // Create button is disabled when input is empty
    await expect(page.getByTestId("work-create-workspace")).toBeDisabled();

    expect(consoleErrors).toEqual([]);
  });

  test("Workspace card list renders after creating a workspace", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err.message)));

    await openHiFi(page);
    await gotoWork(page);

    const name = `e2e-work-${Date.now()}`;
    await createWorkspace(page, name);

    // Card renders with workspace name and expected labels
    const card = page.locator(".card").filter({ hasText: name }).first();
    await expect(card).toContainText("WORKSPACE");
    await expect(card).toContainText("No memories assigned yet");

    expect(consoleErrors).toEqual([]);
  });

  test("Workspace card has More-actions menu with Rename, Archive, Delete", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err.message)));

    await openHiFi(page);
    await gotoWork(page);

    const name = `e2e-work-actions-${Date.now()}`;
    const card = await createWorkspace(page, name);

    // Each workspace card has a "More actions" button (kebab menu)
    const moreBtn = card.getByRole("button", { name: "More actions" });
    await expect(moreBtn).toBeVisible();
    await moreBtn.click();

    // The dropdown menu is an absolutely positioned div inside the card.
    // It contains buttons for Rename, Archive, Delete.
    // Wait for menu contents to appear — check for the "Rename" button text inside the card
    await expect(card).toContainText("Rename", { timeout: 5000 });
    await expect(card).toContainText("Archive");
    await expect(card).toContainText("Delete");

    // Click the Rename button — it sets renaming state so inline input appears.
    // The button contains en-only + jp spans so text is "Rename名前を変更" — use partial match.
    const renameMenuBtn = card.locator("button").filter({ hasText: /Rename/ }).first();
    await renameMenuBtn.click();

    // After clicking Rename the card replaces the title with an inline autoFocus input.
    // The card's text-content changes (name moves to input value, not text), so scope to page.
    // The shogun-grid-cards div contains the card; look for the autoFocus rename input there.
    const renameInput = page.locator('.shogun-grid-cards input[type="text"]').first();
    await expect(renameInput).toBeVisible({ timeout: 5000 });
    await expect(renameInput).toHaveValue(name);

    // Cancel rename with Escape
    await renameInput.press("Escape");
    await expect(renameInput).toHaveCount(0);

    expect(consoleErrors).toEqual([]);
  });

  test("Show-archived toggle changes empty-state message", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err.message)));

    await openHiFi(page);
    await gotoWork(page);

    // With no workspaces, the active (non-archived) empty state shows
    await expect(page.locator(".content-inner")).toContainText(
      "No workspaces yet",
      { timeout: 8000 },
    );

    // Toggling "Show archived" switches to the archived empty-state message
    await page.locator('input[type="checkbox"]').check();
    await expect(page.locator(".content-inner")).toContainText(
      "No archived workspaces",
      { timeout: 5000 },
    );

    // Unchecking restores the default
    await page.locator('input[type="checkbox"]').uncheck();
    await expect(page.locator(".content-inner")).toContainText("No workspaces yet");

    expect(consoleErrors).toEqual([]);
  });
});

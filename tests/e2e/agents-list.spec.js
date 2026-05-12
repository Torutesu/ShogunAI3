// tests/e2e/agents-list.spec.js
// Phase 4 Step 3.1 — Agents list coverage
//
// Covers: tab loads with cards, filter bar updates visible agents,
// and AttentionStrip surfaces agents needing attention.
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

async function gotoAgents(page) {
  await page.locator(".sidebar .nav-item").filter({ hasText: "Agents" }).first().click();
  await expect(page.locator(".page-head h1")).toContainText("Agents", { timeout: 10000 });
}

test.describe("Agents — list", () => {
  test.beforeEach(async ({ page }) => {
    await preacceptConsent(page);
  });

  test("Agents tab renders agent cards without manual interaction", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err.message)));

    await openHiFi(page);
    await gotoAgents(page);

    // Header: "EXECUTION LAYER" monospace label + "Agents" h1
    await expect(page.locator(".content-inner .page-head h1")).toContainText("Agents");

    // Demo data ships 4 agents; the sub-line should show "4 agents"
    await expect(page.locator(".page-head .sub")).toContainText("4 agents");

    // All four demo agent names should be visible in cards
    await expect(page.locator(".content-inner")).toContainText("Inbox triage");
    await expect(page.locator(".content-inner")).toContainText("Meeting notes");
    await expect(page.locator(".content-inner")).toContainText("Daily digest");
    await expect(page.locator(".content-inner")).toContainText("Weekly review");

    // Each AgentCard wraps its name in a card element
    const inboxCard = page.locator(".card").filter({ hasText: "Inbox triage" }).first();
    await expect(inboxCard).toBeVisible();

    expect(consoleErrors).toEqual([]);
  });

  test("Filter bar buttons are visible and clicking Scheduled filters the grid", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err.message)));

    await openHiFi(page);
    await gotoAgents(page);

    // FilterBar renders filter pill buttons using <button type="button"> with all:unset style.
    // Labels are lowercase per FILTER_OPTIONS: "all (4)", "scheduled (2)", etc.
    const allFilter = page.locator('button').filter({ hasText: /^all \(\d/ }).first();
    const scheduledFilter = page.locator('button').filter({ hasText: /^scheduled \(\d/ }).first();

    await expect(allFilter).toBeVisible({ timeout: 8000 });
    await expect(scheduledFilter).toBeVisible();

    // Click "scheduled" — only scheduled agents remain visible
    await scheduledFilter.click();

    // "Daily digest" and "Weekly review" have status: 'scheduled'
    await expect(page.locator(".content-inner")).toContainText("Daily digest");
    await expect(page.locator(".content-inner")).toContainText("Weekly review");

    // "Inbox triage" has status: 'running' — should not appear after filtering
    await expect(page.locator(".content-inner")).not.toContainText("Inbox triage");

    // Click "all" to reset — all four cards visible again
    await allFilter.click();
    await expect(page.locator(".content-inner")).toContainText("Inbox triage");

    expect(consoleErrors).toEqual([]);
  });

  test("AttentionStrip surfaces the stale weekly-review agent", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err.message)));

    await openHiFi(page);
    await gotoAgents(page);

    // demo-data: weekly-review has status 'scheduled' and lastRunMs = NOW - 96h (> 24h).
    // AttentionStrip should surface it with a "Run now" and "View" button.
    // The strip renders a border-left danger bar for each issue — look for "Weekly review"
    // in the attention area which precedes the FilterBar in DOM order.
    await expect(page.locator(".content-inner")).toContainText("Weekly review");

    // AttentionStrip renders "Run now" and "View" buttons for each issue entry
    await expect(page.locator(".content-inner").getByRole("button", { name: "Run now" }).first()).toBeVisible();
    await expect(page.locator(".content-inner").getByRole("button", { name: "View" }).first()).toBeVisible();

    expect(consoleErrors).toEqual([]);
  });

  test("New agent button opens modal", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err.message)));

    await openHiFi(page);
    await gotoAgents(page);

    // Header toolbar has "New agent" primary button
    await page.getByRole("button", { name: /New agent/i }).click();

    // NewAgentModal renders a dialog
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 8000 });

    // Close the modal with Escape
    await page.keyboard.press("Escape");

    expect(consoleErrors).toEqual([]);
  });
});

const { test, expect } = require("@playwright/test");

/** Served by playwright webServer from repo root (see playwright.config.js). */
const HIFI_ENTRY = "/SHOGUN%20Hi-Fi%20UI.html";

async function openHiFi(page) {
  await page.goto(HIFI_ENTRY, { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector(".app", { timeout: 90000 });
}

async function openSettingsModal(page) {
  await page.locator(".user-pill").click();
  await page.locator(".user-float").getByText("Settings", { exact: true }).click();
  await expect(page.locator(".s-modal")).toBeVisible();
}

/** Topbar actions (Hummingbird / star / share) render only on the Chat screen. */
async function goToChat(page) {
  await page.locator(".cmdk").click();
  await expect(page.locator(".page-actions .page-action")).toHaveCount(3);
}

test.describe("SHOGUN Hi-Fi UI", () => {
  test("mounts app and exposes SHOGUN_RUNTIME", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err.message)));

    await openHiFi(page);

    const runtime = await page.evaluate(() => {
      const r = window.SHOGUN_RUNTIME;
      if (!r) return null;
      return {
        hasExecute: typeof r.executeAction === "function",
        hasRequestWrite: typeof r.requestWriteAction === "function",
        hasToast: typeof r.pushToast === "function",
      };
    });

    expect(runtime, "SHOGUN_RUNTIME should exist").not.toBeNull();
    expect(runtime.hasExecute).toBe(true);
    expect(runtime.hasRequestWrite).toBe(true);
    expect(runtime.hasToast).toBe(true);

    expect(
      consoleErrors,
      `No uncaught page errors (got: ${consoleErrors.join("; ")})`
    ).toEqual([]);
  });

  test("executeAction resolves for memory.search (mock transport)", async ({
    page,
  }) => {
    await openHiFi(page);

    const result = await page.evaluate(async () => {
      return window.SHOGUN_RUNTIME.executeAction(
        "memory.search",
        { query: "smoke", limit: 3 },
        { silentError: true }
      );
    });

    expect(result.ok).toBe(true);
    expect(result.data).toBeTruthy();
  });

  test("executeAction integrations.credentials_status and calendar.sync (mock)", async ({
    page,
  }) => {
    await openHiFi(page);

    const cred = await page.evaluate(async () => {
      return window.SHOGUN_RUNTIME.executeAction(
        "integrations.credentials_status",
        { provider: "google_calendar" },
        { silentError: true }
      );
    });
    expect(cred.ok).toBe(true);
    expect(cred.data.configured).toBe(false);
    expect(cred.data.tokenRefreshReady).toBe(false);

    const sync = await page.evaluate(async () => {
      return window.SHOGUN_RUNTIME.executeAction(
        "calendar.sync",
        { calendarId: "primary", maxResults: 10 },
        { silentError: true }
      );
    });
    expect(sync.ok).toBe(true);
    expect(sync.data.ingested).toBe(0);
    expect(sync.data.calendarId).toBe("primary");
  });

  test("executeAction diagnostics.report returns summary (mock)", async ({ page }) => {
    await openHiFi(page);
    const out = await page.evaluate(async () => {
      return window.SHOGUN_RUNTIME.executeAction(
        "diagnostics.report",
        { source: "e2e" },
        { silentError: true },
      );
    });
    expect(out.ok).toBe(true);
    expect(out.data.reportId).toBeTruthy();
    expect(out.data.summary).toBeTruthy();
    expect(out.data.summary.integrations.google_calendar.configured).toBe(false);
    expect(out.data.summary.integrations.google_calendar.tokenRefreshReady).toBe(false);
    expect(out.data.summary.integrations.calendarAutoSync.autoSyncEnabled).toBe(false);
    expect(out.data.summary.integrations.calendarAutoSync.autoSyncIntervalMins).toBe(15);
  });

  test("stats.get with stage capture includes settings (mock)", async ({ page }) => {
    await openHiFi(page);
    const out = await page.evaluate(async () => {
      return window.SHOGUN_RUNTIME.executeAction(
        "stats.get",
        { stage: "capture" },
        { silentError: true },
      );
    });
    expect(out.ok).toBe(true);
    expect(out.data.settings.sections.capture.sampleIntervalSecs).toBe(8);
    expect(out.data.settings.sections.capture.axMinIntervalSecs).toBe(0);
    expect(out.data.settings.sections.integrations.googleCalendarSyncIntervalMins).toBe(15);
  });

  test("opens Settings from user menu and closes with X", async ({ page }) => {
    await openHiFi(page);

    await openSettingsModal(page);
    await expect(page.locator(".s-pane-head")).toContainText("General");

    await page.locator(".s-close").click();
    await expect(page.locator(".s-modal")).toHaveCount(0);
  });

  test("Settings General: Clerk section and auth.status mock", async ({ page }) => {
    await openHiFi(page);
    await openSettingsModal(page);

    await expect(page.locator(".s-pane-body")).toContainText("Clerk account");
    await expect(page.locator(".s-pane-body")).toContainText("Clerk is not configured");

    const result = await page.evaluate(async () => {
      return window.SHOGUN_RUNTIME.executeAction("auth.status", {}, { silentError: true });
    });
    expect(result.ok).toBe(true);
    expect(result.data.clerk).toBeTruthy();
    expect(result.data.clerk.enabled).toBe(false);

    await page.locator(".s-close").click();
    await expect(page.locator(".s-modal")).toHaveCount(0);
  });

  test("Appearance: choosing Light updates html data-color-mode (live)", async ({ page }) => {
    await openHiFi(page);
    await openSettingsModal(page);

    await page.locator(".s-sidebar").getByText("Appearance", { exact: true }).click();
    await expect(page.locator(".s-pane-head")).toContainText("Appearance");

    await page.locator(".s-color-card").filter({ hasText: "Light" }).click();

    const mode = await page.evaluate(() => document.documentElement.getAttribute("data-color-mode"));
    const appearance = await page.evaluate(() => document.documentElement.getAttribute("data-appearance"));
    expect(appearance).toBe("light");
    expect(mode).toBe("light");

    await page.locator(".s-close").click();
    await expect(page.locator(".s-modal")).toHaveCount(0);
  });

  test("Hummingbird WRITE confirm opens and Cancel closes", async ({ page }) => {
    await openHiFi(page);
    await goToChat(page);

    await page.locator(".page-actions .page-action").first().click();
    await expect(page.locator(".swm-modal")).toBeVisible();
    await expect(page.locator(".swm-header")).toContainText("Open Hummingbird");

    await page.locator(".swm-footer").getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator(".swm-modal")).toHaveCount(0);
  });

  test("Hummingbird WRITE confirm completes on Confirm", async ({ page }) => {
    await openHiFi(page);
    await goToChat(page);

    await page.locator(".page-actions .page-action").first().click();
    await expect(page.locator(".swm-modal")).toBeVisible();

    await page.locator(".swm-footer").getByRole("button", { name: "Confirm" }).click();
    await expect(page.locator(".swm-modal")).toHaveCount(0);
    await expect(page.locator(".app-toast.success")).toContainText("Action completed", {
      timeout: 8000,
    });
  });

  test("Data Controls: delete last hour opens WRITE confirm, Cancel closes", async ({
    page,
  }) => {
    await openHiFi(page);
    await openSettingsModal(page);

    await page.locator(".s-sidebar").getByText("Data Controls", { exact: true }).click();
    await expect(page.locator(".s-pane-head")).toContainText("Data Controls");

    await page.locator(".s-pane-body").getByRole("button", { name: "Delete" }).first().click();
    await expect(page.locator(".swm-modal")).toBeVisible();
    await expect(page.locator(".swm-header")).toContainText("Delete last hour");

    await page.locator(".swm-footer").getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator(".swm-modal")).toHaveCount(0);

    await page.locator(".s-close").click();
    await expect(page.locator(".s-modal")).toHaveCount(0);
  });

  test("Share modal opens and closes via backdrop click", async ({ page }) => {
    await openHiFi(page);
    await goToChat(page);

    await page.locator(".page-actions .page-action").nth(2).click();
    await expect(page.locator(".share-modal")).toBeVisible();
    await expect(page.locator(".share-modal")).toContainText("Share chat");

    // Backdrop is full-screen under the modal; click main content area (not the right-side panel).
    await page.mouse.click(360, 280);
    await expect(page.locator(".share-modal")).toHaveCount(0);
  });

  test("Share modal Export to file shows success toast", async ({ page }) => {
    await openHiFi(page);
    await goToChat(page);

    await page.locator(".page-actions .page-action").nth(2).click();
    await expect(page.locator(".share-modal")).toBeVisible();

    await page.locator(".share-modal").getByRole("button", { name: /Export to file/i }).click();
    await expect(page.locator(".share-modal")).toHaveCount(0);
    await expect(page.locator(".app-toast.success")).toContainText("Chat exported to file", {
      timeout: 8000,
    });
  });

  test("Settings Integrations: Connect shows v1 not-implemented warn toast", async ({ page }) => {
    await openHiFi(page);
    await openSettingsModal(page);

    await page.locator(".s-sidebar").getByText("Integrations", { exact: true }).click();
    await expect(page.locator(".s-pane-head")).toContainText("Integrations");

    await page
      .locator(".s-card")
      .filter({ hasText: "Slack" })
      .getByRole("button", { name: "Connect" })
      .click();
    await expect(page.locator(".app-toast.warn")).toContainText(/not available in v1/i, {
      timeout: 8000,
    });
    await page.locator(".s-close").click();
    await expect(page.locator(".s-modal")).toHaveCount(0);
  });

  test("Settings Integrations: Sync to Memory shows success toast (mock)", async ({ page }) => {
    await openHiFi(page);
    await openSettingsModal(page);

    await page.locator(".s-sidebar").getByText("Integrations", { exact: true }).click();
    await expect(page.locator(".s-pane-head")).toContainText("Integrations");

    // Scope to the Google Calendar card — Gmail and Calendar each expose a
    // "Sync to Memory" button, so the unscoped getByRole hits both.
    await page
      .locator(".s-card")
      .filter({ hasText: "Google Calendar" })
      .getByRole("button", { name: "Sync to Memory" })
      .click();
    await expect(page.locator(".app-toast.success")).toContainText("Calendar synced to Memory", {
      timeout: 8000,
    });

    await page.locator(".s-close").click();
    await expect(page.locator(".s-modal")).toHaveCount(0);
  });

  test("Memory: entity sources panel mounts", async ({ page }) => {
    await openHiFi(page);

    await page.locator(".sidebar .nav-item").filter({ hasText: "Memory" }).first().click();
    await expect(page.getByText("MEMORY / TIMELINE")).toBeVisible();
    await expect(page.locator("h1").filter({ hasText: /\u6642\u9593\u8ef8/ })).toBeVisible();

    const panel = page.getByTestId("memory-entity-sources");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(/SOURCES IN INDEX/i);
  });

  test("Work: New document shows draft success toast (mock IPC)", async ({ page }) => {
    await openHiFi(page);

    await page.locator(".sidebar .nav-item").filter({ hasText: "Work" }).first().click();
    await expect(page.locator(".page-head h1")).toContainText("Work");

    await page.getByRole("button", { name: /New document/i }).click();
    await expect(page.locator(".app-toast.success")).toContainText("Draft ready", {
      timeout: 8000,
    });
  });

  test("executeAction memory.search with semantic sets semanticRerank (mock)", async ({ page }) => {
    await openHiFi(page);
    const out = await page.evaluate(async () => {
      return window.SHOGUN_RUNTIME.executeAction(
        "memory.search",
        { query: "smoke", limit: 5, semantic: true },
        { silentError: true },
      );
    });
    expect(out.ok).toBe(true);
    expect(out.data.semanticRerank).toBe(true);
  });

  test("Memory: semantic re-rank toggle is on by default", async ({ page }) => {
    await openHiFi(page);
    await page.locator(".sidebar .nav-item").filter({ hasText: "Memory" }).first().click();
    await expect(page.getByTestId("memory-semantic-rerank")).toBeVisible();
    await expect(page.getByTestId("memory-semantic-rerank")).toBeChecked();
  });

  test("Memory: semantic re-rank preference persists in settings (mock)", async ({ page }) => {
    await openHiFi(page);
    await page.locator(".sidebar .nav-item").filter({ hasText: "Memory" }).first().click();
    await expect(page.getByTestId("memory-semantic-rerank")).toBeVisible();
    await page.getByTestId("memory-semantic-rerank").uncheck();
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const r = await window.SHOGUN_RUNTIME.executeAction("settings.load", {}, { silentError: true });
          return r?.data?.settings?.sections?.memory?.semanticRerank;
        }),
      )
      .toBe(false);
    await page.getByTestId("memory-semantic-rerank").check();
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const r = await window.SHOGUN_RUNTIME.executeAction("settings.load", {}, { silentError: true });
          return r?.data?.settings?.sections?.memory?.semanticRerank;
        }),
      )
      .toBe(true);
  });

  test("Settings Model & API: Backfill embeddings toast after mock key save", async ({ page }) => {
    await openHiFi(page);
    await openSettingsModal(page);
    await page.locator(".s-sidebar").getByText("Model & API", { exact: true }).click();
    await expect(page.locator(".s-pane-head")).toContainText("Model & API");

    await page.locator(".s-pane-body").getByPlaceholder("sk-…").fill("sk-mock-e2e-backfill");
    await page.locator(".s-pane-body").getByRole("button", { name: "Save key" }).click();
    await expect(page.locator(".s-pane-body")).toContainText("Keychain: configured", { timeout: 8000 });

    await page.locator(".s-pane-body").getByRole("button", { name: /Backfill missing vectors/ }).click();
    await expect(page.locator(".app-toast.success")).toContainText("Embedded 0 · failed 0", {
      timeout: 8000,
    });

    await page.locator(".s-close").click();
    await expect(page.locator(".s-modal")).toHaveCount(0);
  });
});

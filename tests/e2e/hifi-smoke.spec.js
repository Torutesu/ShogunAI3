const { test, expect } = require("@playwright/test");
const { preacceptConsent } = require("./_helpers/preseed-consent");

/** Served by playwright webServer from repo root (see playwright.config.js). */
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
  // The consent gate blocks `.app` from rendering on first launch. The
  // helper installs an accessor that observes legal-versions.js's
  // assignment and seeds mock settings with whatever the bundle ships,
  // so version bumps don't silently break this suite.
  test.beforeEach(async ({ page }) => {
    await preacceptConsent(page);
  });

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

  test("Settings Integrations: planned OAuth providers are not clickable", async ({ page }) => {
    await openHiFi(page);
    await openSettingsModal(page);

    await page.locator(".s-sidebar").getByText("Integrations", { exact: true }).click();
    await expect(page.locator(".s-pane-head")).toContainText("Integrations");

    // Outlook has no token-import path yet, so it stays disabled.
    await expect(page
      .locator(".s-card")
      .filter({ hasText: "Outlook" })
      .getByRole("button", { name: "Coming soon" }))
      .toBeDisabled();

    // Slack ships a working paste-token Connect — it must NOT be "Coming soon".
    await expect(page
      .locator(".s-card")
      .filter({ hasText: "Slack" })
      .getByRole("button", { name: "Connect" }))
      .toBeEnabled();

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
    await expect(page.getByText(/Memory \/ Timeline/i)).toBeVisible();

    const panel = page.getByTestId("memory-entity-sources");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(/SOURCES IN INDEX/i);
  });

  test("Work: create workspace adds a card", async ({ page }) => {
    await openHiFi(page);

    await page.locator(".sidebar .nav-item").filter({ hasText: "Work" }).first().click();
    await expect(page.locator(".page-head h1")).toContainText("Work");

    const workspaceName = `e2e-workspace-${Date.now()}`;
    await page
      .getByPlaceholder("New workspace name / 新規Workspace名")
      .fill(workspaceName);
    await page.getByTestId("work-create-workspace").click();
    await expect(page.locator(".card").filter({ hasText: workspaceName })).toBeVisible();
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

  test("Memory: semantic re-rank persists via settings.save (mock)", async ({ page }) => {
    await openHiFi(page);
    await page.evaluate(async () => {
      await window.SHOGUN_RUNTIME.executeAction(
        "settings.save",
        { section: "memory", semanticRerank: false },
        { silentError: true },
      );
    });
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const r = await window.SHOGUN_RUNTIME.executeAction("settings.load", {}, { silentError: true });
          return r?.data?.settings?.sections?.memory?.semanticRerank;
        }),
      )
      .toBe(false);
    await page.evaluate(async () => {
      await window.SHOGUN_RUNTIME.executeAction(
        "settings.save",
        { section: "memory", semanticRerank: true },
        { silentError: true },
      );
    });
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const r = await window.SHOGUN_RUNTIME.executeAction("settings.load", {}, { silentError: true });
          return r?.data?.settings?.sections?.memory?.semanticRerank;
        }),
      )
      .toBe(true);
  });

  test("Memory: kioku_graph read_path persists via settings.save (mock)", async ({ page }) => {
    await openHiFi(page);
    await page.evaluate(async () => {
      await window.SHOGUN_RUNTIME.executeAction(
        "settings.save",
        { section: "kioku_graph", read_path: "legacy" },
        { silentError: true },
      );
    });
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const r = await window.SHOGUN_RUNTIME.executeAction("settings.load", {}, { silentError: true });
          return r?.data?.settings?.sections?.kioku_graph?.read_path;
        }),
      )
      .toBe("legacy");
    await page.evaluate(async () => {
      await window.SHOGUN_RUNTIME.executeAction(
        "settings.save",
        { section: "kioku_graph", read_path: "graph" },
        { silentError: true },
      );
    });
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const r = await window.SHOGUN_RUNTIME.executeAction("settings.load", {}, { silentError: true });
          return r?.data?.settings?.sections?.kioku_graph?.read_path;
        }),
      )
      .toBe("graph");
  });

  test("Memory: timelineSearch reports graph read_path by default (mock)", async ({ page }) => {
    await openHiFi(page);
    const out = await page.evaluate(async () => {
      return window.SHOGUN_RUNTIME.executeAction(
        "memory.timelineSearch",
        { query: "", limit: 20, kinds: ["screen", "input"] },
        { silentError: true },
      );
    });
    expect(out.ok).toBe(true);
    expect(out.data.read_path).toBe("graph");
    expect(out.data.scope).toBe("timeline");
  });

  test("Chat: memoryAssembly reports graph read_path by default (mock)", async ({ page }) => {
    await openHiFi(page);
    const out = await page.evaluate(async () => {
      return window.SHOGUN_RUNTIME.executeAction(
        "chat.complete",
        {
          messages: [{ role: "user", content: "What did we decide about Aurora beta?" }],
          memoryAssembly: { query: "Aurora beta", limit: 8, semantic: true },
        },
        { silentError: true },
      );
    });
    expect(out.ok).toBe(true);
    expect(out.data.memoryReadPath).toBe("graph");
    expect(out.data.memoryAssembly?.read_path).toBe("graph");
  });

  test("Chat: memoryReadPath follows kioku_graph settings (mock)", async ({ page }) => {
    await openHiFi(page);
    await page.evaluate(async () => {
      await window.SHOGUN_RUNTIME.executeAction(
        "settings.save",
        { section: "kioku_graph", read_path: "legacy" },
        { silentError: true },
      );
    });
    const legacy = await page.evaluate(async () => {
      const r = await window.SHOGUN_RUNTIME.executeAction(
        "chat.complete",
        {
          messages: [{ role: "user", content: "legacy path check" }],
          memoryAssembly: { query: "legacy path check", limit: 5, semantic: false },
        },
        { silentError: true },
      );
      return r?.data?.memoryReadPath;
    });
    expect(legacy).toBe("legacy");
    await page.evaluate(async () => {
      await window.SHOGUN_RUNTIME.executeAction(
        "settings.save",
        { section: "kioku_graph", read_path: "graph" },
        { silentError: true },
      );
    });
    const graph = await page.evaluate(async () => {
      const r = await window.SHOGUN_RUNTIME.executeAction(
        "chat.complete",
        {
          messages: [{ role: "user", content: "graph path check" }],
          memoryAssembly: { query: "graph path check", limit: 5, semantic: false },
        },
        { silentError: true },
      );
      return r?.data?.memoryReadPath;
    });
    expect(graph).toBe("graph");
  });

  test("Brief: brief.get reports memoryReadPath from settings (mock)", async ({ page }) => {
    await openHiFi(page);
    const out = await page.evaluate(async () => {
      return window.SHOGUN_RUNTIME.executeAction(
        "brief.get",
        { forceV2: true, user_tz: "Asia/Tokyo", lang: "en" },
        { silentError: true },
      );
    });
    expect(out.ok).toBe(true);
    expect(out.data.memoryReadPath).toBe("graph");
    await page.evaluate(async () => {
      await window.SHOGUN_RUNTIME.executeAction(
        "settings.save",
        { section: "kioku_graph", read_path: "legacy" },
        { silentError: true },
      );
    });
    await expect
      .poll(async () => {
        const r = await page.evaluate(async () =>
          window.SHOGUN_RUNTIME.executeAction(
            "brief.get",
            { forceV2: true, user_tz: "Asia/Tokyo", lang: "en" },
            { silentError: true },
          ),
        );
        return r?.data?.memoryReadPath;
      })
      .toBe("legacy");
  });

  test("Brief: memory_digest reports graph_supplemented in mock", async ({ page }) => {
    await openHiFi(page);
    const out = await page.evaluate(async () => {
      return window.SHOGUN_RUNTIME.executeAction(
        "brief.get",
        { forceV2: true, user_tz: "Asia/Tokyo", lang: "en" },
        { silentError: true },
      );
    });
    expect(out.ok).toBe(true);
    expect(out.data.memory_digest?.graph_supplemented).toBe(true);
    expect(out.data.memory_digest?.read_path).toBe("graph");
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

  test("Agents: Edit modal updates name/description/trigger across screen", async ({ page }) => {
    await openHiFi(page);
    await page.locator(".sidebar .nav-item").filter({ hasText: "Agents" }).first().click();
    await expect(page.locator(".page-head h1")).toContainText("Agents");

    const card = page.locator(".card").filter({ hasText: "Inbox triage" }).first();
    await card.getByRole("button", { name: /expand agent/i }).click();
    await card.getByRole("button", { name: "Edit" }).click();

    const modal = page.getByRole("dialog", { name: "Edit agent" });
    await expect(modal).toBeVisible();

    const saveBtn = modal.getByRole("button", { name: "Save changes" });
    await modal.getByRole("textbox").first().fill("");
    await expect(saveBtn).toBeDisabled();

    await modal.getByRole("textbox").first().fill("Inbox triage v2");
    await modal.getByRole("textbox").nth(1).fill("Updated description from e2e test.");
    await modal.locator("select").first().selectOption("daily");
    await modal.locator('input[type="time"]').fill("22:15");
    await saveBtn.click();

    await expect(page.locator(".app-toast.success")).toContainText("Agent updated", {
      timeout: 8000,
    });
    await expect(modal).toHaveCount(0);
    await expect(page.locator(".page-head .sub")).toContainText("4 agents");
    await expect(page.locator(".card").filter({ hasText: "Inbox triage v2" }).first()).toContainText(
      "Updated description from e2e test.",
    );
    await expect(page.locator(".card").filter({ hasText: "Inbox triage v2" }).first()).toContainText(
      "22:15 daily",
    );
  });
});

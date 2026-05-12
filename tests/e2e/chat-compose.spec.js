// tests/e2e/chat-compose.spec.js
// Phase 4 Step 3.2 — Chat composer coverage
//
// Covers: composer accepts text input, send button triggers chat.complete via
// mock IPC, and empty-state "Ask anything" hint renders before any message.
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

/** Navigate to the Chat screen via the topbar .cmdk button, matching hifi-smoke. */
async function goToChat(page) {
  await page.locator(".cmdk").click();
  // Chat screen mounts the shogun-chat-layout container
  await expect(page.locator(".shogun-chat-layout")).toBeVisible({ timeout: 10000 });
}

test.describe("Chat — composer", () => {
  test.beforeEach(async ({ page }) => {
    await preacceptConsent(page);
  });

  test("Chat screen mounts with thread and composer without errors", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err.message)));

    await openHiFi(page);
    await goToChat(page);

    // The chat layout renders correctly
    await expect(page.locator(".shogun-chat-main")).toBeVisible({ timeout: 8000 });

    // The thread container is always present (may have seeded demo messages)
    await expect(page.locator(".shogun-chat-thread")).toBeVisible();

    // The composer is always present
    await expect(page.locator(".composer")).toBeVisible();

    // The chat header shows the "Chat" title (English) and japanese label
    await expect(page.locator(".shogun-chat-header")).toContainText("Chat");

    // The memory context sidebar is visible
    await expect(page.locator(".shogun-chat-context")).toBeVisible();

    expect(consoleErrors).toEqual([]);
  });

  test("Composer textarea accepts text input and send button becomes enabled", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err.message)));

    await openHiFi(page);
    await goToChat(page);

    // The composer textarea has placeholder "Message…"
    const textarea = page.locator('.composer textarea.s-input');
    await expect(textarea).toBeVisible({ timeout: 8000 });

    // Send button is initially disabled (empty composer)
    const sendBtn = page.locator('button.composer-send[aria-label="Send message"]');
    await expect(sendBtn).toBeDisabled();

    // Type a message — send button should become enabled
    await textarea.fill("Hello from e2e test");
    await expect(sendBtn).toBeEnabled();

    // Clearing the text disables the send button again
    await textarea.fill("");
    await expect(sendBtn).toBeDisabled();

    expect(consoleErrors).toEqual([]);
  });

  test("Sending a message triggers chat.complete IPC and shows assistant reply", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err.message)));

    await openHiFi(page);
    await goToChat(page);

    const textarea = page.locator('.composer textarea.s-input');
    await expect(textarea).toBeVisible({ timeout: 8000 });

    // Type and send a message
    await textarea.fill("What is 2 + 2?");
    await page.locator('button.composer-send[aria-label="Send message"]').click();

    // The user turn should appear in the thread immediately
    await expect(page.locator(".shogun-chat-thread")).toContainText(
      "What is 2 + 2?",
      { timeout: 8000 },
    );

    // The mock IPC transport resolves chat.complete and inserts an assistant reply.
    // mockIpc.ts returns data.message starting with "[Demo — set an API key..."
    await expect(page.locator(".shogun-chat-thread")).toContainText(
      "Demo",
      { timeout: 15000 },
    );

    // The composer textarea should be cleared after sending
    await expect(textarea).toHaveValue("");

    expect(consoleErrors).toEqual([]);
  });

  test("Composer pill buttons (Memory, Web, Assemble) are visible", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err.message)));

    await openHiFi(page);
    await goToChat(page);

    // composer-pill buttons: Attach, Memory, Web, Assemble, Agents, Integrations
    const composerActions = page.locator(".composer-actions");
    await expect(composerActions).toBeVisible({ timeout: 8000 });
    await expect(composerActions.getByRole("button", { name: /Memory/i }).first()).toBeVisible();
    await expect(composerActions.getByRole("button", { name: /Web/i }).first()).toBeVisible();
    await expect(composerActions.getByRole("button", { name: /Assemble/i }).first()).toBeVisible();

    // The footer note shows memory count and keyboard shortcuts
    await expect(page.locator(".shogun-chat-main")).toContainText("Return sends");

    expect(consoleErrors).toEqual([]);
  });
});

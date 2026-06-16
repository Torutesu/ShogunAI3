// E2E for McpSetupGate wizard (Phase 3 onboarding).
//
// Uses `preacceptConsent({ skipMcpComplete: true })` so EntitlementGate is
// bypassed (default billing_config) but the MCP wizard still appears.

const { test, expect } = require("@playwright/test");
const { preacceptConsent } = require("./_helpers/preseed-consent");

const HIFI_ENTRY = "/";

async function openHiFi(page) {
  await page.goto(HIFI_ENTRY, { waitUntil: "load", timeout: 90000 });
  await page.waitForFunction(
    () =>
      document.querySelector(".app") !== null ||
      document.body.textContent.includes("Connect Claude Desktop"),
    null,
    { timeout: 30000 },
  );
}

test.describe("McpSetupGate", () => {
  test("first launch shows 4-step wizard and blocks MainApp", async ({ page }) => {
    await preacceptConsent(page, { skipMcpComplete: true });
    await openHiFi(page);

    await expect(page.getByText("Connect Claude Desktop")).toBeVisible();
    await expect(page.getByText("Step 1 of 4")).toBeVisible();
    await expect(page.locator(".sidebar")).toHaveCount(0);
  });

  test("Skip for now completes wizard and loads MainApp", async ({ page }) => {
    await preacceptConsent(page, { skipMcpComplete: true });
    await openHiFi(page);

    await page.getByRole("button", { name: "Skip for now" }).click();
    await expect(page.locator(".app")).toBeVisible({ timeout: 15000 });
    await page.waitForFunction(() => !!window.SHOGUN_RUNTIME, null, { timeout: 20000 });

    const onboarding = await page.evaluate(async () => {
      const client = window.ShogunIpcClient.createIpcClient();
      const res = await client.invoke("app_settings_load", {});
      return res.data.settings.sections.onboarding;
    });
    expect(onboarding.mcpComplete).toBe(true);
  });

  test("full flow: write config then Done reaches MainApp", async ({ page }) => {
    await preacceptConsent(page, { skipMcpComplete: true });
    await openHiFi(page);

    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Step 2 of 4")).toBeVisible();

    await page.getByPlaceholder("/path/to/shogun-mcp").fill("/mock/shogun-mcp");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Step 3 of 4")).toBeVisible();

    await page.getByRole("button", { name: "Write config" }).click();
    await expect(page.getByText("Step 4 of 4")).toBeVisible();
    await expect(page.getByText(/Configuration saved/i)).toBeVisible();

    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.locator(".app")).toBeVisible({ timeout: 15000 });
  });

  test("mcpComplete in settings skips wizard", async ({ page }) => {
    await preacceptConsent(page);
    await openHiFi(page);

    await expect(page.getByText("Connect Claude Desktop")).toHaveCount(0);
    await expect(page.locator(".app")).toBeVisible();
  });

  test("relaunch after skip keeps wizard closed", async ({ page }) => {
    await preacceptConsent(page, { skipMcpComplete: true });
    await openHiFi(page);

    await page.getByRole("button", { name: "Skip for now" }).click();
    await expect(page.locator(".app")).toBeVisible({ timeout: 15000 });

    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(
      () =>
        document.querySelector(".app") !== null ||
        document.body.textContent.includes("Connect Claude Desktop"),
      null,
      { timeout: 30000 },
    );
    await expect(page.getByText("Connect Claude Desktop")).toHaveCount(0);
    await expect(page.locator(".app")).toBeVisible();
  });
});

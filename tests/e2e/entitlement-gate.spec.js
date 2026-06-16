// E2E for EntitlementGate (Phase 2 onboarding / billing).
//
// Browser mock: billing_config + Clerk session stub + fetch to /api/entitlement.
// Consent is pre-accepted; MCP wizard is skipped via preacceptConsent default.

const { test, expect } = require("@playwright/test");
const { preacceptConsent } = require("./_helpers/preseed-consent");
const {
  MOCK_WEB_APP_URL,
  installBillingConfig,
  installClerkSession,
  seedBillingCache,
  routeEntitlement,
} = require("./_helpers/preseed-gates");

const HIFI_ENTRY = "/";

async function openHiFi(page) {
  await page.goto(HIFI_ENTRY, { waitUntil: "load", timeout: 90000 });
  await page.waitForFunction(
    () =>
      document.querySelector(".app") !== null ||
      document.querySelector("h1")?.textContent?.includes("Sign in") ||
      document.querySelector("h1")?.textContent?.includes("Subscription"),
    null,
    { timeout: 30000 },
  );
}

test.describe("EntitlementGate", () => {
  test.beforeEach(async ({ page }) => {
    await preacceptConsent(page);
  });

  test("billing disabled bypasses gate and loads MainApp", async ({ page }) => {
    await openHiFi(page);
    await expect(page.locator(".app")).toBeVisible();
    await expect(page.getByRole("heading", { name: /Sign in to continue/i })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /Subscription required/i })).toHaveCount(0);
  });

  test("billing enabled + signed out shows sign-in screen", async ({ page }) => {
    await installBillingConfig(page, { enabled: true, webAppUrl: MOCK_WEB_APP_URL });
    await installClerkSession(page, { signedIn: false });
    await openHiFi(page);

    await expect(page.getByRole("heading", { name: /Sign in to continue/i })).toBeVisible();
    await expect(page.locator(".sidebar")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();
  });

  test("billing enabled + signed in + no subscription shows paywall", async ({ page }) => {
    await installBillingConfig(page, { enabled: true, webAppUrl: MOCK_WEB_APP_URL });
    await installClerkSession(page, { signedIn: true });
    await routeEntitlement(page, { status: "none" });
    await openHiFi(page);

    await expect(page.getByRole("heading", { name: /Subscription required/i })).toBeVisible();
    await expect(page.getByText(/Status:\s*none/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Manage billing" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();
    await expect(page.locator(".sidebar")).toHaveCount(0);
  });

  test("billing enabled + trialing entitlement loads MainApp", async ({ page }) => {
    await installBillingConfig(page, { enabled: true, webAppUrl: MOCK_WEB_APP_URL });
    await installClerkSession(page, { signedIn: true });
    await routeEntitlement(page, {
      status: "trialing",
      trialEnd: "2099-01-01T00:00:00.000Z",
      manageUrl: `${MOCK_WEB_APP_URL}/account`,
    });
    await openHiFi(page);

    await expect(page.locator(".app")).toBeVisible();
    await page.waitForFunction(() => !!window.SHOGUN_RUNTIME, null, { timeout: 20000 });
  });

  test("offline grace: valid cache allows MainApp when network fails", async ({ page }) => {
    await installBillingConfig(page, { enabled: true, webAppUrl: MOCK_WEB_APP_URL });
    await installClerkSession(page, { signedIn: true });
    await seedBillingCache(page, {
      status: "active",
      checkedAt: new Date().toISOString(),
      manageUrl: `${MOCK_WEB_APP_URL}/account`,
    });
    await page.route("**/api/entitlement", async (route) => {
      await route.abort("failed");
    });
    await openHiFi(page);

    await expect(page.locator(".app")).toBeVisible();
  });

  test("offline grace expired: paywall when network fails and cache is stale", async ({ page }) => {
    await installBillingConfig(page, { enabled: true, webAppUrl: MOCK_WEB_APP_URL });
    await installClerkSession(page, { signedIn: true });
    await seedBillingCache(page, {
      status: "active",
      checkedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      manageUrl: `${MOCK_WEB_APP_URL}/account`,
    });
    await page.route("**/api/entitlement", async (route) => {
      await route.abort("failed");
    });
    await openHiFi(page);

    await expect(page.getByRole("heading", { name: /Subscription required/i })).toBeVisible();
    await expect(page.locator(".sidebar")).toHaveCount(0);
  });
});

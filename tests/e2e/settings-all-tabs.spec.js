// tests/e2e/settings-all-tabs.spec.js
const { test, expect } = require("@playwright/test");
const { preacceptConsent } = require("./_helpers/preseed-consent");

const HIFI_ENTRY = "/SHOGUN%20Hi-Fi%20UI.html";

// Source of truth: hifi/settings-modal.jsx:5-20 (SETTINGS_NAV array).
// If you add/remove a tab there, update this list and the test will fail
// loud, which is exactly what we want for Phase 0 coverage.
const SETTINGS_TABS = [
  "General",
  "System",
  "Appearance",
  "Privacy Controls",
  "Data Controls",
  "Hummingbird",
  "Meetings",
  "Chat",
  "Model & API",
  "KIOKU Graph",
  "KIOKU Patterns",
  "KIOKU Lessons",
  "Integrations",
  "Keyboard Shortcuts",
  "Team",
  "Support",
];

// NOTE: Helper duplicated from tests/e2e/hifi-smoke.spec.js for Phase 0.
// TODO: extract to tests/e2e/_helpers/open-hifi.js once Tasks 1-4 land.
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
  // Wait for the floating menu to render before clicking inside it. Without
  // this, the inner click can race the menu's enter animation across the
  // 16 sequential cases in this spec and produce flaky failures.
  await expect(page.locator(".user-float")).toBeVisible();
  await page.locator(".user-float").getByText("Settings", { exact: true }).click();
  await expect(page.locator(".s-modal")).toBeVisible();
}

test.describe("Settings: every tab opens without errors", () => {
  test.beforeEach(async ({ page }) => {
    await preacceptConsent(page);
  });

  for (const label of SETTINGS_TABS) {
    test(`opens "${label}" tab and shows pane head`, async ({ page }) => {
      const consoleErrors = [];
      page.on("pageerror", (err) => consoleErrors.push(String(err.message)));

      await openHiFi(page);
      await openSettingsModal(page);

      await page.locator(".s-sidebar").getByText(label, { exact: true }).click();
      // The pane head text contains the tab label (allowing for additional copy
      // such as " — beta" etc. — match by inclusion, not equality).
      await expect(page.locator(".s-pane-head")).toContainText(label, { timeout: 10000 });

      // Closing the modal must always work.
      await page.locator(".s-close").click();
      await expect(page.locator(".s-modal")).toHaveCount(0);

      expect(
        consoleErrors,
        `No uncaught page errors on "${label}" (got: ${consoleErrors.join("; ")})`,
      ).toEqual([]);
    });
  }
});

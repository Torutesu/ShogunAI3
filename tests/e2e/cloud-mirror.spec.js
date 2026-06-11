// Phase 2.1.4 T6 — E2E coverage for the Settings → Cloud Mirror pane.
//
// Drives all three pane states (Disabled / Locked / Active) plus the
// destructive flows. Locked / Active states are reached by overriding
// the `mirror_status` mock response via the `window.__shogunMockOverrides`
// seam added in T6 (see `tests/e2e/_helpers/mirror-mock.js` and the
// matching seam in `hifi/lib/ipc-client.js` + `hifi/app.jsx::mockIpcInvoke`).

const { test, expect } = require("@playwright/test");
const { preacceptConsent } = require("./_helpers/preseed-consent");
const {
  setMirrorActive,
  setMirrorLocked,
} = require("./_helpers/mirror-mock");

const HIFI_ENTRY = "/";

async function openHiFi(page) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto(HIFI_ENTRY, { waitUntil: "load", timeout: 90000 });
    try {
      await page.waitForSelector(".app", { timeout: 20000 });
      await page.waitForFunction(() => !!window.SHOGUN_RUNTIME, null, {
        timeout: 20000,
      });
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

async function openCloudMirrorPane(page) {
  await openSettingsModal(page);
  await page
    .locator(".s-sidebar")
    .getByText("Cloud Mirror", { exact: true })
    .click();
  await expect(page.locator(".s-pane-head")).toContainText("Cloud Mirror");
}

test.describe("SHOGUN Cloud Mirror pane", () => {
  test.beforeEach(async ({ page }) => {
    await preacceptConsent(page);
  });

  test("Disabled state: pane visible with Enable CTA", async ({ page }) => {
    await openHiFi(page);
    await openCloudMirrorPane(page);

    const body = page.locator(".s-pane-body");
    await expect(body).toContainText("Get started");
    await expect(
      body.getByRole("button", { name: "Enable Cloud Mirror" }),
    ).toBeVisible();
  });

  test("Disabled state: clicking Enable opens onboarding wizard step 1", async ({
    page,
  }) => {
    await openHiFi(page);
    await openCloudMirrorPane(page);

    await page
      .locator(".s-pane-body")
      .getByRole("button", { name: "Enable Cloud Mirror" })
      .click();

    // Wizard is a fixed-position overlay outside .s-pane-body.
    await expect(page.getByText("Step 1 of 4")).toBeVisible();
    await expect(
      page.getByText("Mirror server URL", { exact: true }),
    ).toBeVisible();
    await expect(page.locator('input[placeholder*="https://"]')).toBeVisible();
  });

  test("Onboarding step 1: empty URL surfaces error after Next", async ({
    page,
  }) => {
    await openHiFi(page);
    await openCloudMirrorPane(page);

    await page
      .locator(".s-pane-body")
      .getByRole("button", { name: "Enable Cloud Mirror" })
      .click();
    await expect(page.getByText("Step 1 of 4")).toBeVisible();

    // Empty URL field; clicking Next should surface "URL required" and not advance.
    await page.getByRole("button", { name: "Next" }).click();

    await expect(page.getByText("URL required")).toBeVisible();
    await expect(page.getByText("Step 1 of 4")).toBeVisible();
  });

  test("Onboarding step 1: http://attacker.com/?host=localhost rejected", async ({
    page,
  }) => {
    await openHiFi(page);
    await openCloudMirrorPane(page);

    await page
      .locator(".s-pane-body")
      .getByRole("button", { name: "Enable Cloud Mirror" })
      .click();
    await expect(page.getByText("Step 1 of 4")).toBeVisible();

    // The URL passes the protocol regex and `new URL()` parses cleanly,
    // but the hostname check rejects it because `attacker.com` !== localhost.
    await page
      .locator('input[placeholder*="https://"]')
      .fill("http://attacker.com/?host=localhost");

    // Error renders immediately because serverUrl.length > 0.
    await expect(
      page.getByText(/http:\/\/ is only allowed for localhost/i),
    ).toBeVisible();

    // Next is disabled while the URL has an error — wizard stays on step 1.
    await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();
    await expect(page.getByText("Step 1 of 4")).toBeVisible();
  });

  test("Onboarding step 4: weak passphrase blocks Set up Mirror", async ({
    page,
  }) => {
    await openHiFi(page);
    await openCloudMirrorPane(page);

    await page
      .locator(".s-pane-body")
      .getByRole("button", { name: "Enable Cloud Mirror" })
      .click();
    await expect(page.getByText("Step 1 of 4")).toBeVisible();

    // Step 1 → 2
    await page
      .locator('input[placeholder*="https://"]')
      .fill("https://mirror.example.com");
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByText("Step 2 of 4")).toBeVisible();

    // Step 2 → 3
    await page.locator('input[placeholder*="server admin"]').fill("regcode-1234");
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByText("Step 3 of 4")).toBeVisible();

    // Step 3 → 4
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByText("Step 4 of 4")).toBeVisible();

    // Two matching but weak passphrases (length 5, no upper/digit/symbol).
    const passInputs = page.locator('input[type="password"]');
    await passInputs.first().fill("aaaaa");
    await passInputs.nth(1).fill("aaaaa");

    // Strength score < 3 → Set up Mirror disabled.
    await expect(
      page.getByRole("button", { name: "Set up Mirror" }),
    ).toBeDisabled();
  });

  test("Onboarding step 4: passphrase mismatch shows warning", async ({ page }) => {
    await openHiFi(page);
    await openCloudMirrorPane(page);

    await page
      .locator(".s-pane-body")
      .getByRole("button", { name: "Enable Cloud Mirror" })
      .click();
    await expect(page.getByText("Step 1 of 4")).toBeVisible();

    await page
      .locator('input[placeholder*="https://"]')
      .fill("https://mirror.example.com");
    await page.getByRole("button", { name: "Next" }).click();
    await page.locator('input[placeholder*="server admin"]').fill("regcode-1234");
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByText("Step 4 of 4")).toBeVisible();

    // Two non-matching passphrases.
    const passInputs = page.locator('input[type="password"]');
    await passInputs.first().fill("CorrectHorseBattery!1");
    await passInputs.nth(1).fill("DifferentValue!2");

    await expect(page.getByText(/Passphrases don.t match/i)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Set up Mirror" }),
    ).toBeDisabled();
  });

  test("Locked state: unlock button visible", async ({ page }) => {
    await openHiFi(page);
    await setMirrorLocked(page);
    await openCloudMirrorPane(page);

    const body = page.locator(".s-pane-body");
    await expect(body).toContainText("Locked");
    await expect(body).toContainText(/master key isn.t loaded/i);
    await expect(body.getByRole("button", { name: "Unlock" })).toBeVisible();
  });

  test("Active state: status row + Sync now + devices visible", async ({
    page,
  }) => {
    await openHiFi(page);
    await setMirrorActive(page);
    await openCloudMirrorPane(page);

    const body = page.locator(".s-pane-body");
    // Status row labels
    await expect(body).toContainText("Last sync");
    await expect(body).toContainText("Queue depth");

    // Sync card
    await expect(
      body.getByRole("button", { name: "Sync now" }),
    ).toBeVisible();

    // Devices card — default mock list returns "This Mac" + "Stub iMac".
    await expect(body).toContainText("Devices");
    await expect(body).toContainText("This Mac");
    await expect(body).toContainText("Stub iMac");
  });

  test("Devices: typed-text DELETE confirm enables only on exact match", async ({
    page,
  }) => {
    await openHiFi(page);
    await setMirrorActive(page);
    await openCloudMirrorPane(page);

    // Wait for devices list to populate (mock returns 2 devices).
    const body = page.locator(".s-pane-body");
    await expect(body).toContainText("Stub iMac");

    // The "Stub iMac" row is the non-self device; only its row exposes Delete.
    await body
      .locator(".row")
      .filter({ hasText: "Stub iMac" })
      .getByRole("button", { name: "Delete" })
      .click();

    // ConfirmTypedText renders as a fixed-position overlay outside .s-pane-body.
    await expect(page.getByText(/Delete device:/)).toBeVisible();
    const confirmButton = page.getByRole("button", { name: "Delete device" });

    const typeInput = page.getByLabel("Type DELETE to confirm");

    // Empty → disabled.
    await expect(confirmButton).toBeDisabled();

    // Wrong text → still disabled.
    await typeInput.fill("WRONG");
    await expect(confirmButton).toBeDisabled();

    // Exact text → enabled.
    await typeInput.fill("DELETE");
    await expect(confirmButton).toBeEnabled();
  });

  test("Disable danger zone: typed-text DISABLE confirm enables only on exact match", async ({
    page,
  }) => {
    await openHiFi(page);
    await setMirrorActive(page);
    await openCloudMirrorPane(page);

    const body = page.locator(".s-pane-body");
    await expect(body).toContainText("Disable Cloud Mirror");

    // Danger-zone trigger is "Disable Mirror…" (with ellipsis).
    await body.getByRole("button", { name: "Disable Mirror…" }).click();

    // ConfirmTypedText overlay; its action button is "Disable Mirror" (no ellipsis).
    const confirmButton = page.getByRole("button", {
      name: "Disable Mirror",
      exact: true,
    });
    await expect(confirmButton).toBeVisible();
    const typeInput = page.getByLabel("Type DISABLE to confirm");

    // Empty → disabled.
    await expect(confirmButton).toBeDisabled();

    // Lowercase → disabled (case-sensitive).
    await typeInput.fill("disable");
    await expect(confirmButton).toBeDisabled();

    // Exact uppercase → enabled.
    await typeInput.fill("DISABLE");
    await expect(confirmButton).toBeEnabled();
  });
});

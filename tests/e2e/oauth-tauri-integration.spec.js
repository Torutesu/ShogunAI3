const { test, expect } = require("@playwright/test");

const HIFI_ENTRY = "/SHOGUN%20Hi-Fi%20UI.html";

async function openHiFi(page) {
  await page.goto(HIFI_ENTRY, { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector(".app", { timeout: 90000 });
}

async function openIntegrationsPane(page) {
  // The Settings modal opens via the user-pill menu → Settings → Integrations.
  await page.locator('.user-pill').click();
  await page.locator('.user-float').getByText('Settings', { exact: true }).click();
  await expect(page.locator('.s-modal')).toBeVisible();
  // Click the Integrations nav row inside the settings modal.
  await page.locator('.s-sidebar').getByText('Integrations', { exact: true }).click();
  await expect(page.locator('.s-pane-head')).toContainText('Integrations');
}

test.describe('OAuth Tauri integration (Settings → Integrations)', () => {
  test('Gmail Connect → mock IPC → success toast', async ({ page }) => {
    await openHiFi(page);
    await openIntegrationsPane(page);

    // The mock IPC returns ok: true synchronously.
    // Scope to the Gmail card to avoid matching Apple Calendar / other Connect buttons.
    await page.locator('.s-card').filter({ hasText: 'Gmail' }).getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('text=Connected to Gmail')).toBeVisible({ timeout: 5000 });
  });

  test('Google Calendar Connect → mock IPC → success toast', async ({ page }) => {
    await openHiFi(page);
    await openIntegrationsPane(page);

    // Find the Google Calendar Connect button scoped to the Google Calendar card;
    // the order of Gmail vs Calendar in the pane is stable in current settings-modal.jsx.
    await page.locator('.s-card').filter({ hasText: 'Google Calendar' }).getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('text=Connected to Google Calendar')).toBeVisible({ timeout: 5000 });
  });
});

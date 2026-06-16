// tests/e2e/consent-modal.spec.js
// E2E for the TOS/Privacy consent gate.
//
// Harness notes:
//   - Playwright serves the repo root via Python HTTP on port 4173.
//   - Entry point: /  (same as other specs).
//   - No Tauri IPC available → ShogunIpcClient auto-selects "mock" transport.
//   - The consent gate DOES fire in mock mode (ShogunIpcClient is present).
//   - Fresh settings state per test: localStorage is cleared via addInitScript
//     before each navigation so `shogun.hifi.mock.settings.sections.v1` is
//     empty, triggering the gate every time.
//   - `legal_docs_load` hits the mock default branch (returns a stub object).
//     renderMarkdown handles undefined gracefully, so docs become non-null and
//     the Accept button is enabled after the user checks "I agree".
//   - `app_quit` also hits the mock default (returns ok:true stub). The app
//     falls through to window.close(), which is a no-op in the test browser.
//     The decline test verifies the IPC call happened via a flag set from the
//     ShogunIpcClient.createIpcClient intercept installed with addInitScript.

const { test, expect } = require("@playwright/test");
const { pinLegalVersions, MOCK_SETTINGS_LS } = require("./_helpers/preseed-consent");

const HIFI_ENTRY = "/";

/** Navigate to the Hi-Fi app and wait for either the consent modal or the
 *  main app to appear (whichever the legalGate produces). */
async function openHiFi(page) {
  await page.goto(HIFI_ENTRY, { waitUntil: "load", timeout: 90000 });
  // Wait for React to render — either the consent gate or the main .app shell.
  await page.waitForFunction(
    () =>
      document.querySelector(".swm-modal--consent") !== null ||
      document.querySelector(".app") !== null ||
      document.querySelector('[style*="padding: 32px"]') !== null,
    null,
    { timeout: 30000 },
  );
}

test.describe("Consent modal", () => {
  test.beforeEach(async ({ page }) => {
    // addInitScript runs on every navigation (including reloads). Use
    // sessionStorage as a one-shot guard so we only wipe the mock settings
    // on the first page load — subsequent reloads keep whatever the test
    // wrote (e.g. the "relaunch after accept" test relies on the legal
    // section persisting across reload).
    await page.addInitScript((lsKey) => {
      try {
        if (!sessionStorage.getItem("__e2e_consent_init")) {
          sessionStorage.setItem("__e2e_consent_init", "1");
          localStorage.removeItem(lsKey);
        }
      } catch (_) {
        /* ignore */
      }
    }, MOCK_SETTINGS_LS);
  });

  test("first launch shows modal and hides main UI", async ({ page }) => {
    await openHiFi(page);
    await expect(page.locator(".swm-modal--consent")).toBeVisible();
    // Main app sidebar is not rendered while the gate is active.
    await expect(page.locator(".sidebar")).toHaveCount(0);
  });

  test("accept dismisses modal and persists to settings", async ({ page }) => {
    await openHiFi(page);
    await expect(page.locator(".swm-modal--consent")).toBeVisible();

    // The "I agree" checkbox is `disabled={docs == null || saving}`, so
    // .check() auto-waits for docs to load. Once agreed=true and docs are
    // non-null, the Accept button enables.
    await page.getByLabel(/I agree/i).check();
    await expect(
      page.getByRole("button", { name: /Accept & Continue/i }),
    ).not.toBeDisabled({ timeout: 10000 });
    await page.getByRole("button", { name: /Accept & Continue/i }).click();
    await expect(page.locator(".swm-modal--consent")).toHaveCount(0);

    // Verify the saved legal section via the mock IPC client.
    const legal = await page.evaluate(async () => {
      const client = window.ShogunIpcClient.createIpcClient();
      const res = await client.invoke("app_settings_load", {});
      return res.data.settings.sections.legal;
    });
    expect(legal.termsAcceptedVersion).toBe("2026-04-19");
    expect(legal.privacyAcceptedVersion).toBe("2026-04-19");
    expect(legal.telemetryOptIn).toBe(false);
    expect(typeof legal.acceptedAt).toBe("string");
  });

  test("relaunch after accept skips the modal", async ({ page }) => {
    await openHiFi(page);

    await page.getByLabel(/I agree/i).check();
    await expect(
      page.getByRole("button", { name: /Accept & Continue/i }),
    ).not.toBeDisabled({ timeout: 10000 });
    await page.getByRole("button", { name: /Accept & Continue/i }).click();
    await expect(page.locator(".swm-modal--consent")).toHaveCount(0);

    // Reload — settings now have accepted versions, gate should stay closed.
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(
      () =>
        document.querySelector(".app") !== null ||
        document.querySelector(".swm-modal--consent") !== null ||
        document.body.textContent.includes("Connect Claude Desktop"),
      null,
      { timeout: 30000 },
    );
    await expect(page.locator(".swm-modal--consent")).toHaveCount(0);
  });

  test("version bump re-prompts", async ({ page }) => {
    await openHiFi(page);

    // Accept with current versions.
    await page.getByLabel(/I agree/i).check();
    await expect(
      page.getByRole("button", { name: /Accept & Continue/i }),
    ).not.toBeDisabled({ timeout: 10000 });
    await page.getByRole("button", { name: /Accept & Continue/i }).click();
    await expect(page.locator(".swm-modal--consent")).toHaveCount(0);

    // Pin the bundle's legal versions to a future date so the seeded
    // settings (recorded with today's bundled version) no longer match.
    // The helper uses an accessor with a no-op setter, which works in
    // both strict and sloppy mode regardless of how legal-versions.js
    // is loaded in the future.
    await pinLegalVersions(page, "2099-01-01", "2099-01-01");
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(
      () =>
        document.querySelector(".swm-modal--consent") !== null ||
        document.querySelector(".app") !== null,
      null,
      { timeout: 30000 },
    );
    await expect(page.locator(".swm-modal--consent")).toBeVisible();
  });

  test("decline shows goodbye and calls app_quit", async ({ page }) => {
    let quitCalled = false;

    // Expose a function the page can call to signal quit was triggered.
    await page.exposeFunction("__test_quit_called", () => {
      quitCalled = true;
    });

    // Hook ShogunIpcClient before page scripts run to intercept app_quit.
    // The hook runs after the library defines window.ShogunIpcClient, so we
    // use a MutationObserver / polling approach: override createIpcClient once
    // the namespace is defined. Because addInitScript runs before any page
    // script, we wrap in a setter trap on the window object.
    await page.addInitScript(() => {
      let _original = null;
      Object.defineProperty(window, "ShogunIpcClient", {
        configurable: true,
        get() {
          return _original;
        },
        set(val) {
          if (val && typeof val.createIpcClient === "function") {
            const origCreate = val.createIpcClient.bind(val);
            val.createIpcClient = function () {
              const client = origCreate.apply(this, arguments);
              const origInvoke = client.invoke.bind(client);
              client.invoke = async function (cmd, args) {
                if (cmd === "app_quit") {
                  try {
                    await window.__test_quit_called();
                  } catch (_) {
                    /* exposeFunction not yet ready in some environments */
                  }
                  return { ok: true, data: null };
                }
                return origInvoke(cmd, args);
              };
              // Marker so the test can confirm the trap actually wrapped
              // this client (and wasn't bypassed by a later defineProperty).
              client.__e2e_wrapped = true;
              return client;
            };
          }
          _original = val;
        },
      });
    });

    await openHiFi(page);
    await expect(page.locator(".swm-modal--consent")).toBeVisible();

    // Sanity check: the setter trap is bypassable if anything later does
    // `Object.defineProperty(window, "ShogunIpcClient", { value })`, since
    // the trap only fires for plain assignment. Verify a freshly created
    // client carries the wrapper marker so a future regression that
    // reinstalls the namespace via defineProperty fails loudly here rather
    // than silently missing the app_quit call below.
    const wrapped = await page.evaluate(
      () => !!window.ShogunIpcClient.createIpcClient().__e2e_wrapped,
    );
    expect(wrapped, "decline test relies on the createIpcClient wrapper").toBe(
      true,
    );

    await page.getByRole("button", { name: /Decline & Quit/i }).click();
    await expect(page.getByText("Goodbye.")).toBeVisible();

    // Wait for the 1 500 ms decline timer to fire (app.jsx waits 1 500 ms
    // after showing "Goodbye." before calling onDecline → app_quit).
    await page.waitForTimeout(2000);
    expect(quitCalled).toBe(true);
  });

  test("telemetry opt-in toggle persists", async ({ page }) => {
    await openHiFi(page);

    await page.getByLabel(/I agree/i).check();
    await page.getByLabel(/Send anonymous usage telemetry/i).check();
    await expect(
      page.getByRole("button", { name: /Accept & Continue/i }),
    ).not.toBeDisabled({ timeout: 10000 });
    await page.getByRole("button", { name: /Accept & Continue/i }).click();

    const legal = await page.evaluate(async () => {
      const client = window.ShogunIpcClient.createIpcClient();
      const res = await client.invoke("app_settings_load", {});
      return res.data.settings.sections.legal;
    });
    expect(legal.telemetryOptIn).toBe(true);
  });
});

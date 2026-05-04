// tests/e2e/consent-modal.spec.js
// E2E for the TOS/Privacy consent gate.
//
// Harness notes:
//   - Playwright serves the repo root via Python HTTP on port 4173.
//   - Entry point: /SHOGUN%20Hi-Fi%20UI.html  (same as other specs).
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

const HIFI_ENTRY = "/SHOGUN%20Hi-Fi%20UI.html";

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

/** Clear mock settings so the gate treats this as a fresh launch. */
function clearConsentState() {
  return {
    // addInitScript callback — runs before the page script, clearing the LS key.
    script: () => {
      Object.defineProperty(window, "_e2eClearConsent", { value: true });
      const origSetItem = Storage.prototype.setItem;
      // Clear the mock-settings key on first access so the gate always fires.
      try {
        localStorage.removeItem("shogun.hifi.mock.settings.sections.v1");
      } catch (_) {
        /* ignore in environments without localStorage */
      }
    },
  };
}

test.describe("Consent modal", () => {
  test.beforeEach(async ({ page }) => {
    // addInitScript runs on every navigation (including reloads). Use
    // sessionStorage as a one-shot guard so we only wipe the mock settings
    // on the first page load — subsequent reloads keep whatever the test
    // wrote (e.g. the "relaunch after accept" test relies on the legal
    // section persisting across reload).
    await page.addInitScript(() => {
      try {
        if (!sessionStorage.getItem("__e2e_consent_init")) {
          sessionStorage.setItem("__e2e_consent_init", "1");
          localStorage.removeItem("shogun.hifi.mock.settings.sections.v1");
        }
      } catch (_) {
        /* ignore */
      }
    });
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
        document.querySelector(".swm-modal--consent") !== null,
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

    // Bump legal version constants in the window before reload.
    await page.evaluate(() => {
      window.SHOGUN_LEGAL_VERSIONS = Object.freeze({
        TERMS_VERSION: "2099-01-01",
        PRIVACY_VERSION: "2099-01-01",
      });
    });

    await page.reload({ waitUntil: "load" });
    // After reload, window.SHOGUN_LEGAL_VERSIONS comes from the bundle (2026-04-19),
    // but settings already have that version accepted, so gate stays closed.
    // We need to override via addInitScript for the next navigation to persist.
    //
    // NOTE: page.evaluate() only affects the current page execution context;
    // after reload the bundle restores the original version constants.
    // To make the version-bump test work we must inject the override BEFORE
    // the page scripts run, which requires a fresh addInitScript + reload cycle.
    await page.addInitScript(() => {
      // Override legal versions so they no longer match what was accepted.
      // legal-versions.js runs after this and tries to reassign — make the
      // property non-writable so the reassignment silently fails (the file
      // isn't in strict mode, so it doesn't throw).
      Object.defineProperty(window, "SHOGUN_LEGAL_VERSIONS", {
        configurable: false,
        writable: false,
        value: Object.freeze({
          TERMS_VERSION: "2099-01-01",
          PRIVACY_VERSION: "2099-01-01",
        }),
      });
    });
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
              return client;
            };
          }
          _original = val;
        },
      });
    });

    await openHiFi(page);
    await expect(page.locator(".swm-modal--consent")).toBeVisible();

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

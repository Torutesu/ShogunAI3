// Playwright helpers for EntitlementGate / billing mocks in browser E2E.
//
// Uses the `window.__shogunMockOverrides` seam (see src/shared/ipc/mock/handler.ts)
// plus optional fetch interception for `/api/entitlement`.

const MOCK_SETTINGS_LS = "shogun.hifi.mock.settings.sections.v1";
const MOCK_WEB_APP_URL = "http://127.0.0.1:3199";

/** Override mock IPC `billing_config` before navigation. */
async function installBillingConfig(page, { enabled = true, webAppUrl = MOCK_WEB_APP_URL } = {}) {
  await page.addInitScript(
    ({ enabled, webAppUrl }) => {
      window.__shogunMockOverrides = window.__shogunMockOverrides || {};
      window.__shogunMockOverrides.billing_config = () => ({
        enabled,
        webAppUrl,
      });
    },
    { enabled, webAppUrl },
  );
}

/** Stub Clerk session for EntitlementGate (browser mock has no Tauri invoke). */
async function installClerkSession(page, { signedIn = true, token = "mock-session-token" } = {}) {
  await page.addInitScript(({ signedIn, token }) => {
    if (signedIn) {
      window.Clerk = {
        session: {
          getToken: async () => token,
        },
      };
    } else {
      try {
        delete window.Clerk;
      } catch (_) {
        window.Clerk = undefined;
      }
    }
  }, { signedIn, token });
}

/** Seed billing cache into mock settings localStorage (offline grace tests). */
async function seedBillingCache(page, cache) {
  await page.addInitScript(
    ({ lsKey, cache }) => {
      try {
        const raw = localStorage.getItem(lsKey);
        const sections = raw ? JSON.parse(raw) : {};
        sections.billing = cache;
        localStorage.setItem(lsKey, JSON.stringify(sections));
      } catch (_) {
        /* ignore */
      }
    },
    { lsKey: MOCK_SETTINGS_LS, cache },
  );
}

/** Intercept entitlement API for the mock web app URL. */
async function routeEntitlement(page, body, { status = 200 } = {}) {
  await page.route("**/api/entitlement", async (route) => {
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

module.exports = {
  MOCK_SETTINGS_LS,
  MOCK_WEB_APP_URL,
  installBillingConfig,
  installClerkSession,
  seedBillingCache,
  routeEntitlement,
};

// @ts-check
const path = require("path");
const { defineConfig, devices } = require("@playwright/test");

const ROOT = __dirname;
const PORT = process.env.SHOGUN_E2E_PORT || "4173";
const BASE_URL = `http://127.0.0.1:${PORT}`;

module.exports = defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  timeout: 120000,
  webServer: {
    // Vite preview serves the built web-dist/ on the configured port.
    // We run `vite build` first so preview has artifacts to serve.
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
    cwd: path.join(ROOT),
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 240000,
    // A production build ships demo data OFF (real users start empty), but the
    // UI specs below need a roster/history to drive. Opt the e2e build in.
    // That production builds are empty is covered by constants.demo-gate.test.ts.
    env: { ...process.env, VITE_SHOGUN_DEMO: "1" },
  },
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    actionTimeout: 15000,
    navigationTimeout: 90000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

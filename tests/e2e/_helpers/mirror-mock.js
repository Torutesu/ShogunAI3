// Test helper for overriding mirror.* mock IPC responses in Playwright specs.
//
// Pairs with the `window.__shogunMockOverrides` seam added to
// `hifi/lib/ipc-client.js::mockTransport` and `hifi/app.jsx::mockIpcInvoke`
// (Phase 2.1.4 T6). Override convention is the app.jsx envelope shape
// `{ ok, data }`. The ipc-client.js path unwraps to inner data because
// its mockTransport returns raw values (the surrounding `invoke()` rewraps).

/** Inject a single-command override map entry. */
async function setMirrorMockOverride(page, command, response) {
  await page.evaluate(
    ({ command, response }) => {
      window.__shogunMockOverrides = window.__shogunMockOverrides || {};
      // Functions can't survive the structured-clone bridge, so we send a
      // plain value and wrap it in a function on the browser side.
      window.__shogunMockOverrides[command] = () => response;
    },
    { command, response },
  );
}

/** Drop all overrides (e.g. between tests). */
async function clearMirrorMockOverrides(page) {
  await page.evaluate(() => {
    window.__shogunMockOverrides = {};
  });
}

/** Force the pane into the Active state with sensible defaults. */
async function setMirrorActive(page, overrides = {}) {
  await setMirrorMockOverride(page, "mirror_status", {
    ok: true,
    data: {
      enabled: true,
      locked: false,
      queue_depth: 0,
      last_sync_at: "2026-05-06T12:00:00Z",
      last_error: null,
      device_id: "stub_device_self",
      stub: true,
      ...overrides,
    },
  });
}

/** Force the pane into the Locked state. */
async function setMirrorLocked(page) {
  await setMirrorMockOverride(page, "mirror_status", {
    ok: true,
    data: {
      enabled: true,
      locked: true,
      queue_depth: 0,
      last_sync_at: null,
      last_error: null,
      device_id: "override_device",
      stub: true,
    },
  });
}

module.exports = {
  setMirrorMockOverride,
  clearMirrorMockOverrides,
  setMirrorActive,
  setMirrorLocked,
};

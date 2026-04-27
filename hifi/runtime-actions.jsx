// hifi/runtime-actions.jsx
// Shared runtime action helpers for non-module hi-fi screens.
function runRuntimeActionB(key, payload, options) {
  if (!window.SHOGUN_RUNTIME || !window.SHOGUN_RUNTIME.executeAction) {
    return Promise.resolve({ ok: false });
  }
  return window.SHOGUN_RUNTIME.executeAction(key, payload || {}, options || {});
}

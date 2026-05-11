// Canonical version strings the consent flow compares against.
// When you revise a legal document, bump the matching constant here
// and the corresponding `Last updated:` line in the document.
//
// NOTE: this file uses a plain assignment (not `Object.defineProperty`)
// so e2e specs can install accessor traps via `addInitScript` on
// `window.SHOGUN_LEGAL_VERSIONS` to observe or override the bundled
// values (see `tests/e2e/_helpers/preseed-consent.js`). Keep the form
// as-is; switching to defineProperty / strict mode / a module would
// break those tests.

export const SHOGUN_LEGAL_VERSIONS = Object.freeze({
  TERMS_VERSION: '2026-04-19',
  PRIVACY_VERSION: '2026-04-19',
});

// INTENTIONALLY KEPT: Phase 3 Step 2 — unlike other lib/ipc modules whose window bindings
// were removed, this one must remain. The e2e helper (tests/e2e/_helpers/preseed-consent.js)
// installs Object.defineProperty accessor traps on `window.SHOGUN_LEGAL_VERSIONS` via
// Playwright's addInitScript to intercept this assignment and override/observe the version
// strings. Internal readers (AppCore.tsx) use the ESM export directly. Only the binding
// (write side) is needed for the e2e accessor trap to work.
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).SHOGUN_LEGAL_VERSIONS = SHOGUN_LEGAL_VERSIONS;
}

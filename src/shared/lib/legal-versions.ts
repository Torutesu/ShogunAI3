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

// INTENTIONALLY KEPT (Phase 3 Step 2 / Phase 4 Step 4 review): unlike all
// other shared/lib and shared/ipc modules, whose window bindings were
// removed in Phase 3 Step 2, this binding must stay. It is load-bearing
// for e2e tests:
//
//   tests/e2e/_helpers/preseed-consent.js#pinLegalVersions installs an
//   Object.defineProperty getter on window.SHOGUN_LEGAL_VERSIONS via
//   page.addInitScript(). The "version bump re-prompts" test in
//   consent-modal.spec.js uses that getter to make AppCore see fake
//   future version strings, simulating a legal-document version bump,
//   verifying that the consent gate re-prompts after such a bump.
//
//   AppCore.tsx therefore reads `(window as any).SHOGUN_LEGAL_VERSIONS`
//   rather than this ESM export, so the e2e getter can intercept the
//   read. Switching AppCore to the ESM import bypasses the interception
//   and breaks the test (verified in Phase 4 Step 4).
//
// Do NOT remove this assignment and do NOT switch AppCore.tsx to the
// ESM `SHOGUN_LEGAL_VERSIONS` import unless a replacement test strategy
// for "version bump re-prompts" is in place first.
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).SHOGUN_LEGAL_VERSIONS = SHOGUN_LEGAL_VERSIONS;
}

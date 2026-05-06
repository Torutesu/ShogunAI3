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
window.SHOGUN_LEGAL_VERSIONS = Object.freeze({
  TERMS_VERSION: '2026-04-19',
  PRIVACY_VERSION: '2026-04-19',
});

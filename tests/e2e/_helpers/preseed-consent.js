// Shared Playwright helpers for the consent gate.
//
// `legal-versions.js` defines `window.SHOGUN_LEGAL_VERSIONS` via a plain
// assignment. By installing an accessor on `window.SHOGUN_LEGAL_VERSIONS`
// before page scripts run we can intercept the assignment, see the bundled
// versions, and seed the mock settings to match. That keeps tests in sync
// with the bundle without hard-coding version strings.
const MOCK_SETTINGS_LS = "shogun.hifi.mock.settings.sections.v1";

/**
 * Pre-accept consent so the gate stays closed. Use in non-consent specs.
 * Also seeds `onboarding.mcpComplete` unless `skipMcpComplete: true` (for
 * MCP wizard specs).
 */
async function preacceptConsent(page, options = {}) {
  const skipMcpComplete = options.skipMcpComplete === true;
  await page.addInitScript(
    ({ lsKey, skipMcpComplete }) => {
      let _v;
      Object.defineProperty(window, "SHOGUN_LEGAL_VERSIONS", {
        configurable: true,
        get() {
          return _v;
        },
        set(value) {
          _v = value;
          try {
            let sections = {};
            try {
              const raw = localStorage.getItem(lsKey);
              if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === "object") sections = parsed;
              }
            } catch (_) {
              /* ignore */
            }
            sections.legal = {
              termsAcceptedVersion: value && value.TERMS_VERSION,
              privacyAcceptedVersion: value && value.PRIVACY_VERSION,
              telemetryOptIn: false,
              acceptedAt: "2026-01-01T00:00:00.000Z",
            };
            if (!skipMcpComplete) {
              const prev =
                sections.onboarding && typeof sections.onboarding === "object"
                  ? sections.onboarding
                  : {};
              sections.onboarding = { ...prev, mcpComplete: true };
            }
            localStorage.setItem(lsKey, JSON.stringify(sections));
          } catch (_) {
            /* ignore */
          }
        },
      });
    },
    { lsKey: MOCK_SETTINGS_LS, skipMcpComplete },
  );
}

/** Force the bundle's legal versions to a value the seeded settings won't
 *  match — used by the "version bump re-prompts" test. Works in both strict
 *  and sloppy mode because we install an explicit no-op setter. */
async function pinLegalVersions(page, terms, privacy) {
  await page.addInitScript(
    ({ terms, privacy }) => {
      const frozen = Object.freeze({
        TERMS_VERSION: terms,
        PRIVACY_VERSION: privacy,
      });
      Object.defineProperty(window, "SHOGUN_LEGAL_VERSIONS", {
        configurable: true,
        get() {
          return frozen;
        },
        set() {
          /* no-op: legal-versions.js's reassignment is dropped */
        },
      });
    },
    { terms, privacy },
  );
}

module.exports = { preacceptConsent, pinLegalVersions, MOCK_SETTINGS_LS };

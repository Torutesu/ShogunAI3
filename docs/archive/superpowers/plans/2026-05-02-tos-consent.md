# TOS / Privacy Consent Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-launch and version-change consent modal that requires acceptance of the bundled Terms of Service and Privacy Policy before the SHOGUN AI main UI is accessible. Decline quits the app. Acceptance is persisted in `settings.json` keyed by document version. Implements the design at `docs/superpowers/specs/2026-05-02-tos-consent-design.md`.

**Architecture:** A Rust-side Tauri command serves the bundled markdown to the UI. Two small JS libraries (`legal-versions.js`, `markdown-mini.js`) and one new React component (`ConsentModal`) handle versioning, rendering, and the modal UX. The consent gate is a 5-line state machine inside `App` that defers main-UI rendering until `app_settings_load` confirms current versions are accepted.

**Tech Stack:** Rust (Tauri v2 commands, `serde_json`, `std::fs`, `tempfile` for tests), vanilla React 18 via `<script type="text/babel">`, Node.js (smoke test for markdown converter), Playwright (E2E).

---

## File Structure

This plan creates 5 files and modifies 5:

**Create**

- `src-tauri/src/legal_docs.rs` — Tauri command and pure helper for loading the bundled legal markdown by language. Owns disk I/O and language→file mapping.
- `hifi/lib/legal-versions.js` — `window.SHOGUN_LEGAL_VERSIONS = { TERMS_VERSION, PRIVACY_VERSION }`. Single responsibility: hold the canonical version strings.
- `hifi/lib/markdown-mini.js` — `window.shogunMarkdownMini(text) → htmlString`. Limited markdown subset (headings/bold/lists/links). HTML-escapes input first.
- `hifi/components/consent-modal.jsx` — `window.ConsentModal` React component. Owns local UI state for the modal; receives `onAccept(payload)` and `onDecline()` callbacks from its parent.
- `scripts/check-markdown-mini.mjs` — Node-based smoke test for `markdown-mini.js`. Runs in CI eventually; this PR just adds it.
- `tests/e2e/consent-modal.spec.js` — Playwright spec covering the 6 scenarios from the design.

**Modify**

- `src-tauri/src/lib.rs` — register the two new commands (`legal_docs::legal_docs_load`, `commands::app_quit`) and add `mod legal_docs;`.
- `src-tauri/src/commands.rs` — add `app_quit` command (`app_handle.exit(0)`).
- `src-tauri/tauri.conf.json` — add `bundle.resources` entries for the four legal markdown files so they are packaged with the app.
- `SHOGUN Hi-Fi UI.html` — add three `<script>` tags (legal-versions, markdown-mini, consent-modal) before the existing `app.jsx` script.
- `hifi/app.jsx` — wrap the existing `App` body in a 4-state gate (`loading | error | consent_needed | ok`) using a single `useEffect` to load settings + locale.

---

## Task 1: Rust legal_docs module with tests

**Files:**
- Create: `src-tauri/src/legal_docs.rs`

This module owns the language→file mapping and the Tauri command. The Tauri-decorated command is a thin wrapper over a pure helper `load_from_dir(dir, lang)` that takes the resource directory as a parameter so unit tests can inject a `tempfile::TempDir`.

- [ ] **Step 1: Add `tempfile` as a dev-dependency**

Edit `src-tauri/Cargo.toml`. In the `[dev-dependencies]` section (create the section if it does not exist immediately above `[build-dependencies]` or at the end of the file), add:

```toml
tempfile = "3"
```

Run:
```bash
cd ~/code/ShogunAI3/src-tauri && cargo check 2>&1 | tail -5
```

Expected: build succeeds; `tempfile` is downloaded.

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/legal_docs.rs` with this content:

```rust
//! Load the bundled Terms of Service and Privacy Policy markdown documents.
//!
//! The Tauri command `legal_docs_load(lang)` is a thin wrapper around
//! `load_from_dir`, which is independent of the runtime so it can be
//! exercised in unit tests against a `tempfile::TempDir`.

use serde_json::{json, Value};
use std::path::Path;

#[derive(Debug)]
struct DocPaths<'a> {
    terms: std::path::PathBuf,
    privacy: std::path::PathBuf,
    _marker: std::marker::PhantomData<&'a ()>,
}

fn doc_paths(dir: &Path, lang: &str) -> DocPaths<'static> {
    if lang == "ja" {
        DocPaths {
            terms: dir.join("docs/TERMS_OF_SERVICE.md"),
            privacy: dir.join("docs/PRIVACY.ja.md"),
            _marker: std::marker::PhantomData,
        }
    } else {
        DocPaths {
            terms: dir.join("docs/TERMS_OF_SERVICE_EN.md"),
            privacy: dir.join("PRIVACY.md"),
            _marker: std::marker::PhantomData,
        }
    }
}

pub fn load_from_dir(dir: &Path, lang: &str) -> Result<Value, String> {
    let paths = doc_paths(dir, lang);
    let terms = std::fs::read_to_string(&paths.terms)
        .map_err(|e| format!("terms ({}): {}", paths.terms.display(), e))?;
    let privacy = std::fs::read_to_string(&paths.privacy)
        .map_err(|e| format!("privacy ({}): {}", paths.privacy.display(), e))?;
    Ok(json!({ "terms": terms, "privacy": privacy }))
}

#[tauri::command]
pub fn legal_docs_load(app: tauri::AppHandle, lang: String) -> Result<Value, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource_dir: {}", e))?;
    load_from_dir(&dir, &lang)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(dir.path().join("docs")).unwrap();
        fs::write(dir.path().join("docs/TERMS_OF_SERVICE.md"), "# 利用規約\n").unwrap();
        fs::write(dir.path().join("docs/TERMS_OF_SERVICE_EN.md"), "# Terms of Service\n").unwrap();
        fs::write(dir.path().join("docs/PRIVACY.ja.md"), "# プライバシー\n").unwrap();
        fs::write(dir.path().join("PRIVACY.md"), "# Privacy\n").unwrap();
        dir
    }

    #[test]
    fn loads_english_docs_returns_both_files() {
        let dir = fixture_dir();
        let v = load_from_dir(dir.path(), "en").expect("ok");
        assert_eq!(v["terms"], "# Terms of Service\n");
        assert_eq!(v["privacy"], "# Privacy\n");
    }

    #[test]
    fn loads_japanese_docs_returns_both_files() {
        let dir = fixture_dir();
        let v = load_from_dir(dir.path(), "ja").expect("ok");
        assert_eq!(v["terms"], "# 利用規約\n");
        assert_eq!(v["privacy"], "# プライバシー\n");
    }

    #[test]
    fn unknown_language_falls_back_to_english() {
        let dir = fixture_dir();
        let v = load_from_dir(dir.path(), "xx").expect("ok");
        assert_eq!(v["terms"], "# Terms of Service\n");
        assert_eq!(v["privacy"], "# Privacy\n");
    }

    #[test]
    fn missing_resource_returns_err() {
        let dir = tempfile::tempdir().unwrap();
        let err = load_from_dir(dir.path(), "en").unwrap_err();
        assert!(err.contains("terms"), "expected error to mention 'terms', got: {}", err);
    }
}
```

The `_marker: PhantomData` field on `DocPaths` is to silence a possible "lifetime parameter never used" warning in the variant where `'a` could be elided. If the implementer finds the lifetime is genuinely unused, they may remove the field and the lifetime parameter both — that's a free choice.

- [ ] **Step 3: Run tests to verify they fail**

Run:
```bash
cd ~/code/ShogunAI3 && cargo test --manifest-path src-tauri/Cargo.toml --locked legal_docs 2>&1 | tail -10
```

Expected: compile error — `mod legal_docs` is not yet referenced from `lib.rs`. **Stop and proceed to Step 4** (this is the expected failure).

- [ ] **Step 4: Register the module in lib.rs**

Edit `src-tauri/src/lib.rs`. Find the existing `mod` declarations near the top of the file (look for lines like `mod commands;`, `mod kioku_rules;`, etc.). Add:

```rust
mod legal_docs;
```

Place it in alphabetical order among the existing `mod` declarations. **Do NOT** register the command in `invoke_handler` yet — that is Task 2's responsibility.

- [ ] **Step 5: Run tests to verify they pass**

Run:
```bash
cd ~/code/ShogunAI3 && cargo test --manifest-path src-tauri/Cargo.toml --locked legal_docs 2>&1 | tail -10
```

Expected: 4 tests pass.

- [ ] **Step 6: Commit**

Run:
```bash
cd ~/code/ShogunAI3 && git add src-tauri/src/legal_docs.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock && git commit -m "$(cat <<'EOF'
feat(tos-consent): add legal_docs Rust module

New Rust module that loads the bundled Terms of Service and
Privacy Policy markdown by language. Pure `load_from_dir` helper
isolated from the Tauri runtime so it can be unit-tested against
a tempfile fixture; the Tauri-decorated `legal_docs_load` is a
thin wrapper that resolves the resource dir and delegates.

Tests cover en, ja, unknown-language fallback, and missing-file
error paths. Adds tempfile as a dev-dependency.

Module registered in lib.rs but not yet wired into invoke_handler;
that follows in the next commit alongside app_quit.
EOF
)"
```

---

## Task 2: app_quit command + register both new commands

**Files:**
- Modify: `src-tauri/src/commands.rs` (add `app_quit`)
- Modify: `src-tauri/src/lib.rs` (register both `legal_docs_load` and `app_quit` in `invoke_handler`)

- [ ] **Step 1: Add `app_quit` to commands.rs**

Open `src-tauri/src/commands.rs` and find a good location near the other `app_*` commands (e.g., near `app_updates_check` around line 1401). Add:

```rust
#[tauri::command]
pub fn app_quit(app: tauri::AppHandle) -> Result<(), String> {
  app.exit(0);
  Ok(())
}
```

If `tauri::AppHandle` is not already in scope from `use` statements at the top of the file, the existing `use tauri::{AppHandle, Emitter};` at the top should cover it; reference `AppHandle` directly without the `tauri::` prefix to match existing style. So the actual code to insert is:

```rust
#[tauri::command]
pub fn app_quit(app: AppHandle) -> Result<(), String> {
  app.exit(0);
  Ok(())
}
```

- [ ] **Step 2: Register both commands in `invoke_handler`**

Open `src-tauri/src/lib.rs`. Find the `tauri::generate_handler!` macro call. Inside the list (which is alphabetized into rough functional groups), add these two lines, placed near the other `commands::app_*` entries (right after `commands::app_updates_download_install` around line 218):

```rust
      commands::app_quit,
      legal_docs::legal_docs_load,
```

`legal_docs::legal_docs_load` should go at the end of the handler list (or in any consistent location) — the macro doesn't care about ordering, but keep it grouped with the other top-level module commands (not under `commands::`).

- [ ] **Step 3: Verify the build**

Run:
```bash
cd ~/code/ShogunAI3 && cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5
```

Expected: compiles cleanly. If you see "function or associated item not found: `exit`", verify `app.exit(0)` is being called on a value that implements `tauri::Manager` — `AppHandle` does in Tauri v2.

- [ ] **Step 4: Run all Rust tests to confirm no regressions**

Run:
```bash
cd ~/code/ShogunAI3 && cargo test --manifest-path src-tauri/Cargo.toml --locked 2>&1 | tail -15
```

Expected: all tests pass, including the four `legal_docs::tests::*` from Task 1.

- [ ] **Step 5: Commit**

Run:
```bash
cd ~/code/ShogunAI3 && git add src-tauri/src/commands.rs src-tauri/src/lib.rs && git commit -m "$(cat <<'EOF'
feat(tos-consent): wire app_quit and legal_docs_load commands

Adds the `app_quit` Tauri command (used by the consent modal's
Decline button) and registers both `app_quit` and the previously
added `legal_docs_load` in the invoke_handler so the frontend can
call them.
EOF
)"
```

---

## Task 3: Bundle the legal markdown files as Tauri resources

**Files:**
- Modify: `src-tauri/tauri.conf.json` (add `bundle.resources`)

In a `tauri build` packaged app, the markdown files live outside the binary — they must be declared as bundle resources to be copied alongside the app and reachable via `app.path().resource_dir()`. In `tauri dev`, the resource dir maps to the project root, so no resource declaration is needed for development; this step exists for the packaged build.

- [ ] **Step 1: Add the resources array to `bundle`**

Open `src-tauri/tauri.conf.json`. Find the `"bundle"` object (currently around line 33). It contains `"active"`, `"targets"`, `"macOS"`, `"icon"`. Add a `"resources"` key. The full `"bundle"` object after the change should look like:

```json
"bundle": {
  "active": true,
  "targets": "all",
  "resources": [
    "../docs/TERMS_OF_SERVICE.md",
    "../docs/TERMS_OF_SERVICE_EN.md",
    "../docs/PRIVACY.ja.md",
    "../PRIVACY.md"
  ],
  "macOS": {
    "hardenedRuntime": true,
    "entitlements": "Entitlements.plist",
    "infoPlist": "Info.plist"
  },
  "icon": [
    "icons/32x32.png",
    "icons/128x128.png",
    "icons/128x128@2x.png",
    "icons/icon.icns",
    "icons/icon.ico"
  ]
}
```

The `..` prefix is required because Tauri resolves resource paths relative to `src-tauri/`. The packaged resources will land under `<app>/Contents/Resources/_up_/docs/...` and `<app>/Contents/Resources/_up_/PRIVACY.md` on macOS. The `legal_docs::load_from_dir` helper uses `dir.join("docs/TERMS_OF_SERVICE.md")` and friends, which works because Tauri's `resource_dir()` returns the directory containing the bundled tree, and `_up_` is part of that tree mirroring the original `..` traversal.

If the implementer finds `resource_dir()` returns a path where the `_up_` segment is necessary in the join, adjust `load_from_dir` to prepend `_up_` only when files don't exist at the simple path. Verify by running `tauri dev` (Step 3 below) and inspecting that the en path resolves; in dev mode the resource dir is the project root so the simple `docs/TERMS_OF_SERVICE_EN.md` join works.

- [ ] **Step 2: Verify the JSON parses and the schema accepts the new key**

Run:
```bash
cd ~/code/ShogunAI3 && python3 -c "import json; json.load(open('src-tauri/tauri.conf.json'))" && echo "JSON OK"
```

Expected: `JSON OK` printed.

- [ ] **Step 3: Verify Tauri accepts the configuration**

Run:
```bash
cd ~/code/ShogunAI3 && cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5
```

Expected: compiles cleanly. `cargo check` will re-run the `build.rs` which validates `tauri.conf.json` against the schema.

- [ ] **Step 4: Commit**

Run:
```bash
cd ~/code/ShogunAI3 && git add src-tauri/tauri.conf.json && git commit -m "$(cat <<'EOF'
build(tos-consent): bundle legal markdown as Tauri resources

Adds the four Terms-of-Service and Privacy markdown files to
bundle.resources so packaged builds can serve them via
legal_docs_load(). Dev-mode runs already work because Tauri's
resource_dir resolves to the project root.
EOF
)"
```

---

## Task 4: legal-versions.js

**Files:**
- Create: `hifi/lib/legal-versions.js`

- [ ] **Step 1: Create the file**

Create `hifi/lib/legal-versions.js` with this exact content:

```js
// Canonical version strings the consent flow compares against.
// When you revise a legal document, bump the matching constant here
// and the corresponding `Last updated:` line in the document.
window.SHOGUN_LEGAL_VERSIONS = Object.freeze({
  TERMS_VERSION: '2026-04-19',
  PRIVACY_VERSION: '2026-04-19',
});
```

`Object.freeze` is defensive — the object is global and could be mutated by stray code. Freezing makes a regression noisy.

- [ ] **Step 2: Verify the file is valid JS**

Run:
```bash
cd ~/code/ShogunAI3 && node --check hifi/lib/legal-versions.js && echo "JS OK"
```

Expected: `JS OK`.

- [ ] **Step 3: Commit**

Run:
```bash
cd ~/code/ShogunAI3 && git add hifi/lib/legal-versions.js && git commit -m "$(cat <<'EOF'
feat(tos-consent): add legal-versions.js constants

Single source of truth for TERMS_VERSION and PRIVACY_VERSION used
by the consent gate to detect when a re-prompt is needed. Frozen
to surface accidental mutation.
EOF
)"
```

---

## Task 5: markdown-mini.js + Node smoke test

**Files:**
- Create: `hifi/lib/markdown-mini.js`
- Create: `scripts/check-markdown-mini.mjs`

The codebase has no JS unit-test runner; the smoke test follows the existing `scripts/*.mjs` convention.

- [ ] **Step 1: Write the smoke test first**

Create `scripts/check-markdown-mini.mjs`:

```js
#!/usr/bin/env node
// Smoke test for hifi/lib/markdown-mini.js.
// Loads the file in a synthetic browser-like context and asserts a few
// representative inputs render to the expected HTML.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  path.join(__dirname, "..", "hifi", "lib", "markdown-mini.js"),
  "utf8",
);
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(src, ctx);

const md = ctx.window.shogunMarkdownMini;
if (typeof md !== "function") {
  console.error("FAIL: window.shogunMarkdownMini is not a function");
  process.exit(1);
}

const cases = [
  ["# Hello", "<h2>Hello</h2>"],
  ["## Sub", "<h3>Sub</h3>"],
  ["**bold** text", "<p><strong>bold</strong> text</p>"],
  ["- one\n- two", "<ul><li>one</li><li>two</li></ul>"],
  [
    "see [docs](https://example.com)",
    '<p>see <a href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a></p>',
  ],
  ["<script>alert(1)</script>", "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>"],
  ["plain paragraph", "<p>plain paragraph</p>"],
];

let failed = 0;
for (const [input, expected] of cases) {
  const actual = md(input);
  if (actual !== expected) {
    failed++;
    console.error(`FAIL: ${JSON.stringify(input)}`);
    console.error(`  expected: ${JSON.stringify(expected)}`);
    console.error(`  actual:   ${JSON.stringify(actual)}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length} cases failed`);
  process.exit(1);
}

console.log(`OK: ${cases.length} cases passed`);
```

Make it executable:
```bash
cd ~/code/ShogunAI3 && chmod +x scripts/check-markdown-mini.mjs
```

- [ ] **Step 2: Run the smoke test to verify it fails**

Run:
```bash
cd ~/code/ShogunAI3 && node scripts/check-markdown-mini.mjs 2>&1 | tail -5
```

Expected: error reading `hifi/lib/markdown-mini.js` (file does not exist yet). This is the expected failure.

- [ ] **Step 3: Implement markdown-mini.js**

Create `hifi/lib/markdown-mini.js`:

```js
// Tiny markdown converter for the bundled legal documents.
// Supports: # / ## headings, **bold**, - lists, [text](url) links.
// Anything else renders as text. Input is HTML-escaped first.
(function (global) {
  function escape(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function renderInline(line) {
    let out = line;
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );
    return out;
  }

  function shogunMarkdownMini(text) {
    const escaped = escape(String(text == null ? "" : text));
    const lines = escaped.split(/\r?\n/);
    const out = [];
    let para = [];
    let list = [];

    function flushPara() {
      if (para.length === 0) return;
      out.push("<p>" + renderInline(para.join(" ")) + "</p>");
      para = [];
    }
    function flushList() {
      if (list.length === 0) return;
      out.push(
        "<ul>" + list.map((s) => "<li>" + renderInline(s) + "</li>").join("") + "</ul>",
      );
      list = [];
    }

    for (const raw of lines) {
      const line = raw.trim();
      if (line === "") {
        flushPara();
        flushList();
        continue;
      }
      let m;
      if ((m = line.match(/^##\s+(.*)$/))) {
        flushPara();
        flushList();
        out.push("<h3>" + renderInline(m[1]) + "</h3>");
      } else if ((m = line.match(/^#\s+(.*)$/))) {
        flushPara();
        flushList();
        out.push("<h2>" + renderInline(m[1]) + "</h2>");
      } else if ((m = line.match(/^[-*]\s+(.*)$/))) {
        flushPara();
        list.push(m[1]);
      } else {
        flushList();
        para.push(line);
      }
    }
    flushPara();
    flushList();
    return out.join("");
  }

  global.shogunMarkdownMini = shogunMarkdownMini;
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Run the smoke test to verify it passes**

Run:
```bash
cd ~/code/ShogunAI3 && node scripts/check-markdown-mini.mjs
```

Expected: `OK: 7 cases passed`.

- [ ] **Step 5: Commit**

Run:
```bash
cd ~/code/ShogunAI3 && git add hifi/lib/markdown-mini.js scripts/check-markdown-mini.mjs && git commit -m "$(cat <<'EOF'
feat(tos-consent): add markdown-mini.js + smoke test

Tiny self-contained markdown→HTML converter that supports the
limited subset used by the bundled legal documents (headings,
bold, lists, links). HTML-escapes input first to prevent XSS via
markdown content. The Node-based smoke test in scripts/ follows
the existing scripts/*.mjs convention; not yet wired into CI.
EOF
)"
```

---

## Task 6: ConsentModal component

**Files:**
- Create: `hifi/components/consent-modal.jsx`

The component is a single React file following the `confirm-write-modal.jsx` pattern (vanilla React + global ReactDOM, IIFE attaching to `window`). No JS unit tests; coverage comes from the Playwright E2E in Task 8.

- [ ] **Step 1: Write the component**

Create `hifi/components/consent-modal.jsx`:

```jsx
/* global React, Icon */
(function initConsentModal(global) {
  const { useState, useEffect } = React;

  function ConsentModal(props) {
    const initialLang = props.initialLang === "ja" ? "ja" : "en";
    const termsVersion = String(props.termsVersion || "");
    const privacyVersion = String(props.privacyVersion || "");
    const onAccept = props.onAccept || function noop() {};
    const onDecline = props.onDecline || function noop() {};
    const loadDocs = props.loadDocs; // (lang) => Promise<{terms, privacy}>
    const renderMarkdown = props.renderMarkdown; // (text) => htmlString

    const [lang, setLang] = useState(initialLang);
    const [docs, setDocs] = useState(null);
    const [loadError, setLoadError] = useState(null);
    const [agreed, setAgreed] = useState(false);
    const [telemetryOptIn, setTelemetryOptIn] = useState(false);
    const [saveError, setSaveError] = useState(null);
    const [saving, setSaving] = useState(false);
    const [decliningUntil, setDecliningUntil] = useState(null);

    useEffect(() => {
      let cancelled = false;
      setDocs(null);
      setLoadError(null);
      Promise.resolve(loadDocs(lang))
        .then((d) => {
          if (cancelled) return;
          setDocs(d);
        })
        .catch((e) => {
          if (cancelled) return;
          setLoadError(String(e && e.message ? e.message : e));
        });
      return function () {
        cancelled = true;
      };
    }, [lang, loadDocs]);

    useEffect(() => {
      if (decliningUntil == null) return;
      const ms = Math.max(0, decliningUntil - Date.now());
      const t = setTimeout(function () {
        onDecline();
      }, ms);
      return function () {
        clearTimeout(t);
      };
    }, [decliningUntil, onDecline]);

    function handleAccept() {
      setSaving(true);
      setSaveError(null);
      Promise.resolve(
        onAccept({
          termsVersion: termsVersion,
          privacyVersion: privacyVersion,
          telemetryOptIn: telemetryOptIn,
        }),
      ).catch(function (e) {
        setSaving(false);
        setSaveError(String(e && e.message ? e.message : e));
      });
    }

    function handleDecline() {
      setDecliningUntil(Date.now() + 1500);
    }

    const declining = decliningUntil != null;

    return (
      <>
        <div className="swm-backdrop" role="presentation" />
        <div
          className="swm-modal swm-modal--consent"
          role="dialog"
          aria-modal="true"
          aria-labelledby="consent-modal-title"
          onMouseDown={function (e) {
            e.stopPropagation();
          }}
        >
          {declining ? (
            <div className="swm-body" style={{ textAlign: "center", padding: 32 }}>
              <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
                Goodbye.
              </div>
              <div style={{ fontSize: 13, color: "var(--text-dim)" }}>
                SHOGUN AI requires acceptance of the Terms to continue.
              </div>
            </div>
          ) : (
            <>
              <div className="swm-header">
                <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                  <div id="consent-modal-title" style={{ fontSize: 15, fontWeight: 600 }}>
                    Welcome to SHOGUN AI
                  </div>
                  <div className="row" style={{ gap: 4 }}>
                    <button
                      type="button"
                      className={"btn btn-sm " + (lang === "ja" ? "btn-primary" : "btn-ghost")}
                      onClick={function () {
                        setLang("ja");
                      }}
                      aria-pressed={lang === "ja"}
                    >
                      JP
                    </button>
                    <button
                      type="button"
                      className={"btn btn-sm " + (lang === "en" ? "btn-primary" : "btn-ghost")}
                      onClick={function () {
                        setLang("en");
                      }}
                      aria-pressed={lang === "en"}
                    >
                      EN
                    </button>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 6 }}>
                  Please review and accept the Terms of Service and Privacy Policy before continuing.
                </div>
              </div>
              <div
                className="swm-body swm-body--consent"
                style={{ maxHeight: 420, overflowY: "auto" }}
              >
                {loadError ? (
                  <div style={{ color: "var(--danger, #d33)" }}>
                    Failed to load legal documents: {loadError}. Please reinstall the application.
                  </div>
                ) : docs == null ? (
                  <div style={{ color: "var(--text-dim)" }}>Loading…</div>
                ) : (
                  <>
                    <div dangerouslySetInnerHTML={{ __html: renderMarkdown(docs.terms) }} />
                    <hr style={{ margin: "16px 0", border: 0, borderTop: "1px solid var(--border, #ccc)" }} />
                    <div dangerouslySetInnerHTML={{ __html: renderMarkdown(docs.privacy) }} />
                  </>
                )}
              </div>
              <div className="swm-footer" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
                {saveError ? (
                  <div
                    style={{
                      color: "var(--danger, #d33)",
                      background: "var(--danger-bg, rgba(220,80,80,0.1))",
                      padding: 8,
                      borderRadius: 4,
                      fontSize: 12,
                    }}
                  >
                    Could not save consent: {saveError}. Please try again.
                  </div>
                ) : null}
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={agreed}
                    disabled={docs == null || saving}
                    onChange={function (e) {
                      setAgreed(e.target.checked);
                    }}
                  />
                  I agree to the Terms of Service and Privacy Policy
                </label>
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={telemetryOptIn}
                    disabled={saving}
                    onChange={function (e) {
                      setTelemetryOptIn(e.target.checked);
                    }}
                  />
                  Send anonymous usage telemetry (optional)
                </label>
                <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={handleDecline}
                    disabled={saving}
                  >
                    Decline & Quit
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={handleAccept}
                    disabled={!agreed || saving || docs == null}
                  >
                    Accept & Continue
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </>
    );
  }

  global.ConsentModal = ConsentModal;
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 2: Verify the file parses (Babel will run it at runtime; this is a quick sanity check)**

Babel handles JSX at runtime in the browser, so `node --check` cannot validate the JSX. Instead just verify the file is non-empty and contains the global assignment:

Run:
```bash
cd ~/code/ShogunAI3 && grep -q "global.ConsentModal = ConsentModal" hifi/components/consent-modal.jsx && wc -l hifi/components/consent-modal.jsx
```

Expected: a line count is printed (around 165 lines), no error from grep.

- [ ] **Step 3: Commit**

Run:
```bash
cd ~/code/ShogunAI3 && git add hifi/components/consent-modal.jsx && git commit -m "$(cat <<'EOF'
feat(tos-consent): add ConsentModal component

React component that owns the consent UI: language toggle, full-text
inline display of TOS + Privacy with a scrollable region, agree
checkbox, optional telemetry opt-in, Accept and Decline buttons.
Decline triggers a 1500ms goodbye screen before calling onDecline.
The component is pure UI — fetching the docs and persisting the
acceptance happen via `loadDocs` and `onAccept` props injected by
the App-level wiring.
EOF
)"
```

---

## Task 7: Wire the consent gate into App

**Files:**
- Modify: `SHOGUN Hi-Fi UI.html` (add three `<script>` tags)
- Modify: `hifi/app.jsx` (wrap App body in 4-state gate)

- [ ] **Step 1: Update the HTML to load the new scripts**

Open `SHOGUN Hi-Fi UI.html`. Find the script that loads `confirm-write-modal.jsx` (around line 41). Insert three new script tags **before** the existing `app.jsx` script (which is the very last script in the body, around line 42):

```html
<script src="hifi/lib/legal-versions.js?v=b2"></script>
<script src="hifi/lib/markdown-mini.js?v=b2"></script>
<script type="text/babel" src="hifi/components/consent-modal.jsx?v=b2"></script>
```

Place these so the order in the body's script section becomes:
1. ... existing scripts ...
2. `hifi/components/confirm-write-modal.jsx` (already there)
3. `hifi/lib/legal-versions.js` ← new
4. `hifi/lib/markdown-mini.js` ← new
5. `hifi/components/consent-modal.jsx` ← new
6. `hifi/app.jsx` (already there, must remain last)

The cache-buster `?v=b2` matches the convention used elsewhere in this file.

- [ ] **Step 2: Wrap the App body in the consent gate**

Open `hifi/app.jsx`. Find the `function App()` declaration (around line 24 based on the earlier read).

Find the line after the existing `useState`/`useEffect` declarations, **before any `return` statement** in `App()`. The exact location depends on the current structure; the implementer should add the gate state and effect at the **top** of the function body, immediately after the React hook destructuring.

Add the following block at the **very top** of the `App` function body, before any other state declarations:

```jsx
  // ───────── Consent gate (TOS / Privacy) ─────────
  const [legalGate, setLegalGate] = useState({ status: "loading" });

  useEffect(function loadConsentState() {
    let cancelled = false;
    const versions = window.SHOGUN_LEGAL_VERSIONS || {};
    const expectedTerms = versions.TERMS_VERSION || "";
    const expectedPrivacy = versions.PRIVACY_VERSION || "";
    const lang = (navigator.language || "en").toLowerCase().startsWith("ja") ? "ja" : "en";

    const ipc = window.__TAURI__ && window.__TAURI__.core ? window.__TAURI__.core : null;
    if (!ipc) {
      // Browser preview without Tauri — bypass the gate so the wireframe page still loads.
      setLegalGate({ status: "ok" });
      return;
    }

    ipc
      .invoke("app_settings_load", {})
      .then(function (res) {
        if (cancelled) return;
        const sec = (res && res.settings && res.settings.sections && res.settings.sections.legal) || null;
        const ok =
          sec &&
          sec.termsAcceptedVersion === expectedTerms &&
          sec.privacyAcceptedVersion === expectedPrivacy;
        if (ok) {
          setLegalGate({ status: "ok" });
        } else {
          setLegalGate({ status: "consent_needed", lang: lang });
        }
      })
      .catch(function (e) {
        if (cancelled) return;
        setLegalGate({
          status: "error",
          message: String(e && e.message ? e.message : e),
        });
      });
    return function () {
      cancelled = true;
    };
  }, []);

  function handleConsentAccept(payload) {
    const ipc = window.__TAURI__ && window.__TAURI__.core ? window.__TAURI__.core : null;
    if (!ipc) return Promise.resolve();
    return ipc
      .invoke("app_settings_save", {
        section: "legal",
        termsAcceptedVersion: payload.termsVersion,
        privacyAcceptedVersion: payload.privacyVersion,
        telemetryOptIn: payload.telemetryOptIn,
        acceptedAt: new Date().toISOString(),
      })
      .then(function () {
        setLegalGate({ status: "ok" });
      });
  }

  function handleConsentDecline() {
    const ipc = window.__TAURI__ && window.__TAURI__.core ? window.__TAURI__.core : null;
    if (!ipc) return;
    ipc.invoke("app_quit").catch(function () {
      // If the quit IPC fails, fall back to closing the window.
      try {
        window.close();
      } catch (_) {}
    });
  }

  function loadConsentDocs(lang) {
    const ipc = window.__TAURI__ && window.__TAURI__.core ? window.__TAURI__.core : null;
    if (!ipc) {
      return Promise.resolve({ terms: "# Preview mode\nNo documents loaded.", privacy: "" });
    }
    return ipc.invoke("legal_docs_load", { lang: lang });
  }

  if (legalGate.status === "loading") {
    return (
      <div style={{ padding: 32, color: "var(--text-dim)", fontSize: 13 }}>Loading…</div>
    );
  }
  if (legalGate.status === "error") {
    return (
      <div style={{ padding: 32, fontSize: 13 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Failed to load settings</div>
        <div style={{ color: "var(--text-dim)" }}>
          {legalGate.message}. Please restart the app.
        </div>
        <div style={{ marginTop: 16 }}>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={function () {
              const ipc = window.__TAURI__ && window.__TAURI__.core ? window.__TAURI__.core : null;
              if (ipc) ipc.invoke("app_quit").catch(function () {});
            }}
          >
            Quit
          </button>
        </div>
      </div>
    );
  }
  if (legalGate.status === "consent_needed") {
    const versions = window.SHOGUN_LEGAL_VERSIONS || {};
    return (
      <ConsentModal
        initialLang={legalGate.lang}
        termsVersion={versions.TERMS_VERSION || ""}
        privacyVersion={versions.PRIVACY_VERSION || ""}
        onAccept={handleConsentAccept}
        onDecline={handleConsentDecline}
        loadDocs={loadConsentDocs}
        renderMarkdown={window.shogunMarkdownMini}
      />
    );
  }
  // ───────── End consent gate; main app continues below. ─────────
```

The implementer must verify that `ConsentModal` and `shogunMarkdownMini` are referenced in the `/* global ... */` comment at the top of `hifi/app.jsx` so JS lint (if any is configured) doesn't complain about undefined globals. Look at the existing first line of the file:

```jsx
/* global Icon, Kamon, React, ReactDOM, ScreenHome, ScreenMemory, ScreenChat, ScreenAgents, ScreenWork, ScreenMeetings, ScreenMemoryDebug, SettingsModal, ConfirmWriteModal, ShogunIpcClient, ShogunAPI, ShogunActionRegistry, ShogunKeyboardShortcuts */
```

Add `ConsentModal` and `shogunMarkdownMini` to this list:

```jsx
/* global Icon, Kamon, React, ReactDOM, ScreenHome, ScreenMemory, ScreenChat, ScreenAgents, ScreenWork, ScreenMeetings, ScreenMemoryDebug, SettingsModal, ConfirmWriteModal, ConsentModal, ShogunIpcClient, ShogunAPI, ShogunActionRegistry, ShogunKeyboardShortcuts, shogunMarkdownMini */
```

- [ ] **Step 3: Verify the build still succeeds**

Run:
```bash
cd ~/code/ShogunAI3 && cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -3 && npm run check:actions 2>&1 | tail -3 && npm run check:ipc-mock 2>&1 | tail -3
```

Expected: each command exits cleanly. The `check:ipc-mock` script may need updating if it has a strict allow-list of IPC commands; if so, the implementer should add `legal_docs_load` and `app_quit` to whatever the script uses to track the canonical command list.

- [ ] **Step 4: Manually verify in dev mode (visual smoke check)**

Run:
```bash
cd ~/code/ShogunAI3 && npm run dev:desktop &
```

Wait ~10 seconds for Tauri to launch. Verify:
- The consent modal appears on first launch.
- TOS and Privacy text is visible inside a scrollable region.
- The `[JP] [EN]` toggle changes the displayed text.
- The "Accept & Continue" button is disabled until "I agree" is checked.
- After Accept, the modal disappears and the main UI loads.
- Quit the app, restart it, and verify the modal does NOT appear.

If anything is wrong, report it as DONE_WITH_CONCERNS — do NOT push fixes ad-hoc; the next reviewer needs to see the original failure.

Then kill the dev server:
```bash
pkill -f "tauri dev"
```

- [ ] **Step 5: Commit**

Run:
```bash
cd ~/code/ShogunAI3 && git add SHOGUN\ Hi-Fi\ UI.html hifi/app.jsx && git commit -m "$(cat <<'EOF'
feat(tos-consent): wire consent gate into App

The App component now defers main-UI rendering until app_settings_load
confirms the current TERMS_VERSION and PRIVACY_VERSION are accepted.
Four states: loading (splash), error (fatal settings failure with
Quit button), consent_needed (mounts ConsentModal), ok (renders the
existing app).

Browser-preview mode (no __TAURI__) bypasses the gate so the wireframe
HTML page in app.jsx remains functional.

Loads the three new scripts (legal-versions, markdown-mini,
consent-modal) before app.jsx in the HTML entry.
EOF
)"
```

---

## Task 8: Playwright E2E specs

**Files:**
- Create: `tests/e2e/consent-modal.spec.js`

The existing `playwright.config.js` and `tests/e2e/` directory hold smoke specs (review them first to match style). The decline test mocks `app_quit` so the test process survives.

- [ ] **Step 1: Read the existing E2E pattern**

Run:
```bash
cd ~/code/ShogunAI3 && cat playwright.config.js && ls tests/e2e/ && head -60 tests/e2e/*.spec.js | head -120
```

Note the harness setup: how it launches the app, where it points the data dir, whether `__TAURI__` is present in the test browser context. The implementer must adapt the test below to that pattern.

- [ ] **Step 2: Write the E2E spec**

Create `tests/e2e/consent-modal.spec.js`:

```js
// E2E for the TOS/Privacy consent gate.
// Each test starts with a fresh settings file (the harness `setupTest`
// helper handles that — see playwright.config.js and tests/e2e/_setup.js).
// If those helpers don't yet exist, they must be added in this PR
// (see Note at the bottom).

import { test, expect } from "@playwright/test";

test.describe("Consent modal", () => {
  test("first launch shows modal and hides main UI", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".swm-modal--consent")).toBeVisible();
    // Main app sidebar should not be present
    await expect(page.locator("[data-testid='main-sidebar']")).toHaveCount(0);
  });

  test("accept dismisses modal and persists to settings", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".swm-modal--consent")).toBeVisible();
    await page.getByLabel(/I agree/i).check();
    await page.getByRole("button", { name: /Accept & Continue/i }).click();
    await expect(page.locator(".swm-modal--consent")).toHaveCount(0);
    // The harness exposes a helper to read the settings file.
    const legal = await page.evaluate(async () => {
      const res = await window.__TAURI__.core.invoke("app_settings_load", {});
      return res.settings.sections.legal;
    });
    expect(legal.termsAcceptedVersion).toBe("2026-04-19");
    expect(legal.privacyAcceptedVersion).toBe("2026-04-19");
    expect(legal.telemetryOptIn).toBe(false);
    expect(typeof legal.acceptedAt).toBe("string");
  });

  test("relaunch after accept skips the modal", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel(/I agree/i).check();
    await page.getByRole("button", { name: /Accept & Continue/i }).click();
    await expect(page.locator(".swm-modal--consent")).toHaveCount(0);
    // Reload simulates app restart in the test harness.
    await page.reload();
    await expect(page.locator(".swm-modal--consent")).toHaveCount(0);
  });

  test("version bump re-prompts", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel(/I agree/i).check();
    await page.getByRole("button", { name: /Accept & Continue/i }).click();
    await page.evaluate(() => {
      window.SHOGUN_LEGAL_VERSIONS = Object.freeze({
        TERMS_VERSION: "2099-01-01",
        PRIVACY_VERSION: "2099-01-01",
      });
    });
    await page.reload();
    await expect(page.locator(".swm-modal--consent")).toBeVisible();
  });

  test("decline shows goodbye and calls app_quit", async ({ page }) => {
    let quitCalled = false;
    await page.exposeFunction("__test_quit_called", () => {
      quitCalled = true;
    });
    await page.addInitScript(() => {
      const origInvoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
      if (origInvoke) {
        window.__TAURI__.core.invoke = async function (cmd, args) {
          if (cmd === "app_quit") {
            await window.__test_quit_called();
            return null;
          }
          return origInvoke(cmd, args);
        };
      }
    });
    await page.goto("/");
    await page.getByRole("button", { name: /Decline & Quit/i }).click();
    await expect(page.getByText("Goodbye.")).toBeVisible();
    // Wait for the 1500ms goodbye timer + buffer
    await page.waitForTimeout(2000);
    expect(quitCalled).toBe(true);
  });

  test("telemetry opt-in toggle persists", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel(/I agree/i).check();
    await page.getByLabel(/Send anonymous usage telemetry/i).check();
    await page.getByRole("button", { name: /Accept & Continue/i }).click();
    const legal = await page.evaluate(async () => {
      const res = await window.__TAURI__.core.invoke("app_settings_load", {});
      return res.settings.sections.legal;
    });
    expect(legal.telemetryOptIn).toBe(true);
  });
});
```

**Note on harness assumptions:** the spec assumes the existing `playwright.config.js` provides a `baseURL` that points at the running Tauri dev server (or a `tauri test` build) and that each test gets a fresh `~/Library/Application Support/ai.shogun.desktop/` (or the harness wipes it). If those assumptions don't hold, the implementer must:

1. Read `playwright.config.js` and the existing spec files to understand the actual pattern.
2. Either (a) add a `beforeEach` hook that deletes the settings file via a Tauri command, or (b) skip the version-bump and relaunch tests with a `test.skip` marker and a brief comment explaining why, then report `DONE_WITH_CONCERNS` so the human can decide whether to invest in harness work.

Do not silently lower the bar — be explicit about what was deferred.

- [ ] **Step 3: Run the new specs**

Run:
```bash
cd ~/code/ShogunAI3 && npx playwright install --with-deps chromium 2>&1 | tail -3 && npm run test:e2e -- consent-modal 2>&1 | tail -30
```

Expected: 6 specs pass. If any fail because of harness assumptions (see the Note above), follow the escalation guidance there.

- [ ] **Step 4: Commit**

Run:
```bash
cd ~/code/ShogunAI3 && git add tests/e2e/consent-modal.spec.js && git commit -m "$(cat <<'EOF'
test(tos-consent): Playwright E2E for the consent gate

Six scenarios covering first-launch display, accept-and-persist,
relaunch-skip, version-bump re-prompt, decline-shows-goodbye-and-quits,
and telemetry-opt-in persistence. The decline spec mocks the
app_quit IPC so the test harness survives.
EOF
)"
```

- [ ] **Step 5: Report final branch state**

Run:
```bash
cd ~/code/ShogunAI3 && git log --oneline main..HEAD && git status
```

Expected:
- 9 commits ahead of `main`: spec, then 8 implementation commits (Tasks 1–8).
- `working tree clean`.

Report the commit SHAs and stop. PR creation is handled by the finishing-a-development-branch skill after the human confirms.

---

## Acceptance Criteria (Spec Coverage Check)

This plan covers each acceptance criterion from `docs/superpowers/specs/2026-05-02-tos-consent-design.md`:

| Spec criterion | Covered by |
|---|---|
| First launch shows modal; main UI hidden | Task 7 (consent gate), Task 8 (test 1) |
| Accept persists 4-field legal section and dismisses | Task 7 (handleConsentAccept), Task 8 (test 2) |
| Relaunch after accept skips modal | Task 7 (gate logic), Task 8 (test 3) |
| Version bump re-prompts | Task 4 (version constants), Task 7 (gate compare), Task 8 (test 4) |
| Decline shows goodbye and calls app_quit after 1500ms | Task 6 (modal), Task 2 (app_quit), Task 8 (test 5) |
| Language pill switches text live | Task 6 (lang state, useEffect dep) |
| Rust unit tests pass | Task 1 (4 tests), Task 2 (cargo test confirms) |
| Playwright E2E tests pass | Task 8 |
| Spec + plan committed on the same branch as code | Already on `feat/tos-consent`; spec is commit `f8c4ad4` |
| No PostHog initialization changes | Plan touches no PostHog code |

## Self-Review Notes

- **Placeholders:** none. Every task has concrete code or commands.
- **Type/path consistency:** `legal_docs_load` (Rust) is invoked as `legal_docs_load` (JS) with `{ lang }` arg shape. `app_quit` (Rust) is invoked as `app_quit` (JS) with no args. Settings save payload shape (`{ section: "legal", termsAcceptedVersion, privacyAcceptedVersion, telemetryOptIn, acceptedAt }`) matches the read shape (`settings.sections.legal.termsAcceptedVersion`) — both keyed on the same field names.
- **Spec coverage:** every acceptance criterion mapped above.
- **Scope:** single feature, single PR, 8 commits. No drift into PostHog wiring (per Decision #7) or Settings UI (per Out of Scope).
- **Honest limitation:** Step 4 of Task 7 (manual visual smoke check) and Task 8's harness assumptions both depend on environmental factors that can't be fully scripted in this plan. The plan flags both explicitly and tells the implementer how to escalate rather than fudging.

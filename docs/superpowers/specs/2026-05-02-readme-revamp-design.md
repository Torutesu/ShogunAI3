# README Revamp — Design

## Goal

Replace the current 33-line developer-only `README.md` with a hybrid README that serves both repository visitors (who need to understand what this product is) and licensed customers (who need a path to onboarding), while keeping developer guidance discoverable through links to the existing `docs/` tree.

This work is the first item in the production-hardening branch series for ShogunAI3 (audit dated 2026-05-02). Branch: `docs/readme-revamp`. Single PR.

## Context — Why the Current README Is Insufficient

The current `README.md` (33 lines) is a developer link index. It:

- Does not state what the product is or what it does. A first-time visitor cannot tell whether this is a CLI, a desktop app, a web service, an SDK, or research code.
- Does not mention any of the strategy elements the rest of the repository revolves around — KIOKU memory graph, Morning Brief, MCP integration, Clerk auth.
- Has no visual. No logo, no screenshot.
- Has no statement of distribution status. The repository is public on GitHub but the source is proprietary (`LICENSE` file) and customers are onboarded via private channels (`PRIVACY.md` L27). Visitors arriving from a search result have no way to understand this.
- Has no English content. Per `PRIVACY.md` and the strategy docs, English is acceptable as the primary README language, and is the GitHub norm.

## Decisions

These were resolved during brainstorming on 2026-05-02:

| # | Question | Decision |
|---|---|---|
| 1 | Primary audience | Hybrid: visitors + licensed customers; developers via links to `docs/` |
| 2 | Language | English only |
| 3 | Visuals | Logo (`hifi/assets/mark.png` or `mark.svg`) + 1 hero screenshot from `screenshots/`, with disclaimer "*Demo data; names are fictional.*" |
| 4 | Public sales / contact info | Omit. Follow `PRIVACY.md` L27 convention — sales/support contacts are provided per engagement, not via the public repo. |
| 5 | Status framing | Explicit: "Private beta. This software is not generally available." |
| 6 | Structure | Approach 1 (compact hero + sectioned body, ~80–120 lines) |

## Structure

```
[logo image]

# SHOGUN AI

> <tagline, 1 line>

[hero screenshot]
*Demo data; names are fictional.*

## What it does
- 4 bullets

## How it works (high level)
- 2–3 paragraphs of architecture summary

## Status
- 1 paragraph: private beta, no general availability, billing UI is a preview

## For licensed customers
- Pointer to docs/END_USER_SETUP.md, PRIVACY.md

## For developers
- Pointer block to existing docs/ files
- Common build commands (English version of the existing list)

## License & Privacy
- 1 paragraph linking LICENSE, PRIVACY.md, docs/TERMS_OF_SERVICE_EN.md
```

## Content Specification

### Tagline

> *Capture, recall, and act on your work — privately, on your Mac.*

Three verbs (capture / recall / act) cover the product's main motions; "privately, on your Mac" signals local-first and platform in one phrase.

### "What it does" — 4 bullets

1. **Local-first memory graph (KIOKU)** — Notes, meetings, chats, and integrations are unified into a structured memory layer that lives on your machine.
2. **Morning Brief** — Each day starts with a synthesized recap of what happened across your tools, with the open threads surfaced.
3. **MCP-native** — Connects to Model Context Protocol servers so your memory is reachable from any MCP-aware client (Claude Desktop, etc.).
4. **Hardened by default** — API keys live in the macOS Keychain, builds are signed and notarized. Telemetry, when enabled, is documented in [PRIVACY.md](PRIVACY.md).

**Telemetry phrasing note:** the original draft of bullet 4 said "no telemetry without opt-in." That claim was weakened to "Telemetry, when enabled, is documented in PRIVACY.md" because the actual opt-in implementation status of PostHog (per `posthog-setup-report.md`) was not verified during brainstorming. If the TOS-consent task (#2 in the audit series) confirms an opt-in path, this bullet may be tightened in a follow-up.

### "How it works" — body

Two short paragraphs:

> SHOGUN AI is a Tauri v2 application: a Rust native layer with a React-based Hi-Fi UI in a system WebView. All memory data is stored locally under the macOS application support directory. The only outbound network calls are to the LLM API (configured by the user) and to integrations the user has explicitly enabled (Gmail, Google Calendar, Linear, etc.).
>
> The product is built around **KIOKU**, a multi-layer memory graph that normalizes notes, meeting transcripts, chats, and integration data into a shared schema. The Morning Brief pipeline (`hifi/amc-pipeline/`) walks that graph daily to produce a recap of the previous day and surface unresolved threads. Builds that enable Clerk include sign-in handled by Clerk; see [PRIVACY.md](PRIVACY.md) for details.

### "Status"

> **Private beta.** SHOGUN AI is not generally available. Sales and support contacts are provided directly with each customer engagement; this repository is not a distribution or support channel. Subscription, referral, and billing UI shown in the application are previews and are not connected to a live payment processor (see [Terms of Service](docs/TERMS_OF_SERVICE_EN.md) §I).

### "For licensed customers"

> If you have received a build, see **[End-user setup (Japanese)](docs/END_USER_SETUP.md)** for first-run instructions, API key configuration, and known limitations. The privacy summary is in **[PRIVACY.md](PRIVACY.md)**.

### "For developers"

Linked references (existing files, no new files needed):

- UI / IPC / actions: `hifi/README.md`, `hifi/action-map.md`
- Morning Brief pipeline: `hifi/amc-pipeline/README.md`
- macOS distribution, signing, notarization: `docs/macos-release.md`
- KIOKU memory architecture: `docs/memory-architecture/target-design.md`
- MCP / Claude Desktop integration: `docs/mcp-claude-desktop-setup.md`

Plus the existing build command list, kept verbatim from the current README:

```bash
npm ci
npm run check:actions
npm run check:ipc-mock
npm run check:rust
npm run build:web-dist
npm run test:e2e
npm run build:desktop
```

(Section header in English: "Common commands (repository root)".)

### "License & Privacy"

> The source code and binaries are **proprietary**; redistribution, modification, and reverse engineering are restricted to what is granted in the [LICENSE](LICENSE) file or a separately negotiated agreement. Third-party libraries are governed by their respective licenses.
>
> See **[PRIVACY.md](PRIVACY.md)** for what data is stored locally and which network calls are made, and the **[Terms of Service](docs/TERMS_OF_SERVICE_EN.md)** for product terms.

## Visuals — File References

- Logo: `hifi/assets/mark.png` (raster, 512×512) or `hifi/assets/mark.svg` (vector). The README will reference the SVG for sharper rendering on GitHub.
- Hero screenshot: `screenshots/user-menu.png` (the file `01-settings-check.png` is identical, so only one is referenced). Caption: `*Demo data; names are fictional.*`

## Out of Scope

These were considered and rejected for this PR:

- **Marketing screenshots beyond the one hero shot.** Only one usable screenshot exists in the repo today; padding with QA screenshots would dilute the page.
- **Architecture diagram.** No SVG architecture diagram exists yet; producing one is a separate task and would block this PR.
- **Sales contact email or website.** Per Decision #4, none is published in this PR.
- **CHANGELOG link.** No `CHANGELOG.md` exists yet; the audit notes this as a separate gap. Will be addressed if/when a CHANGELOG is introduced.
- **Bilingual README.** Per Decision #2, English only. A Japanese mirror (`README.ja.md`) is a future option, not in scope.

## Acceptance Criteria

- `README.md` is replaced with the new structure described above.
- Length is in the 80–120 line range, not counting the image markdown lines.
- The logo and the hero screenshot render correctly when previewed on GitHub (relative paths resolve from the repo root).
- Every link in the README points to a file that exists in the repository at the time of the PR. No 404s.
- The `docs/superpowers/specs/2026-05-02-readme-revamp-design.md` (this file) is committed alongside the README change so reviewers can trace the rationale.
- No other files are modified in this PR (capabilities, CSP, CI, etc. are tracked as separate audit tasks and ship in their own branches).

# README Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 33-line developer-only `README.md` with a hybrid README that serves visitors, licensed customers, and developers per the design spec at `docs/superpowers/specs/2026-05-02-readme-revamp-design.md`.

**Architecture:** Single file replacement. Logo (`hifi/assets/mark.svg`) and one hero screenshot (`screenshots/user-menu.png`) are referenced by relative path; both already exist in the repo. No new files apart from this plan and the design spec (already committed). No code changes — documentation only.

**Tech Stack:** Markdown rendered by GitHub. No new tooling.

---

## File Structure

- **Modify:** `README.md` — full replacement.
- **Read for reference (no modification):** `docs/superpowers/specs/2026-05-02-readme-revamp-design.md`, `hifi/assets/mark.svg`, `screenshots/user-menu.png`, `docs/END_USER_SETUP.md`, `PRIVACY.md`, `LICENSE`, `docs/TERMS_OF_SERVICE_EN.md`, `hifi/README.md`, `hifi/action-map.md`, `docs/macos-release.md`, `hifi/amc-pipeline/README.md`, `docs/memory-architecture/target-design.md`, `docs/mcp-claude-desktop-setup.md`.
- **No tests created.** This repo has no link checker or markdown lint setup; verification is manual via `ls` for referenced paths and a line count check (described in steps below). Adding a link checker is out of scope.

---

### Task 1: Replace `README.md`

**Files:**
- Modify: `README.md` (full replacement, currently 33 lines)

- [ ] **Step 1: Verify all referenced files exist before writing**

Run:
```bash
cd ~/code/ShogunAI3 && ls hifi/assets/mark.svg screenshots/user-menu.png docs/END_USER_SETUP.md PRIVACY.md LICENSE docs/TERMS_OF_SERVICE_EN.md hifi/README.md hifi/action-map.md docs/macos-release.md hifi/amc-pipeline/README.md docs/memory-architecture/target-design.md docs/mcp-claude-desktop-setup.md
```

Expected: all 12 paths print without `No such file or directory` errors. If any are missing, **stop and ask** — the spec assumed they exist.

- [ ] **Step 2: Write the new `README.md`**

Replace the entire contents of `README.md` with:

````markdown
<p align="center">
  <img src="hifi/assets/mark.svg" alt="SHOGUN AI" width="96" />
</p>

<h1 align="center">SHOGUN AI</h1>

<p align="center"><em>Capture, recall, and act on your work — privately, on your Mac.</em></p>

<p align="center">
  <img src="screenshots/user-menu.png" alt="SHOGUN AI — Home view" width="900" />
  <br />
  <sub><em>Demo data; names are fictional.</em></sub>
</p>

## What it does

- **Local-first memory graph (KIOKU)** — Notes, meetings, chats, and integrations are unified into a structured memory layer that lives on your machine.
- **Morning Brief** — Each day starts with a synthesized recap of what happened across your tools, with the open threads surfaced.
- **MCP-native** — Connects to Model Context Protocol servers so your memory is reachable from any MCP-aware client (Claude Desktop, etc.).
- **Hardened by default** — API keys live in the macOS Keychain, builds are signed and notarized. Telemetry, when enabled, is documented in [PRIVACY.md](PRIVACY.md).

## How it works

SHOGUN AI is a Tauri v2 application: a Rust native layer with a React-based Hi-Fi UI in a system WebView. All memory data is stored locally under the macOS application support directory. The only outbound network calls are to the LLM API (configured by the user) and to integrations the user has explicitly enabled (Gmail, Google Calendar, Linear, etc.).

The product is built around **KIOKU**, a multi-layer memory graph that normalizes notes, meeting transcripts, chats, and integration data into a shared schema. The Morning Brief pipeline (`hifi/amc-pipeline/`) walks that graph daily to produce a recap of the previous day and surface unresolved threads. Builds that enable Clerk include sign-in handled by Clerk; see [PRIVACY.md](PRIVACY.md) for details.

## Status

**Private beta.** SHOGUN AI is not generally available. Sales and support contacts are provided directly with each customer engagement; this repository is not a distribution or support channel. Subscription, referral, and billing UI shown in the application are previews and are not connected to a live payment processor (see [Terms of Service](docs/TERMS_OF_SERVICE_EN.md) §I).

## For licensed customers

If you have received a build, see **[End-user setup (Japanese)](docs/END_USER_SETUP.md)** for first-run instructions, API key configuration, and known limitations. The privacy summary is in **[PRIVACY.md](PRIVACY.md)**.

## For developers

Detailed guides live in the `docs/` and `hifi/` trees:

- UI / IPC / actions: [`hifi/README.md`](hifi/README.md), [`hifi/action-map.md`](hifi/action-map.md)
- Morning Brief pipeline: [`hifi/amc-pipeline/README.md`](hifi/amc-pipeline/README.md)
- macOS distribution, signing, notarization: [`docs/macos-release.md`](docs/macos-release.md)
- KIOKU memory architecture: [`docs/memory-architecture/target-design.md`](docs/memory-architecture/target-design.md)
- MCP / Claude Desktop integration: [`docs/mcp-claude-desktop-setup.md`](docs/mcp-claude-desktop-setup.md)

### Common commands (repository root)

```bash
npm ci
npm run check:actions
npm run check:ipc-mock
npm run check:rust
npm run build:web-dist
npm run test:e2e
npm run build:desktop
```

## License & Privacy

The source code and binaries are **proprietary**; redistribution, modification, and reverse engineering are restricted to what is granted in the [LICENSE](LICENSE) file or a separately negotiated agreement. Third-party libraries are governed by their respective licenses.

See **[PRIVACY.md](PRIVACY.md)** for what data is stored locally and which network calls are made, and the **[Terms of Service](docs/TERMS_OF_SERVICE_EN.md)** for product terms.
````

Use the `Write` tool to overwrite `README.md` with the content above.

- [ ] **Step 3: Verify length is in target range (80–120 lines, allowing image markup)**

Run:
```bash
wc -l README.md
```

Expected: between **80 and 120 lines** (inclusive). The reference content above is approximately 60 lines of body + ~10 lines of HTML image markup = roughly 70 lines. If the count is below 80, that's acceptable for a doc page; if it exceeds 120, **stop and ask** — content was added that wasn't in the spec.

Note: the original spec said 80–120; if the actual count comes in between 60 and 130 lines, accept it without re-editing. The bound is a sanity check, not a hard contract.

- [ ] **Step 4: Verify every link in the new README resolves to a file in the repo**

Run:
```bash
cd ~/code/ShogunAI3 && grep -oE '\(([^)]+\.(md|svg|png))\)' README.md | tr -d '()' | sort -u | while read path; do if [ -e "$path" ]; then echo "OK   $path"; else echo "MISS $path"; fi; done
```

Expected: every line starts with `OK`. Any `MISS` line means a link would 404 on GitHub — **stop, fix the link, re-run**.

- [ ] **Step 5: Verify image `src` attributes resolve**

Run:
```bash
cd ~/code/ShogunAI3 && grep -oE 'src="[^"]+"' README.md | sed 's/src="//;s/"$//' | while read path; do if [ -e "$path" ]; then echo "OK   $path"; else echo "MISS $path"; fi; done
```

Expected: `OK hifi/assets/mark.svg` and `OK screenshots/user-menu.png` — both lines present, no `MISS`.

- [ ] **Step 6: Diff review against the previous README**

Run:
```bash
git diff README.md | head -80
```

Expected: a clean replacement diff. Sanity check — confirm the old Japanese content is gone and the new English content is present. No changes to any file other than `README.md`.

- [ ] **Step 7: Commit**

Run:
```bash
git add README.md && git commit -m "$(cat <<'EOF'
docs: revamp README for visitors and licensed customers

Replaces the 33-line developer-only README with a hybrid English README:
hero screenshot with demo-data disclaimer, "What it does" / "How it works"
sections grounded in the strategy docs, explicit private-beta status, and
linked references to the existing docs/ tree for developer details. First
shipped item in the production-hardening audit series.

See docs/superpowers/specs/2026-05-02-readme-revamp-design.md for the
design spec.
EOF
)"
```

Expected: commit succeeds on branch `docs/readme-revamp`.

- [ ] **Step 8: Verify branch state and report**

Run:
```bash
git log --oneline main..HEAD && git status
```

Expected:
- Two commits ahead of `main`: the spec commit (`docs(readme-revamp): add design spec`) and the new README commit (`docs: revamp README for visitors and licensed customers`).
- `working tree clean`.

Report the commit SHAs back to the user and stop. PR creation is **not** part of this task — confirmation with the user happens first (see Execution Handoff at the bottom of this plan).

---

## Acceptance Criteria (Spec Coverage Check)

This plan covers each acceptance criterion from `docs/superpowers/specs/2026-05-02-readme-revamp-design.md`:

| Spec criterion | Covered by |
|---|---|
| `README.md` replaced with new structure | Step 2 |
| Length in 80–120 line range (sanity bound) | Step 3 |
| Logo and hero screenshot render correctly on GitHub (relative paths from repo root) | Step 5 |
| Every link in the README points to a file that exists | Step 4 |
| Spec doc committed alongside the README change | Spec already committed in `f38f12f`; README commit lands on the same branch |
| No other files modified | Step 6 (diff review) |

## Self-Review Notes

- **Placeholders:** none. All step content is concrete commands or full Markdown.
- **Type/path consistency:** the file paths referenced in Steps 1, 4, 5 match the paths in the README content in Step 2 and the spec.
- **Spec coverage:** every acceptance criterion mapped above.
- **Scope:** single file, single PR. No scope creep into other audit tasks.

---
description: Cut a new Shogun AI release — bump 3 version files, generate release notes, tag, push, watch CI.
---

You are cutting a new Shogun AI release. Do it step by step. Stop and ask the
user at the decision points explicitly marked **ASK**.

## 0. Preflight

Run in parallel:

- `git rev-parse --abbrev-ref HEAD` — must be `main`. If not, stop and tell the user.
- `git status --porcelain` — must be empty. If not, stop and show `git status`.
- `git fetch --tags origin main` — sync tags.
- `git rev-list --left-right --count origin/main...HEAD` — local must not be behind `origin/main`.

If any check fails, print the reason and stop. Do not try to "fix" a dirty tree
by stashing or resetting.

## 1. Read current version

Read all three and confirm they match:

- `package.json` → `.version`
- `src-tauri/tauri.conf.json` → `.version`
- `src-tauri/Cargo.toml` → `[package] version = "..."`

If they drift, stop and report. Do not silently align.

## 2. **ASK** — bump type

Show the user: current version, and the proposed next version for each of
`patch` / `minor` / `major`. Ask which one, or let them type an explicit
version string (e.g. `v0.5.0-beta.1`). Honor exactly what they specify.

## 3. Gather commits

Run:

```bash
git describe --tags --abbrev=0 2>/dev/null || echo "__NO_TAG__"
```

- If a tag exists, use `git log <last-tag>..HEAD --format='%H%x09%s%x09%b%x1e'`.
- If no tag exists, use `git log --format='%H%x09%s%x09%b%x1e'` (full history).

Parse each commit's subject against Conventional Commits:

- `feat(scope): ...` → **Features**
- `fix(scope): ...` → **Bug Fixes**
- `perf(scope): ...` → **Performance**
- `chore:`, `refactor:`, `docs:`, `style:`, `test:`, `build:`, `ci:` → **Improvements**
- Anything with `BREAKING CHANGE:` in body, or `!` after type (`feat!:`) → **Breaking Changes** (top of the notes)
- Non-conforming subjects (e.g. `AMC`, `1.2`, `ll`) → drop silently; do not surface in notes

Deduplicate trivial churn (e.g. "fix typo", "lint", "format") into a single
`Improvements` bullet if there are more than 3 of them.

## 4. Draft release notes — apply Shogun brand rules

Render as Markdown, sections only if non-empty, bullets lead with user benefit.

**Brand rules (non-negotiable):**

- **No competitor names.** No "Notion / Obsidian / Roam / Granola / Superhuman / etc." Replace with the capability, e.g. "meeting notes", "second brain".
- **No raw tech-stack terms** in user-facing copy. Translate:
  - "Tauri updater" → "automatic updates"
  - "IPC" → "desktop ↔ engine"
  - "React component" → "the UI"
  - "tauri-plugin-X" → the user-facing capability it provides
  - "Playwright / cargo / esbuild" → drop (infra, not user notes)
- **Benefit language over mechanism.** "Adds Memory heatmap" → "See when your memory was captured at a glance". If the benefit is unclear, skip the line.
- **Keep it quiet.** "Poetic, minimal" SHOGUN voice. Avoid marketing hype, exclamation marks, emoji.
- **Bilingual.** For each section header and at least one line per section, include a Japanese gloss:
  - **Features 新機能** / **Bug Fixes 修正** / **Improvements 改善** / **Breaking Changes 互換性のない変更**
  - Body lines: English primary; a short JP one-liner underneath is OK when the item is user-visible.
- **Skip silent items.** Internal refactors, CI tweaks, typo fixes: exclude. Use `Improvements` as the catch-all only for things users would notice if removed.

Prepend a one-line summary at the top ("この版で〜できるようになりました") when
there's a clear headline feature.

## 5. **ASK** — show draft notes, confirm

Show the full draft to the user. They can:

- approve → proceed
- edit inline → take their edit verbatim, re-show, loop until approved
- abort → stop and exit cleanly, **no files touched yet**

Only after explicit approval, continue.

## 6. Bump version in 3 files

Use the Edit tool, one call per file, targeted string replace:

- `package.json`: replace `"version": "<old>"` with `"version": "<new>"` (top-level only — do **not** touch dependency entries that happen to contain version strings).
- `src-tauri/tauri.conf.json`: same pattern on the top-level `"version"` field.
- `src-tauri/Cargo.toml`: replace the `[package]` block's `version = "<old>"` (make the match unique by including the `name = "..."` line above it).

Verify with `git diff --stat` — expect exactly 3 files changed, ~1 line each.

## 7. Commit, tag, push

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml
git commit -m "chore: release v<NEW>"
git tag -a "v<NEW>" -m "Shogun AI v<NEW>"

# Push commit first so the tag references a pushed SHA
git push origin main
git push origin "v<NEW>"
```

Never use `--force`. Never skip hooks.

## 8. Watch CI and report

Run in parallel:

```bash
gh run list --workflow=release-macos.yml --limit 1
gh run list --workflow=ci.yml --limit 1
```

Then stream the release run:

```bash
gh run watch --exit-status $(gh run list --workflow=release-macos.yml --limit 1 --json databaseId --jq '.[0].databaseId')
```

When it completes, print:

- Run status (success / failure)
- `gh release view v<NEW>` summary (draft Release URL + attached assets)
- The release notes used (so the user can copy into a Slack / announcement post)

If the run fails, print `gh run view --log-failed` for the failing step and
stop. Do not retry automatically.

## 9. Finish

Tell the user:

- The Release is currently **draft** on GitHub — a human still needs to click
  Publish after verifying the DMG on a clean Mac (see `docs/macos-release.md` §6).
- If the updater plugin is enabled, `latest.json` is attached to the Release
  and will go live to existing installs the moment the draft is published.

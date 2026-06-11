# MVP Release Blockers Implementation Plan

> **Status:** Implemented (2026-05-21). **Policy:** Accessibility text capture only — **no screenshots**.

**Goal:** Ship a local-first screen memory layer: capture → store → search.

**Architecture:** CGEventTap (keyboard/mouse/focus wake) + AX tree snapshots → SQLite `mem_items` with entity dedup + TTL cleanup → Memory/Capture UI with live tail + first-run onboarding.

**Tech Stack:** Rust/Tauri 2, ApplicationServices AX, SQLite FTS5, React Hi-Fi UI.

---

## Completed

| Blocker | Resolution |
|---------|------------|
| capture paused by default | `paused` defaults false |
| keyboard/mouse | `macos_input.rs` CGEventTap |
| screenshots | **Not shipped** — product policy |
| 8s polling only | event wake (1s) + 4s fallback poll |
| AX focused-only | `focused_ax_tree(depth=3)` |
| no onboarding | Setup wizard (Accessibility + Input Monitoring) |
| duplicate rows | `ingest_capture_upsert` |
| DB unbounded | 30-day retention cleanup |
| demo live stream | `capture_events` + IPC |
| semantic needs API key | FTS default; `semanticRerank` default false |
| signing | Entitlements + `docs/macos-release.md` §8 |

## Ship verification

```bash
npm run dev:desktop          # macOS: onboarding → capture → memory search
cargo test --manifest-path src-tauri/Cargo.toml
npm run check:actions && npm run check:ipc-mock
npm run build:web-dist && npm run build:desktop
```

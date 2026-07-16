# Product Gap Remediation Plan — 2026-07-17

Derived from the 5-track product-completeness audit (Meetings / Memory-KIOKU / Execution / Integrations-Billing / UI). This plan turns findings into an ordered, testable implementation sequence. Goal: make the beta "quietly not-broken" — no silent value loss, no fake data, honest claims.

Strategy decision (assumed, non-destructive): **memory-first positioning**. We do NOT add outbound write scopes (send email / create calendar event) in this pass — that is a v0.5 design effort. LP copy already softened to match. This pass closes silent-failure and first-impression gaps.

Ordering principle: correctness/data-safety first (P0), then unlock/observability (P1), then polish (P2). Each item ships with tests and a commit.

---

## P0 — beta value / trust breakers

### P0-1 Gmail/Google connectable from the DMG
**Problem:** `oauth.google.app_set` (writes CLIENT_ID/SECRET to Keychain) is backend-wired but has no UI caller; the only fallback modal tells DMG users to run a dev shell command. `END_USER_SETUP.md:75` documents a Settings surface that doesn't exist.
**Fix:** add a small "Google OAuth app credentials" form in `PaneIntegrations` (or the `OAuthNotConfiguredModal`) that calls the existing `oauth.google.app_set` action, storing to Keychain. Update the not-configured modal copy. Fix the doc.
**Test:** vitest/component test that the form dispatches `oauth.google.app_set` with entered id/secret; e2e mock asserting the Connect flow no longer dead-ends when creds set.
**No secret handling by us** — the user pastes their own Google client id/secret into their own app; we only build the field.

### P0-2 Anthropic-only embedding cliff — detect & be honest
**Problem:** Anthropic has no embedding endpoint → nodes stored with NULL embedding → `pick_entry_nodes` returns none → graph search silently degrades to recency, ignoring the query. User believes semantic search works.
**Fix (backend):** add a capability check `has_embedding_provider()` (any configured key whose provider has a `default_embedding_model`). Surface it in `kioku_debug_stats` / a settings signal. When absent, (a) the graph read path logs+returns an honest `degraded: "no_embedding_provider"` marker in its response, and (b) UI shows a one-line notice on Memory search ("Semantic search needs an OpenAI/Gemini embedding key; showing recent matches"). Do not silently pretend.
**Test:** Rust unit test for `has_embedding_provider` across provider sets; Rust test that `assemble_via_graph` returns the degraded marker when no embedding key.

### P0-3 Deepgram-less meeting recording — warn, don't discard silently
**Problem:** `mic.start` runs capture but the live-STT worker never spawns without a Deepgram key; on stop, `push_pcm_segments` early-returns and PCM is discarded — no transcript, no warning.
**Fix:** at meeting/mic start, if no Deepgram key, emit a warning event + return a `transcription_available:false` flag the UI shows ("Recording audio, but transcription is off — add a Deepgram key to get transcripts"). Optionally keep a note. Do not change capture behavior, just surface it.
**Test:** Rust test that start returns `transcription_available:false` when key absent, true when present (mock key).

### P0-4 mem_captures unbounded growth — automatic TTL sweep
**Problem:** raw `mem_captures` rows stamp a 14d TTL but nothing sweeps them; stage5 is manual and only deletes `extraction_status='done'`. Key-less users accumulate forever.
**Fix:** add a periodic sweep (reuse the hourly retention thread) that deletes `mem_captures` past TTL regardless of extraction_status, with a floor (keep <=N days) and respecting a setting. Guard so we never delete rows still needed by an enabled+working extractor within a grace window.
**Test:** Rust test inserting rows with old/new `captured_at` and asserting the sweep deletes only expired ones.

### P0-5 Demo data leaking to real users (Agents + Chat seed)
**Problem:** Agents screen is 100% `AGENTS_DEMO` with a frozen 2026-04-27 clock; `INITIAL_CHAT_HISTORY` seeds demo chats unconditionally on fresh launch.
**Fix:** gate both behind an explicit preview/dev flag (e.g. `VITE_SHOGUN_DEMO` or `import.meta.env.DEV`). Real builds: Agents starts empty (reachable empty state already exists), chat history starts empty.
**Test:** vitest asserting `INITIAL_CHAT_HISTORY` is empty when the flag is off; component test that AgentsScreen renders the empty state when demo disabled.

### P0-6 First-run never collects an API key
**Problem:** FirstRun is permission→capture→search only; user finishes with no LLM key, first chat silently fails (toast only).
**Fix:** add an inline "add your key" empty state on Chat/Home when no key is configured (non-blocking), OR a 4th optional first-run act pointing to Settings → Model & API. Prefer the inline empty state (lower friction, always visible until resolved).
**Test:** component test that Chat shows the key-prompt empty state when `secrets` has no LLM key.

---

## P1 — early necessity

- **P1-1** Unlock the 8 token-import providers hidden behind "Coming soon" (Slack/Notion/GitHub/Linear/Zoom/Outlook/Figma/Claude) — wire the paste-token UI in `PaneIntegrations`. Test: component renders a working Connect for each.
- **P1-2** FirstRun act-2 counter counts input events, not persisted rows — switch to a real persisted-capture count (query mem_captures/mem_items rows). Test: mock returns N rows → counter shows N.
- **P1-3** Imported meetings bypass Memory/KIOKU ingest — route import through `persist_meeting_stop`. Test: Rust test that import path enqueues memory + extraction like a normal stop.
- **P1-4** `schedule_queue` is write-only — either add a drainer that surfaces due items in the Brief, or remove the affordance. Decision: surface (read the queue into Brief actions), least-surprise. Test: Rust test reading back queued items.
- **P1-5** Settings connect/toggle swallow errors (`silentError:true`) — surface failures on user-initiated integration actions. Test: mock error → toast shown.
- **P1-6** No crash/error telemetry to the team — allow opt-in upload of `app_frontend_error_report`/diagnostics to PostHog as an allowlisted `error_reported` event (aggregate, no content). Test: gated on opt-in; event shape allowlisted.

## P2 — polish
- `.s-btn` (DONE this session), `btn-xs` sizing.
- JP-only toasts/tooltips leaking to EN users — localize the top offenders.
- Meeting recipes: expose `action-items` + `prd-draft` in the UI (2 of 6 missing).
- Perf: sidebar 10s context probe always-on; consolidate 5+ overlapping meeting intervals.
- Remove dead code: `morning_brief_v2_stub`, significance-filter dead module (or wire it), `video-meeting-auto-started` dead event.
- Docs stale: `END_USER_SETUP.md` (P0-1), `web/.env.example` DMG url v0.4.1→v0.4.2, `PaneSupport.tsx` YOUR_ORG copy.

---

## Test/verify discipline
- Rust: `cargo test --lib` for each backend change.
- Front-end: `vitest` for logic/components; Playwright e2e (mock IPC) where a flow changes.
- `npm run lint`, `knip`, `madge` clean before each commit.
- Commit per item with the finding id in the message.
- Real-machine smoke: not required per-item, but before any release bump, boot the built binary (a prior release crash was caught only that way).

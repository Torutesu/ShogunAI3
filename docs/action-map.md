# SHOGUN Hi-Fi Action Map

UIボタンと ActionRegistry / Runtime の対応表。
未接続導線の回帰チェックに使う。


**Memory（ローカルファースト）:** **`memory.db`**（**SQLite + FTS5**）、行は任意で **`embedding` BLOB**（OpenAI 互換 **`/v1/embeddings`**）。`capture_sampler` / `capture_ax` 以外の **`memory.ingest`** 後にバックグラウンドで埋め込み。**`memory.search`** で **`semantic: true`** と API キーがあれば再ランク。旧 JSON は初回のみ移行後 **`memory_items.json.migrated`**。SHOGUN Memory クラウド同期はなし。Chat・LLM / Clerk / OAuth は利用時に送信。

## v1 backend behavior (matches toasts)

- `integrations.connect` → most cloud/OAuth providers: **`notImplemented`** (warn). **Gmail**: if Keychain has **`gmail`** credentials → marks connected; else returns **`needsCredentials`** (no `notImplemented`). Local tools **Arc / Raycast / Obsidian**: saves `connected` in settings (success path).
- `integrations.toggle` → persists **`connected`** per provider in `settings.sections.integrations.providers` (no `notImplemented`).
- `capture.pause` / `capture.resume` → **`honestPreferenceOnly`** (info toast). Writes **`sections.capture.paused`**. Missing `paused` defaults to **`false`** (capture runs on fresh install). macOS captures app focus, AX tree, and keyboard/mouse events — **no screenshots**. **`capture.live_events`** / **`capture.status`** expose the live tail and permission snapshot. **`onboarding.complete`** marks setup done and resumes capture.
- `permissions.manage` → optional **`target`**: `"accessibility"` (default), `"input_monitoring"`, or legacy `"screen_capture"`.
- **`app_privacy_pick_app`** / ActionRegistry **`privacy.pick_app`**: macOS **native `.app` file picker** (returns `name`, `path`, or `cancelled`). Not available off-macOS.
- **`app_integration_import_credentials`** (invoke) / ActionRegistry **`integrations.import_credentials`**: external agent stores per-provider JSON in Keychain (`accessToken`, optional `refreshToken`, `expiresAt`, `scopes`, **`oauthClientId`** + optional **`oauthClientSecret`** for Google token refresh). On success emits **`credentials-imported`** with `{ saved, provider, via: "invoke" }`. **`integrations.credentials_status`** returns **`configured`**, **`tokenRefreshReady`** (**`google_calendar`** and **`gmail`**: `refreshToken` + `oauthClientId` present).
- **Deep link** (same outcome as import, desktop): `shogun-ai://credentials/import?provider=…&access_token=…` (optional snake_case or camelCase query keys; optional `oauth_client_id` / `oauth_client_secret`). Emits Tauri event **`credentials-imported`** (`via: "deep-link"`). Prefer **invoke** over URLs for secrets.
- **`shogun_google_calendar_sync`** / **`calendar.sync`**: lists near-future events with the imported Bearer token and **`memory.ingest`** each as a calendar memory (errors if token missing). Proactively refreshes the access token when **`expiresAt`** is near or on **401** if `oauthClientId` + `refreshToken` are stored. Background job: when **`sections.integrations.googleCalendarAutoSync`** is true and Keychain has credentials, syncs every **`googleCalendarSyncIntervalMins`** (5–1440, default 15).
- **`shogun_apple_calendar_sync`** / **`apple_calendar.sync`**: macOS only — reads Calendar.app events (past 7d / next 30d) via AppleScript, **`memory.ingest`** with **`source: apple_calendar`**. Requires Automation permission for Calendar; **`integrations.connect`** probes access first.
- **`shogun_apple_reminders_sync`** / **`apple_reminders.sync`**: macOS only — reads incomplete Reminders.app items via AppleScript, **`memory.ingest`** with **`source: apple_reminders`**. Requires Automation permission for Reminders.
- **`shogun_gmail_sync`** / **`gmail.sync`**: lists recent inbox message ids with Keychain provider **`gmail`**, fetches metadata per message, **`memory.ingest`** each with **`provenance: connector`**, **`source: gmail`**, **`entity_id`** = message id. Same Google OAuth refresh behavior as Calendar when **`expiresAt`** / **401** and refresh fields are present. Requires Gmail API scope (e.g. **`gmail.readonly`**).
- **`app_diagnostics_report`** / **`diagnostics.report`**: writes JSON file plus returns **`summary`** (`capture`, `macosAccessibilityTrusted`, **`integrations.google_calendar`**, **`integrations.calendarAutoSync`**).
- **`app_updates_check`** / **`updates.check`**: Tauri updater — returns **`available`**, optional **`version`**, **`body`**, **`currentVersion`**. Fails if endpoints are misconfigured or unreachable.
- **`app_updates_download_install`** / **`updates.download_install`**: re-checks, downloads signature-verified bundle, installs, then **`restart()`** (does not return on success).
- **`shogun_stats`** with **`stage: "capture"`** includes full **`settings`** document for Capture UI hydration.
- **`shogun_memory_search`** / **`memory.search`**: **async**. Lexical **FTS5** by default. Payload **`semantic: true`** + non-empty **`query`** + LLM API key → fetch a wider lexical candidate set, **`/v1/embeddings`** on the query, re-rank by cosine vs stored **`embedding` BLOB**; response may include **`semanticRerank: true`**. Without a key (or `semantic: false`) → lexical only. **When `query` is non-empty**, the FTS5 path adds **`title_highlight`** / **`snippet_highlight`** fields to each hit — matched spans wrapped in ASCII STX (`\x02`) / ETX (`\x03`) sentinels. Empty queries and semantic rerank don't produce these fields. Frontend renders them via **`hifi/lib/highlight.js`** → React `<mark>` (no `dangerouslySetInnerHTML`).
- **`shogun_memory_ingest`**: inserts row; **background embedding** for `title`+`snippet` except when **`source`** is **`capture_sampler`** or **`capture_ax`** (cost/noise). Embedding model: **`settings.sections.llm.embeddingModel`**, default **`text-embedding-3-small`** (same **`baseUrl`** / key as chat). Optional: **`provenance`** (`screen`|`connector`|`meeting`|`user`; else derived from `source`), **`entity_id`**, **`confidence`** (0–1), **`redaction`** (`none`|`summary_only`|`redacted`). Spec: **`docs/context-layer-phase-0-1.md`**.
- **`shogun_memory_embed_backfill`** / **`memory.embed_backfill`**: **async**; embeds up to **`limit`** rows (default 40, max 200) where **`embedding` IS NULL** and source not capture noise. Optional **`delayMs`** (0–3000) sleeps between rows to ease API rate limits. Transient API / network errors retry with **exponential backoff** (up to 5 attempts per row); response **`firstError`** is still the **first** failure message only. Emits Tauri event **`memory-embed-backfill-progress`** with **`{ index, total, embedded, failed }`** after each row when running in the desktop app. Returns **`embedded`**, **`failed`**, **`remaining`**, **`attempted`**, optional **`firstError`**, **`cancelled`** (true if the user cancelled mid-run). Long invoke: frontend uses an extended IPC timeout for this command.
- **`shogun_memory_embed_backfill_cancel`** / **`memory.embed_backfill_cancel`**: sets a **shared cancel flag** so the current backfill loop stops between rows; idempotent. Returns **`requested`: true**.
- `draft.create` → LLM draft via **`shogun_draft`** (requires API key in Tauri; browser mock returns Markdown).
- `schedule.create` → append to local **`schedule_queue.json`** (no OS calendar sync).
- `shogun.open_pack` → builds a **`packs/{pack_id}_{ts}/`** folder under app data (`README.md`, `memory_hits.md` from local **FTS** search), reveals in Finder (macOS) or opens README elsewhere.
- `shogun.draft_reply` → **async** LLM Markdown reply from **`brief_item`** + top Memory hits (requires API key); browser mock returns placeholder Markdown.
- `shogun.start_focus_session` → writes **`active_focus.json`**, creates **`packs/focus_{task}_{ts}/FOCUS.md`**, **`memory.ingest`** start note, opens the Markdown file.
- Many call sites use **`silentError: true`** to avoid duplicate error toasts.

## Runtime Entry Points

- `window.SHOGUN_RUNTIME.executeAction(actionKey, payload, options)`
- `window.SHOGUN_RUNTIME.requestWriteAction(actionKey, payload, title, description)`
- `window.SHOGUN_RUNTIME.pushToast(message, kind)`

## app.jsx

- Topbar `Open in Hummingbird` -> `app.open_hummingbird` (WRITE confirm)
- Share modal **Export to file…** -> `app.create_share_link`
- Chat sub-nav `New conversation` -> local chat state update

## settings-modal.jsx

- Appearance changes call `settings.save(section=appearance)`; on success the modal dispatches `shogun-appearance-changed` so the shell updates `data-color-mode` / `data-font-size` without closing.
- General **Clerk** -> `auth.status` (mount), `auth.clerk_sign_in` / `auth.clerk_sign_up`, **Sign Out** -> `auth.clerk_sign_out`
- General `Email edit` -> `settings.save(section=general)`
- Privacy -> `settings.save(section=privacy)` persists **`excludedApps`** / **`excludedSites`** / **`allowChatServerMemoryAssembly`** (default **true**; when **false**, Rust **`shogun_chat_complete`** / **`shogun_draft`** ignore **`memoryAssembly`**). On success the shell dispatches **`shogun-privacy-settings-changed`** so Chat / Memory / Work / Meetings / Agents reload the flag via **`settings.load`** without a full page refresh. **Learn more** opens hosted privacy URL or `permissions.manage` (Screen Recording); **Select .app manually** -> `privacy.pick_app` (macOS `.app` picker; browser mock returns cancelled)
- Data deletion buttons -> `data.delete_range` / `data.delete_all` / `account.delete` (WRITE confirm)
- Chat `Save` buttons -> `settings.save(section=chat.instructions|chat.notes)`
- Integrations `Connect` -> `integrations.connect`
- Integrations **Google Calendar** -> `integrations.credentials_status` (mount + Refresh), `calendar.sync` (**Sync to Memory**), **`settings.save`** (`section: integrations`) for **background sync** (`googleCalendarAutoSync`, `googleCalendarSyncIntervalMins`)
- Integrations **Gmail** -> `integrations.credentials_status` (mount + Refresh), **`integrations.connect`**, **`gmail.sync`** (**Sync to Memory**); import same shape as Calendar with **`provider: "gmail"`**
- Integrations row actions -> `integrations.toggle`
- Subscription actions -> `settings.save(section=subscription, ...)`
- Support `Report` -> `diagnostics.report`
- Support **Check for updates** -> `updates.check` then optional confirm -> `updates.download_install`
- **Model & API** pane -> `settings.save(section=llm)` includes **`embeddingModel`**, **`embedBackfillBatch`** (20|40|80|120|200), **`embedBackfillDelayMs`** (0|250|500|1000); batch/pause persist on change and with **Save endpoint**. **`memory.embed_backfill`** (requires key) uses the on-screen batch + pause; UI shows **N / M** progress (event + initial `0 / limit`), **Cancel** calls **`memory.embed_backfill_cancel`**; toasts include **`remaining`** / **`firstError`** / cancellation. **`Memory: semantic search default`** toggle -> `settings.save(section=memory, semanticRerank)` (same as Memory screen checkbox).

## screens-a.jsx

- Memory timeline (river): **Draft** / **Open in Chat** -> `draft.create` (with **`memoryAssembly`** only if **`allowChatServerMemoryAssembly`**) or **`shogun-chat-composer-seed`** + optional **`memoryAssemblyPreset`** when the same privacy flag allows server assembly; list stack **Open in Chat** same; provenance / entity id badges.
- Home Morning Brief card -> `brief.get` (mount); item CTAs -> `shogun.open_pack` / `shogun.draft_reply` / `shogun.start_focus_session`; dismiss / rating -> local state + `BriefTelemetry` + `settings.save(section=brief)`
- Home **+** menu: attach files -> hidden `<input type=file>` + **`memory.ingest`** (`source: home_attachment`); Memory / GitHub / スキル / コネクタ / プラグイン / スタイル -> `setActiveScreen` or **`openSettingsPane`** (memory, integrations, chat, appearance); リサーチ -> prepends `Research: ` to the home composer; **ウェブ検索** toggles local state and **`shogun-chat-composer-seed`** passes **`webSearch`** into Chat; **Memory 自動取得** toggles **`assembleMemory`** for Chat **Assemble**. Chat composer **Web** / **Assemble** mirror those flags; **`chat.complete`** includes **`webSearch`** → Rust `llm::chat_complete` adds a system hint (no live HTTP; user can paste URLs).
- Home CTA buttons -> `draft.create` / `schedule.create` / `settings.save`
- Memory filter / title / source searches -> `memory.search` (optional UI **`semantic: true`** for embedding re-rank when query non-empty). Memory screen checkbox persists **`settings.sections.memory.semanticRerank`** (boolean) via **`settings.save(section=memory)`** on toggle; hydrated on load before the first timeline fetch. Timeline hit title + snippet render **FTS5 match highlights** (gold `<mark>`) when the backend returns `title_highlight` / `snippet_highlight` for the active query.
- Memory **Sources in index** strip -> `entity.query` (mount, Refresh, and after `memory.ingest` on Save test)
- Memory `Save test` -> `memory.ingest` then `memory.search` refresh
- River actions: **Search title** / **Search source** -> `memory.search`; **Open in Chat** -> **`shogun-chat-composer-seed`** + **`memoryAssemblyPreset`**
- River `Remove from index` (indexed row only) -> `memory.delete` (WRITE confirm); app dispatches `shogun-memory-index-changed` on success for list refresh
- River more menu -> `settings.save(section=memory)`

## screens-b.jsx

- **`shogun-chat-composer-seed`**: `detail.text`, optional **`detail.webSearch`**, **`detail.assembleMemory`**. Optional one-shot retrieval: **`detail.memoryAssemblyPreset`** `{ query, limit?, semantic? }` or **`detail.memoryAssemblyQuery`** (+ optional **`memoryAssemblyLimit`**, **`memoryAssemblySemantic`**) — first **Send** uses this for `chat.complete.memoryAssembly` (then cleared); **`detail.clearMemoryAssemblyPreset`** clears pending preset.
- **`chat.complete`** payload may include **`webSearch`** (boolean), optional **`memoryAssembly`** `{ query, limit?, semantic? }` to **append** a system block from local Memory (default chat still uses only client **`memoryContext`**). **`shogun_draft`** / **`draft.create`**: optional **`memoryAssembly`** injects local hits into the draft prompt.
- **Agents** playground: **Draft + Memory** -> **`draft.create`** with **`memoryAssembly`**; **Open in Chat** -> composer seed + **`memoryAssemblyPreset`**.
- Composer **Assemble** toggle -> includes **`memoryAssembly`** (query from user message, `limit` 12, **`semantic`**: true) on **`chat.complete`** when on and **`allowChatServerMemoryAssembly`** is not false, unless a one-shot seed preset overrides the query for the next send. Each send logs **`BriefTelemetry`** **`chat.completion.context`** (`hasManualMemoryContext`, `manualMemoryContextChars`, `memoryAssemblyRequested`, `memoryAssemblySent`, `memoryAssemblyPreset`, `privacyAllowsServerAssembly`) and shell sink ingests a compact row via **`memory.ingest`** (`source: telemetry_chat_context`, `kinds: ["telemetry","chat"]`).
- Composer buttons (`Memory/Agent/Tool/Attach/Mic/Send`) -> `memory.search` / `schedule.create` / `integrations.connect` / `draft.create`
- **Chat "Attach memory"** uses the **current composer text** as the `memory.search` `query` when non-empty (empty → recent 12). Results render as individual hit cards in the memoryContext pane with provenance pill + `<mark>` highlights. The plain-text `memoryContext` string sent to `chat.complete` is unchanged.
- Chat header more -> `settings.save(section=chat)`
- Artifact actions (`Open in Work`, `Accept/Reject/Iterate`) -> `draft.create`
- Context actions -> `draft.create` / `schedule.create` / `app.create_share_link`
- Agents header/actions -> `settings.save(section=agents)` / `schedule.create`

## screens-c.jsx

- Work: **`memory.search`** (cards) with a **search input** (180 ms debounce) that drives the `query`; empty falls back to recent 24. Hit cards render **FTS5 highlights** on title / snippet when present. **New document** / **Draft from memory** -> `draft.create` with optional **`memoryAssembly`** (toggle「Memory を下書きに取り込む」)
- Work task row more -> `settings.save(section=work)`
- Capture pause/resume -> `capture.pause` / `capture.resume`; **Sampler** card -> `settings.save` (`section: capture`, `sampleIntervalSecs`, `axMinIntervalSecs`); mount uses `stats.get` (`stage: capture`) + `settings.load`
- Capture permissions -> `permissions.manage` (with `target: accessibility` or `screen_capture` from Capture screen)
- Google Calendar agent card -> `integrations.credentials_status`, `calendar.sync`
- Work **Memory を下書きに取り込む** -> `draft.create` with **`memoryAssembly`** only when privacy **`allowChatServerMemoryAssembly`** is not false (same as Chat)
- Integrations add/toggle -> `integrations.connect` / `integrations.toggle`
- Settings key add -> `settings.save(section=keys)`

## screens-meetings.jsx

- Dock paperclip -> `draft.create` with **`memoryAssembly`** from composer text when **`allowChatServerMemoryAssembly`** is not false (or prompt-only draft if off).
- Filter -> `memory.search`
- Prompt actions -> `draft.create` / `schedule.create`
- Recipe chips -> `brief.get`
- `All recipes` -> `brief.get(span=week)`
- Meeting lifecycle / transcript / notes / audio / MCP -> `meetings.*` (see Core Registry Keys)

## Core Registry Keys

- `app.open_hummingbird`
- `app.create_share_link`
- `settings.save`
- `settings.load`
- `integrations.connect`
- `integrations.import_credentials`
- `integrations.credentials_status`
- `integrations.toggle`
- `oauth.google.start`
- `oauth.google.app_status`
- `oauth.google.app_set`
- `agent.run_now`
- `hummingbird.context`
- `claude.sync`
- `calendar.sync`
- `apple_calendar.sync`
- `apple_reminders.sync`
- `gmail.sync`
- `capture.pause`
- `capture.resume`
- `capture.live_events`
- `capture.status`
- `onboarding.complete`
- `permissions.manage`
- `privacy.pick_app`
- `diagnostics.report`
- `updates.check`
- `updates.download_install`
- `data.delete_range`
- `data.delete_all`
- `account.delete`
- `memory.search`
- `memory.ingest`
- `memory.delete`
- `memory.export`
- `memory.import`
- `memory.embed_backfill`
- `memory.embed_backfill_cancel`
- `memory.fetch`
- `memory.summary.get`
- `memory.summary.batch`
- `memory.summary.invalidate`
- `memory.summary.set_priority`
- `memory.summary.edit`
- `memory.summary.revert`
- `memory.summary.acknowledge`
- `memory.summary.snooze`
- `memory.rollup.get`
- `memory.rollup.day.get`
- `memory.rollup.entity.get`
- `memory.rollup.month.get`
- `memory.rollup.year.get`
- `lesson.capture.rejection`
- `lesson.capture.tool_failure`
- `patterns.run_now`
- `supersession.run_now`
- `patterns.list`
- `patterns.invalidate`
- `lessons.list`
- `lessons.archive`
- `lessons.stats`
- `kioku.backup_db`
- `kioku.edge_type_proposals`
- `kioku.edge_type_review`
- `settings.export`
- `settings.import`
- `dead_letter.list`
- `dead_letter.retry`
- `dead_letter.clear`
- `dead_letter.retry_one`
- `dead_letter.delete`
- `slack.sync`
- `notion.sync`
- `github.sync`
- `linear.sync`
- `drive.sync`
- `zoom.sync`
- `outlook.sync`
- `figma.sync`
- `claude.sync`
- `entity.query`
- `brief.get`
- `chat.complete`
- `llm.save_api_key`
- `llm.api_key_status`
- `llm.clear_api_key`
- `shogun.open_pack`
- `shogun.draft_reply`
- `shogun.start_focus_session`
- `stats.get`
- `draft.create`
- `schedule.create`
- `auth.status`
- `auth.clerk_sign_in`
- `auth.clerk_sign_up`
- `auth.clerk_sign_out`
- `auth.biometric.status`
- `auth.biometric.authenticate`
- `meetings.start`
- `meetings.stop`
- `meetings.list`
- `meetings.get`
- `meetings.purge`
- `meetings.transcript.get`
- `meetings.transcript.live`
- `meetings.transcript.push`
- `meetings.transcript.for_block`
- `meetings.notes.get`
- `meetings.note.append_block`
- `meetings.note.edit_block`
- `meetings.note.delete_block`
- `meetings.enhance`
- `meetings.re_enhance`
- `meetings.search`
- `meetings.recipe.run`
- `meetings.templates.list`
- `meetings.audio.status`
- `meetings.mic.start`
- `meetings.mic.stop`
- `meetings.transcribe.pcm`
- `meetings.mcp.tools`
- `meetings.import.pick`
- `meetings.import.file`
- `mirror.register`
- `mirror.unlock`
- `mirror.status`
- `mirror.sync_now`
- `mirror.disable`
- `mirror.reset_stuck`
- `mirror.search_blobs`
- `mirror.list_devices`
- `mirror.rename_device`
- `mirror.delete_device`

## Quick Verification

```bash
./hifi/scripts/check-actions.sh
```

Or:

```bash
python3 hifi/scripts/check-actions.py
```

## E2E (Playwright)

リポジトリルートで依存関係を入れたうえで:

```bash
npm install
npx playwright install chromium
npm run test:e2e
```

`playwright.config.js` が `python3 -m http.server` で静的配信し、`SHOGUN Hi-Fi UI.html` を開いてマウントと `executeAction` を検証します。

`tests/e2e/hifi-smoke.spec.js` の追加ケース: ユーザーメニューから Settings を開いて閉じる、トップバー先頭の Hummingbird で WRITE 確認を開き Cancel または Confirm（成功トースト）。
Also: Settings > Data Controls > first Delete (WRITE confirm, Cancel); Share modal (backdrop close + Export to file toast); Memory entity sources panel; Work draft success (mock).

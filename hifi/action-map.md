# SHOGUN Hi-Fi Action Map

UIボタンと ActionRegistry / Runtime の対応表。
未接続導線の回帰チェックに使う。


**Memory（ローカルファースト）:** **`memory.db`**（**SQLite + FTS5**）、行は任意で **`embedding` BLOB**（OpenAI 互換 **`/v1/embeddings`**）。`capture_sampler` / `capture_ax` 以外の **`memory.ingest`** 後にバックグラウンドで埋め込み。**`memory.search`** で **`semantic: true`** と API キーがあれば再ランク。旧 JSON は初回のみ移行後 **`memory_items.json.migrated`**。SHOGUN Memory クラウド同期はなし。Chat・LLM / Clerk / OAuth は利用時に送信。

## v1 backend behavior (matches toasts)

- `integrations.connect` → cloud/OAuth providers: **`notImplemented`** (warn). Local tools **Arc / Raycast / Obsidian**: saves `connected` in settings (success path).
- `integrations.toggle` → persists **`connected`** per provider in `settings.sections.integrations.providers` (no `notImplemented`).
- `capture.pause` / `capture.resume` → **`honestPreferenceOnly`** (info toast). Resume sets `pipelineAvailable: true`; on **macOS** a background sampler ingests frontmost app name into memory (no screenshots). If `sections.capture.axRichCapture` is true and Accessibility is permitted, the sampler prefers a short **AX** snapshot (role/title/value/window) and falls back to the app name. Optional **`sections.capture.sampleIntervalSecs`** (4–600, default 8) sets the sampler sleep; **`sections.capture.axMinIntervalSecs`** (0–600, default 0) adds a minimum gap between **changed** AX ingests (hash dedup unchanged).
- `permissions.manage` → optional **`target`**: `"accessibility"` opens **Privacy → Accessibility**; default / `"screen_capture"` opens **Screen Recording**.
- **`app_integration_import_credentials`** (invoke) / ActionRegistry **`integrations.import_credentials`**: external agent stores per-provider JSON in Keychain (`accessToken`, optional `refreshToken`, `expiresAt`, `scopes`, **`oauthClientId`** + optional **`oauthClientSecret`** for Google token refresh). On success emits **`credentials-imported`** with `{ saved, provider, via: "invoke" }`. **`integrations.credentials_status`** returns **`configured`**, **`tokenRefreshReady`** (Google: `refreshToken` + `oauthClientId` present).
- **Deep link** (same outcome as import, desktop): `shogun-ai://credentials/import?provider=…&access_token=…` (optional snake_case or camelCase query keys; optional `oauth_client_id` / `oauth_client_secret`). Emits Tauri event **`credentials-imported`** (`via: "deep-link"`). Prefer **invoke** over URLs for secrets.
- **`shogun_google_calendar_sync`** / **`calendar.sync`**: lists near-future events with the imported Bearer token and **`memory.ingest`** each as a calendar memory (errors if token missing). Proactively refreshes the access token when **`expiresAt`** is near or on **401** if `oauthClientId` + `refreshToken` are stored. Background job: when **`sections.integrations.googleCalendarAutoSync`** is true and Keychain has credentials, syncs every **`googleCalendarSyncIntervalMins`** (5–1440, default 15).
- **`app_diagnostics_report`** / **`diagnostics.report`**: writes JSON file plus returns **`summary`** (`capture`, `macosAccessibilityTrusted`, **`integrations.google_calendar`**, **`integrations.calendarAutoSync`**).
- **`shogun_stats`** with **`stage: "capture"`** includes full **`settings`** document for Capture UI hydration.
- **`shogun_memory_search`** / **`memory.search`**: **async**. Lexical **FTS5** by default. Payload **`semantic: true`** + non-empty **`query`** + LLM API key → fetch a wider lexical candidate set, **`/v1/embeddings`** on the query, re-rank by cosine vs stored **`embedding` BLOB**; response may include **`semanticRerank: true`**. Without a key (or `semantic: false`) → lexical only.
- **`shogun_memory_ingest`**: inserts row; **background embedding** for `title`+`snippet` except when **`source`** is **`capture_sampler`** or **`capture_ax`** (cost/noise). Embedding model: **`settings.sections.llm.embeddingModel`**, default **`text-embedding-3-small`** (same **`baseUrl`** / key as chat).
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
- Privacy app toggle -> `settings.save(section=privacy)`
- Data deletion buttons -> `data.delete_range` / `data.delete_all` / `account.delete` (WRITE confirm)
- Chat `Save` buttons -> `settings.save(section=chat.instructions|chat.notes)`
- Integrations `Connect` -> `integrations.connect`
- Integrations **Google Calendar** -> `integrations.credentials_status` (mount + Refresh), `calendar.sync` (**Sync to Memory**), **`settings.save`** (`section: integrations`) for **background sync** (`googleCalendarAutoSync`, `googleCalendarSyncIntervalMins`)
- Integrations row actions -> `integrations.toggle`
- Subscription actions -> `settings.save(section=subscription, ...)`
- Support `Report` -> `diagnostics.report`
- **Model & API** pane -> `settings.save(section=llm)` includes **`embeddingModel`**, **`embedBackfillBatch`** (20|40|80|120|200), **`embedBackfillDelayMs`** (0|250|500|1000); batch/pause persist on change and with **Save endpoint**. **`memory.embed_backfill`** (requires key) uses the on-screen batch + pause; UI shows **N / M** progress (event + initial `0 / limit`), **Cancel** calls **`memory.embed_backfill_cancel`**; toasts include **`remaining`** / **`firstError`** / cancellation. **`Memory: semantic search default`** toggle -> `settings.save(section=memory, semanticRerank)` (same as Memory screen checkbox).

## screens-a.jsx

- Home Morning Brief card -> `brief.get` (mount); item CTAs -> `shogun.open_pack` / `shogun.draft_reply` / `shogun.start_focus_session`; dismiss / rating -> local state + `BriefTelemetry` + `settings.save(section=brief)`
- Home CTA buttons -> `draft.create` / `schedule.create` / `settings.save`
- Memory filter / title / source searches -> `memory.search` (optional UI **`semantic: true`** for embedding re-rank when query non-empty). Memory screen checkbox persists **`settings.sections.memory.semanticRerank`** (boolean) via **`settings.save(section=memory)`** on toggle; hydrated on load before the first timeline fetch.
- Memory **Sources in index** strip -> `entity.query` (mount, Refresh, and after `memory.ingest` on Save test)
- Memory `Save test` -> `memory.ingest` then `memory.search` refresh
- River actions (`Open in Chat`, `Open source`) -> `memory.search`
- River `Remove from index` (indexed row only) -> `memory.delete` (WRITE confirm); app dispatches `shogun-memory-index-changed` on success for list refresh
- River more menu -> `settings.save(section=memory)`

## screens-b.jsx

- Composer buttons (`Memory/Agent/Tool/Attach/Mic/Send`) -> `memory.search` / `schedule.create` / `integrations.connect` / `draft.create`
- Chat header more -> `settings.save(section=chat)`
- Artifact actions (`Open in Work`, `Accept/Reject/Iterate`) -> `draft.create`
- Context actions -> `draft.create` / `schedule.create` / `app.create_share_link`
- Agents header/actions -> `settings.save(section=agents)` / `schedule.create`

## screens-c.jsx

- Work header -> `memory.search` / `draft.create`
- Work task row more -> `settings.save(section=work)`
- Capture pause/resume -> `capture.pause` / `capture.resume`; **Sampler** card -> `settings.save` (`section: capture`, `sampleIntervalSecs`, `axMinIntervalSecs`); mount uses `stats.get` (`stage: capture`) + `settings.load`
- Capture permissions -> `permissions.manage` (with `target: accessibility` or `screen_capture` from Capture screen)
- Google Calendar agent card -> `integrations.credentials_status`, `calendar.sync`
- Integrations add/toggle -> `integrations.connect` / `integrations.toggle`
- Settings key add -> `settings.save(section=keys)`

## screens-meetings.jsx

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
- `calendar.sync`
- `capture.pause`
- `capture.resume`
- `permissions.manage`
- `diagnostics.report`
- `data.delete_range`
- `data.delete_all`
- `account.delete`
- `memory.search`
- `memory.ingest`
- `memory.delete`
- `memory.embed_backfill`
- `memory.embed_backfill_cancel`
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

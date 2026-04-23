# Multi-Provider LLM Support + Security Hardening

更新: 2026-04-23
対象: SHOGUN デスクトップ (Tauri) の LLM 呼び出し・埋め込み・API key 管理

---

## 背景

現在の `src-tauri/src/llm.rs` と `src-tauri/src/embeddings.rs` は **OpenAI `/v1/chat/completions` と `/v1/embeddings` の schema 前提**で固定実装されている:

- 認証: `Authorization: Bearer <KEY>` 固定
- Chat request body: `{model, messages, max_tokens, temperature}`
- Chat response: `choices[0].message.content` の抽出
- Embedding: `text-embedding-3-small` 固定

結果、Anthropic (`x-api-key` + `/v1/messages` の独自 schema) と Gemini (`generativelanguage.googleapis.com/v1beta/openai/*` の OpenAI 互換) のキーはそのままでは動作しない。

加えて、API key のセキュリティ面で以下のギャップがある:

- 送信先ホストに allowlist が無い（任意の URL に key が送信されうる）
- key の接頭辞と送信先ホストの整合性チェックが無い
- `app_llm_api_key_status` が provider 情報を返さないため、UI に「どのプロバイダが接続中か」を表示できない

ユーザは **OpenAI / Anthropic / Gemini のいずれのキーでも動くように** することを要求している。

## 目標

1. **3 プロバイダ自動ルーティング** — キー接頭辞から provider を判定し、適切な endpoint / auth header / request body / response extraction に自動切替
2. **Anthropic の独自 schema 対応** — `/v1/messages` + `{system, messages, max_tokens}` + `content[0].text` 抽出
3. **Gemini の OpenAI 互換 endpoint 利用** — `generativelanguage.googleapis.com/v1beta/openai/*` を OpenAI と同じ経路で扱う
4. **埋め込みの graceful degradation** — Anthropic 選択時は embedding 生成を silently fail させ、FTS のみで検索が動く状態を維持する
5. **ホスト allowlist** — 既知 3 社 + localhost + ユーザー明示許可ホストのみ key を送信する
6. **Key-prefix ⇄ Host 整合性チェック** — `sk-ant-` を OpenAI endpoint に送るなどの誤設定を実行前に拒否
7. **Provider 情報の UI 露出** — `app_llm_api_key_status` に `provider` フィールドを追加し、Settings で「Anthropic (Claude) 接続中」等を表示できる

## 非目標

- Azure OpenAI（別 auth 規約）
- Anthropic Vertex AI / AWS Bedrock 経由
- OpenAI Responses API (`/v1/responses`) / Assistants API
- Function calling / tool use のプロバイダ間差分 — 本 spec の LLM 呼び出しは純粋な chat completion のみ扱う
- ローカル LLM 専用 UI 補助 (LM Studio / Ollama) — 既に allowlist の `localhost` 経由で動く設計
- UI での provider 切替 wizard — 今回はキー入力欄の下に検出結果を表示するだけ
- embedding モデルの自動 provider 内切替（OpenAI の `-large` vs `-small` 等）

## 全体像

### Provider 検出ルール

| 接頭辞 | Provider | 典型例 |
|---|---|---|
| `sk-ant-` | Anthropic | `sk-ant-api03-...` |
| `AIza` + 長さ ≥ 35 | Gemini | `AIzaSyA...` (Google API key の標準フォーマット) |
| `sk-` (他の接頭辞でマッチしなかったもの) | OpenAI | `sk-proj-...`, `sk-svcacct-...`, legacy `sk-...` |
| 上記以外 | Custom (OpenAI 互換扱い) | ローカル LLM, OpenRouter (`sk-or-v1-`), 自社プロキシ |

**Custom 扱いの条件**: `settings.security.allowCustomLlmHost === true` が明示されているか、baseUrl が `localhost` / `127.0.0.1`。それ以外で Custom 判定されたキーは拒否。

### Provider ごとの default 設定

| Provider | Default baseUrl | Default chat model | Default embedding model |
|---|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | `text-embedding-3-small` |
| Anthropic | `https://api.anthropic.com/v1` | `claude-sonnet-4-5-20250929` | なし (fail-open) |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` | `gemini-embedding-001` |
| Custom | (user-supplied) | (user-supplied) | (user-supplied) |

`settings.sections.llm.baseUrl` / `model` / `embeddingModel` が空なら provider default を使い、値があればそれを優先。

### Host allowlist

```
api.openai.com
api.anthropic.com
generativelanguage.googleapis.com
localhost
127.0.0.1
```

ユーザが `settings.security.extraLlmHosts: ["my-corp-proxy.example"]` を明示設定した場合のみ拡張。allowlist に無いホストへの送信は実行前に `Err("host not in allowlist")` で拒否。

### Key-prefix ⇄ Host 整合性

| Provider 判定 | 許容ホスト |
|---|---|
| Anthropic (`sk-ant-`) | `api.anthropic.com` のみ |
| Gemini (`AIza...`) | `generativelanguage.googleapis.com` のみ |
| OpenAI (`sk-` 他) | `api.openai.com` or `localhost`(自己プロキシ) |
| Custom | `localhost` / `127.0.0.1` / `extraLlmHosts` のみ |

検証は `chat_complete` / `embed_one` の実行毎に走る（key や baseUrl が runtime に変わる可能性に備え、毎回検証）。

### 新規モジュール `src-tauri/src/llm_providers.rs`

責務:
- `LlmProvider` enum の定義 (`OpenAI` | `Anthropic` | `Gemini` | `Custom`)
- `detect_provider(key: &str) -> LlmProvider`
- `default_base_url(provider)` / `default_chat_model(provider)` / `default_embedding_model(provider) -> Option<&'static str>`
- `validate_host_for_provider(provider, host: &str) -> Result<(), String>`
- `build_chat_request(provider, model, messages, max_tokens) -> (headers, body)`
- `extract_chat_response(provider, body: &Value) -> Result<String, String>`
- `build_embed_request(provider, model, text) -> Result<(headers, body), String>` (Anthropic で `Err`)
- `extract_embed_response(provider, body: &Value) -> Result<Vec<f32>, String>`
- `allowlist()` / `extra_hosts_from_settings()`

純関数として実装し、ネットワーク I/O は `llm.rs` / `embeddings.rs` 側に残す。これで spec §Testing のとおり、ほとんどの branch が純粋テストでカバーできる。

### `src-tauri/src/llm.rs` の改修

現在の `chat_completions_url` / `validate_llm_base_url` は `llm_providers` が吐く `effective_base_url(provider, overridden_base)` に置き換え。`chat_complete` 本体は:

1. key 読み出し → provider 検出
2. baseUrl 決定（user override 優先、無ければ provider default）
3. allowlist + key/host 整合性チェック → NG なら即 `Err`
4. `build_chat_request(provider, ...)` で headers + body 構築
5. `reqwest` で POST
6. `extract_chat_response(provider, ...)` で content 抽出

既存の `memoryContext` / `memoryAssembly` / `webSearch` システムメッセージ追加ロジックは provider 無関係なのでそのまま残す（Anthropic の場合、messages から `role=system` を抜いて top-level `system` フィールドに連結する変換が `build_chat_request` 内で行われる）。

### `src-tauri/src/embeddings.rs` の改修

現在の `embed_one` も provider 分岐化:

1. key → provider
2. provider == Anthropic なら `Err("embeddings not supported for Anthropic")` を返す
3. OpenAI / Gemini / Custom は OpenAI 互換 schema (`input`, `encoding_format`) で投げる
4. Response の `data[0].embedding` を抽出（OpenAI 互換フォーマットが Gemini でも返る）

`memory_store::ingest` の spawn は既に `if let Err(e) = embed_row_by_id(...)` で warn のみ（fail-open）なので、Anthropic 選択時も自動的に graceful degradation する。

### `app_llm_api_key_status` の拡張

現在:
```json
{ "configured": true }
```

新仕様:
```json
{ "configured": true, "provider": "anthropic", "keyPreview": "sk-ant-...abc" }
```

- `provider`: `"openai"` | `"anthropic"` | `"gemini"` | `"custom"` | `null` (未設定)
- `keyPreview`: 最初 8 文字 + "..." + 最後 3 文字（UI 確認用、UX に寄与）。**生 key は絶対に返さない**

### UI 変更（最小）

`hifi/settings-modal.jsx` の API key 入力欄の下に検出結果を表示:

```
┌─────────────────────────────────┐
│ API Key: [sk-ant-...xyz     ]  │
│ Provider detected: Anthropic   │  ← 新規追加 (1 行)
└─────────────────────────────────┘
```

`app_llm_api_key_status` のレスポンスから `provider` を表示するだけ。既存の「API key configured ✓」表示と並ぶ。

## データモデルへの影響

- 既存 `mem_items` テーブル: 変更なし
- `embedding BLOB` 列は **生成時のモデル・provider に依存した次元数**を保持する
- Provider 切替時のリスク:
  - OpenAI `text-embedding-3-small` (1536次元) → Gemini `gemini-embedding-001` (3072次元) へ切替時、既存 embedding と cosine 計算不能 → **混在した場合の semantic 検索結果は不正確**
  - 対応: Settings で provider 切替時、UI で「既存 embedding は古いモデルのまま保持されます。統一するには Memory 設定で `memory.embed_backfill` を再実行してください」と警告

本 spec では **backfill の再実行 UI 追加は非目標**。既存の `shogun_memory_embed_backfill` IPC はそのまま残るので、必要なら手動で triggerd 可能。

## セキュリティ不変条件

**絶対に違反してはならない**:

1. 生 API key が `log::*!` / `eprintln!` / `println!` / tracing / 診断レポート に出現しない
2. 生 API key が `settings.json` に書かれない（Keychain のみ）
3. 生 API key が Tauri IPC の戻り値に含まれない（`keyPreview` はマスク済み）
4. 生 API key が allowlist 外のホストに送信されない
5. 生 API key と不整合な provider ホストに送信されない（例: `sk-ant-` を `api.openai.com` に送らない）

**SecretString wrapper の導入は本 spec の範囲外** とする（別 spec）。現状のコード監査で上記 1-5 が守られていることを確認する。

## テスト戦略

### Unit tests（`llm_providers.rs` 内）

1. `detect_provider("sk-ant-abc123") == Anthropic`
2. `detect_provider("AIzaSyAbcDef...") == Gemini` (40 chars)
3. `detect_provider("sk-proj-xyz") == OpenAI`
4. `detect_provider("sk-or-v1-xyz") == Custom`
5. `detect_provider("random-key") == Custom`
6. `detect_provider("") == Custom`
7. `default_base_url(Anthropic) == "https://api.anthropic.com/v1"`
8. `default_chat_model(Gemini).starts_with("gemini-")`
9. `default_embedding_model(Anthropic) == None`
10. `validate_host_for_provider(Anthropic, "api.openai.com") == Err(_)`
11. `validate_host_for_provider(Anthropic, "api.anthropic.com") == Ok(())`
12. `validate_host_for_provider(Custom, "random.example") == Err(_)` (allowlist 外)
13. `validate_host_for_provider(Custom, "localhost") == Ok(())`

### Request shape tests

14. `build_chat_request(OpenAI, ...)` が `{model, messages, max_tokens, temperature}` を含む
15. `build_chat_request(Anthropic, ...)` が `system` を top-level に分離し `messages` から `role=system` を除外する
16. `build_chat_request(Anthropic, ...)` header に `x-api-key` と `anthropic-version: 2023-06-01` が含まれる
17. `build_chat_request(Gemini, ...)` は OpenAI と同じ body shape（互換エンドポイントゆえ）

### Response extraction tests

18. `extract_chat_response(OpenAI, fixture)` → `choices[0].message.content`
19. `extract_chat_response(Anthropic, fixture)` → `content[0].text`
20. `extract_chat_response(Gemini, fixture)` → `choices[0].message.content`（OpenAI 互換）

### Embedding tests

21. `build_embed_request(Anthropic, ...)` → `Err`
22. `build_embed_request(OpenAI, ...)` → OpenAI 形式
23. `extract_embed_response(OpenAI, fixture)` → Vec<f32>

### Integration smoke（Manual / out-of-scope for CI）

- 実キーで OpenAI に chat_complete を投げる → 応答が返る
- 実キーで Anthropic に chat_complete を投げる → 応答が返る、embedding は silently skip
- 実キーで Gemini に chat_complete を投げる → 応答が返る
- Settings UI に provider 検出結果が表示される

## マイグレーション / ロールバック

本 spec は **破壊的変更なし**:
- 既存の OpenAI キーを使っている利用者は `detect_provider("sk-...") == OpenAI` により挙動変化なし
- 既存 embedding は保持される
- settings.json / memory.db の schema 変更なし

ロールバック: `llm_providers.rs` の削除 + `llm.rs` / `embeddings.rs` / `commands.rs` の各コミットを revert すれば旧挙動に戻る。

## 完了条件

- [ ] `llm_providers.rs` が新規追加され、23 の unit test が通る
- [ ] `llm::chat_complete` が 3 プロバイダとも動作する（形式正しい request body を吐く、response 抽出成功）
- [ ] `embeddings::embed_one` が Anthropic で `Err` を返し、OpenAI / Gemini で正常動作
- [ ] `memory_store::ingest` が Anthropic 選択時も行追加に成功する（embedding 失敗は warn のみ）
- [ ] Host allowlist が違反を実行前に拒否する
- [ ] Key-prefix ⇄ Host 不整合を実行前に拒否する
- [ ] `app_llm_api_key_status` が `provider` を返す
- [ ] Settings UI に provider 名が表示される
- [ ] 既存のフロントエンドから OpenAI キーで呼び出した場合、動作が変わらない
- [ ] `cargo build` / `cargo test --lib` 全パス
- [ ] `grep -rn "api_key\|apiKey" src-tauri/src/` に key 値が log に出る箇所が無いことを手動監査で確認

## 参考

- Anthropic Messages API: `https://docs.anthropic.com/en/api/messages`
- Gemini OpenAI 互換: `https://ai.google.dev/gemini-api/docs/openai`
- OpenAI Chat Completions: `https://platform.openai.com/docs/api-reference/chat`
- 既存実装: `src-tauri/src/llm.rs`, `src-tauri/src/embeddings.rs`
- Keychain 層: `src-tauri/src/secrets.rs`
- Context layer 仕様: `docs/context-layer-phase-0-1.md`

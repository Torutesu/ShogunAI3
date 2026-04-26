# 現状の取り出し / 注入パターン (current retrieval)

更新: 2026-04-26
監査対象: `/Users/torutano/ShogunAI3/ShogunAI3`

LLM プロンプトに対する記憶注入の経路を全列挙し、注入量・raw 度合いを評価する。

---

## 1. 注入パスの一覧

すべての記憶ヒットは `context_assembly::assemble_memory_hits()` 単一窓口を通る（Phase 1 で集約済）。
内部では `memory_store::search_with_semantics()` を呼ぶ。`semantic=true` かつ API キーありなら FTS5 wide → cosine 再ランク、無ければ FTS5 のみ。

| # | 注入元 (Rust) | 呼出経路 | 注入先 (LLM) | デフォルト Memory? | クエリ供給 | hit limit | フォーマッタ | 1 ヒット最大 (snippet) | ブロック上限 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `llm::chat_complete` | `chat.complete` | system message | **No**（明示時のみ） | `payload.memoryAssembly.query`（または手動 `memoryContext` 文字列） | 1–80（既定 12） | `format_hits_draft_context` | 400 chars | 10,000 chars (`SYSTEM_PROMPT_BUDGET_CHARS`) |
| 1' | `llm::chat_complete` | `chat.complete` (manual) | system message | No | `payload.memoryContext` を**そのまま**注入 | — | — | — | 12,000 chars クリップ |
| 2 | `llm::brief_generate` | `brief.get` | user message（JSON 出力指示） | **Yes** | **空クエリ**（直近順） | 15 固定 | `format_hits_brief_json_prompt` | 300 chars | 10,000 chars |
| 3 | `llm::draft_reply_for_brief` | `shogun.draft_reply` | user message | **Yes**（Brief item + memory） | Brief item の文字列要素から構築 | — | `format_hits_reply_draft` | 200 chars | 上限ガード無し |
| 4 | `llm::draft_from_payload` | `draft.create` 等 | user message | No（`memoryAssembly` 指定時のみ） | `memoryAssembly.query`（既定 prompt） | 1–40（既定 8） | `format_hits_draft_context` | 400 chars | 6,000 chars (`DRAFT_PROMPT_BUDGET_CHARS`) |
| 5 | `brief_actions::open_pack` | `shogun.open_pack` | **ファイル `memory_hits.md`** | **Yes（ファイル化）** | Brief item テキスト | — | `format_hits_pack_markdown` | **無制限**（snippet 全文） | 無し |
| 6 | meeting recipes (`FollowUpEmail` / `FeatureDigest` / `PrdDraft`) | recipes 経路 | LLM プロンプト | **Yes** | recipe テンプレ依存 | recipe 依存 | `format_hits_*` | 200–400 | `MEETING_DIGEST_BUDGET_CHARS=8_000` 等 |

参考: `format_hits_*` の実装は `src-tauri/src/context_assembly.rs:163–222`。`SYSTEM_PROMPT_BUDGET_CHARS=10_000` / `DRAFT_PROMPT_BUDGET_CHARS=6_000` / `MEETING_DIGEST_BUDGET_CHARS=8_000`（同 `:21–32`）。

---

## 2. 注入されるトークン量の推定

`text-embedding-3-small` は無関係（embedding 用）。LLM コンテクストはモデル依存だが、**チャットモデルへの追加負荷**は次の通り：

- 1 ヒットの 1 行: `- [provenance] title — snippet(<=400)` ≒ ASCII で 50–500 bytes
- 文字数換算: ヒット 12 件 × 平均 250 chars + 改行 = ~3,000 chars (system prompt block)
- **トークン**: 英語 ≒ 3〜4 chars/token、日本語 ≒ 1.5–2 chars/token
  - 英語ベース換算: 3,000 chars ≒ 750–1,000 tokens
  - 日本語混在: 3,000 chars ≒ 1,500–2,000 tokens
- 上限を全使い切る最悪ケース: `SYSTEM_PROMPT_BUDGET_CHARS=10_000` ≒ 2,500–6,500 tokens

特殊ケース：

- **`open_pack` の `memory_hits.md`**: snippet を**クリップせずそのまま** Markdown に書き出す。`capture_ax` 行（最大 ~2,000 字）が複数並ぶと数千トークン規模のファイルが生成される。これはファイルなので prompt には直接乗らないが、ユーザーが LLM に貼り付けるパスとして残る。
- **`memoryContext` 直渡し**: 12,000 chars クリップで、上流が何を渡してもそのまま流れる。

---

## 3. raw capture をそのまま context に入れている箇所

### 結論: **複数ある（要注意）**

| 経路 | raw capture が入る? | 詳細 |
|------|---------------------|------|
| `chat.complete` (`memoryAssembly`) | ⚠️ **あり** | `assemble_memory_hits` は `provenance` で除外しない。`capture_sampler`/`capture_ax` 行は通常検索で当たれば普通にヒットする。`format_hits_draft_context` は `[screen]` タグだけ付けて 400 char に切って system prompt に流す。 |
| `brief_generate` | ⚠️ **大いにあり** | クエリ空・直近 15 件取得 → `capture_sampler` の前面アプリ名や `capture_ax` の AX dump が**必ず混じる**（DB の大半が screen 由来）。`format_hits_brief_json_prompt` で番号付き 300 chars 抜粋として LLM に渡る。 |
| `draft_reply_for_brief` | ⚠️ あり（限定的） | Brief item テキストから組んだクエリで search → ヒットした screen 行は 200 char 抜粋として user prompt に入る。 |
| `draft_from_payload` (`memoryAssembly` 指定時) | ⚠️ あり | `chat.complete` と同等の挙動。 |
| `open_pack`（`memory_hits.md`） | ❌❌ **最悪** | snippet **全文**を Markdown に書き出す。`capture_ax` の AX dump（最大 ~2,000 chars）が**そのまま**ファイル化。Pack を開く UX はユーザーが内容を確認する想定だが、共有経路で漏れうる。 |
| `chat.complete` (`memoryContext` 手動) | △ | クライアント次第。Hi-Fi UI は telemetry を `memory.ingest` する一方で、チャット用 `memoryContext` をクライアントが組む際に capture 行を選ぶかは UI の実装依存。 |

### 補足: `provenance='screen'` の特別扱いは無い

`assemble_memory_hits` も `format_hits_*` も、**`provenance` を表示タグとしてしか使っていない**（`[screen]` のラベル付け以外フィルタしない）。`memory_store::search` 内でも除外されない。
すなわちアーキテクチャとして「raw capture は context から外す」原則が**存在しない**。

---

## 4. semantic re-rank の実体

`memory_store::search_with_semantics` (`memory_store.rs:1061–`)：

1. `semantic=true` かつ非空クエリ かつ API キーあり → 進入。さもなくば普通の FTS。
2. limit を `*8` に拡張（最大 160）して FTS / fallback で wide net。
3. クエリを 1 回 embed (`embeddings::embed_one`)。
4. 各 hit について `mem_items.embedding` BLOB を読む（**N 回の単行 SELECT**、`memory_store.rs:1115–1123`）。
5. cosine 内積でスコア。embedding が無い行 (`capture_sampler` / `capture_ax`) は `f32::NEG_INFINITY` で最下位。
6. 上位 `limit` 件にトリム。

**特性:**
- `capture_*` 行は semantic でランクアウトするが lexical で当たり続ける。
- ベクトルインデックス (HNSW) 不在 → 候補 160 件に対する 160 SELECT で完結するが、wide-net 候補がメモリ全件に近づくとスケールしない。
- L2 正規化済みの仮定で内積（コサイン）を計算（`hifi/README.md:5` の記述に依拠）。

---

## 5. プロンプト構造（system prompt 注入のテンプレ）

### 5.1 `chat.complete` (`memoryAssembly`)

```
[system] Additional context assembled from the local memory index (provenance tags in brackets):

- [connector] Deploy window — Prod cut at 19:00
- [screen] AX focus — role=AXTextField value=foo
- [meeting] 1on1 / Alex — discussed Q2 plan ...

Use when helpful.
```

### 5.2 `brief_generate`

```
[user] From these local memory items, output ONLY valid JSON with shape
{"sections":[{"title":string,"body":string}]}. No markdown code fences. ...

Memories:
1. (screen) Slack focus — channel=#shogun-eng ...
2. (connector) Calendar event — Sprint review at 14:00
... (up to 15)
```

`brief_generate` は **クエリ空 + 直近 15 件**で固定。**screen 行が大量に混ざる**最大経路。

### 5.3 `draft_reply_for_brief`

```
[user] Draft a reply for this Brief item.
Brief: (item details)

Related local memory:
- **Title** — snippet(<=200)
- **Title** — snippet(<=200)
...
```

### 5.4 `open_pack`（ファイル）

```markdown
## Related memories (local FTS index)

### {title} (`{id}`)
{snippet — full, no clipping}

### {title} (`{id}`)
{snippet — full, no clipping}
```

---

## 6. プライバシーガード（既存）

- `settings.sections.privacy.allowChatServerMemoryAssembly`（既定 true）が `chat.complete` / `draft.create` で `memoryAssembly` を尊重するかを制御。`false` なら経路 1 と 4 は丸ごと skip。
- `chat.complete` の手動 `memoryContext` は privacy フラグの影響を受けない（クライアントが自分で出した情報なので）。
- `brief_generate` / `draft_reply_for_brief` / `open_pack` / meeting recipes は privacy フラグの**外**にある（Brief / Pack / Reply / Recipe はユーザーが明示的にトリガーするため、Memory 注入が前提という建付け、`docs/context-layer-phase-0-1.md` §4）。

これは正しい原則だが、**screen 由来の raw を Brief / Pack / Reply に乗せている**ので、ユーザーが「明示的にトリガーした」だけで raw a11y dump が LLM 文脈に流れている事実は残る。

---

## 7. 観測ログ（emit）

`memory_obs::emit`（`memory_obs.rs`）と `memory_debug::RingBuffer` で各経路の `(hits, block_chars, semantic, elapsed_ms, provenance_counts)` がローカル ring buffer に記録される。`screen / connector / meeting / user` の比率は `provenance_counts_from_hits` で集計される。これは Phase 2 の評価に流用できる。

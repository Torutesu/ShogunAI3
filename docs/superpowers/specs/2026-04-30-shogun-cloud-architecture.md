# SHOGUN Cloud Architecture

> Local by default. Cloud by choice.

このドキュメントは SHOGUN のクラウド拡張 (Cloud Memory Mirror, Cloud Runtime, iPhone client) の技術設計を定義する。Claude Code handoff用。

> **メタ:** これは Phase 2.x 全体の source-of-truth リファレンス。各 phase の細部はこの spec を親として、`docs/superpowers/specs/` 配下に sub-spec を派生させる:
> - Phase 2.0a: `2026-04-30-sensitive-filter-extensions-design.md` (準備中)
> - Phase 2.0b〜2.6: 都度追加

---

## 0. 設計原則 (絶対に曲げない)

1. **Local is the source of truth.** Mac上のpgliteが原本。クラウドはmirror/extensionでしかない
2. **Server cannot decrypt user data.** どのクラウド機能でも、サーバーは生データを復号できる鍵を持たない
3. **No raw stream to cloud.** Accessibility streamの生テキストは絶対にクラウドに出ない。embeddings + structured metadataのみ
4. **Opt-in cloud features.** Cloud Memory Mirror、Cloud Runtime、iPhone同期は全て明示的オプトイン。デフォルトはfully local
5. **BYOK preserved.** ユーザーのLLM API keysはMacに保管。Cloud Runtimeは"Strict mode"ではキーを保管しない

この5つを破る変更は絶対にしない。便利さのためでも例外なし。

---

## 1. 全体アーキテクチャ

```
┌─────────────────────────────────────────────────────────────┐
│                         Mac (local)                          │
│                                                              │
│  ┌──────────────────┐    ┌───────────────────────────────┐  │
│  │ Capture Layer    │───▶│ Memory Layer (pglite + pgvec) │  │
│  │ (a11y stream)    │    │  ── source of truth ──        │  │
│  └──────────────────┘    └───────────────┬───────────────┘  │
│                                          │                   │
│                                          ▼                   │
│                          ┌───────────────────────────────┐  │
│                          │ Encryption Boundary           │  │
│                          │ (client-side encryption)      │  │
│                          └───────┬───────────────┬───────┘  │
│                                  │               │           │
│                                  │               │           │
│                          ┌───────┴────────┐ ┌───┴─────────┐ │
│                          │ Execution Engine│ │ Sync Engine │ │
│                          │ (MCP, BYOK)    │ │             │ │
│                          └───────┬────────┘ └───┬─────────┘ │
└──────────────────────────────────┼──────────────┼───────────┘
                                   │              │
                    encrypted job  │              │ encrypted index
                    definitions    │              │ (embeddings + metadata)
                                   ▼              ▼
                       ┌───────────────────────────────────┐
                       │        SHOGUN Cloud               │
                       │                                   │
                       │  ┌─────────────┐ ┌─────────────┐ │
                       │  │ Cloud       │ │ Memory      │ │
                       │  │ Runtime     │ │ Mirror      │ │
                       │  │ (jobs)      │ │ (index)     │ │
                       │  └──────┬──────┘ └──────┬──────┘ │
                       └─────────┼───────────────┼────────┘
                                 │               │
                                 │               │ encrypted query/result
                                 │               ▼
                                 │     ┌───────────────────┐
                                 │     │  iPhone client    │
                                 │     │  (read-only first)│
                                 └─────│                   │
                                       └───────────────────┘
```

**Source of truth は常に Mac**。クラウドは index と execution の延長。iPhone は窓口。

---

## 2. Memory Layer の構造 (cloud対応版)

### 2.1 ローカルスキーマ拡張

既存の `memories` テーブルに sync用のフィールドを追加する。

```sql
-- existing
CREATE TABLE memories (
  id UUID PRIMARY KEY,
  captured_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL,              -- 'a11y' | 'mcp_result' | 'user_input'
  app_id TEXT,
  window_title TEXT,
  url TEXT,
  raw_text TEXT NOT NULL,            -- ★ never leaves the device
  embedding VECTOR(1024),
  -- spatial-ready (Phase 3 prep)
  window_pose JSONB,
  gaze_target JSONB,
  dwell_ms INTEGER,
  display_id TEXT,
  window_bounds JSONB
);

-- new for cloud sync
ALTER TABLE memories ADD COLUMN sync_status TEXT DEFAULT 'local_only';
  -- 'local_only' | 'pending_upload' | 'synced' | 'excluded'
ALTER TABLE memories ADD COLUMN sync_excluded_reason TEXT;
  -- 'sensitive_field' | 'incognito' | 'user_excluded' | 'app_blocklist'
ALTER TABLE memories ADD COLUMN cloud_index_id UUID;
  -- Mirrorに上がった時のserver-side ID (server側はこのIDだけ知る)
ALTER TABLE memories ADD COLUMN encrypted_at TIMESTAMPTZ;
```

### 2.2 機密情報除外フィルタ (cloud前に必須)

クラウド機能を出す**前に**ローカルが既にクリーンである必要がある。Capture時にフィルタを通す。

```typescript
// src/capture/sensitive_filter.ts
type ExclusionReason =
  | 'password_field'       // a11y role: AXSecureTextField
  | 'payment_screen'       // pattern match: card number, CVV
  | 'incognito_window'     // browser private mode detection
  | 'app_blocklist'        // user-defined app exclusions
  | 'url_blocklist';       // user-defined URL pattern exclusions

interface CaptureResult {
  shouldStore: boolean;
  shouldSync: boolean;          // local保存はするがcloudには出さない、というケース有り
  exclusionReason?: ExclusionReason;
}

function evaluateCapture(event: A11yEvent): CaptureResult {
  // password fields: never store, even locally
  if (event.role === 'AXSecureTextField') {
    return { shouldStore: false, shouldSync: false };
  }

  // payment screens: store locally for user, never sync
  if (matchesPaymentPattern(event)) {
    return { shouldStore: true, shouldSync: false, exclusionReason: 'payment_screen' };
  }

  // incognito: store locally, never sync
  if (isIncognitoWindow(event)) {
    return { shouldStore: true, shouldSync: false, exclusionReason: 'incognito_window' };
  }

  // user-defined blocklists
  if (userBlocklist.matchesApp(event.appId)) {
    return { shouldStore: true, shouldSync: false, exclusionReason: 'app_blocklist' };
  }

  return { shouldStore: true, shouldSync: true };
}
```

ユーザー設定UIで以下を提供:
- App-level blocklist (例: 1Password, Banking apps)
- URL pattern blocklist (例: `*.bank.com/*`, `mail.google.com/draft/*`)
- Time-based blocklist (例: 22:00-07:00は記録しない)
- 緊急停止ボタン (menu bar から1クリックで capture停止)

---

## 3. Encryption Boundary

ここが全ての肝。**clientだけが復号できる**ことを保証する。

### 3.1 鍵管理

```
[User's Master Key]
    │
    │  derived from passphrase (Argon2id)
    │  + stored in iCloud Keychain (sync across devices)
    │
    ├─▶ Memory Encryption Key (MEK)        - embeddings & metadata
    ├─▶ Job Encryption Key (JEK)           - cloud runtime job definitions
    └─▶ Result Encryption Key (REK)        - cloud runtime results
```

- Master KeyはユーザーのpassphraseからArgon2idで導出。これはユーザーが覚える唯一のシークレット
- iCloud Keychainに保管することでMac間/iPhone間で自動同期 (Apple ecosystem依存だがこれで十分)
- non-Appleエコシステム対応は Phase 4以降。今はApple前提で速度優先
- Server側は Master Key, MEK, JEK, REK のいずれも保管しない

### 3.2 Searchable Encryption (検索可能暗号化)

普通のE2EEだとサーバー側で検索できない。SHOGUNはembedding-based searchが核なので、searchable encryptionが必要。

**採用方式: Encrypted ANN with client-side query encryption**

```
1. Client側で embedding生成 (Macローカル、e.g. embedding model on-device)
2. Embedding を MEK で暗号化 (deterministic encryption for index, not data)
3. 暗号化embedding + 暗号化metadata を Server に送信
4. Server は暗号化されたまま vector index を構築
   - 採用候補: SimHash-based encrypted ANN, または HE (Homomorphic Encryption) lite
   - 速度優先なら "split index" pattern: server は暗号化embeddingsを保持、client が approximate search を実行
5. Query時: Client が query embeddingを暗号化 → Server に送信
6. Server は暗号化query と 暗号化index で類似度計算 → top-K の memory IDs だけ返す
7. Client は IDs を受け取り、ローカルから raw_text を取得 (もしくは別途暗号化された summary を取得して復号)
```

**現実的な妥協ライン (Phase 2 MVP)**:
- 完全な searchable encryption は実装コストが高い
- 最初は "split architecture" で行く:
  - Server: 暗号化embeddings + 暗号化metadata を保管 (rest at encrypted)
  - Search: clientが必要な範囲(時間範囲、app filter等のmetadata条件)で暗号化blobを取得 → ローカルで復号 → ローカルで類似度計算
  - Server視点では "blob storage + filtering by encrypted-equality on metadata"
- これだと server は metadata の特定フィールドの equality だけ見える状態 (時刻、暗号化されたapp_id hash等) で raw text/embedding は見えない
- 完全な server-side similarity searchは Phase 3で導入を検討

### 3.3 暗号化対象の整理

| データ | local | cloud upload | encryption | server visibility |
|--------|-------|--------------|------------|---|
| raw_text | ✅ | ❌ never | n/a | none |
| embedding | ✅ | ✅ | MEK (AES-256-GCM) | encrypted blob |
| app_id | ✅ | ✅ | hash + MEK | hash only |
| window_title | ✅ | ✅ | MEK | encrypted blob |
| url | ✅ | ✅ | MEK + domain hash | domain hash for filtering |
| captured_at | ✅ | ✅ | plaintext | plaintext (for filtering) |
| dwell_ms | ✅ | ✅ | MEK | encrypted |
| password fields | ❌ | ❌ | n/a | n/a |
| payment screens | ✅ (optional) | ❌ | n/a | n/a |

**captured_at は plaintext で server に置く**。理由: 時間範囲filterはどうしても必要、かつ"いつ何かしてた"レベルの粒度はメタデータとして許容範囲 (ユーザー設定で plain timestamp にするか bucketed timestamp にするか選べる)。

### 3.4 鍵ローテーション

- ユーザーが passphrase を変える時、MEK/JEK/REK を再生成
- 既存の暗号化データは新しい鍵で再暗号化(client側でlazy migration)
- compromised key recoveryは別途設計 (Phase 3)

---

## 4. Cloud Runtime (Execution Layer のクラウド化)

### 4.1 2モード設計

ユーザーが選ぶ:

**Strict Mode (default)**:
- API keys は Mac 上にのみ保管
- Cloud Runtime は ジョブ定義 + 必要 contextの暗号化blobだけ持つ
- 実行時、Cloud Runtime が Mac (online時) に "key handoff request" を送る
- Mac が approve → ephemeral session key を Cloud Runtime に渡す → 実行 → セッション終了で破棄
- Macがオフラインなら job は queued state で待機 → Mac復帰時に実行 (or expire after TTL)

**Always-on Mode (opt-in)**:
- ユーザーが明示的に有効化
- Mac がCloud Runtime にAPIキーを暗号化して預ける(JEKで暗号化、Cloud Runtime のexecution contextでのみ復号される)
- Mac閉じてても完全動作
- "Always-on を有効にすると、SHOGUN Cloud があなたのAPIキーを暗号化保管します。あなたが取り消すまでこの状態が続きます。" を必ず表示

### 4.2 ジョブ定義スキーマ

```typescript
interface CloudJob {
  id: string;
  user_id: string;                    // server-visible
  trigger: JobTrigger;                // schedule | event | manual
  encrypted_definition: string;       // JEK encrypted: tools, prompts, skills
  encrypted_context_scope: string;    // JEK encrypted: which memories the job can access
  mode: 'strict' | 'always_on';
  status: 'queued' | 'waiting_for_mac' | 'running' | 'completed' | 'failed';
  created_at: timestamp;
  expires_at: timestamp;              // Strict mode: TTL for waiting state
  encrypted_result?: string;          // REK encrypted
}

type JobTrigger =
  | { type: 'schedule'; cron: string }
  | { type: 'event'; pattern: string }    // e.g. "email_received_from_*@important.com"
  | { type: 'manual' };
```

### 4.3 Memory access from Cloud Runtime

Cloud Runtimeが job 実行に必要な memory にアクセスする方法:

- ジョブ定義に "context scope" を含める (e.g. "last 7 days of emails about Project Foo")
- Strict mode: Cloud Runtime が Mac にscope通知 → Mac が該当memoryを抽出 → ephemeral session key で暗号化して push → 実行 → 終了で破棄
- Always-on mode: 該当範囲のmemoryをjob起動時にcloud側にpush(REKで暗号化)→ TTL付きで保管 → 実行終了でgarbage collected

**ここでの線**: cloud runtime は Memory全体を見ない。常にscope限定。"job が必要とする最小データだけ"を渡す原則。これは Mesa の sparse materialization と同じ思想。

### 4.4 結果の書き戻し

- Cloud Runtime の実行結果は REK で暗号化して保管
- Mac が次回online時に pull して復号 → ローカルmemoryに統合
- iPhone client も REK を持つので独立して結果確認可能

---

## 5. iPhone Client

### 5.1 Phase A (read-only)

最初は閲覧専用にする。書き込みは Mac で。

機能:
- 検索 (時間範囲、自然言語クエリ)
- "今日の recap" 表示
- "yesterday's recap" 表示
- Cloud Runtime job の結果確認
- 通知 (job completion, approval requests)

技術:
- Native iOS app (Swift / SwiftUI)
- Master Key を iCloud Keychain から取得 (passphrase 入力のみ初回)
- Memory Mirror に query → 暗号化 blob 取得 → on-device 復号 → 表示
- Background fetch で新しい job 結果を取得して通知

### 5.2 Phase B (job control)

- Cloud Runtime ジョブの起動 (e.g. "今からこのトピックについてリサーチ開始")
- ジョブの中断
- ジョブパラメータの追加指示

### 5.3 Phase C (notifications)

- "Morning brief ready"
- "Email draft awaits approval"
- "Research complete: [topic]"

### 5.4 Phase D (light approvals)

- ドラフトメールの承認 (送信 vs 編集要求)
- エージェントへの軽い追加指示
- スワイプで approve/reject

iPhoneは"second screen / remote control"。Macが本体。

---

## 6. 実装フェーズと優先順位

### Phase 2.0 (前提整備、cloud機能の前)

1. **Sensitive filter の強化** — password field除外、payment画面検出、incognito検出、ユーザーblocklist UI
2. **sync_status カラムをスキーマに追加** — 既存memoryに後から sync可否を判断できる構造
3. **緊急停止ボタン** (menu bar)
4. **Memory export/import** — ユーザーが自分のデータを完全に手元に持てる手段の保証

これが終わるまで cloud機能は出さない。ローカルがクリーンでないまま cloud に出すと、設計原則1〜5を満たせない。

### Phase 2.1 (Memory Mirror MVP)

1. **Encryption boundary 実装** — Master Key導出、MEK/JEK/REK生成、iCloud Keychain連携
2. **Cloud Mirror server backend** — encrypted blob storage (S3 + KMSではなく、自前で暗号化済みblobを置くだけのストレージ)
3. **Sync engine** — Mac → Cloud Mirror の差分同期、conflict resolution
4. **Search via split architecture** — clientが時間範囲で blob群を取得、ローカルで類似度計算
5. **Settings UI** — どのapp/URLをsyncするか、Mirror有効化/無効化

### Phase 2.2 (iPhone client - Phase A)

1. iPhoneアプリ (read-only)
2. iCloud Keychain連携で Master Key取得
3. Memory Mirror から暗号化blob取得 → ローカル復号 → 表示
4. 検索 + recap表示

### Phase 2.3 (Cloud Runtime - Strict Mode)

1. Job定義スキーマ + scheduler
2. Strict mode の key handoff protocol
3. Memory scope抽出 + ephemeral session key
4. Job result書き戻し
5. Mac側 UI (jobs management)

### Phase 2.4 (iPhone Phase B + Cloud Runtime通知)

1. iPhoneからのjob起動
2. Push通知
3. Mac起動中にiPhoneから結果確認

### Phase 2.5 (Always-on Mode)

1. ユーザーオプトインフロー
2. JEK での API key 暗号化保管
3. Mac完全オフライン時の job実行
4. Always-on状態の継続的な可視化 (UIで常に表示)

### Phase 2.6 (iPhone Phase C, D)

1. リッチ通知
2. 軽い操作 (approve/reject)

### Phase 3 へ

ここまで完了したら、SHOGUN for Teams (Collaboration Layer) の議論に入る。Memory Mirror と Cloud Runtime の基盤を再利用しつつ、共有/承認/監査の層を上に積む。Mesaのversioned filesystemをbackendに採用する選択肢を検討する段階。

---

## 7. セキュリティ・運用の決め事

### 7.1 サーバー側に絶対に置かないもの

- Master Key
- MEK / JEK / REK (Always-on modeの実行コンテキスト内 ephemeral 復号を除く)
- 生 a11y stream
- 生 raw_text
- 復号済み embedding
- API keys (Strict modeでは ephemeral session key のみ)

### 7.2 サーバー側でログ取得しないもの

- query embedding の中身 (暗号化のまま処理)
- decryptionの結果
- ユーザーのapp使用パターン (encrypted metadataのみ)

### 7.3 監査可能性

- ユーザー側で "何がcloudに上がっているか" を**完全に確認できるUI**を提供
- 各memoryに `sync_status` を表示、なぜsync excludedかも表示
- "Download all my cloud data" ボタン (暗号化blobを全部取得)
- "Delete all my cloud data" ボタン (sync状態に戻すかoffにするか選択)

### 7.4 障害設計

- Cloud Mirror が落ちてもローカル動作に影響しない (cloudはmirrorに過ぎない)
- Cloud Runtime が落ちても Strict mode jobs は Mac側で実行可能 (fallback)
- Always-on mode jobs は cloud依存なので、可用性 SLA を明示

### 7.5 法的・コンプライアンス

- データレジデンシー: ユーザーが region 選択 (US, EU, JP)
- GDPR / CCPA 対応の data deletion API
- Subprocessor list の公開
- SOC2 は Phase 3 (for Teams) に入る前に取得開始

---

## 8. コピー上の整理 (外向き)

実装が見えてきたら以下を使い分ける:

### 全体ポジション
- **Local by default. Cloud by choice.**

### 個別機能訴求
- Memory Mirror: **Your Mac stays the source of truth.**
- iPhone: **Your phone becomes the window.**
- Cloud Runtime: **Close your laptop. The work continues.**
- E2EE: **We can't read your data. Neither can our servers.** (Strict mode限定の文脈で)

### 絶対に使わない
- "Sync to the cloud" (中身が不明瞭)
- "Cloud-powered AI" (local-firstの哲学とブレる)
- "Access anywhere" (陳腐)
- "Privacy-first" 単独 (なぜそうなのかとセットで言う)

### Always-on mode の扱い
このモードは"完全な local-first"ではなくなる。コピー上、強調しない。設定画面でのみ提示する。LP/Product Hunt/Show HN等の launch communications には登場させない。

---

## 9. オープンクエスチョン

実装に入る前に決めるべき論点:

1. **Searchable encryption の具体方式**
   Phase 2.1 では split architecture (client-side similarity) で行くか、最初から server-side encrypted ANN を実装するか
   → 推奨: split architecture で MVP出して、性能ボトルネックが明らかになってから ANN を入れる

2. **Master Key recovery**
   ユーザーが passphrase 忘れた時どうするか。social recovery? hardware key backup?
   → Phase 2.1 では "recovery不可、ローカルバックアップから復元してね"が許容範囲。Phase 2.5までに social recovery 検討

3. **non-Apple エコシステム対応**
   iCloud Keychain依存だと Windows/Linux ユーザーは将来的に取り込めない
   → SHOGUN は macOS native のままなので問題は表面化しない。iPhone も Apple前提で Android対応は Phase 4以降

4. **Cloud Runtime の execution sandbox**
   Anthropic Managed Agents を使うか、自前で sandbox を持つか
   → 推奨: Phase 2.3 では Anthropic Managed Agents または Modal/E2B等の既存sandboxを採用。自前は性能要件が見えてから

5. **Memory Mirror の region 戦略**
   日本のユーザー向けに東京リージョン必要か、初期は US East で十分か
   → Phase 2.1 は US East のみで開始。日本ユーザーへの latency / regulatory issue が顕在化したら東京を追加

6. **Pricing への影響**
   Cloud機能はインフラコストが乗る。$49/$62 の中で吸収するか、Cloud有効ユーザーは別 tier にするか
   → 推奨: Cloud Mirror は標準価格内、Always-on Cloud Runtime は higher tier (e.g. $99/mo) に分離

---

## 10. 次の作業

このドキュメントが固まったら:

1. Encryption boundary の prototype 実装 (Master Key導出、MEK/JEK/REK、iCloud Keychain連携)
2. Sensitive filter の強化を SHOGUN macOS app に追加
3. Cloud Mirror server backend の skeleton (Rust or TypeScript)
4. iPhone app の Swift project skeleton

各 phase の完了基準と user-facing release criteria を別途定義する (`SHOGUN_CLOUD_RELEASE_CRITERIA.md`)。

# LP 引き継ぎメモ（デザイン刷新担当者向け）

最終更新: 2026-07-17 / 対象: `lp/` 配下の LP をドラスティックに作り替える人

このメモだけ読めば、既存の文脈なしで安全に作業を始められるように書いてあります。

---

## 0. 30秒サマリ

- LP は **完全に独立した静的サイト**。フレームワークゼロ・ビルドゼロ・`lp/` の外に依存なし。アプリ (`src/`, `src-tauri/`) と一切干渉しないので、好きなだけ作り替えてよい。
- デプロイは **`./lp/deploy.sh preview`** の1コマンド。**Cloudflare 認証は済んでいる**（`wrangler login` 不要）。
- **`./lp/deploy.sh production` は打たないこと**（後述）。
- **絶対に守る事実**が3つある（§4）。ここを間違えると製品が嘘をつくことになる。

---

## 1. 現在の状態

| | |
|---|---|
| Preview | ✅ https://preview.shogun-lp-4wd.pages.dev （常に最新 preview を指す） |
| Production | ❌ 未デプロイ |
| syogun.com | ❌ 未割当（Cloudflare ダッシュボードでカスタムドメイン設定が必要） |
| Cloudflare project | `shogun-lp`（アカウント: torubj0904@gmail.com） |

つまり **まだ世に出ていない**。preview は関係者だけが見る作業用 URL。

---

## 2. ファイル構成

```
lp/
  index.html          # EN（既定・hreflang x-default）。CSS も SVG デモも全部インライン、1ファイル完結
  ja/index.html       # JA（翻訳ではなくネイティブコピー。EN と1:1でなくてよい）
  _headers            # Cloudflare Pages: security headers + cache（Pages が自動で読む）
  deploy.sh           # ./lp/deploy.sh preview | production
  README.md           # デプロイ手順・実行時設定・ローンチチェックリスト
  404.html            # ブランド準拠の404（Pages が自動で使う）
  favicon.svg         # Kamon（gold on #080808）
  apple-touch-icon.png # 180×180
  og-en.png / og-ja.png # 1200×630（~52KB）
  robots.txt / sitemap.xml # hreflang 付き
```

**丸ごと作り替えてよい**: `index.html`, `ja/index.html`, OG 画像
**残すべき**: `_headers`, `deploy.sh`, `robots.txt`, `sitemap.xml`, `404.html`, favicon 系（作り直すなら同名で置換）

---

## 3. デプロイ

```bash
# preview（作業用・一意URLが毎回出る・本番非影響）
./lp/deploy.sh preview

# 本番（打たないこと。§3.1 参照）
./lp/deploy.sh production
```

- 認証済みなので追加設定不要。direct upload なのでビルド工程なし。
- 毎回一意の `https://<hash>.shogun-lp-4wd.pages.dev` が出る → **新旧デザインを並べて比較できる**。
- alias `https://preview.shogun-lp-4wd.pages.dev` は常に最新 preview。

### 3.1 production を打たない理由
production を打つとプロジェクトの本番 URL に出る。syogun.com を割り当てた後だと**そのまま世界に公開される**。公開判断はオーナー（Toru）が行うので、**指示があるまで preview だけ**にすること。

---

## 4. 【最重要】絶対に守る事実

2026-07-17 の製品監査で、LP に**実装より誇張した記述**が見つかり修正した。**作り替える時にうっかり元に戻さないこと。**

| 書いてよい | 書いてはいけない | 理由 |
|---|---|---|
| **12 MCP tools** | ~~20 MCP tools~~ | 実装は12個（meetings 6 + memory 4 + kioku 2）。`src-tauri/src/bin/shogun_mcp.rs` で確認できる |
| 「記憶から**下書きを用意**します。送信ボタンを押すのはあなた」 | ~~「メール・カレンダーへ線が伸びる」「acts where you work」~~ | **外部へ書き込む経路が製品に存在しない**。コネクタは全て `.readonly`。送信・予定作成・投稿は一切できない |
| 「ローカル保存・BYOK・macOS」 | 実測していない性能値・未実装機能 | 監査で裏取りした事実のみ |

**新しい主張を書く前に、必ず実装を確認すること。** 迷ったら書かない。
参考: `docs/audit/2026-07-17-product-gap-remediation-plan.md`

---

## 5. ブランド規則

`shogun-brand` スキルが正典（Claude Code なら `Skill` ツールで読める）。要点:

- **色**: `--bg #080808` / `--gold #C8A96E`。**gold は面積5%以下**（アクセントであって主役ではない）
- **トーン**: 静か・簡潔・詩的。マーケ的誇張、感嘆符、**絵文字ゼロ**
- **コピー**: "Your AI has memory. Now it acts." / 「記憶するAIから、行動するAIへ。」
  - ※ この tagline 自体は残っているが、**本文で「実際に送る」と読める表現は禁止**（§4）
- **ロゴ**: Kamon（`favicon.svg` にインライン SVG あり）
- **競合名を書かない**（Notion / Granola / Limitless 等）

---

## 6. 技術的な設計方針（踏襲推奨・変えてもよい）

現行はこう作ってある。作り替える時の参考として:

- **外部リクエストほぼゼロ**（Lighthouse 95+ 設計）。フォント・画像・スクリプトを外部から引かない
- Hero の「記憶→行動」デモは **インライン SVG + SMIL**。画像リクエストゼロ、`prefers-reduced-motion` で静止
- CSS は `<style>` にインライン（1ファイル完結を優先）
- モバイル 375px で横スクロールゼロを確認済み
- PostHog は `window.SHOGUN_POSTHOG_KEY` があれば `requestIdleCallback` で遅延ロード（未設定なら一切ロードしない）

**変えてよい**: 上記は全部。フレームワークを入れるのも自由。ただし入れるなら `deploy.sh` がビルド成果物を指すよう直すこと（今は `lp/` をそのまま upload している）。

---

## 7. 実行時設定（HTML に直書きしない）

```html
<script>
  window.SHOGUN_WAITLIST_ENDPOINT = "https://app.syogun.com/api/waitlist"; // web/ デプロイ後
  window.SHOGUN_POSTHOG_KEY = "phc_xxx"; // 任意。未設定なら解析は一切ロードされない
</script>
```

- Waitlist endpoint 未設定時: フォームは「準備中・ベータDLは今日から使える」を返す（壊れない）
- **ダウンロードリンクは `releases/latest` を使うこと**（現在 v0.4.3 が公開中）。バージョン直書きは stale になる:
  `https://github.com/Torutesu/ShogunAI3/releases/latest`

---

## 8. ローンチ前チェックリスト

- [x] OG 画像（1200×630）/ apple-touch-icon / robots / sitemap / 404 — 作り替えたら**全部作り直すこと**
- [x] Mobile 375px 破綻なし
- [ ] 本番 Lighthouse 計測（デプロイ後 `npx lighthouse <url> --view`）
- [ ] Twitter/Slack で OGP 実展開確認（デプロイ後）
- [ ] **§4 の事実チェック**（最重要）

OG 画像の作り方: HTML テンプレを Playwright で 1200×630 スクショ（`page.screenshot({clip:{width:1200,height:630}})`）。

---

## 9. 困ったら

- デプロイ周り → `lp/README.md`
- ブランド → `shogun-brand` スキル
- 「この機能って実際にあるの?」 → `docs/audit/2026-07-17-product-gap-remediation-plan.md`、または `src-tauri/src/` を grep
- Cloudflare が `not authenticated` を返したら → `npx wrangler login`（オーナーのアカウントで）

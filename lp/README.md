# SHOGUN LP（syogun.com）

自前静的 LP。フレームワークゼロ・ビルドゼロ・外部リクエストほぼゼロ（Lighthouse 95+ 設計）。
Lovable（shogunai.lovable.app）からの移行先。

## 構成

```
lp/
  index.html      # EN（既定・hreflang x-default）
  ja/index.html   # 日本語（翻訳ではなくネイティブコピー）
  favicon.svg     # Kamon（gold on #080808）
  _headers        # Cloudflare Pages: security headers + favicon cache
```

- Hero の「記憶→行動」デモは**インライン SVG + SMIL**。画像リクエストゼロ、`prefers-reduced-motion` で静止。
- コピー・色・構造は `shogun-brand` スキルに準拠（gold 面積 5% 以下、Hero=ワンライナー+サブ1行+CTA1つ、絵文字ゼロ）。

## ローカルプレビュー

```bash
cd lp && python3 -m http.server 8931
# → http://localhost:8931/ (EN) / http://localhost:8931/ja/ (JA)
```

## デプロイ（Cloudflare Pages）※まだしない

```bash
npx wrangler pages project create shogun-lp   # 初回のみ
npx wrangler pages deploy lp --project-name shogun-lp
```

- `_headers` が security headers を配信（Pages が自動で読む）
- カスタムドメイン syogun.com は Pages ダッシュボードから割当て
- → `docs/lp-download.md` の DL 導線はそのまま有効

## 実行時設定（HTML は触らない）

デプロイ先で以下を `<head>` 直後に 1 スクリプトとして注入するか、`index.html` の該当行を直接編集:

```html
<script>
  window.SHOGUN_WAITLIST_ENDPOINT = "https://app.syogun.com/api/waitlist"; // web/ デプロイ後
  window.SHOGUN_POSTHOG_KEY = "phc_xxx"; // 任意。未設定なら解析は一切ロードされない
</script>
```

- Waitlist endpoint 未設定時: フォームは「準備中・ベータDLは今日から使える」を返す（壊れない）。
- PostHog は requestIdleCallback で遅延ロード。LCP に影響しない。

## ローンチ前チェックリスト（landing-seo-perf スキル §12）

- [x] OG 画像 `og-en.png` / `og-ja.png`（1200×630・~52KB）— ブランド準拠、ブラウザ確認済み
- [x] `apple-touch-icon.png`（180×180）
- [x] `robots.txt` / `sitemap.xml`（hreflang 付き）
- [x] 404 ページ（`404.html`・ブランド準拠）
- [x] Mobile 375px 破綻なし（nav 折返し解消・横スクロールゼロ・確認済み）
- [ ] 本番 Lighthouse 計測（デプロイ後 `npx lighthouse https://syogun.com --view`）
- [ ] Twitter/Slack で OGP 実展開確認（デプロイ後）

OG 画像の再生成: `scratchpad/og-{en,ja}.html` を編集 → Playwright で 1200×630 スクショ
（`node` スクリプトで `page.screenshot({clip:{width:1200,height:630}})`）。

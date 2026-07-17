# Secrets 登録手順（自動更新 / 計測）

対象: リポジトリのオーナー（Toru）。所要 **5分**。
これを済ませると **v0.4.4 から自動更新と計測が実際に効きます**。

> **なぜ人手が必要か**: どちらも「あなたのアカウントの資格情報」を扱うので、エージェントは代行しません（アカウント作成・秘密鍵の登録は本人の操作です）。配線とコードは全部済んでいて、**キーを入れるだけ**の状態です。

---

## 1. 自動更新の鍵（TAURI_SIGNING_PRIVATE_KEY）

### 前提: 鍵はすでに生成済み

`~/.tauri/shogun-updater.key` に生成済みです（公開鍵 ID `E3182DBD…`）。
対応する公開鍵は `src-tauri/tauri.conf.json` に既にコミットされています。

> **背景**: 以前の鍵はセッションの一時領域に置かれていて消失しました。同じ事故を防ぐため、今回は**あなたのホーム配下（永続）**に置いています。

### ステップ 1-A: 鍵をバックアップ（最重要・先にやる）

```bash
# 中身を表示してパスワードマネージャに保存する
cat ~/.tauri/shogun-updater.key
```

これを **1Password / Bitwarden などに「SHOGUN updater private key」として保存**してください。

⚠️ **この鍵を失うと、それまでに配布した全インストールへ二度と自動更新を配信できません。**
（実際に一度失っており、そのせいで v0.4.2 / v0.4.3 は永久に手動 DL のままです）

### ステップ 1-B: GitHub Secret に登録

```bash
cd /Users/torutano/code/ShogunAI3

gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/shogun-updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --body ""
```

（鍵はパスワード無しで生成しているので、2つ目は空文字で正解です）

### ステップ 1-C: 確認

```bash
gh secret list | grep TAURI
```

`TAURI_SIGNING_PRIVATE_KEY` と `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` が並べば完了。

### これで何が起きるか

次にリリースを切ると `.github/workflows/release-macos.yml` が自動で:
- `createUpdaterArtifacts: true` でビルド → `.app.tar.gz` + `.sig` を生成
- `latest.json` を生成して Release に添付

→ **v0.4.4 以降を入れた人は、以後ずっとアプリ内で自動更新を受け取れます。**

---

## 2. 計測（PostHog）

### ステップ 2-A: プロジェクト作成

1. https://posthog.com にアクセスしてサインアップ（無料枠で十分: 月100万イベント）
2. プロジェクトを作成（名前: `SHOGUN`）
3. **リージョンを選ぶ画面で US か EU を選択** ← あとで使うので**どちらを選んだか覚えておく**
4. `Project Settings → Project API Key` から **`phc_` で始まるキー**をコピー

> `phc_…` は**公開キー**です（クライアントに埋め込む前提の値）。秘密ではありません。

### ステップ 2-B: GitHub Secret に登録

```bash
cd /Users/torutano/code/ShogunAI3

gh secret set VITE_POSTHOG_KEY --body "phc_ここに貼る"
```

### ステップ 2-C: EU リージョンを選んだ場合のみ（重要）

コードの既定は **US** (`https://us.i.posthog.com`) です。EU を選んだなら:

```bash
gh secret set VITE_POSTHOG_HOST --body "https://eu.i.posthog.com"
```

そして `.github/workflows/release-macos.yml` の 2箇所の `env:` ブロック
（`VITE_POSTHOG_KEY` の隣）に次を追加してください:

```yaml
          VITE_POSTHOG_HOST: ${{ secrets.VITE_POSTHOG_HOST }}
```

> US を選んだなら **2-C は不要**です。CSP は US/EU 両方を既に許可しています。

### ステップ 2-D: 確認

```bash
gh secret list | grep POSTHOG
```

### これで何が取れるか（そして取れないもの）

**取れる**: DAU/MAU、セッション数、リテンション、どの画面が使われたか
**絶対に送られない**: 画面キャプチャの中身、メモリの内容、ウィンドウタイトル、検索クエリ、ファイルパス

コード側で構造的に保証しています（`src/shared/lib/product-telemetry.ts`）:
- **同意 + ビルド時キー の両方が揃わないと初期化すらしない**（ネットワークに一切出ない）
- 送れるイベントは **allowlist の3つだけ**: `app_opened` / `screen_viewed` / `error_reported`
- プロパティも allowlist（`app_version` / `screen` / `scope` のみ）。それ以外は捨てられる
- 識別子は**匿名のランダム UUID**（メール・名前・Clerk ID は使わない）
- autocapture / session recording / surveys は**全部オフ**

---

## 3. 登録が終わったら

「登録した」と伝えてください。**v0.4.4 を切ります**（自動更新＋計測が実際に効く最初の版）。
今日 main に入った分（Outlook 解禁・日本語トースト62件の英語化・IPC 重複除去など）も同時に載ります。

### 検証手順（リリース後）

```bash
# updater 成果物が付いているか
gh release view v0.4.4 --json assets --jq '[.assets[].name]'
# → latest.json / .app.tar.gz / .sig が並べば自動更新が有効
```

計測は PostHog の Activity タブに `app_opened` が出れば疎通 OK（同意した端末のみ）。

# LP ダウンロード導線（shogunai.lovable.app）

Mac ファースト配布用。LP の DL ボタンと welcome ページが参照する URL をここで管理します。

## ダウンロード URL（v0.4.1）

| 用途 | URL |
|------|-----|
| **LP の DL ボタン（推奨）** | `https://github.com/Torutesu/ShogunAI3/releases/latest` |
| **直接 DMG（v0.4.1 固定）** | `https://github.com/Torutesu/ShogunAI3/releases/download/v0.4.1/Shogun%20AI_0.4.1_aarch64.dmg` |
| **リリース一覧** | `https://github.com/Torutesu/ShogunAI3/releases` |

> `releases/latest` は公開済みの最新 Release に飛びます。バージョンアップ時は LP の直接 DMG リンクを更新するか、`latest` のみ使う運用にしてください。

## Lovable LP でやること

1. **Download / Mac 版を入手** ボタンのリンク先を上記 URL に変更
2. ボタン近くに初回インストール注意を追記（未署名 DMG）:

   **日本語（短）**
   > 初回起動時に macOS が警告を出す場合があります。Applications フォルダで **右クリック → 開く** で起動してください（macOS 15 以降は **システム設定 → プライバシーとセキュリティ → このまま開く**）。

   詳細は [END_USER_SETUP.md](./END_USER_SETUP.md) の「未署名 DMG」を参照。

3. （任意）Waitlist フォームは現状のまま。課金 Web デプロイ後に `POST /api/waitlist` 連携を有効化。

## Web onboarding（`feat/onboarding-billing-web` マージ後）

Vercel デプロイ時に環境変数を設定:

```bash
NEXT_PUBLIC_DMG_DOWNLOAD_URL=https://github.com/Torutesu/ShogunAI3/releases/download/v0.4.1/Shogun%20AI_0.4.1_aarch64.dmg
# または
NEXT_PUBLIC_DMG_DOWNLOAD_URL=https://github.com/Torutesu/ShogunAI3/releases/latest/download/Shogun%20AI_0.4.1_aarch64.dmg
```

`releases/latest/download/` は **アセット名が一致している場合のみ** 有効です。新バージョンで DMG 名が変わるたびに env を更新するか、welcome では `releases/latest` ページへのリンクに切り替えてください。

## 新バージョンを出すとき

1. `package.json` / `tauri.conf.json` / `Cargo.toml` のバージョンを揃える
2. `git tag vX.Y.Z && git push origin vX.Y.Z`（`main` から）
3. GitHub Actions **Release macOS** が draft Release を作成
4. `gh release edit vX.Y.Z --draft=false` で公開
5. このドキュメントと LP のリンクを更新（`latest` のみなら 4 までで可）

# SHOGUN AI（デスクトップ）

macOS 向けの **Tauri v2** デスクトップアプリと、**Hi-Fi UI**（React・ブラウザ／WebView 共用）を同一プロダクトとして開発しています。

## 利用者向け（同梱・配布用ドキュメント）

- **[セットアップ（日本語）](docs/END_USER_SETUP.md)** — 起動、API キー、Memory・埋め込みの要点  
- **[プライバシー概要](PRIVACY.md)**（英語）  
- **[利用規約（日本語・ベータ）](docs/TERMS_OF_SERVICE.md)**  
- **[Terms of Service (English, beta)](docs/TERMS_OF_SERVICE_EN.md)**

## 開発者向け

- **UI / IPC / アクション一覧:** [`docs/action-map.md`](docs/action-map.md)  
- **macOS 配布・署名・公証:** [`docs/macos-release.md`](docs/macos-release.md)  
- **Morning Brief パイプライン（Node）:** [`tools/amc-pipeline/README.md`](tools/amc-pipeline/README.md)

### よく使うコマンド（リポジトリルート）

```bash
npm ci
npm run check:actions
npm run check:ipc-mock
npm run check:rust
npm run build:web-dist
npm run test:e2e
npm run build:desktop
```

## ライセンス

本ソフトウェアの**ソースコードおよびバイナリ**は、**プロプライエタリ（独占的）**です。第三者への再配布・改変・リバースエンジニアリング等は、**別途締結する契約または [`LICENSE`](LICENSE) に記載の範囲**でのみ許可されます。サードパーティのライブラリは各ライセンスに従います。

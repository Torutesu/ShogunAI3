# SHOGUN デスクトップ（Tauri）— かんたんセットアップ

このガイドは **エンドユーザー向け** の最短手順です。開発者向けの詳細はリポジトリ直下の **[`README.md`](../README.md)**、UI・IPC は **[`hifi/README.md`](../hifi/README.md)** および **`hifi/action-map.md`** を参照してください。利用条件は **[`docs/TERMS_OF_SERVICE.md`](TERMS_OF_SERVICE.md)** を参照してください。

## 1. アプリを起動

macOS で SHOGUN の Tauri ビルドを起動します（配布パッケージまたは `npm run dev:desktop` での開発起動）。

## 2. API キーを保存

1. **Settings（設定）** → **Model & API** を開きます。  
2. **Base URL**（例: `https://api.openai.com/v1`）と **Chat model** / **Embedding model** を確認します。  
3. **API key** に OpenAI 互換のキーを入力し **Save key** します。  
   キーは **macOS Keychain** に保存され、設定ファイルには書き込まれません。

## 3. Memory のベクトルが溜まる仕組み

- 会話・取り込みなどで **Memory に項目が増える**と、バックグラウンドで **`/v1/embeddings`** を呼び出し、行にベクトル（`embedding`）を書き込むことがあります。  
- ノイズ抑制のため **`capture_sampler` / `capture_ax`** 由来の行は自動埋め込みの対象外です。  
- 既存データにベクトルが無い場合は、**Settings → Model & API → Backfill missing vectors** でまとめて埋め込みできます。  
  - 進捗は **N / M** 表示、**Cancel** で中断できます。  
  - 一時的な API エラーは **指数バックオフで再試行**します（まとめには **最初のエラー文だけ** が載ります）。

## 4. 「Memory: semantic search default」の意味

- **Settings → Model & API** の **Memory: semantic search default**（Memory 画面のチェックと同じ設定）が **オン**で、検索クエリが空でないとき、  
  **FTS で拾った候補を埋め込みで再ランク**します（クエリごとに embeddings API を **1回**呼びます）。  
- **オフ**のときは **語句検索（FTS）のみ**です。  
- キーが無い場合は再ランクは行われず、語句検索のみになります。

## 5. ブラウザでのプレビューについて

`hifi` をブラウザだけで開いた場合は **モック IPC** が使われます。実際の `memory.db`・Keychain・埋め込みは **Tauri デスクトップ版**で確認してください。

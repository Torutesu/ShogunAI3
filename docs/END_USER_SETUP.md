# SHOGUN デスクトップ（Tauri）— かんたんセットアップ

このガイドは **エンドユーザー向け** の最短手順です。開発者向けの詳細は **[`README.md`](../README.md)**、UI・IPC は **[`hifi/README.md`](../hifi/README.md)** を参照してください。

## 0. ダウンロード（ベータ配布）

1. **[GitHub Releases（最新）](https://github.com/Torutesu/ShogunAI3/releases/latest)** を開く
2. **Shogun AI_*_aarch64.dmg** をダウンロード（Apple Silicon Mac 向け）
3. DMG をマウントし、**Shogun AI.app** を Applications にドラッグ

未署名ビルドのため初回起動で macOS が警告します。**右クリック → 開く**（macOS 14 以前）または **システム設定 → プライバシーとセキュリティ → このまま開く**（macOS 15 以降）。詳細は [`README.md`](../README.md) の「Unsigned ビルドのインストール」。

## 1. アプリを起動

macOS で SHOGUN を起動します（上記 DMG または開発ビルド）。

## 2. 初回セットアップ（権限）

初回起動時に **Setup ウィザード** が表示されます。

1. **Accessibility（アクセシビリティ）** — フォーカス中のウィンドウ・テキストを読み取るために必要  
2. **Input Monitoring（入力監視）** — キーボード / マウス操作の記録に必要  

**Screen Recording（画面収録）は不要です。** SHOGUN はスクリーンショットを撮りません。

3. **Start capture** を押すと、バックグラウンドで記録が始まります。

## 3. 放置して記録

Capture が **Recording** 状態なら、そのまま作業を続けてください。  
記録されるのはテキストコンテキスト（アプリ名、ウィンドウ、AX スナップショット、入力イベント）のみです。

## 4. コンテキストで Chat（メインの使い方）

記録は **検索のためだけ** ではありません。**Chat** で「さっき何してた？」「続きを教えて」と聞くと、直近のキャプチャが自動でプロンプトに入ります。

1. **Memory** 画面上部の **「コンテキストで続ける」** からプリセットを選ぶか、自由入力して **Chat で聞く**
2. または **Chat** タブを開き、**Assemble** をオンにしたまま質問する（MVP ではデフォルトでオン）
3. 特定の記憶を選んだら **Open in Chat / チャットへ** から、そのエントリを起点に続きを相談できる

**回答を得るには** Settings → Model & API で API キーが必要です。  
Memory の語句検索（FTS）だけなら API キーなしでも使えます。

## 5. Memory で検索（補助）

**Memory** 画面の Search ビューやキーワードで、過去のキャプチャを探せます。

- 例: 「Chrome」「Figma」「さっきの PDF」  
- より自然な検索が必要な場合のみ、Settings → Model & API で API キーを設定し、Memory 画面の **semantic re-rank** をオンにしてください

## 6. Capture 画面

**Capture** タブで以下を確認できます。

- **Live capture** — 直近のイベント（リアルタイム）  
- **権限ステータス** — Accessibility / Input Monitoring  
- **Pause / Resume** — 記録の一時停止

## 7. データの保存場所

Memory インデックスは **この Mac 上の SQLite**（`memory.db`）に保存されます。SHOGUN クラウドへの同期はありません。

## 8. ブラウザプレビューについて

`hifi` をブラウザだけで開いた場合はモック IPC です。実際の記録・検索は **Tauri デスクトップ版** で確認してください。

## 9. Integrations（外部サービス連携）

**Integrations** タブまたは **Settings → Integrations** から接続できます。同期されたデータは Memory に入り、Chat の文脈として使えます。

### Google（OAuth）

- **Gmail** / **Google Calendar** / **Google Drive** — アプリ内 OAuth で接続
- 初回接続後、過去データの取り込み（7日〜1年）を促すダイアログが出ます
- **本番ビルド**では Settings → Integrations の **Google OAuth app credentials** から CLIENT_ID / CLIENT_SECRET を Keychain に保存できます（開発時は `scripts/.env.google-oauth` も利用可）

### Apple（macOS ローカル）

- **Apple Calendar** / **Apple Reminders** — macOS の Calendar.app / Reminders.app から読み取り（OAuth 不要）
- **Connect** で Automation 権限を確認し、**Sync to Memory** で予定・未完了リマインダを Memory に取り込み
- 初回は **システム設定 → プライバシーとセキュリティ → オートメーション** で SHOGUN に Calendar / Reminders の操作を許可してください

### トークン貼り付け

Slack / Notion / GitHub / Linear / Zoom / **Outlook** / **Figma** / **Claude** は API トークンを貼り付けて接続します。

- **Outlook** — Microsoft Graph の `Mail.Read` 付きアクセストークン
- **Figma** — Personal Access Token。Settings → Integrations で **file keys**（Figma ファイル URL のキー部分）を登録するとデザインファイルのメタデータも同期
- **Claude** — Anthropic API キー（`sk-ant-…`）。Settings → Integrations で **export notes**（プロジェクトのエクスポート文）を登録すると Memory に取り込み

### 自動同期

各連携で **Background sync** をオンにすると、バックグラウンドで Memory へ定期的に同期されます。

## 10. Hummingbird（クイック相談）

**Option キーをダブルタップ**すると、前面アプリのコンテキストを取り込んだオーバーレイが開きます。質問を入力すると Chat と同じ LLM 経路で回答します（Settings → Model & API の API キーが必要）。

## 11. Chat の画像（Vision）

Chat の **Attach** で画像（PNG / JPEG / WebP 等）を添付すると、vision 対応モデルへ multimodal で送信されます。

- Settings → **Model & API** で API キーを設定
- vision 対応モデル（例: GPT-4o、Claude Sonnet、Gemini 等）を選択

## 12. KIOKU（記憶グラフ）

Settings → **KIOKU Graph** で有効化できます（出荷デフォルトで ON）。Capture データから LLM で記憶グラフを構築します。

- **Model & API** の API キーが必要
- **KIOKU Patterns / Lessons** は作業パターンの抽出に使います

## 13. Agents / Meetings

- **Agents** — エージェント定義とツール連携 UI（Memory / Chat 文脈を利用）
- **Meetings** — カレンダー連携と会議検出（Google Calendar 接続推奨）

## 14. データ削除

Settings → **Data Controls** で保存期間の削除（hours / days / custom 範囲）ができます。

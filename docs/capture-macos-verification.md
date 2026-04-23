# macOS キャプチャ実機検証チェックリスト

更新: 2026-04-23
対象コミット: `c963ac2`（`claude/capture-macos-polish`）で追加された
AX スナップショットの新フィールド (`AXHelp` / `AXDescription` /
`AXSelectedText`) と `AXSecureTextField` スキップ、および URL パーサ経由の
除外ホスト厳格化 (`ax_text_excluded`) が、実アプリで期待通りに振る舞うかを
ユーザが手元で確認するための手順書。

unit テストは `src-tauri/src/{macos_ax,capture_sampler}.rs` の `#[cfg(test)]`
で固めてあるが、`AXUIElement` は実 OS / 実アプリでないと挙動が出ない。
本書は「フィールドが埋まるか」「Secureが漏れないか」「除外ホストが効くか」
の三点を肉眼で確認することが目的。

---

## 0. 事前準備

1. macOS で `npm run tauri dev`（または `dev:hot`）で起動。
2. 設定 → Privacy → "AX rich capture" を **ON**。
3. 初回は macOS が Accessibility 権限ダイアログを出すので許可。
   - 出ない場合はシステム設定 → Privacy & Security → Accessibility に
     `Shogun AI 3`（または dev ビルド名）を追加してチェック。
4. サンプラは既定 8 秒間隔。検証時は設定の `sampleIntervalSecs` を 4 に
   下げると反応が速くて楽。
5. Memory 画面を開いて `source = capture_ax` の行を参照しながら進める。
   （必要なら sqlite を直接開いて `SELECT title, snippet FROM memory_items
   WHERE source='capture_ax' ORDER BY id DESC LIMIT 10;` でも可。
   DB パスは `~/Library/Application Support/<bundle-id>/memory.db`）

---

## 1. 新フィールドが乗るか（Option A）

各行の "フォーカスする要素" に 5 秒以上留まったあと、Memory の
`capture_ax` 行で snippet の各キー (`role=`, `title=`, `value=`, `help=`,
`description=`, `selected=`, `window=`) を確認する。**空行は出力されない**
ので、出ていない = その要素に該当属性がなかったことを意味する。

| # | アプリ | フォーカスする要素 | 期待される主なキー |
|---|--------|--------------------|---------------------|
| 1 | Safari | アドレスバー | `role=AXTextField`, `title=`(Address and Search), `value=`現在の URL, `description=` or `help=` あれば |
| 2 | Safari | Web ページ内の検索フォーム | `role=AXTextField`/`AXTextArea`, `title=` / `description=` (aria-label 由来), 入力中の `value=` |
| 3 | Safari | 複数行選択のあるページ本文 | `role=AXStaticText` 系, `selected=` に選択テキスト |
| 4 | Chrome / Edge | 住所欄, ページ内テキスト | 2 / 3 と同様。aria 属性を `help=` / `description=` で拾えているか |
| 5 | Mail.app | 新規メール "To" 欄 | `role=AXTextField`, `title=`To, 入力中の `value=` |
| 6 | Mail.app | 本文 | `role=AXTextArea`, `value=`本文先頭 500 文字, `selected=`選択範囲 |
| 7 | Notes.app | ノート本文 | `role=AXTextArea`, `value=`, 選択ありなら `selected=` |
| 8 | Slack / Discord | メッセージ入力欄 | `role=AXTextArea`, `description=` or `help=`, `value=`入力中テキスト |
| 9 | Terminal / iTerm2 | プロンプト行 | `role=AXTextArea`, `value=`スクロールバック末尾 |

**合格基準**: 少なくとも `role=` と `window=` が全ケースで出る。`help=` /
`description=` / `selected=` のいずれかが #2 〜 #8 のうち **過半数で観測
できる**こと（全部埋まるとは限らない — aria 属性を設定していないページ
や単純なフィールドでは空になる）。

---

## 2. Secure フィールドが漏れないか（Option A の最重要確認）

| # | アプリ | フォーカスする要素 | 期待 |
|---|--------|--------------------|------|
| 10 | システム設定 → Touch ID & Password | "Old password" 入力 | Memory に `capture_ax` 行が **増えない**（= Secure なのでスナップショット自体が `None`） |
| 11 | Keychain Access のパスワード入力ダイアログ | パスワード欄 | 同上 |
| 12 | 1Password / ブラウザ保存 PW の autofill プロンプト | マスター PW 欄 | 同上 |
| 13 | Web サイトの `<input type="password">`（例: GitHub ログイン） | PW 欄 | 同上。**`value=`にハッシュ風文字列が残っていたら重大バグ**。 |

**合格基準**: #10 〜 #13 の間、Memory に `capture_ax` 行が増えないこと。
ただし同時に別ウィンドウがあればその行は出てよい（あくまで focused 要素
が secure のとき `None` を返す仕様）。

---

## 3. 除外ホストが効くか（Option D）

設定 → Privacy → Excluded sites に
`internal.corp.example`（存在しないドメインで OK）を追加して ON にした
うえで、Safari で以下の URL を開きアドレスバーにフォーカス。

| # | 開く URL / 表示 | 期待 |
|---|------------------|------|
| 14 | `https://internal.corp.example/foo` | `capture_ax` 行が **増えない** |
| 15 | `https://mail.internal.corp.example/inbox` | 増えない（subdomain match） |
| 16 | `https://not-internal.corp.example/` | **増える**（ハイフン前置なので別ドメイン） |
| 17 | `https://internal.corp.example.gov/` | **増える**（TLD が違う） |
| 18 | テキストエディタに `窓口: internal.corp.example を参照` と書いてフォーカス | 増えない（bare host 検出） |
| 19 | テキストエディタに `社内 — internal.corp.example を開く` | 増えない（em dash / 日本語混在でも効く） |

`internal.corp.example` はダミーなので DNS 解決は失敗するが、Safari の
ページ読み込み失敗時でもアドレスバー自体は AX に現れるため判定は走る。

**合格基準**: #14 / #15 / #18 / #19 で行が増えず、#16 / #17 で行が
増えること。

---

## 4. レッドフラグ（= バグ）

以下のいずれかが起きたら GitHub Issue を切る:

- PW 欄フォーカス中に `capture_ax` 行が増え、`value=` に何かしら文字が
  入る。→ `AXSecureTextField` 判定が効いていない（role 名が違う
  プラットフォーム / ブラウザ由来の可能性）。
- `mail.internal.corp.example` で行が増える。→ suffix match が
  壊れている。
- `not-internal.corp.example` で行が **増えない**。→ bare host scan が
  広すぎる（誤検知）。
- Accessibility 権限がない状態で `shogun-capture-ax-not-trusted` トースト
  が出ない。→ 権限チェックの配線ミス。

---

## 5. クリーンアップ

検証後は Excluded sites の `internal.corp.example` 行を削除 / OFF に
戻すこと。そのまま残すと本番設定を汚す。

`capture_ax` の検証行を削除したい場合は `DELETE FROM memory_items WHERE
source='capture_ax' AND created_at > <検証開始 unix_ms>;` で消せる。
FTS インデックスは trigger で追随する。

---

## 6. 参考

- 実装: `src-tauri/src/macos_ax.rs`（`AxFields`, `format_snapshot`),
  `src-tauri/src/capture_sampler.rs`（`ax_text_excluded`,
  `host_suffix_match`）
- unit テスト: 同ファイル内 `#[cfg(test)]`。59 件パス。
- 設計メモ: `docs/capture-platform-polyfill.md`（Windows / Linux への
  展開はここで追うこと）

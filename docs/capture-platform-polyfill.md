# キャプチャ平台ポリフィル設計

更新: 2026-04-22
対象: `src-tauri/src/capture_sampler.rs` の `frontmost_app_name()` と AX 関連処理を、macOS 以外のデスクトップ OS へ拡張する方針。

---

## 1. 現状

### 1.1 実装済み (macOS)
- `frontmost_app_name()` は `osascript` で最前面アプリのプロセス名を取得。
- `focused_ax_snapshot()` は Accessibility (AX) API で `role` / `title` / `value` / `window` を連結した短文を取得。`AXIsProcessTrusted()` で権限を事前確認。
- `start_background_sampler()` のメインループは `#[cfg(target_os = "macos")]` で丸ごとガードされており、他 OS では空回り（タイマーのみ動作）。

### 1.2 動作しない (Windows / Linux)
- `frontmost_app_name()` は `None` を返す分岐のみ。
- AX 相当のスナップショットは取得ルートが無い。
- `excludedApps` / `excludedSites` の評価ロジックは動くが、入力（app 名 / AX テキスト）が常に空なので実害なし／効果なし。

---

## 2. ゴール

**最前面アプリ名の取得**を Windows と Linux (X11) に拡張し、`capture_sampler` が両 OS でも最低限動作する状態にする。AX 相当のリッチスナップショットは **スコープ外**（§6 参照）。

---

## 3. 平台別設計

### 3.1 Windows

**API 選択**：Win32 の `GetForegroundWindow` → `GetWindowThreadProcessId` → `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` → `QueryFullProcessImageNameW`。

- 権限：通常ユーザーで可、管理者不要、UAC 昇格不要。
- 失敗しやすい条件：`hwnd == 0`（フォアグラウンドなし）、別セッションのプロセス、保護プロセス（PPL 対象の一部システムプロセス）→ すべて `None` 返却で吸収。
- 返り値の正規化：フルパスを basename に縮め、末尾 `.exe` / `.EXE` を除去（macOS の「Finder」「1Password」に近いユーザー向き表示に）。

**依存クレート**：`windows = "0.57"` (Microsoft 公式、Tauri 2 周辺と互換). `target_os = "windows"` 限定で追加。

**Cargo.toml 追記例**：
```toml
[target.'cfg(target_os = "windows")'.dependencies]
windows = { version = "0.57", features = [
  "Win32_Foundation",
  "Win32_UI_WindowsAndMessaging",
  "Win32_System_Threading",
] }
```

**コードスケッチ**：
```rust
#[cfg(target_os = "windows")]
fn frontmost_app_name() -> Option<String> {
  use windows::Win32::Foundation::CloseHandle;
  use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
    PROCESS_QUERY_LIMITED_INFORMATION,
  };
  use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowThreadProcessId,
  };

  unsafe {
    let hwnd = GetForegroundWindow();
    if hwnd.0.is_null() {
      return None;
    }
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 {
      return None;
    }
    let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
    let mut buf = [0u16; 32_768];
    let mut len = buf.len() as u32;
    let res = QueryFullProcessImageNameW(
      handle,
      PROCESS_NAME_FORMAT(0),
      windows::core::PWSTR(buf.as_mut_ptr()),
      &mut len,
    );
    let _ = CloseHandle(handle);
    if res.is_err() || len == 0 {
      return None;
    }
    let path = String::from_utf16_lossy(&buf[..len as usize]);
    let basename = path
      .rsplit(|c: char| c == '/' || c == '\\')
      .next()
      .unwrap_or(&path);
    let stripped = basename
      .trim_end_matches(".exe")
      .trim_end_matches(".EXE");
    if stripped.is_empty() {
      None
    } else {
      Some(stripped.to_string())
    }
  }
}
```

**テスト**：純関数として抽出できる部分は `strip_exe_suffix(&str) -> &str` と `path_to_basename(&str) -> &str`。これらは OS 非依存のユニットテスト対象。`unsafe` 部分は実機必須（サンドボックスでは不可）。

---

### 3.2 Linux / X11

**API 選択**：Root Window 上の `_NET_ACTIVE_WINDOW` atom を読み取り → 対象ウィンドウの `_NET_WM_PID` → `/proc/{pid}/comm` を読む。

- 権限：通常ユーザーで可。
- 失敗条件：Window Manager が `_NET_WM_*` を実装していない（稀）、PID が取れない（リモート X 経由等）、`/proc` 読み取り不可（コンテナ内）→ すべて `None` で吸収。
- セッション判定：`std::env::var("XDG_SESSION_TYPE")` が `"x11"` または未設定のときのみ実行。`"wayland"` なら `None`（§3.3 参照）。

**依存クレート**：`x11rb = "0.13"` (pure-Rust, `default-features = false` で lib 依存を減らす) または `xcb = "1.4"` (C lib 依存)。メンテ状況・軽量さから **`x11rb` を推奨**。

**Cargo.toml 追記例**：
```toml
[target.'cfg(target_os = "linux")'.dependencies]
x11rb = { version = "0.13", default-features = false }
```

**フロー**：
1. `x11rb::connect(None)` で既定ディスプレイへ接続
2. `_NET_ACTIVE_WINDOW`, `_NET_WM_PID` atom を取得 (`InternAtom`)
3. Root window の `_NET_ACTIVE_WINDOW` プロパティ → 対象 Window ID
4. 対象 window の `_NET_WM_PID` → PID
5. `fs::read_to_string(format!("/proc/{pid}/comm"))` → アプリ名（末尾改行 trim）

**テスト**：`parse_comm_line(&str) -> Option<String>` を純関数として抽出してユニットテスト。X11 接続経路は実機必須。

---

### 3.3 Linux / Wayland

**結論：ポリフィル対象外。起動時に 1 回 `log::info!` で「未対応」を記録するのみ。**

理由：
- Wayland のセキュリティモデル上、非特権クライアントは他ウィンドウの情報取得不可（設計意図）。
- コンポジタ依存プロトコル（`wlr-foreign-toplevel-management-v1`、`ext-foreign-toplevel-list-v1`）は存在するが、GNOME / KDE / Sway / Hyprland で対応状況がバラバラ。
- 実装量が大きく、品質の担保が難しい（コンポジタ毎に検証が要る）。
- ユーザー価値に対してコストが見合わない。

**将来の拡張余地**：`ext-foreign-toplevel-list-v1` が十分普及した段階で別設計で対応。現状はスコープ外。

---

## 4. プライバシーフィルタの意味論

`sections.privacy.excludedApps[].name` の照合方式は、**OS ごとに異なる実体と照合する**ことをユーザーに明示する必要あり。

| OS | 照合対象 |
|----|---------|
| macOS | AppleScript `name of ... process` → プロセス表示名（例: `"Finder"`, `"1Password"`） |
| Windows | `QueryFullProcessImageNameW` basename from `.exe` stripped（例: `"Finder"` は無い、`"Explorer"` / `"1Password"`） |
| Linux/X11 | `/proc/{pid}/comm`（15 文字制限あり、例: `"firefox"`, `"code"`） |

### 設計方針
- 1 インストール = 1 OS のため、ユーザーは現在の OS 向けリストを管理すれば良い。
- 設定 UI 側で OS を検出し、現 OS に合わない名前に警告を出すのは将来検討。
- **今回の polyfill 実装ではそのままユーザー入力値と大小無視で一致判定**（既存 macOS 実装と同じ仕様）。

### 現状の比較ロジックへの影響
`capture_sampler::app_excluded()` は `trim()` + `to_ascii_lowercase()` 比較。これは OS 非依存なのでコード変更不要。

---

## 5. AX スナップショットの平台差

AX 相当のリッチスナップショット（role / title / value / window 抽出）を Windows / Linux でやるには：

| OS | 選択肢 | スコープ判定 |
|----|--------|-------------|
| Windows | UI Automation (UIA) via `windows` クレート | **スコープ外** — API 複雑、マーシャリング重い、ペイロード大 |
| Linux/X11 | AT-SPI (D-Bus) via `atspi` クレート | **スコープ外** — D-Bus 依存、AT デーモン必須、環境差 |
| Linux/Wayland | なし（§3.3 同様） | 対象外 |

**結論**：本ポリフィル設計では **AX スナップショットは macOS 専用のまま**。`axRichCapture` フラグは他 OS では単に無視される（現状通り）。将来 UIA 対応は別設計で。

---

## 6. 実装順序の提案

1. **Windows** を最優先（ユーザー母数最大、API 最も単純、実機テスト容易）
2. **Linux/X11** を次（実装容易、ユーザー母数は小さいが設計は Windows とパラレル）
3. **Wayland / UIA / AT-SPI** は当面扱わない

各ステップは独立 PR 推奨。

---

## 7. 本 PR でやらないこと（スコープ外）

- 任意 OS の実装コード（検証手段なし）
- `excludedApps` の OS 別正規化 UI
- AX 相当のリッチスナップショット実装（§5）
- Wayland 対応（§3.3）
- macOS 既存挙動の変更

---

## 8. 参考

- Microsoft Learn — [`GetForegroundWindow`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getforegroundwindow), [`QueryFullProcessImageNameW`](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-queryfullprocessimagenamew)
- EWMH 仕様 — [`_NET_ACTIVE_WINDOW`, `_NET_WM_PID`](https://specifications.freedesktop.org/wm-spec/wm-spec-latest.html)
- Wayland プロトコル — [`ext-foreign-toplevel-list-v1`](https://wayland.app/protocols/ext-foreign-toplevel-list-v1)
- 本リポジトリ参照 — `src-tauri/src/capture_sampler.rs`, `src-tauri/src/macos_ax.rs`, `hifi/action-map.md`

//! Per-app capture strategies.
//!
//! The default capture pipeline (`macos_ax::focused_ax_snapshot` → OCR
//! fallback) is generic: it pulls whatever the focused element exposes via the
//! accessibility tree. That works adequately for "dumb" apps but throws away
//! signal we can cheaply recover for a handful of common apps:
//!
//!   * **Browsers** (Chrome/Arc/Brave/Edge, Safari) — AX usually only surfaces
//!     the focused field. The browser knows the URL + page title; AppleScript
//!     can ask for it directly.
//!   * **Editors** (VSCode/Cursor/Code) — the window title encodes the open
//!     file and project (`main.rs — myproject`). AX won't say that.
//!   * **Terminals** (Terminal/iTerm2/Ghostty/Alacritty) — the existing AX
//!     fallback already returns full scrollback. We don't change the behavior
//!     here, but tagging the capture with `strategy = "terminal"` lets the
//!     downstream pipeline reason about it.
//!
//! Strategies run *before* the AX-tree / OCR pipeline. If `capture_for_app`
//! returns `Some`, the caller should use that payload; otherwise it falls
//! through to the existing fallback. All strategies are best-effort: on
//! timeout, parse failure, or any AppleScript error they return `None` and we
//! let the generic pipeline handle the app.
//!
//! Non-macOS builds compile to a no-op stub returning `None`.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

/// Per-strategy result. `text` is the human-readable summary that downstream
/// context-assembly should treat as the primary capture; `url` and
/// `window_title` are optional structured extras strategies can surface for
/// telemetry / link extraction; `strategy` is a stable identifier for which
/// branch produced this capture (used by tests and observability).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppCapture {
  pub text: String,
  pub url: Option<String>,
  pub window_title: Option<String>,
  pub strategy: String,
}

/// Stable identifier for which strategy was selected for an app name. This is
/// a pure function — exposed so the wiring layer can branch on it without
/// running AppleScript, and so tests can pin down the dispatch table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Strategy {
  Chrome,
  Safari,
  VsCode,
  Terminal,
  None,
}

impl Strategy {
  /// String identifier embedded in `AppCapture.strategy`.
  pub fn as_str(&self) -> &'static str {
    match self {
      Strategy::Chrome => "chrome",
      Strategy::Safari => "safari",
      Strategy::VsCode => "vscode",
      Strategy::Terminal => "terminal",
      Strategy::None => "none",
    }
  }
}

/// Hard wall-clock budget for any single `osascript -e` invocation. AppleScript
/// can hang indefinitely if the target app is unresponsive (sleeping, beach-
/// balling, mid-launch); we'd rather miss this sample than freeze the capture
/// thread.
const OSASCRIPT_TIMEOUT_MS: u64 = 1500;

/// Cap returned text size so a giant scrollback / page title doesn't bloat
/// snapshots. Matches the scale of other capture clamps in the codebase
/// (macos_ocr uses 8K; we're tighter here since strategy output is meant to be
/// concise structured data, not a wall of OCR).
const MAX_STRATEGY_BYTES: usize = 4000;

/// Terminal AX scrollback can be enormous (full visible history); only the
/// tail is contextually relevant to "what is the user doing right now".
const TERMINAL_TAIL_BYTES: usize = 2000;

/// Pure-function dispatch table. Lowercased, contains-match against the app
/// name reported by macOS (`NSRunningApplication.localizedName`). Matching is
/// case-insensitive; ordering matters where ambiguous names overlap
/// (`"Edge Animate"` must NOT match `"edge"` even though `"edge"` is a
/// substring — Edge Animate is an Adobe authoring tool, not a browser).
pub fn match_strategy(app_name: &str) -> Strategy {
  let lower = app_name.to_ascii_lowercase();

  // Safari first: short name, exact-ish match. We also have to be careful
  // not to confuse "Safari Technology Preview" or "Safari" with arbitrary
  // app names containing "safari"; contains-match is fine because no other
  // mainstream macOS app embeds that string.
  if lower.contains("safari") {
    return Strategy::Safari;
  }

  // Edge Animate is an Adobe authoring app, not a browser. Explicit
  // exclusion before the chromium check below — otherwise "edge animate"
  // would match "edge" and we'd send AppleScript to an app that doesn't
  // implement the chromium URL API.
  if lower.contains("edge animate") {
    return Strategy::None;
  }

  // Chromium family. All four ship the same AppleScript dictionary
  // (`URL of active tab of front window`, `title of active tab of front
  // window`) so we can use one implementation parameterized by app name.
  if lower.contains("chrome")
    || lower.contains("arc")
    || lower.contains("brave")
    || lower.contains("edge")
  {
    return Strategy::Chrome;
  }

  // Editors: VSCode reports as "Code" (the binary) or "Visual Studio Code"
  // (the bundle name); Cursor is its own bundle. We match the substrings
  // that uniquely identify each.
  if lower == "code"
    || lower.contains("visual studio code")
    || lower.contains("cursor")
  {
    return Strategy::VsCode;
  }

  // Terminals. Includes the macOS built-in plus the common third-party
  // emulators (iTerm2, Ghostty, Alacritty, Kitty, WezTerm). We include
  // these so downstream code can tag terminal captures even though the
  // AX fallback would have worked fine.
  if lower == "terminal"
    || lower.contains("iterm")
    || lower.contains("ghostty")
    || lower.contains("alacritty")
    || lower.contains("kitty")
    || lower.contains("wezterm")
  {
    return Strategy::Terminal;
  }

  Strategy::None
}

/// Returns a per-app capture payload, or `None` if no strategy applies or the
/// strategy failed (timeout, parse error, AppleScript permission denied).
/// macOS-only — other platforms get the stub below.
#[cfg(target_os = "macos")]
pub fn capture_for_app(app_name: &str) -> Option<AppCapture> {
  match match_strategy(app_name) {
    Strategy::Chrome => capture_chromium(app_name),
    Strategy::Safari => capture_safari(),
    Strategy::VsCode => capture_vscode(),
    Strategy::Terminal => capture_terminal(),
    Strategy::None => None,
  }
}

#[cfg(not(target_os = "macos"))]
pub fn capture_for_app(_app_name: &str) -> Option<AppCapture> {
  None
}

/// Parse the standard VSCode-family window title.
///
/// Format observed in the wild:
///   * `"main.rs — myproject"`           (saved file, em-dash separator)
///   * `"● main.rs — myproject"`         (unsaved-changes dot prefix)
///   * `"main.rs - myproject"`           (some forks use ASCII hyphen)
///   * `"README.md"`                     (file open with no folder/project)
///
/// Returns `(filename, project_or_none)`. The leading `●` is stripped. Splits
/// on em-dash (`—`, U+2014) first, then falls back to ` - ` (with surrounding
/// spaces so we don't shred hyphenated filenames like `my-file.rs`).
pub fn parse_vscode_title(title: &str) -> (String, Option<String>) {
  let trimmed = title.trim();
  // Strip the unsaved-changes dot and any whitespace that follows it.
  let cleaned = trimmed
    .strip_prefix('\u{25CF}') // ●
    .map(|s| s.trim_start())
    .unwrap_or(trimmed);

  // Em-dash is the canonical separator VSCode uses; check it first.
  if let Some((file, rest)) = cleaned.split_once('\u{2014}') {
    let file = file.trim().to_string();
    let project = rest.trim();
    return (
      file,
      if project.is_empty() {
        None
      } else {
        Some(project.to_string())
      },
    );
  }

  // Fall back to ` - ` (with required surrounding spaces) so hyphenated
  // filenames stay intact. `split_once` returns the FIRST hit, which is the
  // boundary closest to the filename — exactly what we want.
  if let Some((file, rest)) = cleaned.split_once(" - ") {
    let file = file.trim().to_string();
    let project = rest.trim();
    return (
      file,
      if project.is_empty() {
        None
      } else {
        Some(project.to_string())
      },
    );
  }

  // No separator found → entire string is the filename, no project context.
  (cleaned.to_string(), None)
}

/// Truncate a `String` to at most `max` bytes at a char boundary. Mirrors the
/// helper in `macos_ocr::clamp_bytes` — kept private here to avoid spreading
/// public surface for a one-line utility.
fn clamp_bytes(s: String, max: usize) -> String {
  if s.len() <= max {
    return s;
  }
  let mut end = max;
  while end > 0 && !s.is_char_boundary(end) {
    end -= 1;
  }
  s[..end].to_string()
}

/// Keep only the last `max` bytes of `s`, snapped forward to a char boundary
/// so we never slice mid-codepoint. Used for terminal scrollback where the
/// tail is the contextually-interesting region.
fn clamp_tail_bytes(s: &str, max: usize) -> String {
  if s.len() <= max {
    return s.to_string();
  }
  let mut start = s.len() - max;
  while start < s.len() && !s.is_char_boundary(start) {
    start += 1;
  }
  s[start..].to_string()
}

#[cfg(target_os = "macos")]
mod imp {
  use super::OSASCRIPT_TIMEOUT_MS;
  use std::io::Read;
  use std::process::{Command, Stdio};
  use std::time::{Duration, Instant};

  /// Run `osascript -e <script>` with a hard `OSASCRIPT_TIMEOUT_MS` deadline.
  /// On timeout the child is killed and `None` is returned. Returns
  /// `Some(stdout_trimmed)` on clean exit with status 0; `None` otherwise.
  /// Stderr is discarded — AppleScript errors are noisy and the only signal
  /// we care about at this layer is "did it produce output?".
  pub(super) fn run_osascript(script: &str) -> Option<String> {
    let deadline = Instant::now() + Duration::from_millis(OSASCRIPT_TIMEOUT_MS);
    let mut child = Command::new("/usr/bin/osascript")
      .arg("-e")
      .arg(script)
      .stdin(Stdio::null())
      .stdout(Stdio::piped())
      .stderr(Stdio::null())
      .spawn()
      .ok()?;

    let mut stdout = child.stdout.take();
    loop {
      match child.try_wait() {
        Ok(Some(status)) => {
          if !status.success() {
            return None;
          }
          let mut buf = String::new();
          if let Some(ref mut s) = stdout {
            // Best-effort read; if AppleScript exited cleanly with no
            // output we return Some("") and let the caller decide.
            let _ = s.read_to_string(&mut buf);
          }
          let trimmed = buf.trim().to_string();
          return Some(trimmed);
        }
        Ok(None) => {
          if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
          }
          std::thread::sleep(Duration::from_millis(20));
        }
        Err(_) => {
          let _ = child.kill();
          let _ = child.wait();
          return None;
        }
      }
    }
  }
}

#[cfg(target_os = "macos")]
fn capture_chromium(app_name: &str) -> Option<AppCapture> {
  // Defensive: AppleScript double-quotes are the string delimiter, so any
  // double-quote in the app name would break parsing. Real chromium-family
  // app names never contain `"`, but reject if it shows up rather than
  // emitting broken script.
  if app_name.contains('"') || app_name.contains('\\') {
    return None;
  }
  let script = format!(
    r#"tell application "{app}"
  set theURL to URL of active tab of front window
  set theTitle to title of active tab of front window
  return theURL & "
" & theTitle
end tell"#,
    app = app_name
  );
  let raw = imp::run_osascript(&script)?;
  // AppleScript's `&` of two strings with a literal newline in between
  // produces "url\ntitle" on stdout. Some chromium forks return CR-only or
  // CRLF; `lines()` handles all three.
  let mut lines = raw.lines();
  let url = lines.next()?.trim().to_string();
  let title = lines.next().map(|s| s.trim().to_string()).unwrap_or_default();
  if url.is_empty() {
    return None;
  }
  let text = if title.is_empty() {
    format!("URL: {}", url)
  } else {
    format!("URL: {}\nTitle: {}", url, title)
  };
  Some(AppCapture {
    text: clamp_bytes(text, MAX_STRATEGY_BYTES),
    url: Some(url),
    window_title: if title.is_empty() { None } else { Some(title) },
    strategy: Strategy::Chrome.as_str().to_string(),
  })
}

#[cfg(target_os = "macos")]
fn capture_safari() -> Option<AppCapture> {
  // Safari's `current tab` only exists when a window with tabs is open; if
  // the user is on the "favorites" start page or no window is frontmost we
  // get an AppleScript error → `run_osascript` returns None and we fall
  // through.
  let script = r#"tell application "Safari"
  set theURL to URL of current tab of front window
  set theName to name of front window
  return theURL & "
" & theName
end tell"#;
  let raw = imp::run_osascript(script)?;
  let mut lines = raw.lines();
  let url = lines.next()?.trim().to_string();
  let title = lines.next().map(|s| s.trim().to_string()).unwrap_or_default();
  if url.is_empty() {
    return None;
  }
  let text = if title.is_empty() {
    format!("URL: {}", url)
  } else {
    format!("URL: {}\nTitle: {}", url, title)
  };
  Some(AppCapture {
    text: clamp_bytes(text, MAX_STRATEGY_BYTES),
    url: Some(url),
    window_title: if title.is_empty() { None } else { Some(title) },
    strategy: Strategy::Safari.as_str().to_string(),
  })
}

#[cfg(target_os = "macos")]
fn capture_vscode() -> Option<AppCapture> {
  // We ask System Events for the frontmost process's front-window name
  // rather than wiring a new AX call, since:
  //   * the existing `macos_ax` module's public surface doesn't expose
  //     "title of focused window" as a standalone helper, and
  //   * adding one would touch a second file (outside this task's scope).
  // The osascript route is ~15ms; acceptable for a capture-time strategy.
  let script = r#"tell application "System Events"
  tell (first process whose frontmost is true)
    return name of front window
  end tell
end tell"#;
  let raw = imp::run_osascript(script)?;
  if raw.is_empty() {
    return None;
  }
  let (filename, project) = parse_vscode_title(&raw);
  if filename.is_empty() {
    return None;
  }
  let text = match &project {
    Some(p) => format!("Editing: {}\nProject: {}", filename, p),
    None => format!("Editing: {}", filename),
  };
  Some(AppCapture {
    text: clamp_bytes(text, MAX_STRATEGY_BYTES),
    url: None,
    window_title: Some(raw),
    strategy: Strategy::VsCode.as_str().to_string(),
  })
}

#[cfg(target_os = "macos")]
fn capture_terminal() -> Option<AppCapture> {
  // Terminals: the existing AX fallback already surfaces the full
  // scrollback — but it can be huge and we only need the tail for "what is
  // the user doing right now". We pull the AX snapshot, keep the last
  // `TERMINAL_TAIL_BYTES`, and tag it as the terminal strategy so
  // downstream telemetry can see which path produced the capture.
  let snapshot = crate::macos_ax::focused_ax_snapshot()?;
  if snapshot.trim().is_empty() {
    return None;
  }
  let tail = clamp_tail_bytes(&snapshot, TERMINAL_TAIL_BYTES);
  Some(AppCapture {
    text: tail,
    url: None,
    window_title: None,
    strategy: Strategy::Terminal.as_str().to_string(),
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn match_strategy_chrome_variants() {
    assert_eq!(match_strategy("Google Chrome"), Strategy::Chrome);
    assert_eq!(match_strategy("Google Chrome Canary"), Strategy::Chrome);
    assert_eq!(match_strategy("Arc"), Strategy::Chrome);
    assert_eq!(match_strategy("Brave Browser"), Strategy::Chrome);
    assert_eq!(match_strategy("Microsoft Edge"), Strategy::Chrome);
  }

  #[test]
  fn match_strategy_edge_animate_is_not_a_browser() {
    // Edge Animate is Adobe's authoring tool — must not be routed to the
    // chromium URL-extraction strategy.
    assert_eq!(match_strategy("Edge Animate"), Strategy::None);
    assert_eq!(match_strategy("Adobe Edge Animate"), Strategy::None);
  }

  #[test]
  fn match_strategy_safari() {
    assert_eq!(match_strategy("Safari"), Strategy::Safari);
    assert_eq!(
      match_strategy("Safari Technology Preview"),
      Strategy::Safari
    );
  }

  #[test]
  fn match_strategy_vscode_family() {
    assert_eq!(match_strategy("Visual Studio Code"), Strategy::VsCode);
    assert_eq!(match_strategy("Cursor"), Strategy::VsCode);
    assert_eq!(match_strategy("Code"), Strategy::VsCode);
    // Case-insensitive bundle name shape.
    assert_eq!(match_strategy("code"), Strategy::VsCode);
  }

  #[test]
  fn match_strategy_terminals() {
    assert_eq!(match_strategy("Terminal"), Strategy::Terminal);
    assert_eq!(match_strategy("iTerm2"), Strategy::Terminal);
    assert_eq!(match_strategy("Ghostty"), Strategy::Terminal);
    assert_eq!(match_strategy("Alacritty"), Strategy::Terminal);
  }

  #[test]
  fn match_strategy_unknown_app_is_none() {
    assert_eq!(match_strategy("Slack"), Strategy::None);
    assert_eq!(match_strategy("Notion"), Strategy::None);
    assert_eq!(match_strategy(""), Strategy::None);
  }

  #[test]
  fn parse_vscode_title_emdash_separator() {
    let (file, project) = parse_vscode_title("main.rs \u{2014} myproject");
    assert_eq!(file, "main.rs");
    assert_eq!(project.as_deref(), Some("myproject"));
  }

  #[test]
  fn parse_vscode_title_strips_unsaved_dot() {
    let (file, project) = parse_vscode_title("\u{25CF} Unsaved.md \u{2014} workdir");
    assert_eq!(file, "Unsaved.md");
    assert_eq!(project.as_deref(), Some("workdir"));
  }

  #[test]
  fn parse_vscode_title_no_separator_returns_filename_only() {
    let (file, project) = parse_vscode_title("README.md");
    assert_eq!(file, "README.md");
    assert_eq!(project, None);
  }

  #[test]
  fn parse_vscode_title_ascii_hyphen_fallback() {
    let (file, project) = parse_vscode_title("notes.txt - sideproject");
    assert_eq!(file, "notes.txt");
    assert_eq!(project.as_deref(), Some("sideproject"));
  }

  #[test]
  fn parse_vscode_title_preserves_hyphenated_filenames() {
    // ` - ` boundary must split on the project separator, NOT shred a
    // hyphenated filename like `my-file.rs` (no surrounding spaces).
    let (file, project) = parse_vscode_title("my-file.rs \u{2014} my-project");
    assert_eq!(file, "my-file.rs");
    assert_eq!(project.as_deref(), Some("my-project"));
  }

  #[test]
  fn strategy_as_str_identifiers_are_stable() {
    // Pin the strategy identifiers — downstream telemetry will key on these
    // and we don't want a silent rename to break dashboards.
    assert_eq!(Strategy::Chrome.as_str(), "chrome");
    assert_eq!(Strategy::Safari.as_str(), "safari");
    assert_eq!(Strategy::VsCode.as_str(), "vscode");
    assert_eq!(Strategy::Terminal.as_str(), "terminal");
    assert_eq!(Strategy::None.as_str(), "none");
  }

  #[test]
  fn clamp_bytes_no_op_when_under_limit() {
    assert_eq!(clamp_bytes("hello".into(), 100), "hello");
  }

  #[test]
  fn clamp_bytes_truncates_at_char_boundary() {
    // Each "あ" is 3 bytes; limit of 4 bytes must yield 1 codepoint (3
    // bytes), never a partial codepoint.
    assert_eq!(clamp_bytes("あああ".to_string(), 4), "あ");
  }

  #[test]
  fn clamp_tail_keeps_last_bytes_at_boundary() {
    // 6 bytes of ascii, ask for the last 3 → "lo!" (the trailing 3 bytes).
    assert_eq!(clamp_tail_bytes("hello!", 3), "lo!");
    // Multibyte tail must snap forward to a char boundary, never slice
    // mid-codepoint. "あああ" is 9 bytes (3×3); tail=4 starts at byte 5,
    // which is mid-codepoint, snap forward to byte 6 → 1 codepoint.
    assert_eq!(clamp_tail_bytes("あああ", 4), "あ");
  }

  #[test]
  fn clamp_tail_passthrough_when_already_short() {
    assert_eq!(clamp_tail_bytes("short", 1000), "short");
  }

  #[cfg(not(target_os = "macos"))]
  #[test]
  fn non_macos_stub_returns_none() {
    assert!(capture_for_app("Google Chrome").is_none());
    assert!(capture_for_app("Safari").is_none());
  }
}

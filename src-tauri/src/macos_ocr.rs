//! macOS Vision-API OCR fallback for the capture pipeline.
//!
//! When `macos_ax::focused_ax_snapshot()` returns nothing useful (Electron,
//! Canvas, image-only apps) we capture the focused window's pixel rect and run
//! Apple's Vision framework over it to recover text. This module is the
//! fallback path — it is intentionally cheap to call (zero-arg public fn) and
//! self-contained so the sampler can swap it in without further plumbing.
//!
//! Implementation: shell-out. We invoke `/usr/sbin/screencapture` to grab the
//! focused window rect into `/tmp`, then `/usr/bin/swift -e <script>` to run a
//! one-shot `VNRecognizeTextRequest` against that PNG. Both subprocesses are
//! killed if the combined deadline (3.5s) elapses. Temp PNGs are best-effort
//! cleaned up.
//!
//! Recognition quality knobs: we run Vision with
//! `recognitionLevel = .accurate`, `usesLanguageCorrection = true`, a locale-
//! aware recognition-languages list, a confidence floor (drop observations <
//! `OCR_CONFIDENCE_MIN`), and a normalized-y row grouping so the joined text
//! preserves top-to-bottom / left-to-right layout.
//!
//! Why not pure FFI (objc2 -> Vision)? Vision's async `perform(_:)` requires a
//! run-loop / dispatch wait that's awkward to express through `objc2` without
//! more glue than this fallback warrants. `swift -e` pays ~1s of compile
//! latency, but this only runs on AX-empty samples so the cost is acceptable.
//!
//! Non-macOS builds compile to a no-op stub returning `None`.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

/// Returns OCR'd text from the focused window, or `None` if no focused window
/// is available, the capture failed, OCR returned nothing, or the deadline
/// elapsed. Never panics.
///
/// macOS-only. Other platforms return `None`.
#[cfg(target_os = "macos")]
pub fn ocr_focused_window() -> Option<String> {
  imp::ocr_focused_window()
}

#[cfg(not(target_os = "macos"))]
pub fn ocr_focused_window() -> Option<String> {
  None
}

#[cfg(target_os = "macos")]
mod imp {
  use std::io::Read;
  use std::process::{Command, Stdio};
  use std::sync::atomic::{AtomicU64, Ordering};
  use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

  /// Hard wall-clock budget for the whole pipeline (screencapture + swift).
  /// Bumped from 2.0s → 3.5s because `.accurate` recognition is ~2x slower
  /// than the `.fast` default we used previously.
  pub(super) const TOTAL_BUDGET: Duration = Duration::from_millis(3_500);
  /// Per-phase soft cap so a hung `screencapture` cannot eat the swift budget.
  const SCREENCAPTURE_BUDGET: Duration = Duration::from_millis(500);
  /// Cap returned text size so a wall of OCR'd noise doesn't bloat snapshots.
  const MAX_OCR_BYTES: usize = 8_000;
  /// Vision returns per-observation confidence in 0..1. Skip anything below
  /// this floor — noisy partial detections poison downstream context more than
  /// they help.
  pub(super) const OCR_CONFIDENCE_MIN: f32 = 0.4;
  /// Hardcoded fallback if locale detection fails. Order matters: Vision
  /// biases toward the first language when the script is ambiguous.
  const FALLBACK_LANGUAGES: &[&str] = &["ja-JP", "en-US"];

  /// Rate-limit `log::warn!` for unexpected errors to once per ~30s so a busted
  /// dependency (missing swift, denied screen recording) doesn't spam the log.
  static LAST_WARN_MS: AtomicU64 = AtomicU64::new(0);
  const WARN_INTERVAL_MS: u64 = 30_000;

  fn now_ms() -> u64 {
    SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map(|d| d.as_millis() as u64)
      .unwrap_or(0)
  }

  fn warn_rate_limited(msg: &str) {
    let now = now_ms();
    let prev = LAST_WARN_MS.load(Ordering::Relaxed);
    if now.saturating_sub(prev) >= WARN_INTERVAL_MS {
      LAST_WARN_MS.store(now, Ordering::Relaxed);
      log::warn!("macos_ocr: {}", msg);
    }
  }

  pub fn ocr_focused_window() -> Option<String> {
    let deadline = Instant::now() + TOTAL_BUDGET;

    let geom = crate::macos_ax::focused_window_geometry()?;
    // Reject zero/negative rects — screencapture would either fail or grab the
    // whole screen depending on the version, and Vision over a blank rect is
    // wasted runtime.
    if geom.w < 1.0 || geom.h < 1.0 {
      return None;
    }

    let pid = std::process::id();
    let ts = now_ms();
    let tmp_path = std::path::PathBuf::from(format!(
      "/tmp/shogun_ocr_{}_{}.png",
      pid, ts
    ));

    // Phase 1: capture the rect. `-x` silences the shutter sound, `-R x,y,w,h`
    // grabs an exact display-space rect, `-t png` forces format. Integer
    // truncation of the f64 rect is fine — sub-pixel precision is meaningless
    // for OCR.
    let rect_arg = format!(
      "{},{},{},{}",
      geom.x as i64, geom.y as i64, geom.w as i64, geom.h as i64
    );
    let capture_ok = run_with_deadline(
      Command::new("/usr/sbin/screencapture")
        .arg("-x")
        .arg("-R")
        .arg(&rect_arg)
        .arg("-t")
        .arg("png")
        .arg(&tmp_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null()),
      Instant::now() + SCREENCAPTURE_BUDGET.min(deadline.saturating_duration_since(Instant::now())),
    );
    if !capture_ok {
      let _ = std::fs::remove_file(&tmp_path);
      warn_rate_limited("screencapture failed or timed out");
      return None;
    }
    // File may not exist if screencapture silently no-op'd (e.g., missing
    // screen-recording permission on 10.15+).
    if !tmp_path.exists() {
      warn_rate_limited("screencapture produced no file (screen recording permission?)");
      return None;
    }

    // Phase 2: hand the PNG to Vision via `swift -e`. We print one line per
    // recognized text observation, then a sentinel so we can distinguish
    // empty-output from a hung process. Stdout is captured.
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.as_nanos() == 0 {
      let _ = std::fs::remove_file(&tmp_path);
      return None;
    }
    let languages = detect_recognition_languages();
    let script = build_swift_script(&tmp_path, &languages);
    let output = run_capture_with_deadline(
      Command::new("/usr/bin/swift")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null()),
      script.as_bytes(),
      Instant::now() + remaining,
    );
    // Always best-effort cleanup, even on swift failure.
    let _ = std::fs::remove_file(&tmp_path);
    let _ = deadline; // silence unused once both phases are done

    let stdout = match output {
      Some(s) => s,
      None => {
        warn_rate_limited("swift Vision invocation failed or timed out");
        return None;
      }
    };

    let text = parse_swift_output(&stdout)?;
    if text.trim().is_empty() {
      return None;
    }
    Some(clamp_bytes(text, MAX_OCR_BYTES))
  }

  /// Escape a string for embedding inside a Swift double-quoted string literal.
  fn swift_escape(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() + 4);
    for ch in raw.chars() {
      match ch {
        '\\' => out.push_str("\\\\"),
        '"' => out.push_str("\\\""),
        '\n' => out.push_str("\\n"),
        '\r' => out.push_str("\\r"),
        _ => out.push(ch),
      }
    }
    out
  }

  /// Build a recognition-languages list using the user's locale, falling back
  /// to `FALLBACK_LANGUAGES` when detection produces nothing usable.
  ///
  /// We inspect `LANG` / `LC_ALL` / `LC_CTYPE` (POSIX) — macOS `Terminal.app`
  /// and login shells normally export at least one. The value looks like
  /// `ja_JP.UTF-8` or `en_US.UTF-8`; we strip the codeset and rewrite the
  /// underscore to a dash to produce a BCP-47 tag (`ja-JP`, `en-US`) that
  /// Vision accepts. Anything that doesn't parse to a `xx_YY` shape is
  /// discarded so we don't feed Vision garbage.
  ///
  /// The detected language is *prepended* to the fallback list (de-duped) so
  /// e.g. a German user still gets Japanese + English as secondaries.
  pub(super) fn detect_recognition_languages() -> Vec<String> {
    let raw = std::env::var("LANG")
      .ok()
      .or_else(|| std::env::var("LC_ALL").ok())
      .or_else(|| std::env::var("LC_CTYPE").ok());

    let detected = raw.and_then(|v| normalize_locale_to_bcp47(&v));

    let mut out: Vec<String> = Vec::with_capacity(FALLBACK_LANGUAGES.len() + 1);
    if let Some(tag) = detected {
      out.push(tag);
    }
    for &lang in FALLBACK_LANGUAGES {
      if !out.iter().any(|t| t.eq_ignore_ascii_case(lang)) {
        out.push(lang.to_string());
      }
    }
    out
  }

  /// `ja_JP.UTF-8` → `Some("ja-JP")`; `C`/`POSIX`/`""` → `None`.
  fn normalize_locale_to_bcp47(raw: &str) -> Option<String> {
    // Strip codeset (`.UTF-8`) and modifier (`@euro`).
    let core = raw.split(['.', '@']).next()?.trim();
    if core.is_empty() || core.eq_ignore_ascii_case("C") || core.eq_ignore_ascii_case("POSIX") {
      return None;
    }
    let mut parts = core.split('_');
    let lang = parts.next()?.trim();
    let region = parts.next().map(str::trim).unwrap_or("");
    // Language subtag must be 2-3 ascii letters; region (if present) must be
    // 2 ascii letters. Anything else → reject.
    if lang.len() < 2 || lang.len() > 3 || !lang.chars().all(|c| c.is_ascii_alphabetic()) {
      return None;
    }
    if region.is_empty() {
      return Some(lang.to_ascii_lowercase());
    }
    if region.len() != 2 || !region.chars().all(|c| c.is_ascii_alphabetic()) {
      return None;
    }
    Some(format!(
      "{}-{}",
      lang.to_ascii_lowercase(),
      region.to_ascii_uppercase()
    ))
  }

  /// Build the Swift snippet that runs Vision over `path` and prints recognized
  /// text terminated by an `__OCR_DONE__` sentinel so the parser can distinguish
  /// "ran successfully, found nothing" from "process crashed before emitting
  /// anything".
  ///
  /// Quality knobs baked into the script:
  ///   * `recognitionLevel = .accurate`
  ///   * `usesLanguageCorrection = true`
  ///   * `recognitionLanguages = <languages>` (locale-aware, JA/EN fallback)
  ///   * Per-observation confidence floor (`OCR_CONFIDENCE_MIN`)
  ///   * Layout-preserving output: observations are bucketed into rows by
  ///     normalized-y centroid (rows ≈ 1.5% of frame height) then sorted
  ///     top-to-bottom and within each row left-to-right before printing.
  pub(super) fn build_swift_script(
    path: &std::path::Path,
    languages: &[String],
  ) -> String {
    let escaped_path = swift_escape(&path.to_string_lossy());
    // Build a Swift array literal: `["ja-JP", "en-US"]`. Each tag is escaped
    // even though valid BCP-47 tags are ASCII alnum + `-`; cheap insurance
    // against a future caller passing through a hostile value.
    let langs_literal = if languages.is_empty() {
      "[\"ja-JP\", \"en-US\"]".to_string()
    } else {
      let parts: Vec<String> = languages
        .iter()
        .map(|l| format!("\"{}\"", swift_escape(l)))
        .collect();
      format!("[{}]", parts.join(", "))
    };

    format!(
      r#"import Foundation
import Vision
import AppKit

let url = URL(fileURLWithPath: "{path}")
guard let img = NSImage(contentsOf: url),
      let tiff = img.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let cg = rep.cgImage else {{
  print("__OCR_DONE__")
  exit(0)
}}
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = true
req.recognitionLanguages = {langs}
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
struct Row {{ var y: Double; var items: [(Double, String)] }}
var rows: [Row] = []
let rowTol: Double = 0.015
do {{
  try handler.perform([req])
  if let results = req.results {{
    for obs in results {{
      guard let top = obs.topCandidates(1).first else {{ continue }}
      if top.confidence < Float({conf}) {{ continue }}
      let s = top.string
      if s.isEmpty {{ continue }}
      let bb = obs.boundingBox
      // Vision normalized coords: origin bottom-left. Convert to top-down y so
      // higher rows sort first.
      let cy = 1.0 - (Double(bb.origin.y) + Double(bb.size.height) * 0.5)
      let cx = Double(bb.origin.x)
      if let idx = rows.firstIndex(where: {{ abs($0.y - cy) <= rowTol }}) {{
        rows[idx].items.append((cx, s))
        rows[idx].y = (rows[idx].y + cy) * 0.5
      }} else {{
        rows.append(Row(y: cy, items: [(cx, s)]))
      }}
    }}
  }}
}} catch {{
  // swallow; the sentinel below still fires
}}
rows.sort {{ $0.y < $1.y }}
for var r in rows {{
  r.items.sort {{ $0.0 < $1.0 }}
  let line = r.items.map {{ $0.1 }}.joined(separator: " ")
  print(line)
}}
print("__OCR_DONE__")
"#,
      path = escaped_path,
      langs = langs_literal,
      conf = OCR_CONFIDENCE_MIN
    )
  }

  /// Drop the sentinel line and return everything above it, joined by `\n`.
  /// Returns `None` if the sentinel is missing (process didn't finish cleanly).
  fn parse_swift_output(stdout: &str) -> Option<String> {
    let mut lines: Vec<&str> = Vec::new();
    let mut saw_sentinel = false;
    for line in stdout.lines() {
      if line == "__OCR_DONE__" {
        saw_sentinel = true;
        break;
      }
      lines.push(line);
    }
    if !saw_sentinel {
      return None;
    }
    Some(lines.join("\n"))
  }

  /// Truncate a `String` to at most `max` bytes at a char boundary.
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

  /// Spawn `cmd`, wait until it exits OR `deadline` passes. On deadline we
  /// `kill()` the child and return false. No stdin written.
  fn run_with_deadline(cmd: &mut Command, deadline: Instant) -> bool {
    let mut child = match cmd.spawn() {
      Ok(c) => c,
      Err(_) => return false,
    };
    loop {
      match child.try_wait() {
        Ok(Some(status)) => return status.success(),
        Ok(None) => {
          if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return false;
          }
          std::thread::sleep(Duration::from_millis(20));
        }
        Err(_) => {
          let _ = child.kill();
          let _ = child.wait();
          return false;
        }
      }
    }
  }

  /// Like `run_with_deadline` but writes `stdin_bytes` and captures stdout.
  /// Returns `Some(stdout_utf8)` on clean exit, `None` on failure/timeout.
  fn run_capture_with_deadline(
    cmd: &mut Command,
    stdin_bytes: &[u8],
    deadline: Instant,
  ) -> Option<String> {
    let mut child = cmd.spawn().ok()?;
    if let Some(mut stdin) = child.stdin.take() {
      use std::io::Write;
      let _ = stdin.write_all(stdin_bytes);
      // dropping stdin closes the pipe so `swift -` proceeds to compile.
    }
    let mut stdout = child.stdout.take();
    loop {
      match child.try_wait() {
        Ok(Some(status)) => {
          if !status.success() {
            return None;
          }
          let mut buf = String::new();
          if let Some(ref mut s) = stdout {
            // Best-effort read; partial output is still useful.
            let _ = s.read_to_string(&mut buf);
          }
          return Some(buf);
        }
        Ok(None) => {
          if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
          }
          std::thread::sleep(Duration::from_millis(25));
        }
        Err(_) => {
          let _ = child.kill();
          let _ = child.wait();
          return None;
        }
      }
    }
  }

  #[cfg(test)]
  mod tests {
    use super::*;

    #[test]
    fn parse_swift_output_extracts_lines_before_sentinel() {
      let raw = "hello\nworld\n__OCR_DONE__\n";
      assert_eq!(parse_swift_output(raw).as_deref(), Some("hello\nworld"));
    }

    #[test]
    fn parse_swift_output_returns_none_without_sentinel() {
      assert_eq!(parse_swift_output("hello\nworld\n"), None);
    }

    #[test]
    fn parse_swift_output_empty_with_sentinel_is_some_empty() {
      assert_eq!(parse_swift_output("__OCR_DONE__\n").as_deref(), Some(""));
    }

    #[test]
    fn clamp_bytes_no_op_when_under_limit() {
      assert_eq!(clamp_bytes("hello".into(), 100), "hello");
    }

    #[test]
    fn clamp_bytes_truncates_at_char_boundary() {
      let s = "a".repeat(10);
      let out = clamp_bytes(s, 4);
      assert_eq!(out, "aaaa");
    }

    #[test]
    fn clamp_bytes_respects_multibyte_boundary() {
      // each "あ" is 3 bytes; limit of 4 should yield 1 char (3 bytes).
      let s = "あああ".to_string();
      let out = clamp_bytes(s, 4);
      assert_eq!(out, "あ");
    }

    #[test]
    fn build_swift_script_escapes_quotes_and_backslashes() {
      let p = std::path::PathBuf::from(r#"/tmp/has "quote" and \back.png"#);
      let langs = vec!["ja-JP".to_string(), "en-US".to_string()];
      let script = build_swift_script(&p, &langs);
      assert!(script.contains(r#"\"quote\""#));
      assert!(script.contains(r"\\back.png"));
    }

    #[test]
    fn build_swift_script_enables_accurate_and_language_correction() {
      let p = std::path::PathBuf::from("/tmp/x.png");
      let langs = vec!["ja-JP".to_string(), "en-US".to_string()];
      let script = build_swift_script(&p, &langs);
      assert!(
        script.contains(".accurate"),
        "script should request .accurate recognition level"
      );
      assert!(
        script.contains("usesLanguageCorrection = true"),
        "script should enable language correction"
      );
    }

    #[test]
    fn build_swift_script_embeds_recognition_languages() {
      let p = std::path::PathBuf::from("/tmp/x.png");
      let langs = vec![
        "de-DE".to_string(),
        "ja-JP".to_string(),
        "en-US".to_string(),
      ];
      let script = build_swift_script(&p, &langs);
      assert!(
        script.contains("recognitionLanguages = [\"de-DE\", \"ja-JP\", \"en-US\"]"),
        "script should embed the supplied language list verbatim, got:\n{script}"
      );
    }

    #[test]
    fn build_swift_script_falls_back_to_ja_en_when_languages_empty() {
      let p = std::path::PathBuf::from("/tmp/x.png");
      let script = build_swift_script(&p, &[]);
      assert!(
        script.contains("[\"ja-JP\", \"en-US\"]"),
        "empty list should yield hardcoded ja-JP / en-US fallback"
      );
    }

    #[test]
    fn build_swift_script_contains_confidence_threshold() {
      let p = std::path::PathBuf::from("/tmp/x.png");
      let langs = vec!["ja-JP".to_string(), "en-US".to_string()];
      let script = build_swift_script(&p, &langs);
      // The constant is rendered via `{:?}` → `0.4`. Accept either `0.4` or
      // an explicit `Float(0.4)` cast since both encode the same value.
      assert!(
        script.contains("0.4"),
        "script should embed OCR_CONFIDENCE_MIN (0.4), got:\n{script}"
      );
      assert!(
        script.contains("top.confidence"),
        "script should filter on top.confidence, got:\n{script}"
      );
    }

    #[test]
    fn total_budget_is_bumped_to_at_least_3500ms() {
      // .accurate is ~2x slower than .fast; we widened the deadline.
      assert!(
        TOTAL_BUDGET >= Duration::from_millis(3_500),
        "TOTAL_BUDGET should be ≥ 3500ms after the .accurate switch, got {:?}",
        TOTAL_BUDGET
      );
    }

    #[test]
    fn ocr_confidence_min_is_within_unit_interval() {
      assert!(OCR_CONFIDENCE_MIN >= 0.0 && OCR_CONFIDENCE_MIN <= 1.0);
      assert!((OCR_CONFIDENCE_MIN - 0.4).abs() < f32::EPSILON);
    }

    #[test]
    fn normalize_locale_parses_common_shapes() {
      assert_eq!(
        normalize_locale_to_bcp47("ja_JP.UTF-8").as_deref(),
        Some("ja-JP")
      );
      assert_eq!(
        normalize_locale_to_bcp47("en_US.UTF-8").as_deref(),
        Some("en-US")
      );
      assert_eq!(normalize_locale_to_bcp47("ja_JP").as_deref(), Some("ja-JP"));
      assert_eq!(normalize_locale_to_bcp47("en").as_deref(), Some("en"));
    }

    #[test]
    fn normalize_locale_rejects_garbage_and_posix() {
      assert_eq!(normalize_locale_to_bcp47(""), None);
      assert_eq!(normalize_locale_to_bcp47("C"), None);
      assert_eq!(normalize_locale_to_bcp47("POSIX"), None);
      assert_eq!(normalize_locale_to_bcp47("123_45"), None);
      assert_eq!(normalize_locale_to_bcp47("en_USA"), None);
    }

    #[test]
    fn detect_recognition_languages_always_contains_fallback() {
      let langs = detect_recognition_languages();
      // Regardless of env, ja-JP and en-US must be present somewhere in the
      // returned list (they may be at index 0+ if the user locale already
      // matches one of them).
      assert!(
        langs.iter().any(|l| l == "ja-JP"),
        "expected ja-JP in {:?}",
        langs
      );
      assert!(
        langs.iter().any(|l| l == "en-US"),
        "expected en-US in {:?}",
        langs
      );
    }

    #[test]
    fn ocr_returns_none_or_some_no_panic() {
      // Smoke test: we don't assume any focused window exists, screen-recording
      // permission, or that `swift` is installed — just that the function
      // returns without panicking.
      let _ = ocr_focused_window();
    }
  }
}

#[cfg(all(test, not(target_os = "macos")))]
mod tests {
  use super::*;

  #[test]
  fn non_macos_stub_returns_none() {
    assert!(ocr_focused_window().is_none());
  }
}

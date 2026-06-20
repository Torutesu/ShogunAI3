//! Load the bundled Terms of Service and Privacy Policy markdown documents.
//!
//! The Tauri command `legal_docs_load(lang)` is a thin wrapper around
//! `load_from_dir`, which is independent of the runtime so it can be
//! exercised in unit tests against a `tempfile::TempDir`.

use serde_json::{json, Value};
use std::path::Path;

#[derive(Debug)]
struct DocPaths {
    terms: std::path::PathBuf,
    privacy: std::path::PathBuf,
}

// Naming asymmetry is intentional: docs/TERMS_OF_SERVICE.md is the JA original
// and PRIVACY.md sits at the repo root for historical reasons.
fn doc_paths(dir: &Path, lang: &str) -> DocPaths {
    if lang == "ja" {
        DocPaths {
            terms: dir.join("docs/TERMS_OF_SERVICE.md"),
            privacy: dir.join("docs/PRIVACY.ja.md"),
        }
    } else {
        DocPaths {
            terms: dir.join("docs/TERMS_OF_SERVICE_EN.md"),
            privacy: dir.join("PRIVACY.md"),
        }
    }
}

// Tauri 2 packaged builds copy resources declared with `..` paths into
// `<Resources>/_up_/...`. `app.path().resource_dir()` returns the plain
// `<Resources>/` path, so we try the direct join first (which works in
// dev where resource_dir is the project root) and fall back to `_up_/`
// (which works in packaged builds). This keeps dev and prod on a single
// code path and lets the existing unit tests continue to drive
// `load_from_dir` against a flat fixture directory.
fn read_doc(dir: &Path, rel: &Path) -> Result<String, String> {
    let primary = dir.join(rel);
    if primary.exists() {
        return std::fs::read_to_string(&primary)
            .map_err(|e| format!("{}: {}", primary.display(), e));
    }
    let with_up = dir.join("_up_").join(rel);
    std::fs::read_to_string(&with_up).map_err(|e| format!("{}: {}", with_up.display(), e))
}

pub fn load_from_dir(dir: &Path, lang: &str) -> Result<Value, String> {
    let paths = doc_paths(dir, lang);
    let terms_rel = paths.terms.strip_prefix(dir).unwrap_or(&paths.terms);
    let privacy_rel = paths.privacy.strip_prefix(dir).unwrap_or(&paths.privacy);
    let terms = read_doc(dir, terms_rel).map_err(|e| format!("terms ({})", e))?;
    let privacy = read_doc(dir, privacy_rel).map_err(|e| format!("privacy ({})", e))?;
    Ok(json!({ "terms": terms, "privacy": privacy }))
}

#[tauri::command]
pub fn legal_docs_load(app: tauri::AppHandle, lang: String) -> Result<Value, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource_dir: {}", e))?;
    load_from_dir(&dir, &lang)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(dir.path().join("docs")).unwrap();
        fs::write(dir.path().join("docs/TERMS_OF_SERVICE.md"), "# 利用規約\n").unwrap();
        fs::write(
            dir.path().join("docs/TERMS_OF_SERVICE_EN.md"),
            "# Terms of Service\n",
        )
        .unwrap();
        fs::write(dir.path().join("docs/PRIVACY.ja.md"), "# プライバシー\n").unwrap();
        fs::write(dir.path().join("PRIVACY.md"), "# Privacy\n").unwrap();
        dir
    }

    #[test]
    fn loads_english_docs_returns_both_files() {
        let dir = fixture_dir();
        let v = load_from_dir(dir.path(), "en").expect("ok");
        assert_eq!(v["terms"], "# Terms of Service\n");
        assert_eq!(v["privacy"], "# Privacy\n");
    }

    #[test]
    fn loads_japanese_docs_returns_both_files() {
        let dir = fixture_dir();
        let v = load_from_dir(dir.path(), "ja").expect("ok");
        assert_eq!(v["terms"], "# 利用規約\n");
        assert_eq!(v["privacy"], "# プライバシー\n");
    }

    #[test]
    fn unknown_language_falls_back_to_english() {
        let dir = fixture_dir();
        let v = load_from_dir(dir.path(), "xx").expect("ok");
        assert_eq!(v["terms"], "# Terms of Service\n");
        assert_eq!(v["privacy"], "# Privacy\n");
    }

    #[test]
    fn missing_resource_returns_err() {
        let dir = tempfile::tempdir().unwrap();
        let err = load_from_dir(dir.path(), "en").unwrap_err();
        assert!(
            err.contains("terms"),
            "expected error to mention 'terms', got: {}",
            err
        );
    }

    /// Tauri-2 packaged builds copy `..`-prefixed bundle resources under
    /// `<Resources>/_up_/...`. Simulate that layout: the only files live
    /// under `_up_/`, and `load_from_dir` must still find them.
    #[test]
    fn falls_back_to_up_segment_for_packaged_layout() {
        let dir = tempfile::tempdir().expect("tempdir");
        let up = dir.path().join("_up_");
        fs::create_dir_all(up.join("docs")).unwrap();
        fs::write(
            up.join("docs/TERMS_OF_SERVICE_EN.md"),
            "# Terms (packaged)\n",
        )
        .unwrap();
        fs::write(up.join("PRIVACY.md"), "# Privacy (packaged)\n").unwrap();
        let v = load_from_dir(dir.path(), "en").expect("ok");
        assert_eq!(v["terms"], "# Terms (packaged)\n");
        assert_eq!(v["privacy"], "# Privacy (packaged)\n");
    }
}

//! Spawns the Node-based AMC (`hifi/amc-pipeline`) as a one-shot subprocess
//! and returns its v1 Morning Brief JSON.
//!
//! Supports two input modes:
//! - **fixture** (`run_pipeline_dry`): the pipeline reads its bundled mock.
//! - **stdin** (`run_pipeline_with_candidates`): Rust builds
//!   `MorningBriefCandidate` JSON locally (see `amc_candidates`) and pipes
//!   it to the pipeline's `--stdin` reader.
//!
//! Production bundling of the pipeline + `node_modules` is follow-up.

use crate::secrets;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::time::timeout;

const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const MAX_STDOUT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug)]
pub enum SidecarError {
  PipelineNotFound(PathBuf),
  NodeSpawnFailed(String),
  Timeout(Duration),
  NonZeroExit { code: Option<i32>, stderr: String },
  InvalidJson(String),
  StdoutTooLarge,
}

impl std::fmt::Display for SidecarError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Self::PipelineNotFound(p) => write!(f, "amc-pipeline script not found at {}", p.display()),
      Self::NodeSpawnFailed(e) => write!(f, "failed to spawn node: {}", e),
      Self::Timeout(d) => write!(f, "amc-pipeline timed out after {}ms", d.as_millis()),
      Self::NonZeroExit { code, stderr } => {
        write!(f, "amc-pipeline exited {:?}: {}", code, stderr)
      }
      Self::InvalidJson(e) => write!(f, "amc-pipeline produced invalid JSON: {}", e),
      Self::StdoutTooLarge => write!(f, "amc-pipeline stdout exceeded {} bytes", MAX_STDOUT_BYTES),
    }
  }
}

/// Resolve the path to `hifi/amc-pipeline/src/cli.js`. Tries, in order:
///
/// 1. **`SHOGUN_AMC_PIPELINE_PATH`** env override (tests, power users).
/// 2. **Tauri bundle resource dir** when an `AppHandle` is provided —
///    requires `tauri.conf.json` `bundle.resources` to ship
///    `hifi/amc-pipeline/` (production builds).
/// 3. **`CARGO_MANIFEST_DIR/../hifi/amc-pipeline/src/cli.js`** —
///    works in `tauri dev` because the binary carries the build host's
///    manifest path; useless after `tauri build`.
pub(crate) fn resolve_pipeline_path(app: Option<&AppHandle>) -> PathBuf {
  if let Ok(p) = std::env::var("SHOGUN_AMC_PIPELINE_PATH") {
    let pb = PathBuf::from(p);
    if !pb.as_os_str().is_empty() {
      return pb;
    }
  }
  if let Some(handle) = app {
    if let Ok(resource_root) = handle.path().resource_dir() {
      // Tauri 2's `bundle.resources` may rewrite parent (`..`) segments
      // to `_up_` in the destination layout, depending on whether each
      // entry uses the array form or the explicit `{path, name}` form.
      // Probe the most likely locations and use the first one found so
      // packaging tweaks don't require a Rust change.
      const PROBE: &[&str] = &[
        "amc-pipeline/src/cli.js",
        "hifi/amc-pipeline/src/cli.js",
        "_up_/hifi/amc-pipeline/src/cli.js",
        "resources/amc-pipeline/src/cli.js",
      ];
      for sub in PROBE {
        let candidate = resource_root.join(sub);
        if candidate.exists() {
          return candidate;
        }
      }
    }
  }
  let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
  manifest.join("../hifi/amc-pipeline/src/cli.js")
}

fn node_binary() -> String {
  std::env::var("SHOGUN_NODE_BIN").unwrap_or_else(|_| "node".to_string())
}

fn base_command(script: &Path) -> Command {
  let mut cmd = Command::new(node_binary());
  cmd
    .arg(script)
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped())
    .kill_on_drop(true);
  // If the user hasn't already exported ANTHROPIC_API_KEY, inject it from
  // the Keychain so the pipeline composer can reach Anthropic. Failures to
  // read the keychain are silent — the pipeline already gracefully falls
  // back to its heuristic dry path when the env var is missing or empty.
  if std::env::var_os("ANTHROPIC_API_KEY")
    .map(|v| v.is_empty())
    .unwrap_or(true)
  {
    if let Ok(Some(key)) = secrets::get_anthropic_api_key() {
      let trimmed = key.trim();
      if !trimmed.is_empty() {
        cmd.env("ANTHROPIC_API_KEY", trimmed);
      }
    }
  }
  cmd
}

async fn collect_output(mut child: Child, timeout_ms: u64) -> Result<Value, SidecarError> {
  let mut stdout = child.stdout.take().expect("stdout piped");
  let mut stderr = child.stderr.take().expect("stderr piped");

  let collect = async {
    let mut out = Vec::with_capacity(64 * 1024);
    let mut err = Vec::with_capacity(8 * 1024);
    let mut out_buf = [0u8; 16 * 1024];
    let mut err_buf = [0u8; 4 * 1024];
    let mut stderr_open = true;
    loop {
      tokio::select! {
        r = stdout.read(&mut out_buf) => match r {
          Ok(0) => break,
          Ok(n) => {
            if out.len() + n > MAX_STDOUT_BYTES {
              return Err(SidecarError::StdoutTooLarge);
            }
            out.extend_from_slice(&out_buf[..n]);
          }
          Err(e) => return Err(SidecarError::NodeSpawnFailed(e.to_string())),
        },
        r = stderr.read(&mut err_buf), if stderr_open => match r {
          Ok(0) => { stderr_open = false; }
          Ok(n) => {
            if err.len() < 8192 {
              let take = n.min(8192 - err.len());
              err.extend_from_slice(&err_buf[..take]);
            }
          }
          Err(_) => { stderr_open = false; }
        }
      }
    }
    Ok((out, err))
  };

  let (stdout_bytes, stderr_bytes) = match timeout(Duration::from_millis(timeout_ms), collect).await
  {
    Ok(r) => r?,
    Err(_) => {
      let _ = child.kill().await;
      return Err(SidecarError::Timeout(Duration::from_millis(timeout_ms)));
    }
  };

  let status = child
    .wait()
    .await
    .map_err(|e| SidecarError::NodeSpawnFailed(e.to_string()))?;
  if !status.success() {
    let err_text = String::from_utf8_lossy(&stderr_bytes).to_string();
    return Err(SidecarError::NonZeroExit {
      code: status.code(),
      stderr: err_text.chars().take(800).collect(),
    });
  }

  let text = String::from_utf8_lossy(&stdout_bytes);
  serde_json::from_str(&text).map_err(|e| SidecarError::InvalidJson(e.to_string()))
}

/// Run the pipeline in `--dry` mode on its bundled fixture.
pub async fn run_pipeline_dry(app: Option<&AppHandle>) -> Result<Value, SidecarError> {
  run_pipeline_dry_with(DEFAULT_TIMEOUT_MS, resolve_pipeline_path(app)).await
}

/// Test seam: explicit timeout + script path for the fixture path.
pub(crate) async fn run_pipeline_dry_with(
  timeout_ms: u64,
  script: PathBuf,
) -> Result<Value, SidecarError> {
  if !script.exists() {
    return Err(SidecarError::PipelineNotFound(script));
  }
  let child = base_command(&script)
    .arg("--dry")
    .spawn()
    .map_err(|e| SidecarError::NodeSpawnFailed(e.to_string()))?;
  collect_output(child, timeout_ms).await
}

/// Run the pipeline with a locally-built candidate list piped to stdin.
/// When `dry` is true the composer runs its heuristic only; otherwise
/// the pipeline itself decides based on `ANTHROPIC_API_KEY` (see
/// `hifi/amc-pipeline/src/cli.js`). `candidates` may be empty; the
/// pipeline then emits `{skipped: true}`.
pub async fn run_pipeline_with_candidates(
  candidates: &[Value],
  dry: bool,
  app: Option<&AppHandle>,
) -> Result<Value, SidecarError> {
  run_pipeline_with_candidates_inner(
    candidates,
    dry,
    DEFAULT_TIMEOUT_MS,
    resolve_pipeline_path(app),
  )
  .await
}

pub(crate) async fn run_pipeline_with_candidates_inner(
  candidates: &[Value],
  dry: bool,
  timeout_ms: u64,
  script: PathBuf,
) -> Result<Value, SidecarError> {
  if !script.exists() {
    return Err(SidecarError::PipelineNotFound(script));
  }
  let payload = serde_json::to_vec(&Value::Array(candidates.to_vec()))
    .map_err(|e| SidecarError::InvalidJson(e.to_string()))?;

  let mut cmd = base_command(&script);
  cmd.arg("--stdin");
  if dry {
    cmd.arg("--dry");
  }
  cmd.stdin(std::process::Stdio::piped());

  let mut child = cmd
    .spawn()
    .map_err(|e| SidecarError::NodeSpawnFailed(e.to_string()))?;

  if let Some(mut stdin) = child.stdin.take() {
    if let Err(e) = stdin.write_all(&payload).await {
      let _ = child.kill().await;
      return Err(SidecarError::NodeSpawnFailed(e.to_string()));
    }
    let _ = stdin.shutdown().await;
    drop(stdin);
  }

  collect_output(child, timeout_ms).await
}

#[cfg(test)]
mod tests {
  use super::*;

  // The two env-driven tests share `SHOGUN_AMC_PIPELINE_PATH`; keep a Mutex
  // so they don't race even if the test harness is multi-threaded.
  static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

  #[test]
  fn resolves_pipeline_path_relative_to_manifest() {
    let _g = ENV_LOCK.lock().unwrap();
    let prev = std::env::var_os("SHOGUN_AMC_PIPELINE_PATH");
    std::env::remove_var("SHOGUN_AMC_PIPELINE_PATH");
    let p = resolve_pipeline_path(None);
    let text = p.to_string_lossy();
    assert!(text.ends_with("hifi/amc-pipeline/src/cli.js"), "path was {}", text);
    if let Some(v) = prev {
      std::env::set_var("SHOGUN_AMC_PIPELINE_PATH", v);
    }
  }

  #[test]
  fn env_override_takes_precedence_over_manifest_fallback() {
    let _g = ENV_LOCK.lock().unwrap();
    let prev = std::env::var_os("SHOGUN_AMC_PIPELINE_PATH");
    std::env::set_var("SHOGUN_AMC_PIPELINE_PATH", "/custom/cli.js");
    let p = resolve_pipeline_path(None);
    assert_eq!(p, PathBuf::from("/custom/cli.js"));
    match prev {
      Some(v) => std::env::set_var("SHOGUN_AMC_PIPELINE_PATH", v),
      None => std::env::remove_var("SHOGUN_AMC_PIPELINE_PATH"),
    }
  }

  #[tokio::test]
  async fn missing_script_returns_not_found_for_dry() {
    let bogus = PathBuf::from("/tmp/definitely-not-a-path-shogun/cli.js");
    let err = run_pipeline_dry_with(1000, bogus.clone()).await.unwrap_err();
    match err {
      SidecarError::PipelineNotFound(p) => assert_eq!(p, bogus),
      other => panic!("expected PipelineNotFound, got {:?}", other),
    }
  }

  #[tokio::test]
  async fn missing_script_returns_not_found_for_stdin() {
    let bogus = PathBuf::from("/tmp/definitely-not-a-path-shogun/cli.js");
    let err = run_pipeline_with_candidates_inner(&[], true, 1000, bogus.clone())
      .await
      .unwrap_err();
    match err {
      SidecarError::PipelineNotFound(p) => assert_eq!(p, bogus),
      other => panic!("expected PipelineNotFound, got {:?}", other),
    }
  }

  #[test]
  fn node_binary_honors_env_override() {
    let current = std::env::var("SHOGUN_NODE_BIN").ok();
    assert_eq!(current.unwrap_or_else(|| "node".into()), node_binary());
  }
}

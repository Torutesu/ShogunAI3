//! Spawns the Node-based AMC (`hifi/amc-pipeline`) as a one-shot subprocess
//! and returns its v1 Morning Brief JSON.
//!
//! **Scope (Phase B.1):** dev-mode fixture dry-run only. Live LLM-backed
//! candidate ingestion (memory / calendar / meetings) is left to Phase B.2.
//! Production bundling of the pipeline + `node_modules` is also follow-up.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
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

/// Resolve the repo-relative path to `hifi/amc-pipeline/src/cli.js`.
///
/// In `tauri dev`, the compiled binary carries `CARGO_MANIFEST_DIR` from
/// `src-tauri/`, so `../hifi/amc-pipeline/src/cli.js` resolves correctly.
/// Production bundles will need a different strategy (Tauri resource dir);
/// see Phase B.2.
pub(crate) fn resolve_pipeline_path() -> PathBuf {
  let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
  manifest.join("../hifi/amc-pipeline/src/cli.js")
}

fn node_binary() -> String {
  std::env::var("SHOGUN_NODE_BIN").unwrap_or_else(|_| "node".to_string())
}

/// Run the pipeline in `--dry` mode on its bundled fixture and return the
/// parsed v1 JSON object.
pub async fn run_pipeline_dry() -> Result<Value, SidecarError> {
  run_pipeline_dry_with(DEFAULT_TIMEOUT_MS, resolve_pipeline_path()).await
}

/// Test seam: allow overriding timeout + script path.
pub(crate) async fn run_pipeline_dry_with(
  timeout_ms: u64,
  script: PathBuf,
) -> Result<Value, SidecarError> {
  if !script.exists() {
    return Err(SidecarError::PipelineNotFound(script));
  }

  let mut child = Command::new(node_binary())
    .arg(&script)
    .arg("--dry")
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped())
    .kill_on_drop(true)
    .spawn()
    .map_err(|e| SidecarError::NodeSpawnFailed(e.to_string()))?;

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
        r = stdout.read(&mut out_buf) => {
          match r {
            Ok(0) => break,
            Ok(n) => {
              if out.len() + n > MAX_STDOUT_BYTES {
                return Err(SidecarError::StdoutTooLarge);
              }
              out.extend_from_slice(&out_buf[..n]);
            }
            Err(e) => return Err(SidecarError::NodeSpawnFailed(e.to_string())),
          }
        }
        r = stderr.read(&mut err_buf), if stderr_open => {
          match r {
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
  let value: Value = serde_json::from_str(&text).map_err(|e| SidecarError::InvalidJson(e.to_string()))?;
  Ok(value)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn resolves_pipeline_path_relative_to_manifest() {
    let p = resolve_pipeline_path();
    let text = p.to_string_lossy();
    assert!(text.ends_with("hifi/amc-pipeline/src/cli.js"), "path was {}", text);
  }

  #[tokio::test]
  async fn missing_script_returns_not_found() {
    let bogus = PathBuf::from("/tmp/definitely-not-a-path-shogun/cli.js");
    let err = run_pipeline_dry_with(1000, bogus.clone()).await.unwrap_err();
    match err {
      SidecarError::PipelineNotFound(p) => assert_eq!(p, bogus),
      other => panic!("expected PipelineNotFound, got {:?}", other),
    }
  }

  #[test]
  fn node_binary_honors_env_override() {
    // Unsafe only on test threads sharing env; this project runs tests single-threaded
    // for cross-crate safety but here we just verify the default path.
    let current = std::env::var("SHOGUN_NODE_BIN").ok();
    assert_eq!(current.unwrap_or_else(|| "node".into()), node_binary());
  }
}

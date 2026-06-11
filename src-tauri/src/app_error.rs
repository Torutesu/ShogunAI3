//! Unified error type for internal Rust boundaries. IPC handlers convert to
//! `String` via [`AppError::to_ipc_string`] at the Tauri command edge.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
  #[error("{0}")]
  InvalidInput(String),
  #[error("{0}")]
  NotFound(String),
  #[error("database error: {0}")]
  Db(#[from] rusqlite::Error),
  #[error("io error: {0}")]
  Io(#[from] std::io::Error),
  #[error("{0}")]
  Other(String),
}

impl AppError {
  /// Flatten to a user-facing string for Tauri `Result<_, String>` boundaries.
  pub fn to_ipc_string(self) -> String {
    self.to_string()
  }
}

impl From<serde_json::Error> for AppError {
  fn from(e: serde_json::Error) -> Self {
    AppError::InvalidInput(e.to_string())
  }
}

impl From<std::sync::PoisonError<std::sync::MutexGuard<'_, ()>>> for AppError {
  fn from(e: std::sync::PoisonError<std::sync::MutexGuard<'_, ()>>) -> Self {
    AppError::Other(e.to_string())
  }
}

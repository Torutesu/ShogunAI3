//! Shared cancel flag for long-running `memory.embed_backfill` (Tauri invoke).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct EmbedBackfillState {
  cancel: Arc<AtomicBool>,
}

impl Default for EmbedBackfillState {
  fn default() -> Self {
    Self {
      cancel: Arc::new(AtomicBool::new(false)),
    }
  }
}

impl EmbedBackfillState {
  /// Clears cancel so a new backfill run can proceed.
  pub fn begin_run(&self) {
    self.cancel.store(false, Ordering::SeqCst);
  }

  pub fn request_cancel(&self) {
    self.cancel.store(true, Ordering::SeqCst);
  }

  pub fn cancel_flag(&self) -> &AtomicBool {
    self.cancel.as_ref()
  }
}

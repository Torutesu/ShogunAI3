//! Shared helpers for periodic background sync workers (calendar, rollup,
//! patterns, supersession, connector_sync). Each domain keeps its own STATE
//! and run_once logic; this module only deduplicates the loop boilerplate.

use std::future::Future;
use std::pin::Pin;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::async_runtime::spawn;

pub fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

/// True when `last_ms` is absent or at least `period_ms` has elapsed.
pub fn is_due(last_ms: Option<u64>, period_ms: u64) -> bool {
  let now = now_ms();
  last_ms
    .map(|t| now.saturating_sub(t) >= period_ms)
    .unwrap_or(true)
}

/// Spawn a tokio loop: optional startup delay, then repeated `wake_secs` sleeps.
/// `tick` returns `enabled`; when true, `run` is invoked (errors are ignored
/// by the caller inside `run`).
pub fn spawn_periodic<FEnabled, FRun, Fut>(
  startup_delay_secs: u64,
  wake_secs: u64,
  mut tick: FEnabled,
  mut run: FRun,
) where
  FEnabled: FnMut() -> bool + Send + 'static,
  FRun: FnMut() -> Fut + Send + 'static,
  Fut: Future<Output = ()> + Send + 'static,
{
  spawn(async move {
    if startup_delay_secs > 0 {
      tokio::time::sleep(std::time::Duration::from_secs(startup_delay_secs)).await;
    }
    loop {
      if tick() {
        run().await;
      }
      tokio::time::sleep(std::time::Duration::from_secs(wake_secs)).await;
    }
  });
}

/// Type-erased variant for callers that return different future types per tick.
pub fn spawn_periodic_boxed<FEnabled>(
  startup_delay_secs: u64,
  wake_secs: u64,
  mut tick: FEnabled,
  mut run: impl FnMut() -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + 'static,
) where
  FEnabled: FnMut() -> bool + Send + 'static,
{
  spawn_periodic(startup_delay_secs, wake_secs, tick, move || run());
}

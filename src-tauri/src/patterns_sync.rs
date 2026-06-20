//! Patterns daily background sync (KIOKU Sub-spec B). Modeled after
//! `rollup_sync.rs`. Wakes every 30 min, runs detection if 24h+ has
//! elapsed since the last successful run.

#![allow(dead_code)]

use std::sync::Mutex;

#[derive(Clone, Default)]
pub struct PatternsSyncState {
    pub last_run_ms: Option<i64>,
    pub last_error: Option<String>,
    pub last_emitted_count: usize,
}

static STATE: Mutex<PatternsSyncState> = Mutex::new(PatternsSyncState {
    last_run_ms: None,
    last_error: None,
    last_emitted_count: 0,
});

pub fn snapshot_state() -> PatternsSyncState {
    STATE.lock().map(|g| g.clone()).unwrap_or_default()
}

fn patterns_enabled() -> bool {
    crate::settings_store::load()
        .ok()
        .and_then(|d| {
            d.pointer("/sections/kioku_graph/patterns_enabled")
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(true) // default ON
}

fn should_run() -> bool {
    let last = STATE.lock().ok().and_then(|s| s.last_run_ms);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    match last {
        None => true,
        Some(t) => (now - t) >= 24 * 60 * 60 * 1000,
    }
}

pub fn spawn_background_patterns_sync() {
    tauri::async_runtime::spawn(async move {
        // Cold-start delay so app boot isn't competing with detection.
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        loop {
            if patterns_enabled() && should_run() {
                match crate::patterns::run_detection().await {
                    Ok(emitted) => {
                        if let Ok(mut s) = STATE.lock() {
                            s.last_run_ms = Some(
                                std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .map(|d| d.as_millis() as i64)
                                    .unwrap_or(0),
                            );
                            s.last_emitted_count = emitted;
                            s.last_error = None;
                        }
                        crate::memory_obs::emit(
                            "patterns_sync_done",
                            &[("emitted", emitted.to_string())],
                        );
                    }
                    Err(e) => {
                        log::warn!("patterns_sync failed: {}", e);
                        if let Ok(mut s) = STATE.lock() {
                            s.last_error = Some(e.clone());
                        }
                        crate::memory_obs::emit("patterns_sync_error", &[("error", e)]);
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(30 * 60)).await;
        }
    });
}

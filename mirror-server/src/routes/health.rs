//! `GET /v1/health` — no auth required.

use axum::{response::IntoResponse, Json};
use serde_json::json;
use std::sync::OnceLock;
use std::time::Instant;

static START_TIME: OnceLock<Instant> = OnceLock::new();

/// Call once at startup to record the process start time.
pub fn init_start_time() {
    START_TIME.get_or_init(Instant::now);
}

pub async fn health() -> impl IntoResponse {
    let uptime = START_TIME.get().map(|s| s.elapsed().as_secs()).unwrap_or(0);
    Json(json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "uptime_seconds": uptime,
    }))
}

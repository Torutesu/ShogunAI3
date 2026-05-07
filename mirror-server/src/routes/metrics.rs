//! `/metrics` — Prometheus-style counters + gauges on a separate port. No auth.

use axum::{response::IntoResponse, routing::get, Router};
use std::sync::atomic::{AtomicU64, Ordering};

// ── Global counters ───────────────────────────────────────────────────────────

pub static BLOBS_UPLOADED: AtomicU64 = AtomicU64::new(0);
pub static BLOBS_FETCHED: AtomicU64 = AtomicU64::new(0);
pub static TOMBSTONES_CREATED: AtomicU64 = AtomicU64::new(0);
pub static RATE_LIMITED: AtomicU64 = AtomicU64::new(0);
/// Gauge: number of registered devices on this server.
pub static ACTIVE_DEVICES: AtomicU64 = AtomicU64::new(0);

pub fn inc_uploaded() {
    BLOBS_UPLOADED.fetch_add(1, Ordering::Relaxed);
}
pub fn inc_fetched() {
    BLOBS_FETCHED.fetch_add(1, Ordering::Relaxed);
}
pub fn inc_tombstoned() {
    TOMBSTONES_CREATED.fetch_add(1, Ordering::Relaxed);
}
pub fn inc_rate_limited() {
    RATE_LIMITED.fetch_add(1, Ordering::Relaxed);
}

/// Initialize the active-devices gauge from a startup count.
pub fn set_active_devices(n: u64) {
    ACTIVE_DEVICES.store(n, Ordering::Relaxed);
}
pub fn inc_active_devices() {
    ACTIVE_DEVICES.fetch_add(1, Ordering::Relaxed);
}
pub fn dec_active_devices() {
    // Saturating subtract; never go negative.
    let mut cur = ACTIVE_DEVICES.load(Ordering::Relaxed);
    loop {
        let next = cur.saturating_sub(1);
        match ACTIVE_DEVICES.compare_exchange_weak(cur, next, Ordering::Relaxed, Ordering::Relaxed)
        {
            Ok(_) => break,
            Err(observed) => cur = observed,
        }
    }
}

// ── Handler ───────────────────────────────────────────────────────────────────

async fn metrics_handler() -> impl IntoResponse {
    let body = format!(
        "# HELP shogun_mirror_blobs_uploaded_total Total blobs uploaded\n\
         # TYPE shogun_mirror_blobs_uploaded_total counter\n\
         shogun_mirror_blobs_uploaded_total {}\n\
         # HELP shogun_mirror_blobs_fetched_total Total blobs fetched\n\
         # TYPE shogun_mirror_blobs_fetched_total counter\n\
         shogun_mirror_blobs_fetched_total {}\n\
         # HELP shogun_mirror_tombstones_total Total tombstones created\n\
         # TYPE shogun_mirror_tombstones_total counter\n\
         shogun_mirror_tombstones_total {}\n\
         # HELP shogun_mirror_rate_limited_total Total rate-limited requests\n\
         # TYPE shogun_mirror_rate_limited_total counter\n\
         shogun_mirror_rate_limited_total {}\n\
         # HELP shogun_mirror_active_devices Number of registered devices on this server.\n\
         # TYPE shogun_mirror_active_devices gauge\n\
         shogun_mirror_active_devices {}\n",
        BLOBS_UPLOADED.load(Ordering::Relaxed),
        BLOBS_FETCHED.load(Ordering::Relaxed),
        TOMBSTONES_CREATED.load(Ordering::Relaxed),
        RATE_LIMITED.load(Ordering::Relaxed),
        ACTIVE_DEVICES.load(Ordering::Relaxed),
    );
    (
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; version=0.0.4",
        )],
        body,
    )
}

/// Build and serve the metrics router on `addr`. Intended to be spawned.
pub async fn serve(addr: String) {
    let app = Router::new().route("/metrics", get(metrics_handler));
    match tokio::net::TcpListener::bind(&addr).await {
        Ok(listener) => {
            tracing::info!("metrics server listening on {addr}");
            let _ = axum::serve(listener, app).await;
        }
        Err(e) => {
            tracing::warn!("failed to bind metrics server on {addr}: {e}");
        }
    }
}

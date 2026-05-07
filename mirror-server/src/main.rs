//! Entry point: load config, start tokio runtime, mount axum router.

use std::net::SocketAddr;
use std::sync::Arc;

use tracing_subscriber::{fmt, EnvFilter};

use shogun_mirror_server::{
    config::Config,
    ratelimit::RateLimiter,
    reaper,
    routes::{self, health, metrics},
    storage::{BlobStore, LocalDiskStore},
    AppState,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Load configuration (file + env vars). Log loudly to stderr if it fails.
    // We can't use `tracing` here yet — the subscriber isn't initialized.
    let config = match Config::load() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("WARN: failed to parse config file/env ({e}); falling back to defaults");
            Config::default()
        }
    };

    // Init tracing.
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    fmt().json().with_env_filter(filter).init();

    tracing::info!(
        "shogun-mirror-server v{} starting",
        env!("CARGO_PKG_VERSION")
    );

    // Warn loudly if binding to a non-loopback address. The server speaks
    // plain HTTP only; operators must run a reverse proxy in front.
    warn_if_non_loopback(&config.server.listen_addr);

    // Build storage.
    let store: Arc<dyn BlobStore> = match config.storage.backend {
        shogun_mirror_server::config::StorageBackend::LocalDisk => {
            Arc::new(LocalDiskStore::new(&config.storage.data_dir).await?)
        }
    };

    // Build shared state.
    let rate_limiter = Arc::new(RateLimiter::new(config.ratelimit.clone()));
    let register_limiter = Arc::new(RateLimiter::new(config.ratelimit.clone()));
    let app_state = AppState {
        store: store.clone(),
        rate_limiter,
        register_limiter,
        config: config.clone(),
    };

    // Record start time for health endpoint uptime.
    health::init_start_time();

    // Initialize active-devices gauge from existing device records.
    if let Ok(devices) = store.list_devices().await {
        metrics::set_active_devices(devices.len() as u64);
    }

    // Spawn reaper.
    tokio::spawn(reaper::run_reaper(store.clone(), config.reaper.clone()));

    // Spawn metrics server on separate port.
    let metrics_addr = config.server.metrics_addr.clone();
    tokio::spawn(metrics::serve(metrics_addr));

    // Build main app.
    let app = routes::build_router(app_state);

    let listen_addr = config.server.listen_addr.clone();
    let listener = tokio::net::TcpListener::bind(&listen_addr).await?;
    tracing::info!("listening on http://{}", listen_addr);

    // `into_make_service_with_connect_info` exposes the client `SocketAddr`
    // to handlers via `ConnectInfo` (used by the per-IP register rate limit).
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;

    Ok(())
}

/// Emit a WARN log if `listen_addr`'s host is non-loopback. The check is
/// best-effort: we parse the address and inspect the IP. Hostnames that
/// resolve later are skipped with a generic warning.
fn warn_if_non_loopback(listen_addr: &str) {
    match listen_addr.parse::<SocketAddr>() {
        Ok(addr) => {
            if !addr.ip().is_loopback() {
                tracing::warn!(
                    addr = %listen_addr,
                    "binding to non-loopback address without local TLS; \
                     ensure a reverse proxy terminates HTTPS in front of \
                     this server, and never expose this port directly to \
                     the public internet"
                );
            }
        }
        Err(_) => {
            tracing::warn!(
                addr = %listen_addr,
                "listen_addr is not a parseable SocketAddr; if it resolves \
                 to a non-loopback IP, ensure a reverse proxy terminates \
                 HTTPS in front of this server"
            );
        }
    }
}

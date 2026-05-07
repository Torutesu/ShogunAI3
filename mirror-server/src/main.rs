//! Entry point: load config, start tokio runtime, mount axum router.

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
    // Load configuration (file + env vars; falls back to defaults).
    let config = Config::load().unwrap_or_default();

    // Init tracing.
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    fmt().with_env_filter(filter).init();

    tracing::info!(
        "shogun-mirror-server v{} starting",
        env!("CARGO_PKG_VERSION")
    );

    // Build storage.
    let store: Arc<dyn BlobStore> = match config.storage.backend {
        shogun_mirror_server::config::StorageBackend::LocalDisk => {
            Arc::new(LocalDiskStore::new(&config.storage.data_dir).await?)
        }
    };

    // Build shared state.
    let rate_limiter = Arc::new(RateLimiter::new(config.ratelimit.clone()));
    let app_state = AppState {
        store: store.clone(),
        rate_limiter,
        config: config.clone(),
    };

    // Record start time for health endpoint uptime.
    health::init_start_time();

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

    axum::serve(listener, app).await?;

    Ok(())
}

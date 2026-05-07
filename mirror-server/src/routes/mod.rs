//! Route assembly — builds the main axum `Router`.

pub mod blobs;
pub mod devices;
pub mod health;
pub mod metrics;

use axum::{
    middleware,
    routing::{get, post, put},
    Router,
};
use tower_http::trace::TraceLayer;

use crate::{auth::require_device_token, AppState};

/// Build the main application router.
///
/// Auth-exempt routes (`POST /v1/devices`, `GET /v1/health`) are on a separate
/// sub-router that is merged without the auth middleware.
pub fn build_router(state: AppState) -> Router {
    // Authenticated routes.
    let authed = Router::new()
        .route(
            "/v1/devices/:id",
            put(devices::rename).delete(devices::delete),
        )
        .route("/v1/blobs", post(blobs::upload).get(blobs::list))
        .route("/v1/blobs/:id", get(blobs::fetch))
        .route("/v1/blobs/:id/tombstone", post(blobs::tombstone))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            require_device_token,
        ));

    // Unauthenticated routes.
    let public = Router::new()
        .route("/v1/devices", post(devices::register))
        .route("/v1/health", get(health::health));

    Router::new()
        .merge(authed)
        .merge(public)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

//! SHOGUN Memory Mirror server — encrypted blob storage with cursor-based
//! delta sync. See spec docs/superpowers/specs/2026-05-07-mirror-server-reference-design.md
//! and RFC docs/superpowers/specs/2026-05-07-mirror-protocol-rfc.md.

#![allow(dead_code)]

pub mod auth;
pub mod config;
pub mod error;
pub mod ratelimit;
pub mod reaper;
pub mod routes;
pub mod storage;

use std::sync::Arc;

use crate::{config::Config, ratelimit::RateLimiter, storage::BlobStore};

/// Shared application state, cloned into every route handler.
#[derive(Clone)]
pub struct AppState {
    pub store: Arc<dyn BlobStore>,
    pub rate_limiter: Arc<RateLimiter>,
    pub config: Config,
}

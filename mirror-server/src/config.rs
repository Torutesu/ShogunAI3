//! Server configuration — loaded from `mirror-server.toml` + `SHOGUN_MIRROR_*` env vars.
//!
//! ## TLS
//!
//! This server speaks **plain HTTP only** on its bind address. TLS termination
//! is the operator's responsibility via a reverse proxy (Caddy / nginx /
//! Cloudflare). See README "Production deployment" for the recommended setup.
//!
//! Operators MUST bind only to a loopback or private interface; never expose
//! this server's port to the public internet without TLS in front. The startup
//! sequence emits a WARN log if it detects a non-loopback `listen_addr`.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::ratelimit::RateLimitConfig;
use crate::reaper::ReaperConfig;

// ── Sub-configs ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    /// Main HTTP listen address. Default: `127.0.0.1:8443`.
    pub listen_addr: String,
    /// Metrics server listen address. Default: `127.0.0.1:9090`.
    pub metrics_addr: String,
}

impl Default for ServerConfig {
    fn default() -> Self {
        ServerConfig {
            listen_addr: "127.0.0.1:8443".to_string(),
            metrics_addr: "127.0.0.1:9090".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StorageBackend {
    LocalDisk,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageConfig {
    pub backend: StorageBackend,
    pub data_dir: PathBuf,
}

impl Default for StorageConfig {
    fn default() -> Self {
        StorageConfig {
            backend: StorageBackend::LocalDisk,
            data_dir: PathBuf::from("/tmp/shogun-mirror-data"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthConfig {
    /// Single static registration code for MVP self-hosted.
    pub registration_code: String,
    /// Stable per-instance account identifier.
    pub account_id: String,
    /// Per-IP rate limit on the unauthenticated `POST /v1/devices` endpoint.
    /// Default: 10 attempts per IP per hour. (Note: this is informational only;
    /// the actual rate limiter uses `RateLimitConfig::register_per_ip_per_hour`.)
    #[serde(default = "default_register_per_ip_per_hour")]
    pub register_per_ip_per_hour: u32,
}

fn default_register_per_ip_per_hour() -> u32 {
    10
}

impl Default for AuthConfig {
    fn default() -> Self {
        AuthConfig {
            registration_code: "dev-secret".to_string(),
            account_id: "default-account".to_string(),
            register_per_ip_per_hour: 10,
        }
    }
}

// ── Root Config ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub server: ServerConfig,
    #[serde(default)]
    pub storage: StorageConfig,
    #[serde(default)]
    pub auth: AuthConfig,
    #[serde(default)]
    pub ratelimit: RateLimitConfig,
    #[serde(default)]
    pub reaper: ReaperConfig,
}

impl Config {
    /// Load from `mirror-server.toml` (optional) + `SHOGUN_MIRROR_*` env vars.
    /// Returns the parsed config or a `ConfigError`. Caller is expected to
    /// log the error and fall back to defaults.
    pub fn load() -> Result<Self, config::ConfigError> {
        config::Config::builder()
            .add_source(config::File::with_name("mirror-server").required(false))
            .add_source(
                config::Environment::with_prefix("SHOGUN_MIRROR")
                    .separator("__")
                    .try_parsing(true),
            )
            .build()?
            .try_deserialize()
    }
}

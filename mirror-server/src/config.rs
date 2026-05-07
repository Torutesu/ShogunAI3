//! Server configuration — loaded from `mirror-server.toml` + `SHOGUN_MIRROR_*` env vars.

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
}

impl Default for AuthConfig {
    fn default() -> Self {
        AuthConfig {
            registration_code: "dev-secret".to_string(),
            account_id: "default-account".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TlsConfig {
    pub cert_path: PathBuf,
    pub key_path: PathBuf,
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
    pub tls: Option<TlsConfig>,
}

impl Config {
    /// Load from `mirror-server.toml` (optional) + `SHOGUN_MIRROR_*` env vars.
    /// Falls back to defaults for any missing fields.
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
            .or_else(|_| Ok(Config::default()))
    }
}

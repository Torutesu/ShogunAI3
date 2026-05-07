//! In-memory token-bucket rate limiter per device.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

// ── Config ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RateLimitConfig {
    pub post_blobs_per_minute: u32,
    pub post_blobs_per_day: u32,
    pub get_list_per_minute: u32,
    pub get_blob_per_minute: u32,
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        RateLimitConfig {
            post_blobs_per_minute: 100,
            post_blobs_per_day: 10000,
            get_list_per_minute: 60,
            get_blob_per_minute: 600,
        }
    }
}

// ── Endpoint enum ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Endpoint {
    PostBlob,
    GetBlobList,
    GetBlob,
}

// ── Token bucket ────────────────────────────────────────────────────────────

#[derive(Debug)]
struct Bucket {
    /// Tokens available right now.
    tokens: f64,
    /// Maximum tokens (= limit per window).
    capacity: f64,
    /// Tokens added per second.
    refill_rate: f64,
    /// Last time we refilled.
    last_refill: Instant,
}

impl Bucket {
    fn new(capacity: u32, window_secs: u64) -> Self {
        let cap = capacity as f64;
        Bucket {
            tokens: cap,
            capacity: cap,
            refill_rate: cap / window_secs as f64,
            last_refill: Instant::now(),
        }
    }

    /// Try to consume one token. Returns `Ok(())` or `Err(retry_after)`.
    fn try_consume(&mut self) -> Result<(), Duration> {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_refill).as_secs_f64();
        self.tokens = (self.tokens + elapsed * self.refill_rate).min(self.capacity);
        self.last_refill = now;

        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            Ok(())
        } else {
            // How long until 1 token refills.
            let wait = (1.0 - self.tokens) / self.refill_rate;
            Err(Duration::from_secs_f64(wait))
        }
    }
}

// ── Per-device, per-endpoint bucket key ─────────────────────────────────────

#[derive(Debug, PartialEq, Eq, Hash)]
struct BucketKey {
    device_id: String,
    endpoint: Endpoint,
}

// ── RateLimiter ───────────────────────────────────────────────────────────────

pub struct RateLimiter {
    buckets: Mutex<HashMap<BucketKey, Bucket>>,
    config: RateLimitConfig,
}

impl RateLimiter {
    pub fn new(config: RateLimitConfig) -> Self {
        RateLimiter {
            buckets: Mutex::new(HashMap::new()),
            config,
        }
    }

    /// Try to acquire a slot for the given device + endpoint.
    /// Returns `Ok(())` or `Err(retry_after)`.
    pub fn try_acquire(&self, device_id: &str, endpoint: Endpoint) -> Result<(), Duration> {
        let (capacity, window_secs) = match endpoint {
            Endpoint::PostBlob => (self.config.post_blobs_per_minute, 60),
            Endpoint::GetBlobList => (self.config.get_list_per_minute, 60),
            Endpoint::GetBlob => (self.config.get_blob_per_minute, 60),
        };
        let key = BucketKey {
            device_id: device_id.to_string(),
            endpoint,
        };
        let mut guard = self.buckets.lock();
        let bucket = guard
            .entry(key)
            .or_insert_with(|| Bucket::new(capacity, window_secs));
        bucket.try_consume()
    }
}

// ── Unit tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_acquire_within_limit() {
        let cfg = RateLimitConfig {
            post_blobs_per_minute: 10,
            ..Default::default()
        };
        let rl = RateLimiter::new(cfg);
        for _ in 0..10 {
            assert!(rl.try_acquire("device1", Endpoint::PostBlob).is_ok());
        }
    }

    #[test]
    fn test_acquire_exceeds_limit() {
        let cfg = RateLimitConfig {
            post_blobs_per_minute: 5,
            ..Default::default()
        };
        let rl = RateLimiter::new(cfg);
        for _ in 0..5 {
            rl.try_acquire("device2", Endpoint::PostBlob).unwrap();
        }
        let err = rl.try_acquire("device2", Endpoint::PostBlob);
        assert!(err.is_err());
        let retry = err.unwrap_err();
        assert!(retry.as_secs_f64() > 0.0);
    }

    #[test]
    fn test_different_devices_independent() {
        let cfg = RateLimitConfig {
            post_blobs_per_minute: 3,
            ..Default::default()
        };
        let rl = RateLimiter::new(cfg);
        // Exhaust device1.
        for _ in 0..3 {
            rl.try_acquire("device3", Endpoint::PostBlob).unwrap();
        }
        assert!(rl.try_acquire("device3", Endpoint::PostBlob).is_err());
        // device4 is still fresh.
        assert!(rl.try_acquire("device4", Endpoint::PostBlob).is_ok());
    }

    #[test]
    fn test_different_endpoints_independent() {
        let cfg = RateLimitConfig {
            post_blobs_per_minute: 2,
            get_blob_per_minute: 600,
            ..Default::default()
        };
        let rl = RateLimiter::new(cfg);
        for _ in 0..2 {
            rl.try_acquire("dev5", Endpoint::PostBlob).unwrap();
        }
        assert!(rl.try_acquire("dev5", Endpoint::PostBlob).is_err());
        // GET blob is a different bucket — still has tokens.
        assert!(rl.try_acquire("dev5", Endpoint::GetBlob).is_ok());
    }

    #[test]
    fn test_retry_after_is_positive() {
        let cfg = RateLimitConfig {
            post_blobs_per_minute: 1,
            ..Default::default()
        };
        let rl = RateLimiter::new(cfg);
        rl.try_acquire("dev6", Endpoint::PostBlob).unwrap();
        let err = rl.try_acquire("dev6", Endpoint::PostBlob).unwrap_err();
        assert!(err.as_secs_f64() > 0.0);
        assert!(err.as_secs_f64() <= 60.0);
    }
}

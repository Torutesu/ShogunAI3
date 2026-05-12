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
    /// Per-IP cap on `POST /v1/devices` (registration) per hour.
    /// Defaulted via serde so that older config files / partial env-var sets
    /// continue to load cleanly.
    #[serde(default = "default_register_per_ip_per_hour")]
    pub register_per_ip_per_hour: u32,
}

fn default_register_per_ip_per_hour() -> u32 {
    10
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        RateLimitConfig {
            post_blobs_per_minute: 100,
            post_blobs_per_day: 10000,
            get_list_per_minute: 60,
            get_blob_per_minute: 600,
            register_per_ip_per_hour: 10,
        }
    }
}

// ── Endpoint enum ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Endpoint {
    PostBlob,
    GetBlobList,
    GetBlob,
    /// `POST /v1/devices` keyed by client IP (not device_id).
    RegisterByIp,
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

// ── Per-device, per-endpoint, per-window bucket key ──────────────────────────

/// Window kind. Some endpoints (PostBlob) have multiple windows enforced
/// simultaneously (per-minute AND per-day per RFC § 8.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Window {
    Minute,
    Day,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct BucketKey {
    /// The principal key — either a `device_id` (authenticated endpoints) or
    /// a client IP string (the unauthenticated register endpoint).
    principal: String,
    endpoint: Endpoint,
    window: Window,
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

    /// Try to acquire a slot for the given principal + endpoint.
    /// `principal` is either a `device_id` (authenticated endpoints) or a
    /// client IP string for `Endpoint::RegisterByIp`.
    ///
    /// For `PostBlob`, BOTH the per-minute and per-day buckets must allow the
    /// request; the longer retry-after is returned on failure.
    /// Returns `Ok(())` or `Err(retry_after)`.
    pub fn try_acquire(&self, principal: &str, endpoint: Endpoint) -> Result<(), Duration> {
        // Build the (capacity, window_secs, window_kind) tuples to enforce.
        let checks: Vec<(u32, u64, Window)> = match endpoint {
            Endpoint::PostBlob => vec![
                (self.config.post_blobs_per_minute, 60, Window::Minute),
                (self.config.post_blobs_per_day, 86400, Window::Day),
            ],
            Endpoint::GetBlobList => vec![(self.config.get_list_per_minute, 60, Window::Minute)],
            Endpoint::GetBlob => vec![(self.config.get_blob_per_minute, 60, Window::Minute)],
            Endpoint::RegisterByIp => {
                // 1-hour window, configurable cap.
                vec![(self.config.register_per_ip_per_hour, 3600, Window::Day)]
            }
        };

        let mut guard = self.buckets.lock();

        // First pass: peek every bucket without consuming. If any would deny,
        // return the longest retry-after and consume nothing.
        let mut peeks: Vec<(BucketKey, u32, u64)> = Vec::with_capacity(checks.len());
        let mut deny: Option<Duration> = None;
        for (capacity, window_secs, window) in checks.into_iter() {
            let key = BucketKey {
                principal: principal.to_string(),
                endpoint,
                window,
            };
            let bucket = guard
                .entry(key.clone())
                .or_insert_with(|| Bucket::new(capacity, window_secs));
            // refill timeline-only check (don't consume yet)
            let now = Instant::now();
            let elapsed = now.duration_since(bucket.last_refill).as_secs_f64();
            let projected = (bucket.tokens + elapsed * bucket.refill_rate).min(bucket.capacity);
            if projected < 1.0 {
                let wait = (1.0 - projected) / bucket.refill_rate;
                let wait = Duration::from_secs_f64(wait);
                deny = Some(match deny {
                    Some(prev) if prev >= wait => prev,
                    _ => wait,
                });
            }
            peeks.push((key, capacity, window_secs));
        }

        if let Some(retry) = deny {
            return Err(retry);
        }

        // Second pass: actually consume from every bucket.
        for (key, capacity, window_secs) in peeks {
            let bucket = guard
                .entry(key)
                .or_insert_with(|| Bucket::new(capacity, window_secs));
            // Should always succeed since the peek pass said so.
            let _ = bucket.try_consume();
        }

        Ok(())
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

    #[test]
    fn test_per_day_limit_enforced() {
        // Per-minute is generous, per-day is tight: only the per-day cap applies.
        let cfg = RateLimitConfig {
            post_blobs_per_minute: 100,
            post_blobs_per_day: 5,
            ..Default::default()
        };
        let rl = RateLimiter::new(cfg);
        for _ in 0..5 {
            rl.try_acquire("dayDev", Endpoint::PostBlob).unwrap();
        }
        let err = rl.try_acquire("dayDev", Endpoint::PostBlob);
        assert!(err.is_err(), "6th acquire should hit the per-day cap");
        let retry = err.unwrap_err();
        // The day-bucket retry should be much longer than the minute window.
        // With 5/day refill rate, a single token takes 86400/5 = 17280s to refill.
        assert!(
            retry.as_secs_f64() > 60.0,
            "retry-after should be > 60s when day cap is hit; got {}s",
            retry.as_secs_f64()
        );
    }

    #[test]
    fn test_per_minute_atomic_with_per_day() {
        // Per-minute hits first; the day bucket should NOT have been consumed
        // when the minute peek denies the request (atomic, no partial consume).
        let cfg = RateLimitConfig {
            post_blobs_per_minute: 2,
            post_blobs_per_day: 100,
            ..Default::default()
        };
        let rl = RateLimiter::new(cfg);
        rl.try_acquire("atomDev", Endpoint::PostBlob).unwrap();
        rl.try_acquire("atomDev", Endpoint::PostBlob).unwrap();
        // 3rd request hits per-minute cap.
        let err = rl.try_acquire("atomDev", Endpoint::PostBlob);
        assert!(err.is_err());
        // The day-bucket should still have ~98 tokens left (no partial consume).
        // We can't directly inspect, but we can verify by making the day cap
        // very small and ensuring the minute denial does not consume the day token.
    }

    #[test]
    fn test_register_by_ip_limit() {
        let cfg = RateLimitConfig {
            register_per_ip_per_hour: 3,
            ..Default::default()
        };
        let rl = RateLimiter::new(cfg);
        for _ in 0..3 {
            rl.try_acquire("1.2.3.4", Endpoint::RegisterByIp).unwrap();
        }
        // 4th attempt from same IP must be denied.
        let err = rl
            .try_acquire("1.2.3.4", Endpoint::RegisterByIp)
            .unwrap_err();
        assert!(err.as_secs_f64() > 0.0);
        // Different IP is fresh.
        assert!(rl.try_acquire("5.6.7.8", Endpoint::RegisterByIp).is_ok());
    }

    #[test]
    fn test_per_day_not_consumed_on_minute_denial() {
        // Set day cap = 3 so we can detect leakage.
        let cfg = RateLimitConfig {
            post_blobs_per_minute: 1,
            post_blobs_per_day: 3,
            ..Default::default()
        };
        let rl = RateLimiter::new(cfg);

        // First request: both buckets consume → day=2, min=0.
        rl.try_acquire("leakDev", Endpoint::PostBlob).unwrap();
        // Two more attempts immediately fail on per-minute; day must NOT decrement.
        for _ in 0..5 {
            assert!(rl.try_acquire("leakDev", Endpoint::PostBlob).is_err());
        }
        // Force the per-minute bucket to refill enough by manually replenishing —
        // we sidestep clock waiting by directly consuming day=2 still has 2 left.
        // After 5 denials, peek again: if day was incorrectly drained, this final
        // path would also fail with a long retry; we just assert the same minute-
        // bound retry-after pattern persists.
        let err = rl.try_acquire("leakDev", Endpoint::PostBlob).unwrap_err();
        // If per-minute is the bottleneck (1/min), retry < 60s. If day was leaked
        // and is now 0, retry would be > 60s.
        assert!(
            err.as_secs_f64() < 60.0,
            "expected minute-cap retry <60s; got {}s — day bucket was likely \
             consumed on a denied attempt",
            err.as_secs_f64()
        );
    }
}

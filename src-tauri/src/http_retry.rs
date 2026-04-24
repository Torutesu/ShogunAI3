//! Tiny retry helper for HTTP calls that might be rate-limited (429) or
//! temporarily unavailable (5xx). Honors `Retry-After` when present, otherwise
//! falls back to a capped exponential backoff.

use reqwest::header::HeaderMap;
use reqwest::{Response, StatusCode};
use std::future::Future;
use std::time::Duration;

/// Reasonable defaults for historical-sync use.
pub const DEFAULT_MAX_ATTEMPTS: u32 = 5;
pub const DEFAULT_BASE_DELAY_MS: u64 = 500;
pub const DEFAULT_MAX_DELAY_MS: u64 = 30_000;

/// Returns parsed seconds from the `Retry-After` header, if present and
/// interpretable as an integer. HTTP-date form is out of scope.
fn parse_retry_after_secs(headers: &HeaderMap) -> Option<u64> {
  let v = headers.get("retry-after")?.to_str().ok()?;
  v.trim().parse::<u64>().ok()
}

/// Decide whether to retry a transient HTTP failure and the delay to wait
/// before the next attempt. Returns `None` when the caller should stop.
pub fn next_retry_delay(
  status: StatusCode,
  headers: &HeaderMap,
  attempt: u32,
  base_delay_ms: u64,
  max_delay_ms: u64,
) -> Option<Duration> {
  let retriable = status == StatusCode::TOO_MANY_REQUESTS
    || status == StatusCode::SERVICE_UNAVAILABLE
    || status == StatusCode::BAD_GATEWAY
    || status == StatusCode::GATEWAY_TIMEOUT;
  if !retriable {
    return None;
  }
  if let Some(secs) = parse_retry_after_secs(headers) {
    let ms = (secs * 1000).min(max_delay_ms);
    return Some(Duration::from_millis(ms));
  }
  // Exponential backoff: base * 2^(attempt-1), capped at max_delay_ms.
  let factor = 1u64.checked_shl(attempt.saturating_sub(1)).unwrap_or(u64::MAX);
  let ms = base_delay_ms.saturating_mul(factor).min(max_delay_ms);
  Some(Duration::from_millis(ms))
}

/// Run an async HTTP call with retry on 429/503/502/504.
///
/// `send` is called once per attempt and must return `Ok(Response)` on success
/// (including non-2xx). Network-level failures are propagated after the final
/// attempt; the caller is responsible for inspecting the final status.
pub async fn with_retry<F, Fut>(
  mut send: F,
  max_attempts: u32,
  base_delay_ms: u64,
  max_delay_ms: u64,
) -> Result<Response, String>
where
  F: FnMut() -> Fut,
  Fut: Future<Output = Result<Response, reqwest::Error>>,
{
  let mut attempt: u32 = 0;
  let mut last_net_err: Option<String> = None;
  loop {
    attempt += 1;
    match send().await {
      Ok(resp) => {
        let status = resp.status();
        if status.is_success() {
          return Ok(resp);
        }
        if attempt >= max_attempts {
          return Ok(resp);
        }
        let Some(delay) =
          next_retry_delay(status, resp.headers(), attempt, base_delay_ms, max_delay_ms)
        else {
          return Ok(resp);
        };
        log::warn!(
          "http retry: status {} attempt {}/{} sleeping {:?}",
          status,
          attempt,
          max_attempts,
          delay
        );
        // Drain the body to free the socket before sleeping.
        let _ = resp.bytes().await;
        tokio::time::sleep(delay).await;
      }
      Err(e) => {
        last_net_err = Some(e.to_string());
        if attempt >= max_attempts {
          return Err(last_net_err.unwrap_or_else(|| "http send failed".to_string()));
        }
        let factor = 1u64.checked_shl(attempt.saturating_sub(1)).unwrap_or(u64::MAX);
        let ms = base_delay_ms.saturating_mul(factor).min(max_delay_ms);
        log::warn!(
          "http retry: network err attempt {}/{}: {} — sleeping {}ms",
          attempt,
          max_attempts,
          last_net_err.as_deref().unwrap_or(""),
          ms
        );
        tokio::time::sleep(Duration::from_millis(ms)).await;
      }
    }
  }
}

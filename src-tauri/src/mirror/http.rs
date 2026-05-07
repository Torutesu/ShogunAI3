//! HTTP client for the Mirror protocol (RFC at
//! `docs/superpowers/specs/2026-05-07-mirror-protocol-rfc.md`).
//! Wraps `reqwest` with structured request/response types and a
//! retry-aware error taxonomy.

use serde::{Deserialize, Serialize};
use std::time::Duration;

// ─── Error taxonomy ──────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub(crate) enum Error {
    #[error("network: {0}")]
    Network(String),
    #[error("server error: {0}")]
    ServerError(u16),
    #[error("unauthorized")]
    Unauthorized,
    #[error("forbidden")]
    Forbidden,
    #[error("rate limited; retry after {0:?}")]
    RateLimited(Duration),
    #[error("payload too large")]
    PayloadTooLarge,
    #[error("invalid envelope: {0}")]
    InvalidEnvelope(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("not found")]
    NotFound,
    #[error("gone")]
    Gone,
    #[error("unknown: {0}")]
    Unknown(String),
}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        Error::Network(e.to_string())
    }
}

// ─── Wire types (RFC § 4.1) ──────────────────────────────────────────────────

/// Plaintext metadata embedded in a BlobEnvelope (RFC § 4.2).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct BlobMetadata {
    /// High-level provenance categories (e.g. ["screen"]).
    pub kinds: Vec<String>,
    /// Same enum value as kinds[0].
    pub provenance: String,
    /// Unix minute (floor(unix_ms / 60_000)) — minute-precision only.
    pub captured_at_minute: u64,
}

/// Wire shape of the ciphertext field in a BlobEnvelope.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EnvelopeCiphertext {
    /// Base64-encoded 24-byte XChaCha20 nonce.
    pub nonce: String,
    /// Base64-encoded ciphertext + 16-byte AEAD tag.
    pub data: String,
}

/// RFC § 4.1 BlobEnvelope — the JSON object posted to POST /v1/blobs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct BlobEnvelope {
    pub version: u8,
    pub blob_id: String,
    pub device_id: String,
    pub created_at: String,
    pub schema: String,
    pub metadata: BlobMetadata,
    pub ciphertext: EnvelopeCiphertext,
}

/// Response from POST /v1/devices (RFC § 5.3).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct DeviceRegistration {
    pub device_id: String,
    pub device_token: String,
}

/// Response from POST /v1/blobs (RFC § 5.3).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct UploadResponse {
    pub blob_id: String,
    pub stored_at: String,
}

/// One entry in a ListBlobsResponse.
#[allow(dead_code)] // consumed by Phase 2.1.4 split-arch search and 2.1.3 server tests
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct BlobListEntry {
    pub blob_id: String,
    pub device_id: String,
    pub stored_at: String,
    pub metadata: Option<BlobMetadata>,
    pub tombstoned_at: Option<String>,
}

/// Response from GET /v1/blobs (RFC § 5.3).
#[allow(dead_code)] // consumed by Phase 2.1.4 split-arch search and 2.1.3 server tests
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ListBlobsResponse {
    pub blobs: Vec<BlobListEntry>,
    pub next_cursor: Option<String>,
}

/// Response from GET /v1/health (RFC § 5.3).
#[allow(dead_code)] // consumed by Phase 2.1.4 split-arch search and 2.1.3 server tests
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct HealthResponse {
    pub ok: bool,
    pub version: String,
    pub uptime_seconds: Option<u64>,
}

/// Wire response from PUT /v1/devices/<id>.
///
/// Mirrors the server's `DeviceResponse` shape (mirror-server/src/routes/devices.rs).
/// `registered_at` is an RFC3339 string (server serializes `chrono::DateTime<Utc>`).
#[allow(dead_code)] // consumed by Phase 2.1.4 Settings UI device management
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct DeviceRecord {
    pub device_id: String,
    pub device_name: String,
    pub registered_at: String,
}

/// Aggregation summary for `list_devices_by_aggregation`. The server has no
/// GET /v1/devices endpoint (per design U9); this is derived from listing
/// blobs across the full account. Note: `device_name` is NOT available here
/// because the server doesn't expose names except on the register response.
/// The frontend caches names from register; this struct only carries the id
/// + counts.
#[allow(dead_code)] // consumed by Phase 2.1.4 Settings UI device management
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct DeviceSummary {
    pub device_id: String,
    pub blob_count: u64,
    /// RFC3339 string of the most recent blob's `stored_at`, or `None` if no
    /// non-tombstoned blobs exist for this device.
    pub latest_stored_at: Option<String>,
}

// ─── Status code → Error ─────────────────────────────────────────────────────

fn status_to_error(status: reqwest::StatusCode, body: &str, retry_after_secs: Option<u64>) -> Error {
    match status.as_u16() {
        400 => Error::InvalidEnvelope(body.to_string()),
        401 => Error::Unauthorized,
        403 => Error::Forbidden,
        404 => Error::NotFound,
        409 => Error::Conflict(body.to_string()),
        410 => Error::Gone,
        413 => Error::PayloadTooLarge,
        429 => {
            let secs = retry_after_secs.unwrap_or(60);
            Error::RateLimited(Duration::from_secs(secs))
        }
        s if s >= 500 => Error::ServerError(status.as_u16()),
        _ => Error::Unknown(format!("status {}", status)),
    }
}

/// Parse the Retry-After header value (integer seconds or HTTP-date).
/// Returns None if absent or unparseable; callers fall back to 60 s.
fn parse_retry_after(response: &reqwest::Response) -> Option<u64> {
    let val = response.headers().get("retry-after")?.to_str().ok()?;
    val.trim().parse::<u64>().ok()
}

/// Map a non-2xx `reqwest::Response` to our `Error` enum.
async fn map_error_response(resp: reqwest::Response) -> Error {
    let status = resp.status();
    let retry_after = parse_retry_after(&resp);
    let body = resp.text().await.unwrap_or_default();
    status_to_error(status, &body, retry_after)
}

// ─── Client ──────────────────────────────────────────────────────────────────

#[derive(Clone)]
pub(crate) struct Client {
    base_url: String,
    http: reqwest::Client,
    device_token: Option<String>,
}

impl Client {
    /// Create an authenticated client (bearer token set on every request except register_device).
    pub(crate) fn new(base_url: String, device_token: String) -> Result<Self, Error> {
        let http = reqwest::Client::builder()
            .use_rustls_tls()
            .build()
            .map_err(|e| Error::Network(e.to_string()))?;
        Ok(Self {
            base_url,
            http,
            device_token: Some(device_token),
        })
    }

    /// Create an unauthenticated client for use before registration.
    pub(crate) fn new_unauthenticated(base_url: String) -> Result<Self, Error> {
        let http = reqwest::Client::builder()
            .use_rustls_tls()
            .build()
            .map_err(|e| Error::Network(e.to_string()))?;
        Ok(Self {
            base_url,
            http,
            device_token: None,
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url.trim_end_matches('/'), path)
    }

    fn auth_header(&self) -> Option<String> {
        self.device_token.as_deref().map(|t| format!("Bearer {}", t))
    }

    /// POST /v1/devices — register this device. No auth header.
    pub(crate) async fn register_device(
        &self,
        registration_code: &str,
        device_name: &str,
    ) -> Result<DeviceRegistration, Error> {
        let body = serde_json::json!({
            "registration_code": registration_code,
            "device_name": device_name,
        });
        let resp = self
            .http
            .post(self.url("/v1/devices"))
            .json(&body)
            .send()
            .await?;

        if resp.status().is_success() {
            let reg: DeviceRegistration = resp.json().await.map_err(|e| Error::Network(e.to_string()))?;
            Ok(reg)
        } else {
            Err(map_error_response(resp).await)
        }
    }

    /// POST /v1/blobs — upload an encrypted blob.
    pub(crate) async fn upload_blob(&self, envelope: &BlobEnvelope) -> Result<UploadResponse, Error> {
        let mut req = self.http.post(self.url("/v1/blobs")).json(envelope);
        if let Some(auth) = self.auth_header() {
            req = req.header("Authorization", auth);
        }
        let resp = req.send().await?;

        if resp.status().is_success() {
            let upload: UploadResponse = resp.json().await.map_err(|e| Error::Network(e.to_string()))?;
            Ok(upload)
        } else {
            Err(map_error_response(resp).await)
        }
    }

    /// GET /v1/blobs?cursor=<cursor>&device_id=<id>&limit=<n> — delta sync.
    #[allow(dead_code)] // consumed by Phase 2.1.4 split-arch search and 2.1.3 server tests
    pub(crate) async fn list_blobs_cursor(
        &self,
        cursor: Option<&str>,
        device_id: Option<&str>,
        limit: Option<u32>,
    ) -> Result<ListBlobsResponse, Error> {
        let mut params: Vec<(&str, String)> = Vec::new();
        if let Some(c) = cursor {
            params.push(("cursor", c.to_string()));
        }
        if let Some(d) = device_id {
            params.push(("device_id", d.to_string()));
        }
        if let Some(l) = limit {
            params.push(("limit", l.to_string()));
        }

        let mut req = self.http.get(self.url("/v1/blobs")).query(&params);
        if let Some(auth) = self.auth_header() {
            req = req.header("Authorization", auth);
        }
        let resp = req.send().await?;

        if resp.status().is_success() {
            let list: ListBlobsResponse = resp.json().await.map_err(|e| Error::Network(e.to_string()))?;
            Ok(list)
        } else {
            Err(map_error_response(resp).await)
        }
    }

    /// GET /v1/blobs?since=<rfc3339>&until=<rfc3339>&device_id=<id>&cursor=<c> — time-range query.
    ///
    /// The server paginates this endpoint (default 100, max 1000 per page) and
    /// returns `next_cursor` when more results are available. Callers that need
    /// the full window must drain by re-calling with the returned cursor.
    #[allow(dead_code)] // consumed by Phase 2.1.4 split-arch search and 2.1.3 server tests
    pub(crate) async fn list_blobs_time_range(
        &self,
        since: &str,
        until: &str,
        device_id: Option<&str>,
        cursor: Option<&str>,
    ) -> Result<ListBlobsResponse, Error> {
        let mut params: Vec<(&str, String)> = vec![
            ("since", since.to_string()),
            ("until", until.to_string()),
        ];
        if let Some(d) = device_id {
            params.push(("device_id", d.to_string()));
        }
        if let Some(c) = cursor {
            params.push(("cursor", c.to_string()));
        }

        let mut req = self.http.get(self.url("/v1/blobs")).query(&params);
        if let Some(auth) = self.auth_header() {
            req = req.header("Authorization", auth);
        }
        let resp = req.send().await?;

        if resp.status().is_success() {
            let list: ListBlobsResponse = resp.json().await.map_err(|e| Error::Network(e.to_string()))?;
            Ok(list)
        } else {
            Err(map_error_response(resp).await)
        }
    }

    /// GET /v1/blobs/<blob_id> — fetch a single blob envelope.
    #[allow(dead_code)] // consumed by Phase 2.1.4 split-arch search and 2.1.3 server tests
    pub(crate) async fn fetch_blob(&self, blob_id: &str) -> Result<BlobEnvelope, Error> {
        let mut req = self.http.get(self.url(&format!("/v1/blobs/{}", blob_id)));
        if let Some(auth) = self.auth_header() {
            req = req.header("Authorization", auth);
        }
        let resp = req.send().await?;

        if resp.status().is_success() {
            let env: BlobEnvelope = resp.json().await.map_err(|e| Error::Network(e.to_string()))?;
            Ok(env)
        } else {
            Err(map_error_response(resp).await)
        }
    }

    /// POST /v1/blobs/<blob_id>/tombstone — soft delete.
    #[allow(dead_code)] // consumed by Phase 2.1.4 split-arch search and 2.1.3 server tests
    pub(crate) async fn tombstone(&self, blob_id: &str) -> Result<(), Error> {
        let mut req = self
            .http
            .post(self.url(&format!("/v1/blobs/{}/tombstone", blob_id)));
        if let Some(auth) = self.auth_header() {
            req = req.header("Authorization", auth);
        }
        let resp = req.send().await?;

        if resp.status().is_success() {
            Ok(())
        } else {
            Err(map_error_response(resp).await)
        }
    }

    /// GET /v1/health — server reachability check. No auth.
    #[allow(dead_code)] // consumed by Phase 2.1.4 split-arch search and 2.1.3 server tests
    pub(crate) async fn health(&self) -> Result<HealthResponse, Error> {
        let resp = self.http.get(self.url("/v1/health")).send().await?;

        if resp.status().is_success() {
            let h: HealthResponse = resp.json().await.map_err(|e| Error::Network(e.to_string()))?;
            Ok(h)
        } else {
            Err(map_error_response(resp).await)
        }
    }

    /// PUT /v1/devices/<device_id> — rename a device.
    ///
    /// Returns the updated `DeviceRecord` on success. The server validates
    /// `new_name` (non-empty, ≤64 chars, no control characters) and rejects
    /// cross-account access.
    ///
    /// Errors:
    /// - 401 → `Error::Unauthorized` (missing/invalid token, or cross-account)
    /// - 403 → `Error::Forbidden`
    /// - 404 → `Error::NotFound`
    /// - other → mapped via `map_error_response`
    #[allow(dead_code)] // consumed by Phase 2.1.4 Settings UI device management
    pub(crate) async fn rename_device(
        &self,
        device_id: &str,
        new_name: &str,
    ) -> Result<DeviceRecord, Error> {
        let body = serde_json::json!({
            "device_name": new_name,
        });
        let mut req = self
            .http
            .put(self.url(&format!("/v1/devices/{}", device_id)))
            .json(&body);
        if let Some(auth) = self.auth_header() {
            req = req.header("Authorization", auth);
        }
        let resp = req.send().await?;

        if resp.status().is_success() {
            let rec: DeviceRecord = resp.json().await.map_err(|e| Error::Network(e.to_string()))?;
            Ok(rec)
        } else {
            Err(map_error_response(resp).await)
        }
    }

    /// DELETE /v1/devices/<device_id> — remove a device and tombstone all its
    /// blobs.
    ///
    /// Returns the count of tombstoned blobs (`tombstoned_blobs` field of the
    /// server response). Bearer auth required.
    #[allow(dead_code)] // consumed by Phase 2.1.4 Settings UI device management
    pub(crate) async fn delete_device(&self, device_id: &str) -> Result<u64, Error> {
        let mut req = self
            .http
            .delete(self.url(&format!("/v1/devices/{}", device_id)));
        if let Some(auth) = self.auth_header() {
            req = req.header("Authorization", auth);
        }
        let resp = req.send().await?;

        if resp.status().is_success() {
            #[derive(Deserialize)]
            struct DeleteWire {
                tombstoned_blobs: u64,
            }
            let wire: DeleteWire = resp.json().await.map_err(|e| Error::Network(e.to_string()))?;
            Ok(wire.tombstoned_blobs)
        } else {
            Err(map_error_response(resp).await)
        }
    }

    /// Derive a list of devices by listing recent blobs across all devices and
    /// grouping by `device_id`. Calls `list_blobs_cursor` repeatedly to drain
    /// the cursor. Bounded by `MAX_AGGREGATION_PAGES` (100; ~100K blobs max
    /// at the server's 1000-per-page cap).
    ///
    /// Returns a `Vec<DeviceSummary>` sorted by `latest_stored_at` desc (most
    /// recent first). Tombstoned blobs are excluded from `blob_count` and from
    /// the `latest_stored_at` calculation.
    ///
    /// NOTE: this returns counts only — `device_name` is not available here
    /// (server has no `GET /v1/devices` endpoint per design U9). The frontend
    /// caches names from the register response.
    ///
    /// If pagination cap is hit, logs a warning and returns the partial
    /// aggregation rather than erroring (graceful degradation).
    #[allow(dead_code)] // consumed by Phase 2.1.4 Settings UI device management
    pub(crate) async fn list_devices_by_aggregation(
        &self,
    ) -> Result<Vec<DeviceSummary>, Error> {
        const MAX_AGGREGATION_PAGES: usize = 100;

        use std::collections::HashMap;

        struct Agg {
            count: u64,
            latest: Option<String>,
        }

        let mut groups: HashMap<String, Agg> = HashMap::new();
        let mut cursor: Option<String> = None;
        let mut pages = 0usize;

        loop {
            pages += 1;
            if pages > MAX_AGGREGATION_PAGES {
                log::warn!(
                    "list_devices_by_aggregation: pagination cap ({}) reached; returning partial results",
                    MAX_AGGREGATION_PAGES
                );
                break;
            }
            let resp = self
                .list_blobs_cursor(cursor.as_deref(), None, Some(1000))
                .await?;

            for entry in resp.blobs {
                if entry.tombstoned_at.is_some() {
                    continue;
                }
                let g = groups.entry(entry.device_id.clone()).or_insert(Agg {
                    count: 0,
                    latest: None,
                });
                g.count += 1;
                // RFC3339 strings sort lexicographically in chronological
                // order when normalized (Z suffix, fixed-width fields), which
                // is what the server emits.
                match &g.latest {
                    Some(cur) if cur.as_str() >= entry.stored_at.as_str() => {}
                    _ => g.latest = Some(entry.stored_at),
                }
            }

            if resp.next_cursor.is_none() {
                break;
            }
            cursor = resp.next_cursor;
        }

        let mut summaries: Vec<DeviceSummary> = groups
            .into_iter()
            .map(|(device_id, agg)| DeviceSummary {
                device_id,
                blob_count: agg.count,
                latest_stored_at: agg.latest,
            })
            .collect();

        // Sort by latest_stored_at desc. None sorts last.
        summaries.sort_by(|a, b| b.latest_stored_at.cmp(&a.latest_stored_at));

        Ok(summaries)
    }
}

// ─── Integration tests ───────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Server;
    use serde_json::json;

    fn make_envelope(blob_id: &str) -> BlobEnvelope {
        BlobEnvelope {
            version: 1,
            blob_id: blob_id.to_string(),
            device_id: "01HVDDD_device".to_string(),
            created_at: "2026-05-07T12:34:56.000Z".to_string(),
            schema: "mem_items.v1".to_string(),
            metadata: BlobMetadata {
                kinds: vec!["screen".to_string()],
                provenance: "screen".to_string(),
                captured_at_minute: 28872034,
            },
            ciphertext: EnvelopeCiphertext {
                nonce: "VGhpcyBpcyAyNCBieXRlcyBleGFjdGx5".to_string(),
                data: "0Xn_mock_ciphertext_data".to_string(),
            },
        }
    }

    fn make_client(server: &Server, token: &str) -> Client {
        Client::new(server.url(), token.to_string()).unwrap()
    }

    /// I1: register_device — mock 201 with device_id + device_token.
    #[tokio::test]
    async fn i1_register_device_happy_path() {
        let mut server = Server::new_async().await;
        let _m = server
            .mock("POST", "/v1/devices")
            .with_status(201)
            .with_header("content-type", "application/json")
            .with_body(r#"{"device_id":"01HVDDD","device_token":"tok_abc"}"#)
            .create_async()
            .await;

        let client = Client::new_unauthenticated(server.url()).unwrap();
        let reg = client
            .register_device("CODE-123", "My Mac")
            .await
            .expect("register_device should succeed");

        assert_eq!(reg.device_id, "01HVDDD");
        assert_eq!(reg.device_token, "tok_abc");
    }

    /// I2: upload_blob happy path → UploadResponse.
    #[tokio::test]
    async fn i2_upload_blob_happy_path() {
        let mut server = Server::new_async().await;
        let _m = server
            .mock("POST", "/v1/blobs")
            .with_status(201)
            .with_header("content-type", "application/json")
            .with_body(r#"{"blob_id":"01HVXXX","stored_at":"2026-05-07T12:34:57Z"}"#)
            .create_async()
            .await;

        let client = make_client(&server, "tok");
        let env = make_envelope("01HVXXX");
        let resp = client.upload_blob(&env).await.expect("upload_blob should succeed");

        assert_eq!(resp.blob_id, "01HVXXX");
    }

    /// I3: upload_blob 409 → Error::Conflict.
    #[tokio::test]
    async fn i3_upload_blob_409_conflict() {
        let mut server = Server::new_async().await;
        let _m = server
            .mock("POST", "/v1/blobs")
            .with_status(409)
            .with_header("content-type", "application/json")
            .with_body(r#"{"error":"conflict","message":"blob_id collision"}"#)
            .create_async()
            .await;

        let client = make_client(&server, "tok");
        let env = make_envelope("01HVXXX");
        let err = client.upload_blob(&env).await.expect_err("should be conflict");
        assert!(matches!(err, Error::Conflict(_)), "expected Conflict, got: {:?}", err);
    }

    /// I4: upload_blob 413 → Error::PayloadTooLarge.
    #[tokio::test]
    async fn i4_upload_blob_413_payload_too_large() {
        let mut server = Server::new_async().await;
        let _m = server
            .mock("POST", "/v1/blobs")
            .with_status(413)
            .with_body("")
            .create_async()
            .await;

        let client = make_client(&server, "tok");
        let env = make_envelope("01HVXXX");
        let err = client.upload_blob(&env).await.expect_err("should be PayloadTooLarge");
        assert!(matches!(err, Error::PayloadTooLarge), "expected PayloadTooLarge, got: {:?}", err);
    }

    /// I5: upload_blob 429 with Retry-After: 60 → Error::RateLimited(60s).
    #[tokio::test]
    async fn i5_upload_blob_429_rate_limited() {
        let mut server = Server::new_async().await;
        let _m = server
            .mock("POST", "/v1/blobs")
            .with_status(429)
            .with_header("retry-after", "60")
            .with_body("")
            .create_async()
            .await;

        let client = make_client(&server, "tok");
        let env = make_envelope("01HVXXX");
        let err = client.upload_blob(&env).await.expect_err("should be RateLimited");
        match err {
            Error::RateLimited(d) => assert_eq!(d, Duration::from_secs(60)),
            other => panic!("expected RateLimited(60s), got: {:?}", other),
        }
    }

    /// I6: upload_blob 500 → Error::ServerError(500).
    #[tokio::test]
    async fn i6_upload_blob_500_server_error() {
        let mut server = Server::new_async().await;
        let _m = server
            .mock("POST", "/v1/blobs")
            .with_status(500)
            .with_body("")
            .create_async()
            .await;

        let client = make_client(&server, "tok");
        let env = make_envelope("01HVXXX");
        let err = client.upload_blob(&env).await.expect_err("should be ServerError");
        assert!(matches!(err, Error::ServerError(500)), "expected ServerError(500), got: {:?}", err);
    }

    /// I7: list_blobs_cursor happy path with pagination.
    #[tokio::test]
    async fn i7_list_blobs_cursor_happy_path() {
        let mut server = Server::new_async().await;
        let body = json!({
            "blobs": [
                {
                    "blob_id": "01HVXXX",
                    "device_id": "01HVDDD",
                    "stored_at": "2026-05-07T12:34:57Z",
                    "metadata": {
                        "kinds": ["screen"],
                        "provenance": "screen",
                        "captured_at_minute": 28872034
                    },
                    "tombstoned_at": null
                }
            ],
            "next_cursor": "BASE64_CURSOR"
        });
        let _m = server
            .mock("GET", mockito::Matcher::Regex(r"^/v1/blobs".to_string()))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(body.to_string())
            .create_async()
            .await;

        let client = make_client(&server, "tok");
        let resp = client
            .list_blobs_cursor(None, None, Some(100))
            .await
            .expect("list_blobs_cursor should succeed");

        assert_eq!(resp.blobs.len(), 1);
        assert_eq!(resp.blobs[0].blob_id, "01HVXXX");
        assert_eq!(resp.next_cursor.as_deref(), Some("BASE64_CURSOR"));
    }

    /// I8: fetch_blob 410 → Error::Gone.
    #[tokio::test]
    async fn i8_fetch_blob_410_gone() {
        let mut server = Server::new_async().await;
        let _m = server
            .mock("GET", "/v1/blobs/01HVXXX")
            .with_status(410)
            .with_body("")
            .create_async()
            .await;

        let client = make_client(&server, "tok");
        let err = client.fetch_blob("01HVXXX").await.expect_err("should be Gone");
        assert!(matches!(err, Error::Gone), "expected Gone, got: {:?}", err);
    }

    /// I9: fetch_blob 404 → Error::NotFound.
    #[tokio::test]
    async fn i9_fetch_blob_404_not_found() {
        let mut server = Server::new_async().await;
        let _m = server
            .mock("GET", "/v1/blobs/missing_id")
            .with_status(404)
            .with_body("")
            .create_async()
            .await;

        let client = make_client(&server, "tok");
        let err = client.fetch_blob("missing_id").await.expect_err("should be NotFound");
        assert!(matches!(err, Error::NotFound), "expected NotFound, got: {:?}", err);
    }

    /// I10: health — no auth required, returns version.
    #[tokio::test]
    async fn i10_health_happy_path() {
        let mut server = Server::new_async().await;
        let _m = server
            .mock("GET", "/v1/health")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"ok":true,"version":"0.1.0","uptime_seconds":12345}"#)
            .create_async()
            .await;

        // Even unauthenticated client.
        let client = Client::new_unauthenticated(server.url()).unwrap();
        let h = client.health().await.expect("health should succeed");

        assert!(h.ok);
        assert_eq!(h.version, "0.1.0");
        assert_eq!(h.uptime_seconds, Some(12345));
    }

    /// D1: rename_device 200 — returns the updated DeviceRecord.
    #[tokio::test]
    async fn d1_rename_device_200_returns_record() {
        let mut server = Server::new_async().await;
        let body = json!({
            "device_id": "01HVDDD",
            "device_name": "My Renamed Mac",
            "registered_at": "2026-05-07T12:00:00Z"
        });
        let _m = server
            .mock("PUT", "/v1/devices/01HVDDD")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(body.to_string())
            .create_async()
            .await;

        let client = make_client(&server, "tok");
        let rec = client
            .rename_device("01HVDDD", "My Renamed Mac")
            .await
            .expect("rename_device should succeed");

        assert_eq!(rec.device_id, "01HVDDD");
        assert_eq!(rec.device_name, "My Renamed Mac");
        assert_eq!(rec.registered_at, "2026-05-07T12:00:00Z");
    }

    /// D2: rename_device 404 → Error::NotFound.
    #[tokio::test]
    async fn d2_rename_device_404_not_found() {
        let mut server = Server::new_async().await;
        let _m = server
            .mock("PUT", "/v1/devices/missing_id")
            .with_status(404)
            .with_body("")
            .create_async()
            .await;

        let client = make_client(&server, "tok");
        let err = client
            .rename_device("missing_id", "Whatever")
            .await
            .expect_err("should be NotFound");
        assert!(matches!(err, Error::NotFound), "expected NotFound, got: {:?}", err);
    }

    /// D3: rename_device 403 → Error::Forbidden.
    #[tokio::test]
    async fn d3_rename_device_403_forbidden() {
        let mut server = Server::new_async().await;
        let _m = server
            .mock("PUT", "/v1/devices/01HVDDD")
            .with_status(403)
            .with_body("")
            .create_async()
            .await;

        let client = make_client(&server, "tok");
        let err = client
            .rename_device("01HVDDD", "Nope")
            .await
            .expect_err("should be Forbidden");
        assert!(matches!(err, Error::Forbidden), "expected Forbidden, got: {:?}", err);
    }

    /// D4: delete_device 200 — returns tombstoned_blobs count.
    #[tokio::test]
    async fn d4_delete_device_200_returns_count() {
        let mut server = Server::new_async().await;
        let _m = server
            .mock("DELETE", "/v1/devices/01HVDDD")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"device_id":"01HVDDD","tombstoned_blobs":5}"#)
            .create_async()
            .await;

        let client = make_client(&server, "tok");
        let count = client
            .delete_device("01HVDDD")
            .await
            .expect("delete_device should succeed");
        assert_eq!(count, 5);
    }

    /// D5: list_devices_by_aggregation — single page, two devices, one
    /// tombstoned entry excluded from counts.
    #[tokio::test]
    async fn d5_list_devices_by_aggregation_groups_correctly() {
        let mut server = Server::new_async().await;
        // device_a: 3 blobs (1 tombstoned → 2 counted), latest non-tombstoned
        //           stored_at = 2026-05-07T13:00:00Z
        // device_b: 2 blobs, latest stored_at = 2026-05-07T14:00:00Z
        // → device_b sorts first (more recent latest_stored_at).
        let body = json!({
            "blobs": [
                {
                    "blob_id": "blob_a1",
                    "device_id": "device_a",
                    "stored_at": "2026-05-07T11:00:00Z",
                    "metadata": null,
                    "tombstoned_at": null
                },
                {
                    "blob_id": "blob_a2",
                    "device_id": "device_a",
                    "stored_at": "2026-05-07T13:00:00Z",
                    "metadata": null,
                    "tombstoned_at": null
                },
                {
                    "blob_id": "blob_a3",
                    "device_id": "device_a",
                    "stored_at": "2026-05-07T13:30:00Z",
                    "metadata": null,
                    "tombstoned_at": "2026-05-07T13:31:00Z"
                },
                {
                    "blob_id": "blob_b1",
                    "device_id": "device_b",
                    "stored_at": "2026-05-07T12:00:00Z",
                    "metadata": null,
                    "tombstoned_at": null
                },
                {
                    "blob_id": "blob_b2",
                    "device_id": "device_b",
                    "stored_at": "2026-05-07T14:00:00Z",
                    "metadata": null,
                    "tombstoned_at": null
                }
            ],
            "next_cursor": null
        });
        let _m = server
            .mock("GET", mockito::Matcher::Regex(r"^/v1/blobs".to_string()))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(body.to_string())
            .create_async()
            .await;

        let client = make_client(&server, "tok");
        let summaries = client
            .list_devices_by_aggregation()
            .await
            .expect("aggregation should succeed");

        assert_eq!(summaries.len(), 2);
        // device_b first (latest = 14:00), device_a second (latest = 13:00).
        assert_eq!(summaries[0].device_id, "device_b");
        assert_eq!(summaries[0].blob_count, 2);
        assert_eq!(
            summaries[0].latest_stored_at.as_deref(),
            Some("2026-05-07T14:00:00Z")
        );
        assert_eq!(summaries[1].device_id, "device_a");
        // 2 = 3 entries - 1 tombstoned.
        assert_eq!(summaries[1].blob_count, 2);
        // Tombstoned entry's stored_at (13:30) is excluded from latest.
        assert_eq!(
            summaries[1].latest_stored_at.as_deref(),
            Some("2026-05-07T13:00:00Z")
        );
    }

    /// D6: list_devices_by_aggregation drains the cursor across multiple pages.
    #[tokio::test]
    async fn d6_list_devices_by_aggregation_drains_cursor() {
        let mut server = Server::new_async().await;
        // Page 1: 1 blob from device_a, with next_cursor = "page2".
        let page1 = json!({
            "blobs": [
                {
                    "blob_id": "blob_a1",
                    "device_id": "device_a",
                    "stored_at": "2026-05-07T11:00:00Z",
                    "metadata": null,
                    "tombstoned_at": null
                }
            ],
            "next_cursor": "page2"
        });
        let page2 = json!({
            "blobs": [
                {
                    "blob_id": "blob_a2",
                    "device_id": "device_a",
                    "stored_at": "2026-05-07T12:00:00Z",
                    "metadata": null,
                    "tombstoned_at": null
                },
                {
                    "blob_id": "blob_c1",
                    "device_id": "device_c",
                    "stored_at": "2026-05-07T15:00:00Z",
                    "metadata": null,
                    "tombstoned_at": null
                }
            ],
            "next_cursor": null
        });
        // Page 1 mock: broad regex matcher. Mockito evaluates matchers in
        // reverse registration order (LIFO), so the more-specific page-2
        // matcher (registered after) wins when its cursor predicate matches.
        let _m1 = server
            .mock("GET", mockito::Matcher::Regex(r"^/v1/blobs".to_string()))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(page1.to_string())
            .expect(1)
            .create_async()
            .await;
        // Page 2 mock: only matches when `cursor=page2` is in the query string.
        let _m2 = server
            .mock("GET", "/v1/blobs")
            .match_query(mockito::Matcher::UrlEncoded(
                "cursor".to_string(),
                "page2".to_string(),
            ))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(page2.to_string())
            .expect(1)
            .create_async()
            .await;

        let client = make_client(&server, "tok");
        let summaries = client
            .list_devices_by_aggregation()
            .await
            .expect("aggregation should succeed");

        // Both pages contributed: device_a has 2 blobs across pages, device_c
        // has 1 from page 2.
        assert_eq!(summaries.len(), 2);
        // device_c first (latest = 15:00), device_a second (latest = 12:00).
        assert_eq!(summaries[0].device_id, "device_c");
        assert_eq!(summaries[0].blob_count, 1);
        assert_eq!(summaries[1].device_id, "device_a");
        assert_eq!(summaries[1].blob_count, 2);
        assert_eq!(
            summaries[1].latest_stored_at.as_deref(),
            Some("2026-05-07T12:00:00Z")
        );
    }
}

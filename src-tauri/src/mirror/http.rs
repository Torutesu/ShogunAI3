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

// ─── Status code → Error ─────────────────────────────────────────────────────

fn status_to_error(status: reqwest::StatusCode, body: &str, retry_after_secs: Option<u64>) -> Error {
    match status.as_u16() {
        400 => Error::InvalidEnvelope(body.to_string()),
        401 => Error::Unauthorized,
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

    /// GET /v1/blobs?since=<rfc3339>&until=<rfc3339>&device_id=<id> — time-range query.
    #[allow(dead_code)] // consumed by Phase 2.1.4 split-arch search and 2.1.3 server tests
    pub(crate) async fn list_blobs_time_range(
        &self,
        since: &str,
        until: &str,
        device_id: Option<&str>,
    ) -> Result<ListBlobsResponse, Error> {
        let mut params: Vec<(&str, String)> = vec![
            ("since", since.to_string()),
            ("until", until.to_string()),
        ];
        if let Some(d) = device_id {
            params.push(("device_id", d.to_string()));
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
}

//! HTTP integration tests using `axum_test::TestServer` against a real `LocalDiskStore`.

use axum_test::TestServer;
use serde_json::{json, Value};
use tempfile::TempDir;

use shogun_mirror_server::{
    config::{AuthConfig, Config, StorageBackend, StorageConfig},
    ratelimit::{RateLimitConfig, RateLimiter},
    routes::build_router,
    storage::{BlobStore, LocalDiskStore},
    AppState,
};

use chrono::Utc;
use std::sync::Arc;

// ── Test fixtures ─────────────────────────────────────────────────────────────

struct TestFixture {
    server: TestServer,
    store: Arc<dyn BlobStore>,
    _dir: TempDir,
}

async fn make_fixture() -> TestFixture {
    let dir = TempDir::new().unwrap();
    let store: Arc<dyn BlobStore> = Arc::new(LocalDiskStore::new(dir.path()).await.unwrap());
    let rate_limiter = Arc::new(RateLimiter::new(RateLimitConfig {
        post_blobs_per_minute: 10000,
        post_blobs_per_day: 1000000,
        get_list_per_minute: 10000,
        get_blob_per_minute: 100000,
    }));
    let config = Config {
        auth: AuthConfig {
            registration_code: "test-secret".to_string(),
            account_id: "account1".to_string(),
        },
        storage: StorageConfig {
            backend: StorageBackend::LocalDisk,
            data_dir: dir.path().to_path_buf(),
        },
        ..Config::default()
    };
    let app_state = AppState {
        store: store.clone(),
        rate_limiter,
        config,
    };
    let router = build_router(app_state);
    let server = TestServer::new(router).unwrap();
    TestFixture {
        server,
        store,
        _dir: dir,
    }
}

/// Register a device, returning (device_id, device_token).
async fn register_device(server: &TestServer, name: &str) -> (String, String) {
    let resp = server
        .post("/v1/devices")
        .json(&json!({
            "registration_code": "test-secret",
            "device_name": name
        }))
        .await;
    resp.assert_status_success();
    let body: Value = resp.json();
    (
        body["device_id"].as_str().unwrap().to_string(),
        body["device_token"].as_str().unwrap().to_string(),
    )
}

fn make_blob_body(blob_id: &str, device_id: &str) -> Value {
    json!({
        "version": 1,
        "blob_id": blob_id,
        "device_id": device_id,
        "created_at": "2026-05-07T12:34:56.000Z",
        "schema": "mem_items.v1",
        "metadata": {
            "kinds": ["screen"],
            "provenance": "screen",
            "captured_at_minute": 28872034u64
        },
        "ciphertext": {
            "nonce": "VGhpcyBpcyAyNCBieXRlcyBleGFjdGx5",
            "data": "0Xn_fake_ciphertext"
        }
    })
}

// ── I1: Happy path ────────────────────────────────────────────────────────────

#[tokio::test]
async fn i1_happy_path_register_upload_list_fetch() {
    let fix = make_fixture().await;

    // Register device.
    let (device_id, token) = register_device(&fix.server, "Test Mac").await;

    // Upload a blob.
    let blob_id = "01HVXXX000000000000000001";
    let resp = fix
        .server
        .post("/v1/blobs")
        .authorization_bearer(&token)
        .bytes(
            serde_json::to_vec(&make_blob_body(blob_id, &device_id))
                .unwrap()
                .into(),
        )
        .await;
    resp.assert_status_success();
    let body: Value = resp.json();
    assert_eq!(body["blob_id"].as_str().unwrap(), blob_id);

    // List with cursor.
    let resp = fix
        .server
        .get("/v1/blobs")
        .authorization_bearer(&token)
        .await;
    resp.assert_status_success();
    let body: Value = resp.json();
    assert_eq!(body["blobs"].as_array().unwrap().len(), 1);

    // Fetch full blob.
    let resp = fix
        .server
        .get(&format!("/v1/blobs/{blob_id}"))
        .authorization_bearer(&token)
        .await;
    resp.assert_status_success();
    let fetched: Value = resp.json();
    assert_eq!(fetched["blob_id"].as_str().unwrap(), blob_id);
    assert_eq!(
        fetched["ciphertext"]["data"].as_str().unwrap(),
        "0Xn_fake_ciphertext"
    );
}

// ── I2: 401 on missing/invalid token ─────────────────────────────────────────

#[tokio::test]
async fn i2_unauthorized_on_missing_token() {
    let fix = make_fixture().await;
    let resp = fix.server.get("/v1/blobs").await;
    resp.assert_status_failure();
    assert_eq!(resp.status_code().as_u16(), 401);
}

#[tokio::test]
async fn i2_unauthorized_on_invalid_token() {
    let fix = make_fixture().await;
    let resp = fix
        .server
        .get("/v1/blobs")
        .authorization_bearer("badtoken123")
        .await;
    resp.assert_status_failure();
    assert_eq!(resp.status_code().as_u16(), 401);
}

#[tokio::test]
async fn i2_unauthorized_malformed_bearer() {
    let fix = make_fixture().await;
    let resp = fix
        .server
        .get("/v1/blobs")
        .authorization("Token wrongscheme")
        .await;
    resp.assert_status_failure();
    assert_eq!(resp.status_code().as_u16(), 401);
}

// ── I3: 401 on revoked token ─────────────────────────────────────────────────

#[tokio::test]
async fn i3_revoked_token_rejected() {
    let fix = make_fixture().await;
    let (device_id, token) = register_device(&fix.server, "Revoked Mac").await;

    // Delete the device (simulates revocation).
    fix.store.delete_device(&device_id).await.unwrap();

    let resp = fix
        .server
        .get("/v1/blobs")
        .authorization_bearer(&token)
        .await;
    assert_eq!(resp.status_code().as_u16(), 401);
}

// ── I4: 413 on > 1MB blob ─────────────────────────────────────────────────────

#[tokio::test]
async fn i4_payload_too_large() {
    let fix = make_fixture().await;
    let (device_id, token) = register_device(&fix.server, "Big Mac").await;

    let mut big = make_blob_body("bigblob001", &device_id);
    // Overwrite the data field with >1MB of junk.
    big["ciphertext"]["data"] = json!("x".repeat(1024 * 1024 + 1));
    let body_bytes = serde_json::to_vec(&big).unwrap();

    let resp = fix
        .server
        .post("/v1/blobs")
        .authorization_bearer(&token)
        .bytes(body_bytes.into())
        .await;
    assert_eq!(resp.status_code().as_u16(), 413);
}

// ── I5: 400 on malformed envelope ────────────────────────────────────────────

#[tokio::test]
async fn i5_bad_request_missing_fields() {
    let fix = make_fixture().await;
    let (_, token) = register_device(&fix.server, "Bad Mac").await;

    let resp = fix
        .server
        .post("/v1/blobs")
        .authorization_bearer(&token)
        .json(&json!({ "hello": "world" }))
        .await;
    assert_eq!(resp.status_code().as_u16(), 400);
}

#[tokio::test]
async fn i5_bad_request_unknown_schema() {
    let fix = make_fixture().await;
    let (device_id, token) = register_device(&fix.server, "Schema Mac").await;

    let mut body = make_blob_body("schemablob", &device_id);
    body["schema"] = json!("unknown_schema.v99");
    let resp = fix
        .server
        .post("/v1/blobs")
        .authorization_bearer(&token)
        .bytes(serde_json::to_vec(&body).unwrap().into())
        .await;
    assert_eq!(resp.status_code().as_u16(), 400);
}

#[tokio::test]
async fn i5_bad_request_unknown_version() {
    let fix = make_fixture().await;
    let (device_id, token) = register_device(&fix.server, "Ver Mac").await;

    let mut body = make_blob_body("verblob", &device_id);
    body["version"] = json!(99u8);
    let resp = fix
        .server
        .post("/v1/blobs")
        .authorization_bearer(&token)
        .bytes(serde_json::to_vec(&body).unwrap().into())
        .await;
    assert_eq!(resp.status_code().as_u16(), 400);
}

// ── I6: 409 on conflicting blob_id ────────────────────────────────────────────

#[tokio::test]
async fn i6_conflict_different_content() {
    let fix = make_fixture().await;
    let (device_id, token) = register_device(&fix.server, "Conflict Mac").await;

    let blob_id = "conflictblob001";
    let body1 = make_blob_body(blob_id, &device_id);
    let mut body2 = make_blob_body(blob_id, &device_id);
    body2["ciphertext"]["data"] = json!("different_content");

    let r1 = fix
        .server
        .post("/v1/blobs")
        .authorization_bearer(&token)
        .bytes(serde_json::to_vec(&body1).unwrap().into())
        .await;
    r1.assert_status_success();

    let r2 = fix
        .server
        .post("/v1/blobs")
        .authorization_bearer(&token)
        .bytes(serde_json::to_vec(&body2).unwrap().into())
        .await;
    assert_eq!(r2.status_code().as_u16(), 409);
}

// ── I7: cursor pagination ─────────────────────────────────────────────────────

#[tokio::test]
async fn i7_cursor_pagination_250_blobs() {
    let fix = make_fixture().await;
    let (device_id, token) = register_device(&fix.server, "Pager Mac").await;

    // Upload 250 blobs.
    for i in 0..250u32 {
        let blob_id = format!("pagerblob{i:05}");
        let body = make_blob_body(&blob_id, &device_id);
        let r = fix
            .server
            .post("/v1/blobs")
            .authorization_bearer(&token)
            .bytes(serde_json::to_vec(&body).unwrap().into())
            .await;
        r.assert_status_success();
    }

    // Page through all 250 with limit=100.
    let mut total = 0usize;
    let mut cursor: Option<String> = None;
    let mut pages = 0;

    loop {
        let mut req = fix
            .server
            .get("/v1/blobs")
            .authorization_bearer(&token)
            .add_query_params([("limit", "100")]);
        if let Some(ref c) = cursor {
            req = req.add_query_params([("cursor", c.as_str())]);
        }
        let resp = req.await;
        resp.assert_status_success();
        let body: Value = resp.json();
        let page_blobs = body["blobs"].as_array().unwrap();
        total += page_blobs.len();
        pages += 1;
        cursor = body["next_cursor"].as_str().map(|s| s.to_string());
        if cursor.is_none() || page_blobs.is_empty() {
            break;
        }
    }

    assert_eq!(total, 250, "expected 250 total blobs, got {total}");
    assert_eq!(pages, 3, "expected 3 pages, got {pages}");
}

// ── I8: time-range query ──────────────────────────────────────────────────────

#[tokio::test]
async fn i8_time_range_query() {
    let fix = make_fixture().await;
    let (device_id, token) = register_device(&fix.server, "Time Mac").await;

    // Upload a few blobs.
    for i in 0..5u32 {
        let body = make_blob_body(&format!("trblob{i:03}"), &device_id);
        let r = fix
            .server
            .post("/v1/blobs")
            .authorization_bearer(&token)
            .bytes(serde_json::to_vec(&body).unwrap().into())
            .await;
        r.assert_status_success();
    }

    let since = (Utc::now() - chrono::Duration::hours(1)).to_rfc3339();
    let until = (Utc::now() + chrono::Duration::hours(1)).to_rfc3339();

    let resp = fix
        .server
        .get("/v1/blobs")
        .authorization_bearer(&token)
        .add_query_params([("since", since.as_str()), ("until", until.as_str())])
        .await;
    resp.assert_status_success();
    let body: Value = resp.json();
    assert_eq!(body["blobs"].as_array().unwrap().len(), 5);
}

// ── I9: tombstone visibility in list + 410 on GET ────────────────────────────

#[tokio::test]
async fn i9_tombstone_visibility() {
    let fix = make_fixture().await;
    let (device_id, token) = register_device(&fix.server, "Tombstone Mac").await;

    let blob_id = "tombblob001";
    let body = make_blob_body(blob_id, &device_id);
    fix.server
        .post("/v1/blobs")
        .authorization_bearer(&token)
        .bytes(serde_json::to_vec(&body).unwrap().into())
        .await
        .assert_status_success();

    // Tombstone it.
    fix.server
        .post(&format!("/v1/blobs/{blob_id}/tombstone"))
        .authorization_bearer(&token)
        .await
        .assert_status_success();

    // List should contain the tombstone entry.
    let resp = fix
        .server
        .get("/v1/blobs")
        .authorization_bearer(&token)
        .await;
    resp.assert_status_success();
    let body: Value = resp.json();
    let blobs = body["blobs"].as_array().unwrap();
    assert_eq!(blobs.len(), 1);
    assert!(blobs[0]["tombstoned_at"].is_string());
    assert!(blobs[0]["metadata"].is_null());

    // GET should return 410 Gone.
    let resp = fix
        .server
        .get(&format!("/v1/blobs/{blob_id}"))
        .authorization_bearer(&token)
        .await;
    assert_eq!(resp.status_code().as_u16(), 410);
}

// ── I10: device delete tombstones all blobs ───────────────────────────────────

#[tokio::test]
async fn i10_device_delete_tombstones_blobs() {
    let fix = make_fixture().await;
    let (device_id, token) = register_device(&fix.server, "Delete Mac").await;

    for i in 0..3u32 {
        let body = make_blob_body(&format!("delblob{i:03}"), &device_id);
        fix.server
            .post("/v1/blobs")
            .authorization_bearer(&token)
            .bytes(serde_json::to_vec(&body).unwrap().into())
            .await
            .assert_status_success();
    }

    // Delete device.
    let resp = fix
        .server
        .delete(&format!("/v1/devices/{device_id}"))
        .authorization_bearer(&token)
        .await;
    resp.assert_status_success();
    let body: Value = resp.json();
    assert_eq!(body["tombstoned_blobs"].as_u64().unwrap(), 3);
}

// ── I11: device rename ────────────────────────────────────────────────────────

#[tokio::test]
async fn i11_device_rename() {
    let fix = make_fixture().await;
    let (device_id, token) = register_device(&fix.server, "Original Mac").await;

    let resp = fix
        .server
        .put(&format!("/v1/devices/{device_id}"))
        .authorization_bearer(&token)
        .json(&json!({ "device_name": "Renamed Mac" }))
        .await;
    resp.assert_status_success();
    let body: Value = resp.json();
    assert_eq!(body["device_name"].as_str().unwrap(), "Renamed Mac");
}

// ── I12: health endpoint ─────────────────────────────────────────────────────

#[tokio::test]
async fn i12_health_no_auth_required() {
    let fix = make_fixture().await;
    let resp = fix.server.get("/v1/health").await;
    resp.assert_status_success();
    let body: Value = resp.json();
    assert!(body["ok"].as_bool().unwrap());
    assert!(body["version"].is_string());
    assert!(body["uptime_seconds"].is_number());
}

// ── Registration validation ───────────────────────────────────────────────────

#[tokio::test]
async fn i13_invalid_registration_code() {
    let fix = make_fixture().await;
    let resp = fix
        .server
        .post("/v1/devices")
        .json(&json!({
            "registration_code": "wrong-code",
            "device_name": "Sneaky Mac"
        }))
        .await;
    assert_eq!(resp.status_code().as_u16(), 400);
}

// ── Idempotent upload ─────────────────────────────────────────────────────────

#[tokio::test]
async fn i14_idempotent_upload_same_content() {
    let fix = make_fixture().await;
    let (device_id, token) = register_device(&fix.server, "Idem Mac").await;

    let blob_id = "idemblob001";
    let body = make_blob_body(blob_id, &device_id);

    let r1 = fix
        .server
        .post("/v1/blobs")
        .authorization_bearer(&token)
        .bytes(serde_json::to_vec(&body).unwrap().into())
        .await;
    r1.assert_status_success();

    let r2 = fix
        .server
        .post("/v1/blobs")
        .authorization_bearer(&token)
        .bytes(serde_json::to_vec(&body).unwrap().into())
        .await;
    // Idempotent — should succeed too (201).
    r2.assert_status_success();
}

//! Handle `shogun-ai://credentials/import?...` deep links (same data as `app_integration_import_credentials`).
//! Tokens in URLs are visible to shells and logs; prefer Tauri `invoke` when possible.

use crate::commands;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Runtime};
use url::Url;

fn query_first(url: &Url, keys: &[&str]) -> Option<String> {
    for (k, v) in url.query_pairs() {
        let ks = k.as_ref();
        if keys.iter().any(|&x| x == ks) {
            let s = v.into_owned();
            if !s.trim().is_empty() {
                return Some(s);
            }
        }
    }
    None
}

fn value_from_url(url: &Url) -> Option<Value> {
    let provider = query_first(url, &["provider"])?;
    let access_token = query_first(url, &["accessToken", "access_token"])?;
    let mut payload = json!({
      "provider": provider,
      "accessToken": access_token,
    });
    if let Some(r) = query_first(url, &["refreshToken", "refresh_token"]) {
        payload["refreshToken"] = json!(r);
    }
    if let Some(exp) = query_first(url, &["expiresAt", "expires_at"]) {
        if let Ok(n) = exp.parse::<u64>() {
            payload["expiresAt"] = json!(n);
        } else if let Ok(n) = exp.parse::<i64>() {
            payload["expiresAt"] = json!(n);
        }
    }
    if let Some(sc) = query_first(url, &["scopes"]) {
        let parts: Vec<String> = sc
            .split(|c| c == ',' || c == ' ')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if !parts.is_empty() {
            payload["scopes"] = json!(parts);
        }
    }
    if let Some(cid) = query_first(url, &["oauthClientId", "oauth_client_id"]) {
        payload["oauthClientId"] = json!(cid);
    }
    if let Some(cs) = query_first(url, &["oauthClientSecret", "oauth_client_secret"]) {
        payload["oauthClientSecret"] = json!(cs);
    }
    Some(payload)
}

fn is_credentials_import_url(url: &Url) -> bool {
    if url.scheme() != "shogun-ai" {
        return false;
    }
    let host = url.host_str().unwrap_or("");
    let path = url.path().trim_matches('/');
    host == "credentials" && path == "import"
}

pub fn handle_urls<R: Runtime>(app: &AppHandle<R>, urls: &[Url]) {
    for url in urls {
        if !is_credentials_import_url(url) {
            continue;
        }
        let Some(payload) = value_from_url(url) else {
            log::warn!("deep link credentials/import missing provider or accessToken");
            let _ = app.emit(
        "credentials-imported",
        json!({ "saved": false, "error": "missing_provider_or_access_token", "via": "deep-link" }),
      );
            continue;
        };
        match commands::persist_integration_credentials_inner(&payload) {
            Ok(slug) => {
                log::info!("integration credentials saved via deep link for {}", slug);
                let _ = app.emit(
                    "credentials-imported",
                    json!({ "saved": true, "provider": slug, "via": "deep-link" }),
                );
            }
            Err(e) => {
                log::warn!("deep link credentials import failed: {}", e);
                let _ = app.emit(
                    "credentials-imported",
                    json!({ "saved": false, "error": e, "via": "deep-link" }),
                );
            }
        }
    }
}

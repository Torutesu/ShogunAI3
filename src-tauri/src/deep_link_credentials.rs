//! Handle `shogun-ai://...` deep links.
//! `credentials/import` mirrors `app_integration_import_credentials`.
//! `open?...` routes into the desktop context surfaces.
//! Tokens in URLs are visible to shells and logs; prefer Tauri `invoke` when possible.

use crate::commands;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};
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

fn bool_from_query(url: &Url, keys: &[&str]) -> Option<bool> {
    let value = query_first(url, keys)?;
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn is_navigation_url(url: &Url) -> bool {
    if url.scheme() != "shogun-ai" {
        return false;
    }
    url.host_str().unwrap_or("") == "open"
}

fn navigation_payload_from_url(url: &Url) -> Option<Value> {
    let raw_path = url.path().trim_matches('/');
    let screen = if raw_path.is_empty() {
        None
    } else {
        Some(raw_path.to_string())
    };
    let settings_pane = query_first(url, &["settingsPane", "settings_pane", "pane"]);
    let entity_id = query_first(url, &["entityId", "entity_id"]);
    let meeting_id = query_first(url, &["meetingId", "meeting_id"]);
    let workspace_id = query_first(url, &["workspaceId", "workspace_id"]);
    let memory_id = query_first(url, &["memoryId", "memory_id"]);
    let query = query_first(url, &["query", "q"]);
    let ai_field_id = query_first(url, &["aiFieldId", "ai_field_id"]);
    let action_id = query_first(url, &["actionId", "action_id"]);
    let queue_id = query_first(url, &["queueId", "queue_id"]);
    let source_action_id = query_first(url, &["sourceActionId", "source_action_id"]);
    let view = query_first(url, &["view"]);
    let open_audit = bool_from_query(url, &["openAudit", "open_audit"]);
    let text = query_first(url, &["text", "prompt", "message"]);
    let web_search = bool_from_query(url, &["webSearch", "web_search"]);
    let assemble_memory = bool_from_query(url, &["assembleMemory", "assemble_memory"]);
    let auto_send = bool_from_query(url, &["autoSend", "auto_send"]);
    let new_chat = bool_from_query(url, &["newChat", "new_chat"]);
    let memory_assembly_query =
        query_first(url, &["memoryAssemblyQuery", "memory_assembly_query", "memoryQuery"]);
    let memory_assembly_limit = query_first(
        url,
        &["memoryAssemblyLimit", "memory_assembly_limit", "memoryLimit"],
    )
    .and_then(|value| value.parse::<u64>().ok());
    let memory_assembly_semantic =
        bool_from_query(url, &["memoryAssemblySemantic", "memory_assembly_semantic"]);

    if screen.is_none()
        && settings_pane.is_none()
        && entity_id.is_none()
        && meeting_id.is_none()
        && workspace_id.is_none()
        && memory_id.is_none()
        && query.is_none()
        && ai_field_id.is_none()
        && action_id.is_none()
        && queue_id.is_none()
        && source_action_id.is_none()
        && text.is_none()
    {
        return None;
    }

    let mut payload = json!({});
    if let Some(value) = screen {
        payload["screen"] = json!(value);
    }
    if let Some(value) = settings_pane {
        payload["settingsPane"] = json!(value);
    }
    if let Some(value) = entity_id {
        payload["entityId"] = json!(value);
    }
    if let Some(value) = meeting_id {
        payload["meetingId"] = json!(value);
    }
    if let Some(value) = workspace_id {
        payload["workspaceId"] = json!(value);
    }
    if let Some(value) = memory_id {
        payload["memoryId"] = json!(value);
    }
    if let Some(value) = query {
        payload["query"] = json!(value);
    }
    if let Some(value) = ai_field_id {
        payload["aiFieldId"] = json!(value);
    }
    if let Some(value) = action_id {
        payload["actionId"] = json!(value);
    }
    if let Some(value) = queue_id {
        payload["queueId"] = json!(value);
    }
    if let Some(value) = source_action_id {
        payload["sourceActionId"] = json!(value);
    }
    if let Some(value) = view {
        payload["view"] = json!(value);
    }
    if let Some(value) = open_audit {
        payload["openAudit"] = json!(value);
    }
    if let Some(value) = text {
        payload["text"] = json!(value);
    }
    if let Some(value) = web_search {
        payload["webSearch"] = json!(value);
    }
    if let Some(value) = assemble_memory {
        payload["assembleMemory"] = json!(value);
    }
    if let Some(value) = auto_send {
        payload["autoSend"] = json!(value);
    }
    if let Some(value) = new_chat {
        payload["newChat"] = json!(value);
    }
    if let Some(value) = memory_assembly_query {
        payload["memoryAssemblyQuery"] = json!(value);
    }
    if let Some(value) = memory_assembly_limit {
        payload["memoryAssemblyLimit"] = json!(value);
    }
    if let Some(value) = memory_assembly_semantic {
        payload["memoryAssemblySemantic"] = json!(value);
    }
    Some(payload)
}

pub fn handle_urls<R: Runtime>(app: &AppHandle<R>, urls: &[Url]) {
    for url in urls {
        if is_navigation_url(url) {
            let Some(payload) = navigation_payload_from_url(url) else {
                log::warn!("deep link open missing navigation target");
                let _ = app.emit(
                    "shogun-app-navigate",
                    json!({ "error": "missing_navigation_target", "via": "deep-link" }),
                );
                continue;
            };
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
            let _ = app.emit("shogun-app-navigate", payload);
            continue;
        }
        if !is_credentials_import_url(url) {
            continue;
        }
        let Some(payload) = value_from_url(url) else {
            log::warn!("deep link credentials/import missing provider or accessToken");
            let _ = app.emit(
        "credentials-imported",
        json!({ "saved": false, "error": "missing_provider_or_access_token", "via": "deep-link" }),
      );
            let _ = app.emit(
                "shogun-app-navigate",
                json!({ "settingsPane": "integrations" }),
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
                let _ = app.emit(
                    "shogun-app-navigate",
                    json!({ "settingsPane": "integrations" }),
                );
            }
            Err(e) => {
                log::warn!("deep link credentials import failed: {}", e);
                let _ = app.emit(
                    "credentials-imported",
                    json!({ "saved": false, "error": e, "via": "deep-link" }),
                );
                let _ = app.emit(
                    "shogun-app-navigate",
                    json!({ "settingsPane": "integrations" }),
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{is_navigation_url, navigation_payload_from_url, value_from_url};
    use serde_json::json;
    use url::Url;

    #[test]
    fn parses_credentials_import_payload() {
        let url = Url::parse("shogun-ai://credentials/import?provider=gmail&accessToken=abc123&refreshToken=ref&expiresAt=123").expect("url");
        let payload = value_from_url(&url).expect("payload");
        assert_eq!(
            payload,
            json!({
              "provider": "gmail",
              "accessToken": "abc123",
              "refreshToken": "ref",
              "expiresAt": 123u64,
            })
        );
    }

    #[test]
    fn detects_navigation_urls() {
        let url =
            Url::parse("shogun-ai://open/entity_context?entityId=company%3Aaurora").expect("url");
        assert!(is_navigation_url(&url));
    }

    #[test]
    fn parses_navigation_payload_for_context_surface() {
        let url = Url::parse(
            "shogun-ai://open/entity_context?entityId=company%3Aaurora&actionId=act-7&openAudit=true",
        )
        .expect("url");
        let payload = navigation_payload_from_url(&url).expect("payload");
        assert_eq!(
            payload,
            json!({
              "screen": "entity_context",
              "entityId": "company:aurora",
              "actionId": "act-7",
              "openAudit": true,
            })
        );
    }

    #[test]
    fn parses_navigation_payload_for_memory_search() {
        let url =
            Url::parse("shogun-ai://open/memory?query=security%20review&view=search").expect("url");
        let payload = navigation_payload_from_url(&url).expect("payload");
        assert_eq!(
            payload,
            json!({
              "screen": "memory",
              "query": "security review",
              "view": "search",
            })
        );
    }

    #[test]
    fn parses_navigation_payload_for_settings_pane() {
        let url = Url::parse("shogun-ai://open/settings?settingsPane=integrations").expect("url");
        let payload = navigation_payload_from_url(&url).expect("payload");
        assert_eq!(
            payload,
            json!({
              "screen": "settings",
              "settingsPane": "integrations",
            })
        );
    }

    #[test]
    fn parses_navigation_payload_for_general_settings_screen() {
        let url = Url::parse("shogun-ai://open/settings").expect("url");
        let payload = navigation_payload_from_url(&url).expect("payload");
        assert_eq!(
            payload,
            json!({
              "screen": "settings",
            })
        );
    }

    #[test]
    fn parses_navigation_payload_for_seeded_chat() {
        let url = Url::parse(
            "shogun-ai://open/chat?text=Review%20Aurora%20follow-up&newChat=true&assembleMemory=true&memoryAssemblyQuery=company%3Aaurora&memoryAssemblyLimit=12&autoSend=false",
        )
        .expect("url");
        let payload = navigation_payload_from_url(&url).expect("payload");
        assert_eq!(
            payload,
            json!({
              "screen": "chat",
              "text": "Review Aurora follow-up",
              "newChat": true,
              "assembleMemory": true,
              "memoryAssemblyQuery": "company:aurora",
              "memoryAssemblyLimit": 12u64,
              "autoSend": false,
            })
        );
    }

    #[test]
    fn parses_navigation_payload_for_actions_queue_focus() {
        let url = Url::parse(
            "shogun-ai://open/actions?queueId=sch_123&sourceActionId=act_99&entityId=workspace%3Aapollo&aiFieldId=af_7",
        )
        .expect("url");
        let payload = navigation_payload_from_url(&url).expect("payload");
        assert_eq!(
            payload,
            json!({
              "screen": "actions",
              "queueId": "sch_123",
              "sourceActionId": "act_99",
              "entityId": "workspace:apollo",
              "aiFieldId": "af_7",
            })
        );
    }
}

use crate::{
    apple_local, claude, figma, github, gmail, google_calendar, google_drive, integration_secrets,
    integrations, linear, notion, outlook, settings_store, slack, zoom,
};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub fn app_integration_connect(payload: Value) -> Result<Value, String> {
    let raw = payload
        .get("provider")
        .and_then(|p| p.as_str())
        .unwrap_or("");
    let slug = integrations::normalize_provider(raw);
    if integrations::supports_google_oauth(&slug) || slug == "gmail" || slug == "google_calendar" {
        let configured = integration_secrets::get_credentials(&slug)?.is_some();
        if configured {
            settings_store::upsert_integration_provider(
                &slug,
                &json!({ "connected": true, "mode": "oauth_in_app" }),
            )?;
            return Ok(json!({
              "connected": true,
              "provider": slug,
              "stub": false,
              "echo": payload,
            }));
        }
        return Ok(json!({
          "connected": false,
          "needsCredentials": true,
          "needsOAuth": true,
          "provider": slug,
          "message": format!(
            "{} requires Google OAuth. Click Connect to start the in-app consent flow, or import tokens via app_integration_import_credentials.",
            slug
          ),
          "stub": false,
          "echo": payload,
        }));
    }
    if integrations::supports_token_import(&slug) {
        let configured = integration_secrets::get_credentials(&slug)?.is_some();
        if configured {
            settings_store::upsert_integration_provider(
                &slug,
                &json!({ "connected": true, "mode": "token_import" }),
            )?;
            return Ok(json!({
              "connected": true,
              "provider": slug,
              "stub": false,
              "echo": payload,
            }));
        }
        return Ok(json!({
          "connected": false,
          "needsCredentials": true,
          "needsPasteToken": true,
          "provider": slug,
          "message": format!(
            "{} requires an API token. Paste it in the token dialog or import via app_integration_import_credentials.",
            slug
          ),
          "stub": false,
          "echo": payload,
        }));
    }
    if integrations::allows_local_connect(&slug) {
        settings_store::upsert_integration_provider(
            &slug,
            &json!({ "connected": true, "mode": "local_tool" }),
        )?;
        return Ok(json!({
          "connected": true,
          "provider": slug,
          "stub": false,
          "echo": payload,
        }));
    }
    if integrations::supports_apple_local(&slug) {
        #[cfg(target_os = "macos")]
        {
            if slug == "apple_calendar" {
                apple_local::probe_calendar()?;
            } else if slug == "apple_reminders" {
                apple_local::probe_reminders()?;
            }
            settings_store::upsert_integration_provider(
                &slug,
                &json!({ "connected": true, "mode": "local_macos" }),
            )?;
            return Ok(json!({
              "connected": true,
              "provider": slug,
              "stub": false,
              "echo": payload,
            }));
        }
        #[cfg(not(target_os = "macos"))]
        {
            return Err(format!(
                "{} is only available on macOS.",
                slug.replace('_', " ")
            ));
        }
    }
    Ok(json!({
      "notImplemented": true,
      "message": format!(
        "Integration \"{}\" is not wired yet. Supported: Gmail, Google Calendar, Google Drive, Slack, Notion, GitHub, Linear, Zoom, Outlook, Figma, Claude, Apple Calendar, Apple Reminders, Arc, Raycast, Obsidian.",
        slug
      ),
      "stub": false,
      "echo": payload,
    }))
}

pub(crate) fn persist_integration_credentials_inner(payload: &Value) -> Result<String, String> {
    let raw = payload
        .get("provider")
        .and_then(|p| p.as_str())
        .ok_or_else(|| "provider is required".to_string())?;
    let slug = integrations::normalize_provider(raw);
    let token = payload
        .get("accessToken")
        .and_then(|t| t.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "accessToken is required".to_string())?;

    let mut doc = json!({ "accessToken": token });
    if let Some(r) = payload.get("refreshToken").and_then(|x| x.as_str()) {
        if !r.trim().is_empty() {
            doc["refreshToken"] = json!(r);
        }
    }
    if let Some(exp) = payload.get("expiresAt") {
        doc["expiresAt"] = exp.clone();
    }
    if let Some(sc) = payload.get("scopes") {
        doc["scopes"] = sc.clone();
    }
    if let Some(cid) = payload
        .get("oauthClientId")
        .or_else(|| payload.get("oauth_client_id"))
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        doc["oauthClientId"] = json!(cid);
    }
    if let Some(cs) = payload
        .get("oauthClientSecret")
        .or_else(|| payload.get("oauth_client_secret"))
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        doc["oauthClientSecret"] = json!(cs);
    }

    integration_secrets::set_credentials(&slug, &doc)?;
    if integrations::supports_google_oauth(&slug) {
        settings_store::upsert_integration_provider(
            &slug,
            &json!({ "connected": true, "mode": "oauth_in_app" }),
        )?;
    } else if integrations::supports_token_import(&slug) {
        settings_store::upsert_integration_provider(
            &slug,
            &json!({ "connected": true, "mode": "token_import" }),
        )?;
    }
    Ok(slug)
}

#[tauri::command]
pub fn app_integration_import_credentials(app: AppHandle, payload: Value) -> Result<Value, String> {
    let slug = persist_integration_credentials_inner(&payload)?;
    let _ = app.emit(
        "credentials-imported",
        json!({ "saved": true, "provider": slug, "via": "invoke" }),
    );
    Ok(json!({
      "saved": true,
      "provider": slug,
      "stub": false,
    }))
}

#[tauri::command]
pub fn app_integration_credentials_status(payload: Value) -> Result<Value, String> {
    let raw = payload
        .get("provider")
        .and_then(|p| p.as_str())
        .unwrap_or("google_calendar");
    let slug = integrations::normalize_provider(raw);
    let configured = if integrations::supports_apple_local(&slug) {
        integrations::provider_connected_in_settings(&slug)?
    } else {
        integration_secrets::get_credentials(&slug)?.is_some()
    };
    let creds = integration_secrets::get_credentials(&slug)?;
    let token_refresh_ready = match creds.as_ref() {
        Some(doc) if slug == "google_calendar" => google_calendar::credentials_can_refresh(doc),
        Some(doc) if slug == "gmail" => crate::google_oauth::credentials_can_refresh(doc),
        _ => false,
    };
    Ok(json!({
      "configured": configured,
      "tokenRefreshReady": token_refresh_ready,
      "provider": slug,
      "stub": false,
      "echo": payload,
    }))
}

#[tauri::command]
pub async fn shogun_oauth_google_start(app: AppHandle, payload: Value) -> Result<Value, String> {
    let provider = payload
        .get("provider")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "oauth_invalid_provider".to_string())?;
    if provider != "gmail" && provider != "google_calendar" && provider != "google_drive" {
        return Err("oauth_invalid_provider".into());
    }

    let tokens = crate::oauth_flow::run(None).await.map_err(String::from)?;

    // Save tokens for Google providers — a single OAuth consent grants all scopes.
    for save_provider in ["gmail", "google_calendar", "google_drive"] {
        let mut save_payload = json!({
          "provider": save_provider,
          "accessToken": tokens.access_token,
          "oauthClientId": tokens.client_id,
          "oauthClientSecret": tokens.client_secret,
        });
        if let Some(rt) = &tokens.refresh_token {
            save_payload["refreshToken"] = json!(rt);
        }
        if let Some(exp) = tokens.expires_at {
            save_payload["expiresAt"] = json!(exp);
        }
        if !tokens.scopes.is_empty() {
            save_payload["scopes"] = json!(tokens.scopes);
        }
        persist_integration_credentials_inner(&save_payload)
            .map_err(|e| format!("oauth_save_failed: {}", e))?;
    }
    let _ = app.emit(
        "credentials-imported",
        json!({ "saved": true, "provider": provider, "via": "oauth_in_app" }),
    );

    Ok(json!({
      "ok": true,
      "provider": provider,
      "scopes": tokens.scopes,
      "expiresAt": tokens.expires_at,
      "refreshTokenPresent": tokens.refresh_token.is_some(),
    }))
}

#[tauri::command]
pub fn shogun_oauth_google_app_status(payload: Value) -> Result<Value, String> {
    let configured = crate::oauth_flow::load_oauth_credentials().is_ok();
    Ok(json!({
      "configured": configured,
      "stub": false,
      "echo": payload,
    }))
}

#[tauri::command]
pub fn shogun_oauth_google_app_set(payload: Value) -> Result<Value, String> {
    let client_id = payload
        .get("clientId")
        .or_else(|| payload.get("client_id"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "clientId is required".to_string())?;
    let client_secret = payload
        .get("clientSecret")
        .or_else(|| payload.get("client_secret"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "clientSecret is required".to_string())?;
    crate::integration_secrets::set_credentials(
        crate::oauth_flow::GOOGLE_OAUTH_APP_PROVIDER,
        &json!({ "clientId": client_id, "clientSecret": client_secret }),
    )?;
    Ok(json!({
      "saved": true,
      "configured": true,
      "stub": false,
      "echo": payload,
    }))
}

#[tauri::command]
pub async fn shogun_agent_run_now(payload: Value) -> Result<Value, String> {
    crate::agents::run_now_with_payload(&payload).await
}

#[tauri::command]
pub async fn shogun_google_calendar_sync(payload: Value) -> Result<Value, String> {
    let cal = payload
        .get("calendarId")
        .and_then(|c| c.as_str())
        .unwrap_or("primary");
    let days_opt = payload.get("days").and_then(|d| d.as_u64());
    let is_historical = days_opt.is_some();
    let default_max: u64 = if is_historical { 500 } else { 25 };
    let cap_max: u64 = if is_historical { 2500 } else { 50 };
    let max = payload
        .get("maxResults")
        .and_then(|m| m.as_u64())
        .unwrap_or(default_max)
        .clamp(1, cap_max) as usize;
    let past_days = days_opt.unwrap_or(0).min(366) as u32;
    google_calendar::sync_events_to_memory(cal, max, past_days).await
}

#[tauri::command]
pub async fn shogun_gmail_sync(payload: Value) -> Result<Value, String> {
    let days_opt = payload.get("days").and_then(|d| d.as_u64());
    let is_historical = days_opt.is_some();
    let default_max: u64 = if is_historical { 500 } else { 20 };
    let cap_max: u64 = if is_historical { 500 } else { 50 };
    let max = payload
        .get("maxResults")
        .and_then(|m| m.as_u64())
        .unwrap_or(default_max)
        .clamp(1, cap_max) as usize;
    let days = days_opt.map(|d| d.min(366) as u32);
    gmail::sync_inbox_to_memory(max, days).await
}

#[tauri::command]
pub async fn shogun_slack_sync(payload: Value) -> Result<Value, String> {
    let days = payload
        .get("days")
        .and_then(|d| d.as_u64())
        .map(|d| d.min(366) as u32);
    let max_per_channel = payload
        .get("maxPerChannel")
        .and_then(|m| m.as_u64())
        .unwrap_or(500)
        .clamp(1, 1000) as usize;
    slack::sync_workspace_to_memory(days, max_per_channel).await
}

#[tauri::command]
pub async fn shogun_notion_sync(payload: Value) -> Result<Value, String> {
    let days = payload
        .get("days")
        .and_then(|d| d.as_u64())
        .map(|d| d.min(366) as u32);
    let max_pages = payload
        .get("maxPages")
        .and_then(|m| m.as_u64())
        .unwrap_or(1000)
        .clamp(1, 5000) as usize;
    notion::sync_workspace_to_memory(days, max_pages).await
}

#[tauri::command]
pub async fn shogun_github_sync(payload: Value) -> Result<Value, String> {
    let days = payload
        .get("days")
        .and_then(|d| d.as_u64())
        .map(|d| d.min(366) as u32);
    let max_items = payload
        .get("maxItems")
        .and_then(|m| m.as_u64())
        .unwrap_or(500)
        .clamp(1, 2000) as usize;
    github::sync_activity_to_memory(days, max_items).await
}

#[tauri::command]
pub async fn shogun_linear_sync(payload: Value) -> Result<Value, String> {
    let days = payload
        .get("days")
        .and_then(|d| d.as_u64())
        .map(|d| d.min(366) as u32);
    let max_items = payload
        .get("maxItems")
        .and_then(|m| m.as_u64())
        .unwrap_or(500)
        .clamp(1, 2000) as usize;
    linear::sync_activity_to_memory(days, max_items).await
}

#[tauri::command]
pub async fn shogun_drive_sync(payload: Value) -> Result<Value, String> {
    let days = payload
        .get("days")
        .and_then(|d| d.as_u64())
        .map(|d| d.min(366) as u32);
    let max_files = payload
        .get("maxFiles")
        .and_then(|m| m.as_u64())
        .unwrap_or(500)
        .clamp(1, 3000) as usize;
    google_drive::sync_drive_to_memory(days, max_files).await
}

#[tauri::command]
pub async fn shogun_outlook_sync(payload: Value) -> Result<Value, String> {
    let days = payload
        .get("days")
        .and_then(|d| d.as_u64())
        .map(|d| d.min(366) as u32);
    let max_messages = payload
        .get("maxMessages")
        .and_then(|m| m.as_u64())
        .unwrap_or(100)
        .clamp(1, 500) as usize;
    outlook::sync_mail_to_memory(days, max_messages).await
}

#[tauri::command]
pub async fn shogun_figma_sync(payload: Value) -> Result<Value, String> {
    let max_files = payload
        .get("maxFiles")
        .and_then(|m| m.as_u64())
        .unwrap_or(50)
        .clamp(1, 200) as usize;
    figma::sync_files_to_memory(max_files).await
}

#[tauri::command]
pub async fn shogun_claude_sync(payload: Value) -> Result<Value, String> {
    let max_items = payload
        .get("maxItems")
        .and_then(|m| m.as_u64())
        .unwrap_or(20)
        .clamp(1, 100) as usize;
    claude::sync_context_to_memory(max_items).await
}

#[tauri::command]
pub fn shogun_apple_calendar_sync(payload: Value) -> Result<Value, String> {
    let max_events = payload
        .get("maxResults")
        .or_else(|| payload.get("maxEvents"))
        .and_then(|m| m.as_u64())
        .unwrap_or(50)
        .clamp(1, 500) as usize;
    apple_local::sync_calendar_to_memory(max_events)
}

#[tauri::command]
pub fn shogun_apple_reminders_sync(payload: Value) -> Result<Value, String> {
    let max_items = payload
        .get("maxItems")
        .or_else(|| payload.get("maxResults"))
        .and_then(|m| m.as_u64())
        .unwrap_or(80)
        .clamp(1, 300) as usize;
    apple_local::sync_reminders_to_memory(max_items)
}

#[tauri::command]
pub async fn shogun_zoom_sync(payload: Value) -> Result<Value, String> {
    let days = payload
        .get("days")
        .and_then(|d| d.as_u64())
        .map(|d| d.min(366) as u32);
    let max_meetings = payload
        .get("maxMeetings")
        .and_then(|m| m.as_u64())
        .unwrap_or(50)
        .clamp(1, 200) as usize;
    zoom::sync_recordings_to_memory(days, max_meetings).await
}

#[tauri::command]
pub fn app_integration_toggle(payload: Value) -> Result<Value, String> {
    let raw = payload
        .get("provider")
        .and_then(|p| p.as_str())
        .unwrap_or("");
    let slug = integrations::normalize_provider(raw);
    let connected = payload
        .get("connected")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    settings_store::upsert_integration_provider(
        &slug,
        &json!({ "connected": connected, "mode": "ui_toggle" }),
    )?;
    Ok(json!({
      "saved": true,
      "connected": connected,
      "provider": slug,
      "stub": false,
      "echo": payload,
    }))
}

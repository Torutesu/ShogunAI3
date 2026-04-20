//! Read-only Gmail inbox sync into local memory (Bearer token from `integration_secrets` key `gmail`).

use crate::{google_oauth, integration_secrets, memory_store};
use reqwest::StatusCode;
use serde_json::{json, Value};

const PROVIDER: &str = "gmail";

fn not_configured_msg() -> String {
  "Gmail is not configured. Import credentials via app_integration_import_credentials with provider \"gmail\"."
    .to_string()
}

async fn gmail_list_messages(token: &str, max_results: usize) -> Result<(StatusCode, String), String> {
  let url = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
  let client = reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(60))
    .build()
    .map_err(|e| e.to_string())?;
  let max_s = max_results.to_string();
  let resp = client
    .get(url)
    .query(&[("maxResults", max_s.as_str())])
    .header("Authorization", format!("Bearer {}", token.trim()))
    .send()
    .await
    .map_err(|e| format!("Gmail list request failed: {}", e))?;
  let status = resp.status();
  let text = resp.text().await.map_err(|e| e.to_string())?;
  Ok((status, text))
}

async fn gmail_get_message_metadata(
  token: &str,
  message_id: &str,
) -> Result<(StatusCode, String), String> {
  let path = urlencoding::encode(message_id);
  let url = format!(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}",
    path
  );
  let client = reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(60))
    .build()
    .map_err(|e| e.to_string())?;
  let resp = client
    .get(&url)
    .query(&[
      ("format", "metadata"),
      ("metadataHeaders", "Subject"),
      ("metadataHeaders", "From"),
    ])
    .header("Authorization", format!("Bearer {}", token.trim()))
    .send()
    .await
    .map_err(|e| format!("Gmail get message failed: {}", e))?;
  let status = resp.status();
  let text = resp.text().await.map_err(|e| e.to_string())?;
  Ok((status, text))
}

fn header_value(msg: &Value, name: &str) -> Option<String> {
  let headers = msg
    .pointer("/payload/headers")?
    .as_array()?;
  for h in headers {
    let n = h.get("name").and_then(|x| x.as_str())?;
    if n.eq_ignore_ascii_case(name) {
      return h.get("value").and_then(|v| v.as_str()).map(|s| s.to_string());
    }
  }
  None
}

fn ingest_gmail_message(message_id: &str, msg: &Value) -> Result<(), String> {
  let subject = header_value(msg, "Subject").unwrap_or_else(|| "(no subject)".to_string());
  let from = header_value(msg, "From").unwrap_or_default();
  let snippet = msg
    .get("snippet")
    .and_then(|s| s.as_str())
    .unwrap_or("");
  let body = format!("Subject: {}\nFrom: {}\n{}", subject, from, snippet);
  let ing = json!({
    "title": format!("Gmail: {}", subject.chars().take(200).collect::<String>()),
    "snippet": body.chars().take(4000).collect::<String>(),
    "source": "gmail",
    "kinds": ["mail"],
    "provenance": "connector",
    "entity_id": message_id,
  });
  memory_store::ingest(&ing).map(|_| ())
}

async fn refresh_and_persist_creds(creds: &Value) -> Result<Value, String> {
  let refreshed = google_oauth::refresh_access_token(creds).await?;
  integration_secrets::set_credentials(PROVIDER, &refreshed)?;
  Ok(refreshed)
}

pub async fn sync_inbox_to_memory(max_results: usize) -> Result<Value, String> {
  let mut creds = integration_secrets::get_credentials(PROVIDER)?
    .ok_or_else(not_configured_msg)?;

  google_oauth::maybe_refresh_credentials(PROVIDER, &mut creds).await?;

  let mut token = google_oauth::access_token_from_doc(&creds)?;
  let (status, text) = gmail_list_messages(&token, max_results).await?;

  let (status, text) = if status == StatusCode::UNAUTHORIZED && google_oauth::credentials_can_refresh(&creds) {
    log::warn!("Gmail API 401 on list; attempting token refresh");
    creds = refresh_and_persist_creds(&creds).await?;
    token = google_oauth::access_token_from_doc(&creds)?;
    gmail_list_messages(&token, max_results).await?
  } else {
    (status, text)
  };

  if !status.is_success() {
    let snippet: String = text.chars().take(600).collect();
    return Err(format!("Gmail API {}: {}", status, snippet));
  }

  let body: Value = serde_json::from_str(&text)
    .map_err(|e| format!("Invalid Gmail JSON: {} — {}", e, text.chars().take(200).collect::<String>()))?;

  let items = body
    .get("messages")
    .and_then(|m| m.as_array())
    .cloned()
    .unwrap_or_default();

  let mut ingested = 0u32;
  for item in items.iter().take(max_results) {
    let id = item.get("id").and_then(|x| x.as_str()).unwrap_or("");
    if id.is_empty() {
      continue;
    }
    let (st, txt) = gmail_get_message_metadata(&token, id).await?;
    let (st, txt) = if st == StatusCode::UNAUTHORIZED && google_oauth::credentials_can_refresh(&creds) {
      log::warn!("Gmail API 401 on get; attempting token refresh");
      creds = refresh_and_persist_creds(&creds).await?;
      token = google_oauth::access_token_from_doc(&creds)?;
      gmail_get_message_metadata(&token, id).await?
    } else {
      (st, txt)
    };
    if !st.is_success() {
      log::warn!("Skipping message {}: Gmail API {}", id, st);
      continue;
    }
    let msg: Value = serde_json::from_str(&txt).unwrap_or(json!({}));
    ingest_gmail_message(id, &msg)?;
    ingested += 1;
  }

  Ok(json!({
    "ingested": ingested,
    "stub": false,
  }))
}

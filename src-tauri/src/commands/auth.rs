use crate::{auth, biometric, secrets};
use serde_json::{json, Value};

#[tauri::command]
pub fn auth_clerk_config() -> Result<Value, String> {
  Ok(auth::clerk_config())
}


#[tauri::command]
pub fn auth_open_browser_sign_in() -> Result<Value, String> {
  let url = auth::sign_in_url()?;
  open::that(&url).map_err(|e| e.to_string())?;
  Ok(json!({ "opened": true }))
}


#[tauri::command]
pub fn auth_open_browser_sign_up() -> Result<Value, String> {
  let url = auth::sign_up_url()?;
  open::that(&url).map_err(|e| e.to_string())?;
  Ok(json!({ "opened": true }))
}


#[tauri::command]
pub fn auth_status() -> Result<Value, String> {
  let cfg = auth::clerk_config();
  let snap_raw = secrets::get_clerk_snapshot()?;
  let snapshot: Value = match snap_raw {
    Some(s) if !s.trim().is_empty() => serde_json::from_str(&s).unwrap_or(json!(null)),
    _ => json!(null),
  };
  Ok(json!({
    "clerk": cfg,
    "snapshot": snapshot,
  }))
}


#[tauri::command]
pub fn auth_session_save(payload: Value) -> Result<Value, String> {
  let body = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
  secrets::set_clerk_snapshot(&body)?;
  Ok(json!({ "saved": true }))
}


#[tauri::command]
pub fn auth_sign_out() -> Result<Value, String> {
  secrets::clear_clerk_snapshot()?;
  Ok(json!({ "signedOut": true }))
}


#[tauri::command]
pub async fn auth_biometric_status(payload: Value) -> Result<Value, String> {
  let echo = payload;
  let mut v = tokio::task::spawn_blocking(biometric::status_json)
    .await
    .map_err(|e| format!("biometric status task failed: {e}"))?;
  if let Some(m) = v.as_object_mut() {
    m.insert("echo".to_string(), echo);
    m.insert("stub".to_string(), json!(false));
  }
  Ok(v)
}


#[tauri::command]
pub fn auth_biometric_authenticate(payload: Value) -> Result<Value, String> {
  let reason = payload
    .get("reason")
    .and_then(|r| r.as_str())
    .unwrap_or("Unlock SHOGUN");
  match biometric::authenticate(reason) {
    Ok(()) => Ok(json!({
      "ok": true,
      "stub": false,
      "echo": payload,
    })),
    Err(msg) => Ok(json!({
      "ok": false,
      "message": msg,
      "stub": false,
      "echo": payload,
    })),
  }
}

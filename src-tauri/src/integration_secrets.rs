//! OAuth tokens and integration secrets (per provider) in the OS credential store.
//! Populated by an external agent via `app_integration_import_credentials` — no OAuth flow here.

use keyring::Entry;
use serde_json::Value;

const SERVICE: &str = "ai.shogun.desktop";

fn entry_label(provider: &str) -> String {
  format!("integration_credentials_{}", provider)
}

pub fn set_credentials(provider: &str, doc: &Value) -> Result<(), String> {
  let json = serde_json::to_string(doc).map_err(|e| e.to_string())?;
  let entry = Entry::new(SERVICE, &entry_label(provider)).map_err(|e| e.to_string())?;
  entry.set_password(&json).map_err(|e| e.to_string())
}

pub fn get_credentials(provider: &str) -> Result<Option<Value>, String> {
  let entry = Entry::new(SERVICE, &entry_label(provider)).map_err(|e| e.to_string())?;
  match entry.get_password() {
    Ok(s) => {
      let v: Value = serde_json::from_str(&s).map_err(|e| e.to_string())?;
      Ok(Some(v))
    }
    Err(keyring::Error::NoEntry) => Ok(None),
    Err(e) => Err(e.to_string()),
  }
}

pub fn clear_credentials(provider: &str) -> Result<(), String> {
  let entry = Entry::new(SERVICE, &entry_label(provider)).map_err(|e| e.to_string())?;
  match entry.delete_credential() {
    Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
    Err(e) => Err(e.to_string()),
  }
}

pub fn access_token(provider: &str) -> Result<Option<String>, String> {
  Ok(
    get_credentials(provider)?
      .and_then(|v| v.get("accessToken").and_then(|t| t.as_str()).map(|s| s.to_string())),
  )
}

/// Clears known integration credential entries (extend when adding providers).
pub fn clear_all_known() {
  for p in ["google_calendar"] {
    let _ = clear_credentials(p);
  }
}

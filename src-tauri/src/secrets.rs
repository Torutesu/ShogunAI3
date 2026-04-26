//! LLM API key in the OS credential store (macOS Keychain via `keyring`).

use keyring::Entry;
use std::sync::Mutex;

const SERVICE: &str = "ai.shogun.desktop";
const USER: &str = "llm_openai_compatible_api_key";
const CLERK_SNAPSHOT_USER: &str = "clerk_session_snapshot";

// Keychain access prompts the user on macOS every call. Cache the key in
// process memory after the first successful read so batch callers
// (summarizer, embeddings) don't trigger a flood of dialogs.
// Outer Option: whether we've attempted a load. Inner Option: whether a key exists.
static LLM_KEY_CACHE: Mutex<Option<Option<String>>> = Mutex::new(None);

pub fn set_llm_api_key(key: &str) -> Result<(), String> {
  let entry = Entry::new(SERVICE, USER).map_err(|e| e.to_string())?;
  entry.set_password(key).map_err(|e| e.to_string())?;
  if let Ok(mut cache) = LLM_KEY_CACHE.lock() {
    *cache = Some(Some(key.to_string()));
  }
  Ok(())
}

pub fn get_llm_api_key() -> Result<Option<String>, String> {
  if let Ok(cache) = LLM_KEY_CACHE.lock() {
    if let Some(cached) = cache.as_ref() {
      return Ok(cached.clone());
    }
  }
  // Dev convenience: ANTHROPIC_API_KEY env var (loaded from .env at startup)
  // bypasses the macOS Keychain prompt that fires on every fresh process
  // when the binary signature changes (i.e. every dev rebuild).
  if let Ok(env_key) = std::env::var("ANTHROPIC_API_KEY") {
    let trimmed = env_key.trim().to_string();
    if !trimmed.is_empty() {
      let result = Some(trimmed);
      if let Ok(mut cache) = LLM_KEY_CACHE.lock() {
        *cache = Some(result.clone());
      }
      return Ok(result);
    }
  }
  let entry = Entry::new(SERVICE, USER).map_err(|e| e.to_string())?;
  let result = match entry.get_password() {
    Ok(p) => Some(p),
    Err(keyring::Error::NoEntry) => None,
    Err(e) => return Err(e.to_string()),
  };
  if let Ok(mut cache) = LLM_KEY_CACHE.lock() {
    *cache = Some(result.clone());
  }
  Ok(result)
}

pub fn llm_api_key_configured() -> Result<bool, String> {
  Ok(get_llm_api_key()?.map(|s| !s.trim().is_empty()).unwrap_or(false))
}

pub fn clear_llm_api_key() -> Result<(), String> {
  let entry = Entry::new(SERVICE, USER).map_err(|e| e.to_string())?;
  let result = match entry.delete_credential() {
    Ok(()) => Ok(()),
    Err(keyring::Error::NoEntry) => Ok(()),
    Err(e) => Err(e.to_string()),
  };
  if let Ok(mut cache) = LLM_KEY_CACHE.lock() {
    *cache = Some(None);
  }
  result
}

/// Last known Clerk user (JSON) for Settings when the webview session is cleared.
pub fn set_clerk_snapshot(json: &str) -> Result<(), String> {
  let entry = Entry::new(SERVICE, CLERK_SNAPSHOT_USER).map_err(|e| e.to_string())?;
  entry.set_password(json).map_err(|e| e.to_string())
}

pub fn get_clerk_snapshot() -> Result<Option<String>, String> {
  let entry = Entry::new(SERVICE, CLERK_SNAPSHOT_USER).map_err(|e| e.to_string())?;
  match entry.get_password() {
    Ok(p) => Ok(Some(p)),
    Err(keyring::Error::NoEntry) => Ok(None),
    Err(e) => Err(e.to_string()),
  }
}

pub fn clear_clerk_snapshot() -> Result<(), String> {
  let entry = Entry::new(SERVICE, CLERK_SNAPSHOT_USER).map_err(|e| e.to_string())?;
  match entry.delete_credential() {
    Ok(()) => Ok(()),
    Err(keyring::Error::NoEntry) => Ok(()),
    Err(e) => Err(e.to_string()),
  }
}

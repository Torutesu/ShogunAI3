//! LLM + AMC pipeline API keys in the OS credential store (macOS Keychain via `keyring`).

use keyring::Entry;

const SERVICE: &str = "ai.shogun.desktop";
const USER: &str = "llm_openai_compatible_api_key";
const CLERK_SNAPSHOT_USER: &str = "clerk_session_snapshot";
const ANTHROPIC_USER: &str = "anthropic_api_key";

pub fn set_llm_api_key(key: &str) -> Result<(), String> {
  let entry = Entry::new(SERVICE, USER).map_err(|e| e.to_string())?;
  entry.set_password(key).map_err(|e| e.to_string())
}

pub fn get_llm_api_key() -> Result<Option<String>, String> {
  let entry = Entry::new(SERVICE, USER).map_err(|e| e.to_string())?;
  match entry.get_password() {
    Ok(p) => Ok(Some(p)),
    Err(keyring::Error::NoEntry) => Ok(None),
    Err(e) => Err(e.to_string()),
  }
}

pub fn llm_api_key_configured() -> Result<bool, String> {
  Ok(get_llm_api_key()?.map(|s| !s.trim().is_empty()).unwrap_or(false))
}

pub fn clear_llm_api_key() -> Result<(), String> {
  let entry = Entry::new(SERVICE, USER).map_err(|e| e.to_string())?;
  match entry.delete_credential() {
    Ok(()) => Ok(()),
    Err(keyring::Error::NoEntry) => Ok(()),
    Err(e) => Err(e.to_string()),
  }
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

/// Anthropic API key used by the AMC composer pipeline. Passed into the
/// Node subprocess as `ANTHROPIC_API_KEY` when present; when missing,
/// the pipeline forces its heuristic dry path.
pub fn set_anthropic_api_key(key: &str) -> Result<(), String> {
  let entry = Entry::new(SERVICE, ANTHROPIC_USER).map_err(|e| e.to_string())?;
  entry.set_password(key).map_err(|e| e.to_string())
}

pub fn get_anthropic_api_key() -> Result<Option<String>, String> {
  let entry = Entry::new(SERVICE, ANTHROPIC_USER).map_err(|e| e.to_string())?;
  match entry.get_password() {
    Ok(p) => Ok(Some(p)),
    Err(keyring::Error::NoEntry) => Ok(None),
    Err(e) => Err(e.to_string()),
  }
}

pub fn anthropic_api_key_configured() -> Result<bool, String> {
  Ok(
    get_anthropic_api_key()?
      .map(|s| !s.trim().is_empty())
      .unwrap_or(false),
  )
}

pub fn clear_anthropic_api_key() -> Result<(), String> {
  let entry = Entry::new(SERVICE, ANTHROPIC_USER).map_err(|e| e.to_string())?;
  match entry.delete_credential() {
    Ok(()) => Ok(()),
    Err(keyring::Error::NoEntry) => Ok(()),
    Err(e) => Err(e.to_string()),
  }
}

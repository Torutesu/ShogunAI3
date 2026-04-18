//! LLM API key in the OS credential store (macOS Keychain via `keyring`).

use keyring::Entry;

const SERVICE: &str = "ai.shogun.desktop";
const USER: &str = "llm_openai_compatible_api_key";

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

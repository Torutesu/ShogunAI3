//! LLM API key in the OS credential store (macOS Keychain via `keyring`).

use keyring::Entry;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

const SERVICE: &str = "ai.shogun.desktop";
const USER: &str = "llm_openai_compatible_api_key";
const CLERK_SNAPSHOT_USER: &str = "clerk_session_snapshot";
const DEEPGRAM_USER: &str = "deepgram_api_key";

// Keychain access prompts the user on macOS every call. Cache keys in
// process memory after the first successful read so batch callers
// (summarizer, embeddings) don't trigger a flood of dialogs.
// Outer Option: whether we've attempted a load. Inner Vec: normalized keys.
static LLM_KEY_CACHE: Mutex<Option<Vec<String>>> = Mutex::new(None);
static LLM_KEYCHAIN_LOAD_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

fn normalize_llm_key_input(raw: &str) -> String {
    let mut s = raw.trim();
    if s.starts_with('{') || s.starts_with('[') {
        return s.to_string();
    }
    if let Some(rest) = s.strip_prefix("export ") {
        s = rest.trim();
    }
    if let Some((name, value)) = s.split_once('=') {
        let name_l = name.trim().to_ascii_lowercase();
        if name_l.contains("api_key") || name_l.ends_with("key") {
            s = value.trim();
        }
    }
    let s = s.trim_matches(|c| c == '"' || c == '\'').trim();
    if crate::llm_providers::detect_provider(s) != crate::llm_providers::LlmProvider::Custom {
        return s.to_string();
    }
    extract_known_key_token(s).unwrap_or_else(|| s.to_string())
}

fn is_key_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.'
}

fn extract_known_key_token(input: &str) -> Option<String> {
    input
        .split(|c| !is_key_token_char(c))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .find(|token| {
            crate::llm_providers::detect_provider(token)
                != crate::llm_providers::LlmProvider::Custom
        })
        .map(ToString::to_string)
}

fn push_unique(keys: &mut Vec<String>, key: String) {
    if key.trim().is_empty() {
        return;
    }
    if !keys.iter().any(|k| k == &key) {
        keys.push(key);
    }
}

fn keys_from_env() -> Vec<String> {
    let mut keys = Vec::new();
    [
        "SHOGUN_LLM_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
    ]
    .iter()
    .filter_map(|name| std::env::var(name).ok())
    .map(|v| normalize_llm_key_input(&v))
    .filter(|v| !v.is_empty())
    .for_each(|k| push_unique(&mut keys, k));
    keys
}

fn parse_stored_keys(raw: &str) -> Vec<String> {
    let normalized = normalize_llm_key_input(raw);
    if normalized.is_empty() {
        return Vec::new();
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&normalized) {
        if let Some(arr) = v.get("keys").and_then(|x| x.as_array()) {
            let mut keys = Vec::new();
            for item in arr {
                if let Some(key) = item.as_str() {
                    let key = normalize_llm_key_input(key);
                    if !key.is_empty() {
                        push_unique(&mut keys, key);
                    }
                } else if let Some(key) = item.get("key").and_then(|x| x.as_str()) {
                    let key = normalize_llm_key_input(key);
                    if !key.is_empty() {
                        push_unique(&mut keys, key);
                    }
                }
            }
            return keys;
        }
    }
    vec![normalized]
}

fn serialize_keys(keys: &[String]) -> String {
    if keys.len() == 1 {
        return keys[0].clone();
    }
    let arr: Vec<serde_json::Value> = keys
        .iter()
        .map(|key| {
            serde_json::json!({
              "provider": crate::llm_providers::detect_provider(key).as_str(),
              "key": key,
            })
        })
        .collect();
    serde_json::json!({ "version": 1, "keys": arr }).to_string()
}

fn read_stored_keys() -> Result<Vec<String>, String> {
    let entry = Entry::new(SERVICE, USER).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(p) => Ok(parse_stored_keys(&p)),
        Err(keyring::Error::NoEntry) => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
    }
}

fn cached_or_load_keys() -> Result<Vec<String>, String> {
    if let Ok(cache) = LLM_KEY_CACHE.lock() {
        if let Some(cached) = cache.as_ref() {
            return Ok(cached.clone());
        }
    }
    let mut keys = read_stored_keys()?;
    for key in keys_from_env() {
        push_unique(&mut keys, key);
    }
    if let Ok(mut cache) = LLM_KEY_CACHE.lock() {
        *cache = Some(keys.clone());
    }
    Ok(keys)
}

pub fn set_llm_api_key(key: &str) -> Result<(), String> {
    let key = normalize_llm_key_input(key);
    if key.is_empty() {
        return Err("apiKey is required".to_string());
    }
    let provider = crate::llm_providers::detect_provider(&key);
    let mut keys = read_stored_keys()?;
    keys.retain(|existing| crate::llm_providers::detect_provider(existing) != provider);
    keys.insert(0, key);
    let entry = Entry::new(SERVICE, USER).map_err(|e| e.to_string())?;
    entry
        .set_password(&serialize_keys(&keys))
        .map_err(|e| e.to_string())?;
    if let Ok(mut cache) = LLM_KEY_CACHE.lock() {
        let mut all = keys.clone();
        for key in keys_from_env() {
            push_unique(&mut all, key);
        }
        *cache = Some(all);
    }
    Ok(())
}

pub fn get_llm_api_key() -> Result<Option<String>, String> {
    Ok(cached_or_load_keys()?.into_iter().next())
}

pub fn get_llm_api_keys() -> Result<Vec<String>, String> {
    cached_or_load_keys()
}

/// Return keys already available without touching Keychain. Background workers
/// use this to avoid stalling behind macOS SecurityAgent prompts; Settings and
/// foreground commands can still call `get_llm_api_keys` to unlock Keychain.
pub fn get_cached_or_env_llm_api_keys() -> Vec<String> {
    if let Ok(cache) = LLM_KEY_CACHE.lock() {
        if let Some(cached) = cache.as_ref() {
            return cached.clone();
        }
    }
    keys_from_env()
}

/// Start a Keychain read on a helper thread if keys are not cached yet. The
/// worker can keep ticking while macOS SecurityAgent waits for user approval.
pub fn load_llm_api_keys_in_background() {
    if get_cached_or_env_llm_api_keys()
        .iter()
        .any(|k| !k.trim().is_empty())
    {
        return;
    }
    if LLM_KEYCHAIN_LOAD_IN_FLIGHT
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    std::thread::spawn(|| {
        let result = cached_or_load_keys();
        match result {
            Ok(keys) => {
                crate::memory_obs::emit(
                    "llm_keychain_load_done",
                    &[("keys", keys.len().to_string())],
                );
            }
            Err(e) => {
                crate::memory_obs::emit(
                    "llm_keychain_load_failed",
                    &[("error", crate::memory_obs::clip_preview(&e))],
                );
            }
        }
        LLM_KEYCHAIN_LOAD_IN_FLIGHT.store(false, Ordering::Release);
    });
}

#[allow(dead_code)]
pub fn llm_api_key_configured() -> Result<bool, String> {
    Ok(get_llm_api_key()?
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false))
}

pub fn clear_llm_api_key() -> Result<(), String> {
    let entry = Entry::new(SERVICE, USER).map_err(|e| e.to_string())?;
    let result = match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    };
    if let Ok(mut cache) = LLM_KEY_CACHE.lock() {
        *cache = Some(keys_from_env());
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

/// Deepgram (meeting transcription) API key. Audit F-2: this key used to live in
/// `settings.json` as plaintext and leaked into `app_settings_export`; it now
/// lives in the Keychain alongside every other secret.
pub fn set_deepgram_api_key(key: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE, DEEPGRAM_USER).map_err(|e| e.to_string())?;
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return clear_deepgram_api_key();
    }
    entry.set_password(trimmed).map_err(|e| e.to_string())
}

pub fn get_deepgram_api_key() -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE, DEEPGRAM_USER).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(p) => {
            let t = p.trim().to_string();
            Ok(if t.is_empty() { None } else { Some(t) })
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn clear_deepgram_api_key() -> Result<(), String> {
    let entry = Entry::new(SERVICE, DEEPGRAM_USER).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_llm_key_input, parse_stored_keys, serialize_keys};

    #[test]
    fn normalize_llm_key_input_strips_env_assignment() {
        assert_eq!(
            normalize_llm_key_input("GEMINI_API_KEY='AIzaSyExampleKeyValue123456789012345'"),
            "AIzaSyExampleKeyValue123456789012345"
        );
    }

    #[test]
    fn normalize_llm_key_input_strips_export_assignment() {
        assert_eq!(
            normalize_llm_key_input("export ANTHROPIC_API_KEY=\"sk-ant-example\""),
            "sk-ant-example"
        );
    }

    #[test]
    fn normalize_llm_key_input_extracts_key_from_labelled_paste() {
        assert_eq!(
            normalize_llm_key_input("Gemini Key: AIzaSyExampleKeyValue123456789012345"),
            "AIzaSyExampleKeyValue123456789012345"
        );
        assert_eq!(
            normalize_llm_key_input("Anthropic: sk-ant-api03-example"),
            "sk-ant-api03-example"
        );
    }

    #[test]
    fn parse_stored_keys_accepts_legacy_single_key() {
        assert_eq!(
            parse_stored_keys("AIzaSyExampleKeyValue123456789012345").len(),
            1
        );
    }

    #[test]
    fn parse_stored_keys_accepts_json_bundle() {
        let raw = serialize_keys(&[
            "AIzaSyExampleKeyValue123456789012345".to_string(),
            "sk-ant-example".to_string(),
        ]);
        let keys = parse_stored_keys(&raw);
        assert_eq!(keys.len(), 2);
        assert!(keys[0].starts_with("AIza"));
        assert!(keys[1].starts_with("sk-ant-"));
    }
}

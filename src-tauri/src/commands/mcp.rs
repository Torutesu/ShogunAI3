use crate::{mcp_setup, settings_store};
use serde_json::{json, Value};
use std::path::PathBuf;

#[tauri::command]
pub fn mcp_setup_detect(_payload: Value) -> Result<Value, String> {
    mcp_setup::detect_status()
}

#[tauri::command]
pub fn mcp_setup_write_config(payload: Value) -> Result<Value, String> {
    let command_path = if let Some(raw) = payload.get("binaryPath").and_then(|v| v.as_str()) {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err("binaryPath is empty".into());
        }
        PathBuf::from(trimmed)
    } else {
        mcp_setup::resolve_shogun_mcp_binary()?
    };

    if !command_path.is_file() {
        return Err(format!("binary not found: {}", command_path.display()));
    }

    mcp_setup::write_shogun_config(&command_path)
}

#[tauri::command]
pub fn mcp_setup_verify(_payload: Value) -> Result<Value, String> {
    mcp_setup::verify_setup()
}

#[tauri::command]
pub fn mcp_setup_complete(payload: Value) -> Result<Value, String> {
    let doc = settings_store::save_patch(&json!({
      "section": "onboarding",
      "mcpComplete": true,
    }))?;
    Ok(json!({
      "complete": true,
      "settings": doc,
      "stub": false,
      "echo": payload,
    }))
}

#[tauri::command]
pub fn mcp_setup_open_claude_config(_payload: Value) -> Result<Value, String> {
    let path = mcp_setup::claude_config_path()?;
    if let Some(parent) = path.parent() {
        open::that(parent).map_err(|e| e.to_string())?;
    }
    Ok(json!({ "opened": true, "path": path.display().to_string() }))
}

#[tauri::command]
pub fn mcp_setup_open_claude_app(_payload: Value) -> Result<Value, String> {
    let path = mcp_setup::claude_app_path();
    if path.is_dir() {
        open::that(&path).map_err(|e| e.to_string())?;
    } else {
        return Err("Claude.app not found in /Applications".into());
    }
    Ok(json!({ "opened": true }))
}

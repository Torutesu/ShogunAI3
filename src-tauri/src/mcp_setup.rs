//! Claude Desktop MCP configuration helpers for the onboarding wizard and app settings.

use crate::{context_mcp, kioku_mcp, mcp_server, meeting_mcp, memory_mcp};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const SHOGUN_MCP_SERVER_KEY: &str = "shogun";

fn sample_args_for_tool(name: &str) -> Value {
    match name {
        "shogun.search_context" => json!({ "query": "unlikely-query-token", "limit": 3 }),
        "shogun.get_recent_context" => json!({ "limit": 3 }),
        "shogun.get_customer_context" => json!({ "entityId": "company:acme", "limit": 3 }),
        "shogun.get_project_context" => json!({ "entityId": "project:apollo", "limit": 3 }),
        "shogun.get_meeting_summary" => json!({ "meeting_id": "meeting-demo" }),
        "shogun.list_tasks" => json!({ "limit": 3 }),
        "shogun.ai_fields_list" => json!({ "limit": 3 }),
        "shogun.action_queue_list" => json!({ "limit": 3 }),
        "shogun.action_audit_list" => json!({ "actionId": "action-demo", "limit": 3 }),
        "shogun.queue_artifacts_list" => json!({ "limit": 3 }),
        "shogun.owner_context_summary" => json!({ "ownerEntityId": "company:acme", "limit": 3 }),
        "shogun.entity_context_get" => json!({ "entityId": "company:acme", "limit": 3 }),
        "shogun.meetings_list" => json!({ "limit": 3 }),
        "shogun.meeting_get" => json!({ "meeting_id": "meeting-demo" }),
        "shogun.meeting_transcript" => json!({ "meeting_id": "meeting-demo" }),
        "shogun.meeting_notes" => json!({ "meeting_id": "meeting-demo" }),
        "shogun.meetings_search" => json!({ "query": "demo", "limit": 3 }),
        "shogun.memory_search" => json!({ "query": "unlikely-query-token", "limit": 3 }),
        "shogun.memory_search_timeline" => json!({ "query": "unlikely-query-token", "limit": 3 }),
        "shogun.memory_fetch" => json!({ "ids": ["memory-demo"] }),
        "shogun.memory_entities" => json!({ "q": "demo" }),
        "shogun.kioku_debug_stats" => json!({}),
        "shogun.kioku_related" => json!({ "seed_ids": ["memory-demo"], "limit": 3 }),
        _ => json!({}),
    }
}

pub fn home_dir() -> Result<PathBuf, String> {
    if let Ok(home) = std::env::var("HOME") {
        if !home.trim().is_empty() {
            return Ok(PathBuf::from(home));
        }
    }
    directories::BaseDirs::new()
        .map(|b| b.home_dir().to_path_buf())
        .ok_or_else(|| "home directory not found".to_string())
}

pub fn claude_config_path() -> Result<PathBuf, String> {
    Ok(home_dir()?.join("Library/Application Support/Claude/claude_desktop_config.json"))
}

pub fn claude_app_path() -> PathBuf {
    PathBuf::from("/Applications/Claude.app")
}

pub fn resolve_shogun_mcp_binary() -> Result<PathBuf, String> {
    if let Ok(from_env) = std::env::var("SHOGUN_MCP_BIN") {
        let trimmed = from_env.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            if path.is_file() {
                return Ok(path);
            }
            return Err(format!("SHOGUN_MCP_BIN not found: {}", path.display()));
        }
    }

    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let mut dir = exe.parent();

    for _ in 0..6 {
        let Some(d) = dir else { break };
        let candidate = d.join("shogun-mcp");
        if candidate.is_file() {
            return Ok(candidate);
        }
        dir = d.parent();
    }

    Err(
    "shogun-mcp binary not found. Build with: cargo build --manifest-path src-tauri/Cargo.toml --bin shogun-mcp"
      .to_string(),
  )
}

pub fn read_json_file(path: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))
}

pub fn merge_shogun_server(existing: Value, command: &str) -> Value {
    let mut root = match existing {
        Value::Object(map) => map,
        _ => Map::new(),
    };

    let mut servers = match root.remove("mcpServers") {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };

    servers.insert(
        SHOGUN_MCP_SERVER_KEY.to_string(),
        json!({ "command": command }),
    );
    root.insert("mcpServers".to_string(), Value::Object(servers));
    Value::Object(root)
}

pub fn shogun_command_from_config(doc: &Value) -> Option<String> {
    doc.get("mcpServers")
        .and_then(|v| v.get(SHOGUN_MCP_SERVER_KEY))
        .and_then(|v| v.get("command"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

pub fn detect_status() -> Result<Value, String> {
    let config_path = claude_config_path()?;
    let config_exists = config_path.is_file();
    let claude_installed = claude_app_path().is_dir();

    let mut config_parsed: Option<Value> = None;
    let mut shogun_configured = false;
    let mut configured_command: Option<String> = None;

    if config_exists {
        if let Ok(doc) = read_json_file(&config_path) {
            configured_command = shogun_command_from_config(&doc);
            shogun_configured = configured_command.is_some();
            config_parsed = Some(doc);
        }
    }

    let binary_path = resolve_shogun_mcp_binary().ok();
    let binary_found = binary_path.as_ref().is_some_and(|p| p.is_file());

    Ok(json!({
      "claudeConfigPath": config_path.display().to_string(),
      "claudeConfigExists": config_exists,
      "claudeInstalled": claude_installed,
      "binaryPath": binary_path.as_ref().map(|p| p.display().to_string()),
      "binaryFound": binary_found,
      "shogunConfigured": shogun_configured,
      "configuredCommand": configured_command,
      "configValid": config_parsed.is_some() || !config_exists,
    }))
}

fn backup_path_for(config_path: &Path) -> PathBuf {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    config_path.with_extension(format!("json.bak.{ts}"))
}

pub fn write_shogun_config(command_path: &Path) -> Result<Value, String> {
    let config_path = claude_config_path()?;
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create Claude config dir: {e}"))?;
    }

    let existing = if config_path.is_file() {
        read_json_file(&config_path)?
    } else {
        json!({})
    };

    let backup_path = if config_path.is_file() {
        let backup = backup_path_for(&config_path);
        fs::copy(&config_path, &backup).map_err(|e| format!("backup config: {e}"))?;
        Some(backup.display().to_string())
    } else {
        None
    };

    let merged = merge_shogun_server(existing, &command_path.display().to_string());
    let pretty = serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())?;
    fs::write(&config_path, pretty).map_err(|e| format!("write config: {e}"))?;

    Ok(json!({
      "written": true,
      "configPath": config_path.display().to_string(),
      "backupPath": backup_path,
      "command": command_path.display().to_string(),
    }))
}

pub fn verify_setup() -> Result<Value, String> {
    let config_path = claude_config_path()?;
    if !config_path.is_file() {
        return Ok(json!({ "ok": false, "reason": "config_missing" }));
    }

    let doc = read_json_file(&config_path)?;
    let command = shogun_command_from_config(&doc)
        .ok_or_else(|| "shogun MCP server not configured".to_string())?;
    let command_path = PathBuf::from(&command);

    if !command_path.is_file() {
        return Ok(json!({
          "ok": false,
          "reason": "binary_missing",
          "command": command,
        }));
    }

    Ok(json!({
      "ok": true,
      "command": command,
      "configPath": config_path.display().to_string(),
    }))
}

pub fn list_shogun_mcp_tools() -> Result<Value, String> {
    let groups = [
        ("meetings", meeting_mcp::tool_definitions()),
        ("memory", memory_mcp::tool_definitions()),
        ("context", context_mcp::tool_definitions()),
        ("kioku", kioku_mcp::tool_definitions()),
    ];

    let mut total: usize = 0;
    let sections: Vec<Value> = groups
        .into_iter()
        .map(|(group_id, defs)| {
            let items = defs
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|item| {
                    let name = item
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                    let description = item
                        .get("description")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                    json!({
                        "name": name,
                        "description": description,
                        "sampleArgs": sample_args_for_tool(&name),
                    })
                })
                .collect::<Vec<Value>>();
            total += items.len();
            json!({
                "groupId": group_id,
                "count": items.len(),
                "items": items,
            })
        })
        .collect();

    Ok(json!({
        "total": total,
        "sections": sections,
        "stub": false,
    }))
}

pub fn preview_tool(name: &str, args: &Value) -> Result<Value, String> {
    let result = mcp_server::dispatch(name, args)?;
    let text = result
        .get("content")
        .and_then(|value| value.as_array())
        .and_then(|items| items.first())
        .and_then(|item| item.get("text"))
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();

    Ok(json!({
        "ok": true,
        "toolName": name,
        "args": args,
        "text": text,
        "stub": false,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_shogun_server_preserves_other_servers() {
        let existing = json!({
          "mcpServers": {
            "other": { "command": "/bin/other" }
          },
          "preferences": { "darkMode": true }
        });
        let merged = merge_shogun_server(existing, "/tmp/shogun-mcp");
        assert_eq!(
            merged["mcpServers"]["other"]["command"].as_str(),
            Some("/bin/other")
        );
        assert_eq!(
            merged["mcpServers"]["shogun"]["command"].as_str(),
            Some("/tmp/shogun-mcp")
        );
        assert_eq!(merged["preferences"]["darkMode"].as_bool(), Some(true));
    }

    #[test]
    fn merge_shogun_server_creates_root_when_empty() {
        let merged = merge_shogun_server(json!({}), "/tmp/shogun-mcp");
        assert_eq!(
            merged["mcpServers"]["shogun"]["command"].as_str(),
            Some("/tmp/shogun-mcp")
        );
    }

    #[test]
    fn list_shogun_mcp_tools_returns_grouped_tool_catalog() {
        let payload = list_shogun_mcp_tools().expect("tool catalog");
        let sections = payload["sections"].as_array().expect("sections");
        assert!(!sections.is_empty());
        let context_section = sections
            .iter()
            .find(|section| section["groupId"].as_str() == Some("context"))
            .expect("context section");
        let items = context_section["items"].as_array().expect("items");
        assert!(
            items.iter().any(|item| item["name"].as_str() == Some("shogun.search_context"))
        );
        assert_eq!(
            items.iter()
                .find(|item| item["name"].as_str() == Some("shogun.search_context"))
                .and_then(|item| item.get("sampleArgs"))
                .and_then(|value| value.get("query"))
                .and_then(|value| value.as_str()),
            Some("unlikely-query-token")
        );
        assert!(payload["total"].as_u64().unwrap_or(0) >= items.len() as u64);
    }

    #[test]
    fn preview_tool_returns_text_payload() {
        let payload = preview_tool("shogun.search_context", &json!({
            "query": "unlikely-query-token",
            "limit": 2
        }))
        .expect("preview");
        assert_eq!(payload["toolName"].as_str(), Some("shogun.search_context"));
        assert!(payload["text"].as_str().is_some());
    }
}

use crate::memory_store;
use rusqlite::{params, Connection};
use serde_json::{json, Map, Value};
use uuid::Uuid;

const ALLOWED_ACTION_STATUSES: &[&str] = &["proposed", "approved", "executed", "rejected"];
const ALLOWED_RISK_LEVELS: &[&str] = &["low", "medium", "high", "critical"];
const SUPPORTED_ACTION_TYPES: &[&str] =
    &["follow_up_email_draft", "create_task", "update_crm"];

pub(crate) fn ensure_context_actions_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS context_actions (
          id TEXT PRIMARY KEY,
          owner_entity_id TEXT NOT NULL,
          action_type TEXT NOT NULL,
          title TEXT NOT NULL,
          detail TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL,
          risk_level TEXT NOT NULL,
          source_ai_field_id TEXT,
          evidence_event_ids_json TEXT NOT NULL DEFAULT '[]',
          execution_result_json TEXT,
          executed_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_context_actions_owner_entity_id
          ON context_actions(owner_entity_id);
        CREATE INDEX IF NOT EXISTS idx_context_actions_status
          ON context_actions(status);
        CREATE INDEX IF NOT EXISTS idx_context_actions_updated_at
          ON context_actions(updated_at DESC);",
    )
    .map_err(|e| e.to_string())?;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS context_action_audit_log (
          id TEXT PRIMARY KEY,
          action_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          actor TEXT NOT NULL,
          from_status TEXT,
          to_status TEXT,
          detail TEXT NOT NULL DEFAULT '',
          payload_json TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_context_action_audit_action_id
          ON context_action_audit_log(action_id, created_at DESC);",
    )
    .map_err(|e| e.to_string())?;

    for ddl in [
        "ALTER TABLE context_actions ADD COLUMN execution_result_json TEXT",
        "ALTER TABLE context_actions ADD COLUMN executed_at INTEGER",
    ] {
        match conn.execute(ddl, []) {
            Ok(_) => {}
            Err(err) => {
                let msg = err.to_string().to_lowercase();
                if !msg.contains("duplicate column name") {
                    return Err(err.to_string());
                }
            }
        }
    }

    Ok(())
}

fn normalize_choice(value: Option<&str>, allowed: &[&str], fallback: &str) -> String {
    let raw = value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or(fallback)
        .to_ascii_lowercase();
    if allowed.iter().any(|candidate| *candidate == raw) {
        raw
    } else {
        fallback.to_string()
    }
}

fn normalize_action_type(value: Option<&str>) -> Result<String, String> {
    let action_type = value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "actionType is required".to_string())?
        .to_ascii_lowercase();
    let action_type = match action_type.as_str() {
        "queue_crm_update" => "update_crm".to_string(),
        _ => action_type,
    };
    if SUPPORTED_ACTION_TYPES
        .iter()
        .any(|candidate| *candidate == action_type)
    {
        Ok(action_type)
    } else {
        Err(format!(
            "Unsupported action type: {}. Supported types: {}",
            action_type,
            SUPPORTED_ACTION_TYPES.join(", ")
        ))
    }
}

fn normalize_evidence_ids(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(|raw| raw.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::trim))
                .filter(|item| !item.is_empty())
                .map(String::from)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn row_to_context_action(
    id: String,
    owner_entity_id: String,
    action_type: String,
    title: String,
    detail: String,
    status: String,
    risk_level: String,
    source_ai_field_id: Option<String>,
    evidence_event_ids_json: String,
    execution_result_json: Option<String>,
    executed_at: Option<i64>,
    created_at: i64,
    updated_at: i64,
) -> Value {
    let evidence_event_ids: Vec<String> =
        serde_json::from_str(&evidence_event_ids_json).unwrap_or_default();
    let execution_result = execution_result_json
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or(Value::Null);
    let mut map = Map::new();
    map.insert("id".to_string(), json!(id));
    map.insert("ownerEntityId".to_string(), json!(owner_entity_id));
    map.insert("actionType".to_string(), json!(action_type));
    map.insert("title".to_string(), json!(title));
    map.insert("detail".to_string(), json!(detail));
    map.insert("status".to_string(), json!(status));
    map.insert("riskLevel".to_string(), json!(risk_level));
    map.insert(
        "sourceAiFieldId".to_string(),
        source_ai_field_id.map_or(Value::Null, Value::from),
    );
    map.insert("evidenceEventIds".to_string(), json!(evidence_event_ids));
    map.insert("executionResult".to_string(), execution_result);
    map.insert(
        "executedAt".to_string(),
        executed_at.map_or(Value::Null, Value::from),
    );
    map.insert("createdAt".to_string(), json!(created_at));
    map.insert("updatedAt".to_string(), json!(updated_at));
    Value::Object(map)
}

fn row_to_context_action_audit_event(
    id: String,
    action_id: String,
    event_type: String,
    actor: String,
    from_status: Option<String>,
    to_status: Option<String>,
    detail: String,
    payload_json: Option<String>,
    created_at: i64,
) -> Value {
    let payload = payload_json
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or(Value::Null);
    json!({
      "id": id,
      "actionId": action_id,
      "eventType": event_type,
      "actor": actor,
      "fromStatus": from_status,
      "toStatus": to_status,
      "detail": detail,
      "payload": payload,
      "createdAt": created_at,
    })
}

fn append_context_action_audit_event(
    conn: &Connection,
    action_id: &str,
    event_type: &str,
    actor: &str,
    from_status: Option<&str>,
    to_status: Option<&str>,
    detail: &str,
    payload: Option<&Value>,
) -> Result<(), String> {
    let now = memory_store::now_ms() as i64;
    let payload_json = payload
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO context_action_audit_log
          (id, action_id, event_type, actor, from_status, to_status, detail, payload_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            format!("audit_{}", Uuid::new_v4().simple()),
            action_id,
            event_type,
            actor,
            from_status,
            to_status,
            detail,
            payload_json,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn get_context_action_with_conn(conn: &Connection, id: &str) -> Result<Value, String> {
    conn.query_row(
        "SELECT id, owner_entity_id, action_type, title, detail, status, risk_level,
                source_ai_field_id, evidence_event_ids_json, execution_result_json, executed_at, created_at, updated_at
         FROM context_actions WHERE id = ?1",
        params![id],
        |row| {
            Ok(row_to_context_action(
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
                row.get(9)?,
                row.get(10)?,
                row.get(11)?,
                row.get(12)?,
            ))
        },
    )
    .map_err(|e| e.to_string())
}

fn build_execution_navigation(
    side_effect: &str,
    execution_result: &Value,
    action_id: &str,
    owner_entity_id: &str,
    action_type: &str,
    title: &str,
    detail: &str,
    source_ai_field_id: Option<&str>,
) -> Value {
    match side_effect {
        "queue_only" | "crm_queue_only" => execution_result
            .get("queued")
            .and_then(|queued| queued.get("id"))
            .and_then(|value| value.as_str())
            .map(|queue_id| {
                json!({
                  "screen": "actions",
                  "queueId": queue_id,
                  "sourceActionId": action_id,
                  "entityId": owner_entity_id,
                  "aiFieldId": source_ai_field_id,
                })
            })
            .unwrap_or(Value::Null),
        "draft_only" => execution_result
            .get("content")
            .and_then(|value| value.as_str())
            .map(|draft_content| {
                json!({
                  "screen": "chat",
                  "newChat": true,
                  "assembleMemory": true,
                  "memoryAssemblyQuery": owner_entity_id,
                  "memoryAssemblyLimit": 14,
                  "memoryAssemblySemantic": true,
                  "text": format!(
                    "{owner_entity_id} の draft を shared context と合わせてレビューしてください。\n\nAction: {title}\n\nType: {action_type}\n\n{detail_block}Draft:\n{draft_content}\n\n必要なら改善版の文面、抜けている論点、次の一手を提案してください。",
                    detail_block = if detail.trim().is_empty() {
                        String::new()
                    } else {
                        format!("Detail: {detail}\n\n")
                    },
                  ),
                })
            })
            .unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

pub(crate) fn list_context_actions(payload: &Value) -> Result<Value, String> {
    let conn = memory_store::open_conn()?;
    list_context_actions_with_conn(&conn, payload)
}

fn list_context_actions_with_conn(conn: &Connection, payload: &Value) -> Result<Value, String> {
    let id_filter = payload
        .get("id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(String::from);
    let owner_entity_id = payload
        .get("ownerEntityId")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(String::from);
    let source_ai_field_id_filter = payload
        .get("sourceAiFieldId")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(String::from);
    let status_filter = payload
        .get("status")
        .and_then(|v| v.as_str())
        .map(|v| normalize_choice(Some(v), ALLOWED_ACTION_STATUSES, ""));
    let query = payload
        .get("query")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let limit = payload
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(20)
        .clamp(1, 100) as i64;

    let mut sql = String::from(
        "SELECT id, owner_entity_id, action_type, title, detail, status, risk_level,
                source_ai_field_id, evidence_event_ids_json, execution_result_json, executed_at, created_at, updated_at
         FROM context_actions",
    );
    let mut clauses: Vec<String> = Vec::new();
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(id) = id_filter {
        clauses.push("id = ?".to_string());
        args.push(Box::new(id));
    }
    if let Some(owner) = owner_entity_id {
        clauses.push("owner_entity_id = ?".to_string());
        args.push(Box::new(owner));
    }
    if let Some(source_ai_field_id) = source_ai_field_id_filter {
        clauses.push("source_ai_field_id = ?".to_string());
        args.push(Box::new(source_ai_field_id));
    }
    if let Some(status) = status_filter.filter(|v| !v.is_empty()) {
        clauses.push("status = ?".to_string());
        args.push(Box::new(status));
    }
    if !query.is_empty() {
        clauses.push("(action_type LIKE ? OR title LIKE ? OR detail LIKE ?)".to_string());
        let like = format!("%{}%", query);
        args.push(Box::new(like.clone()));
        args.push(Box::new(like.clone()));
        args.push(Box::new(like));
    }
    if !clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&clauses.join(" AND "));
    }
    sql.push_str(" ORDER BY updated_at DESC LIMIT ?");
    args.push(Box::new(limit));

    let params_ref: Vec<&dyn rusqlite::ToSql> = args.iter().map(|item| item.as_ref()).collect();
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_ref.as_slice(), |row| {
            Ok(row_to_context_action(
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
                row.get(9)?,
                row.get(10)?,
                row.get(11)?,
                row.get(12)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let items: Vec<Value> = rows.filter_map(Result::ok).collect();

    Ok(json!({ "items": items, "total": items.len() }))
}

pub(crate) fn list_context_action_audit(payload: &Value) -> Result<Value, String> {
    let conn = memory_store::open_conn()?;
    list_context_action_audit_with_conn(&conn, payload)
}

fn list_context_action_audit_with_conn(
    conn: &Connection,
    payload: &Value,
) -> Result<Value, String> {
    let action_id = payload
        .get("actionId")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "actionId is required".to_string())?;
    let limit = payload
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(12)
        .clamp(1, 100) as i64;

    let mut stmt = conn
        .prepare(
            "SELECT id, action_id, event_type, actor, from_status, to_status, detail, payload_json, created_at
             FROM context_action_audit_log
             WHERE action_id = ?1
             ORDER BY created_at DESC, rowid DESC
             LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![action_id, limit], |row| {
            Ok(row_to_context_action_audit_event(
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let items: Vec<Value> = rows.filter_map(Result::ok).collect();
    Ok(json!({ "items": items, "total": items.len() }))
}

pub(crate) fn propose_context_action(payload: &Value) -> Result<Value, String> {
    let conn = memory_store::open_conn()?;
    let result = propose_context_action_with_conn(&conn, payload)?;
    crate::app_events::emit_action_layer_refresh("action-proposed", Some(result.clone()));
    Ok(result)
}

fn propose_context_action_with_conn(conn: &Connection, payload: &Value) -> Result<Value, String> {
    let owner_entity_id = payload
        .get("ownerEntityId")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "ownerEntityId is required".to_string())?;
    let action_type = payload
        .get("actionType")
        .and_then(|v| v.as_str())
        .map(str::trim);
    let action_type = normalize_action_type(action_type)?;
    let title = payload
        .get("title")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "title is required".to_string())?;
    let detail = payload
        .get("detail")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let status = normalize_choice(
        payload.get("status").and_then(|v| v.as_str()),
        ALLOWED_ACTION_STATUSES,
        "proposed",
    );
    let risk_level = normalize_choice(
        payload.get("riskLevel").and_then(|v| v.as_str()),
        ALLOWED_RISK_LEVELS,
        "medium",
    );
    let source_ai_field_id = payload
        .get("sourceAiFieldId")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(String::from);
    let evidence_event_ids = normalize_evidence_ids(payload.get("evidenceEventIds"));
    let evidence_event_ids_json =
        serde_json::to_string(&evidence_event_ids).map_err(|e| e.to_string())?;
    let now = memory_store::now_ms() as i64;
    let id = payload
        .get("id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(String::from)
        .unwrap_or_else(|| format!("act_{}", memory_store::now_ms()));
    let created_at = conn
        .query_row(
            "SELECT created_at FROM context_actions WHERE id = ?1",
            params![id.clone()],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(now);

    conn.execute(
        "INSERT INTO context_actions
          (id, owner_entity_id, action_type, title, detail, status, risk_level, source_ai_field_id, evidence_event_ids_json, execution_result_json, executed_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, NULL, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
           owner_entity_id = excluded.owner_entity_id,
           action_type = excluded.action_type,
           title = excluded.title,
           detail = excluded.detail,
           status = excluded.status,
           risk_level = excluded.risk_level,
           source_ai_field_id = excluded.source_ai_field_id,
            evidence_event_ids_json = excluded.evidence_event_ids_json,
           execution_result_json = NULL,
           executed_at = NULL,
           updated_at = excluded.updated_at",
        params![
            id.clone(),
            owner_entity_id,
            action_type,
            title,
            detail,
            status,
            risk_level,
            source_ai_field_id,
            evidence_event_ids_json,
            created_at,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;

    append_context_action_audit_event(
        conn,
        &id,
        "proposed",
        "system",
        None,
        Some(status.as_str()),
        &format!("Action proposed: {}", title),
        Some(&json!({
          "ownerEntityId": owner_entity_id,
          "actionType": action_type,
          "riskLevel": risk_level,
          "sourceAiFieldId": source_ai_field_id,
          "evidenceEventIds": evidence_event_ids,
        })),
    )?;

    let item = get_context_action_with_conn(conn, &id)?;

    Ok(json!({ "item": item }))
}

pub(crate) fn set_context_action_status(payload: &Value) -> Result<Value, String> {
    let conn = memory_store::open_conn()?;
    let result = set_context_action_status_with_conn(&conn, payload)?;
    let status = payload
        .get("status")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("unknown");
    crate::app_events::emit_action_layer_refresh(
        &format!("action-status-{}", status),
        Some(result.clone()),
    );
    Ok(result)
}

fn set_context_action_status_with_conn(
    conn: &Connection,
    payload: &Value,
) -> Result<Value, String> {
    let id = payload
        .get("id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "id is required".to_string())?;
    let status = normalize_choice(
        payload.get("status").and_then(|v| v.as_str()),
        ALLOWED_ACTION_STATUSES,
        "proposed",
    );
    let previous_status = conn
        .query_row(
            "SELECT status FROM context_actions WHERE id = ?1",
            params![id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| "Action not found".to_string())?;
    let now = memory_store::now_ms() as i64;
    let updated = conn
        .execute(
            "UPDATE context_actions SET status = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, status, now],
        )
        .map_err(|e| e.to_string())?;
    if updated == 0 {
        return Err("Action not found".to_string());
    }
    append_context_action_audit_event(
        conn,
        id,
        "status_changed",
        "system",
        Some(previous_status.as_str()),
        Some(status.as_str()),
        &format!("Status changed from {} to {}", previous_status, status),
        None,
    )?;
    let item = get_context_action_with_conn(conn, id)?;
    Ok(json!({ "item": item }))
}

async fn execute_context_action_with_conn(
    conn: Connection,
    payload: &Value,
    ring: Option<&crate::memory_debug::RingBuffer>,
) -> Result<Value, String> {
    let id = payload
        .get("id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "id is required".to_string())?;
    let row = conn
        .query_row(
            "SELECT id, owner_entity_id, action_type, title, detail, status, risk_level,
                    source_ai_field_id, evidence_event_ids_json
             FROM context_actions WHERE id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, String>(8)?,
                ))
            },
        )
        .map_err(|_| "Action not found".to_string())?;

    let (
        action_id,
        owner_entity_id,
        action_type,
        title,
        detail,
        status,
        _risk_level,
        source_ai_field_id,
        evidence_event_ids_json,
    ) = row;

    if status != "approved" {
        return Err("Only approved actions can be executed".to_string());
    }
    let evidence_event_ids: Vec<String> =
        serde_json::from_str(&evidence_event_ids_json).unwrap_or_default();
    let (execution_result, side_effect): (Value, &str) = match action_type.as_str() {
        "follow_up_email_draft" => {
            let prompt = if detail.trim().is_empty() {
                format!("Create a concise follow-up email draft for: {}", title)
            } else {
                format!(
                    "Create a concise follow-up email draft.\nTitle: {}\nIntent: {}\nOwner: {}",
                    title, detail, owner_entity_id
                )
            };

            let draft = crate::llm::draft_from_payload(
                &json!({
                  "target": "email",
                  "title": format!("Draft · {}", title),
                  "prompt": prompt,
                  "source": "approved_context_action",
                  "memoryAssembly": {
                    "query": format!("{} {} {}", owner_entity_id, title, detail),
                    "limit": 8,
                    "semantic": true
                  }
                }),
                ring,
            )
            .await?;
            (draft, "draft_only")
        }
        "create_task" => {
            let queued = crate::schedule_queue::append(&json!({
              "title": title,
              "detail": detail,
              "owner_entity_id": owner_entity_id,
              "source": "approved_context_action",
              "source_action_id": action_id,
              "source_ai_field_id": source_ai_field_id,
              "evidence_event_ids": evidence_event_ids,
            }))?;
            (
                json!({
                  "queued": queued,
                  "title": title,
                  "detail": detail,
                  "ownerEntityId": owner_entity_id,
                }),
                "queue_only",
            )
        }
        "update_crm" => {
            let queued = crate::crm_update_queue::append(&json!({
              "title": title,
              "detail": detail,
              "owner_entity_id": owner_entity_id,
              "source": "approved_context_action",
              "source_action_id": action_id,
              "source_ai_field_id": source_ai_field_id,
              "evidence_event_ids": evidence_event_ids,
            }))?;
            (
                json!({
                  "queued": queued,
                  "title": title,
                  "detail": detail,
                  "ownerEntityId": owner_entity_id,
                }),
                "crm_queue_only",
            )
        }
        _ => {
            return Err(format!(
                "Execution is not implemented yet for action type: {}",
                action_type
            ))
        }
    };

    let execution_result_json =
        serde_json::to_string(&execution_result).map_err(|e| e.to_string())?;
    let now = memory_store::now_ms() as i64;
    conn.execute(
        "UPDATE context_actions
         SET status = 'executed',
             execution_result_json = ?2,
             executed_at = ?3,
             updated_at = ?3
         WHERE id = ?1",
        params![action_id, execution_result_json, now],
    )
    .map_err(|e| e.to_string())?;

    append_context_action_audit_event(
        &conn,
        &action_id,
        "executed",
        "system",
        Some("approved"),
        Some("executed"),
        &format!("Executed action via {}", side_effect),
        Some(&execution_result),
    )?;

    let item = get_context_action_with_conn(&conn, id)?;
    let navigation = build_execution_navigation(
        side_effect,
        &execution_result,
        &action_id,
        &owner_entity_id,
        &action_type,
        &title,
        &detail,
        source_ai_field_id.as_deref(),
    );

    let result = json!({
      "item": item,
      "executed": true,
      "actionType": action_type,
      "sideEffect": side_effect,
      "evidenceEventIds": evidence_event_ids,
      "sourceAiFieldId": source_ai_field_id,
      "navigation": navigation,
    });
    let notification_body = match side_effect {
        "queue_only" => format!("{} was added to the local task queue.", title),
        "crm_queue_only" => format!("{} was added to the local CRM queue.", title),
        "draft_only" => format!("Draft ready for {}.", owner_entity_id),
        _ => format!("{} was executed.", title),
    };
    crate::app_events::notify_native("SHOGUN Action Executed", &notification_body);
    crate::app_events::emit_action_layer_refresh(
        &format!("action-executed-{}", id),
        Some(result.clone()),
    );
    Ok(result)
}

pub(crate) async fn execute_context_action(
    payload: &Value,
    ring: Option<&crate::memory_debug::RingBuffer>,
) -> Result<Value, String> {
    let conn = memory_store::open_conn()?;
    execute_context_action_with_conn(conn, payload, ring).await
}

#[cfg(test)]
mod tests {
    use super::{
        build_execution_navigation, ensure_context_actions_schema, execute_context_action_with_conn,
        list_context_action_audit_with_conn,
        list_context_actions_with_conn, normalize_action_type, propose_context_action_with_conn,
        set_context_action_status_with_conn,
    };
    use rusqlite::Connection;
    use serde_json::json;

    #[test]
    fn propose_and_list_actions_round_trip() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        ensure_context_actions_schema(&conn).expect("schema");
        let saved = propose_context_action_with_conn(
            &conn,
            &json!({
              "ownerEntityId": "deal:acme",
              "actionType": "follow_up_email_draft",
              "title": "Draft the security follow-up",
              "detail": "Answer the questionnaire and confirm owner.",
              "riskLevel": "high",
              "sourceAiFieldId": "af_1",
              "evidenceEventIds": ["m_1", "meeting:123"]
            }),
        )
        .expect("propose");
        assert_eq!(saved["item"]["status"].as_str(), Some("proposed"));
        let listed = list_context_actions_with_conn(&conn, &json!({ "limit": 5 })).expect("list");
        assert_eq!(listed["total"].as_u64(), Some(1));
        assert_eq!(listed["items"][0]["riskLevel"].as_str(), Some("high"));
    }

    #[test]
    fn status_update_changes_existing_action() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        ensure_context_actions_schema(&conn).expect("schema");
        let saved = propose_context_action_with_conn(
            &conn,
            &json!({
              "ownerEntityId": "company:acme",
              "actionType": "create_task",
              "title": "Create onboarding task"
            }),
        )
        .expect("propose");
        let id = saved["item"]["id"].as_str().expect("id").to_string();
        let updated = set_context_action_status_with_conn(
            &conn,
            &json!({
              "id": id,
              "status": "approved"
            }),
        )
        .expect("update");
        assert_eq!(updated["item"]["status"].as_str(), Some("approved"));
    }

    #[test]
    fn list_filters_by_id_and_source_ai_field_id() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        ensure_context_actions_schema(&conn).expect("schema");
        let first = propose_context_action_with_conn(
            &conn,
            &json!({
              "id": "act_one",
              "ownerEntityId": "company:acme",
              "actionType": "create_task",
              "title": "Task one",
              "sourceAiFieldId": "af_focus"
            }),
        )
        .expect("first");
        assert_eq!(first["item"]["id"].as_str(), Some("act_one"));
        propose_context_action_with_conn(
            &conn,
            &json!({
              "id": "act_two",
              "ownerEntityId": "company:acme",
              "actionType": "update_crm",
              "title": "Task two",
              "sourceAiFieldId": "af_other"
            }),
        )
        .expect("second");

        let by_id =
            list_context_actions_with_conn(&conn, &json!({ "id": "act_one" })).expect("by id");
        assert_eq!(by_id["total"].as_u64(), Some(1));
        assert_eq!(by_id["items"][0]["id"].as_str(), Some("act_one"));

        let by_field =
            list_context_actions_with_conn(&conn, &json!({ "sourceAiFieldId": "af_focus" }))
                .expect("by field");
        assert_eq!(by_field["total"].as_u64(), Some(1));
        assert_eq!(
            by_field["items"][0]["sourceAiFieldId"].as_str(),
            Some("af_focus")
        );
    }

    #[test]
    fn audit_log_records_propose_and_status_change() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        ensure_context_actions_schema(&conn).expect("schema");
        let saved = propose_context_action_with_conn(
            &conn,
            &json!({
              "id": "act_audit",
              "ownerEntityId": "company:acme",
              "actionType": "create_task",
              "title": "Audit me"
            }),
        )
        .expect("propose");
        assert_eq!(saved["item"]["id"].as_str(), Some("act_audit"));
        set_context_action_status_with_conn(
            &conn,
            &json!({
              "id": "act_audit",
              "status": "approved"
            }),
        )
        .expect("approve");

        let audit = list_context_action_audit_with_conn(&conn, &json!({ "actionId": "act_audit" }))
            .expect("audit");
        assert_eq!(audit["total"].as_u64(), Some(2));
        assert_eq!(
            audit["items"][0]["eventType"].as_str(),
            Some("status_changed")
        );
        assert_eq!(audit["items"][1]["eventType"].as_str(), Some("proposed"));
    }

    #[tokio::test]
    async fn execute_task_action_returns_navigation_payload() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        ensure_context_actions_schema(&conn).expect("schema");
        let saved = propose_context_action_with_conn(
            &conn,
            &json!({
              "id": "act_execute_queue",
              "ownerEntityId": "workspace:apollo",
              "actionType": "create_task",
              "title": "Queue Apollo task",
              "sourceAiFieldId": "af_apollo",
              "evidenceEventIds": ["mem_1"]
            }),
        )
        .expect("propose");
        assert_eq!(saved["item"]["status"].as_str(), Some("proposed"));
        set_context_action_status_with_conn(
            &conn,
            &json!({
              "id": "act_execute_queue",
              "status": "approved"
            }),
        )
        .expect("approve");

        let result = execute_context_action_with_conn(
            conn,
            &json!({ "id": "act_execute_queue" }),
            None,
        )
            .await
            .expect("execute");
        assert_eq!(result["sideEffect"].as_str(), Some("queue_only"));
        assert_eq!(result["navigation"]["screen"].as_str(), Some("actions"));
        assert_eq!(
            result["navigation"]["sourceActionId"].as_str(),
            Some("act_execute_queue")
        );
        assert_eq!(
            result["navigation"]["entityId"].as_str(),
            Some("workspace:apollo")
        );
        assert_eq!(
            result["navigation"]["aiFieldId"].as_str(),
            Some("af_apollo")
        );
        assert!(result["navigation"]["queueId"]
            .as_str()
            .is_some_and(|value| !value.is_empty()));
    }

    #[test]
    fn build_draft_navigation_returns_chat_payload() {
        let result = build_execution_navigation(
            "draft_only",
            &json!({
              "content": "# Draft\n\nAurora follow-up body"
            }),
            "act_execute_draft",
            "company:aurora",
            "follow_up_email_draft",
            "Draft Aurora follow-up",
            "Mention the diligence blocker.",
            None,
        );
        assert_eq!(result["screen"].as_str(), Some("chat"));
        assert_eq!(result["newChat"].as_bool(), Some(true));
        assert_eq!(result["memoryAssemblyQuery"].as_str(), Some("company:aurora"));
        assert_eq!(result["memoryAssemblyLimit"].as_u64(), Some(14));
        assert_eq!(result["memoryAssemblySemantic"].as_bool(), Some(true));
        assert!(result["text"]
            .as_str()
            .is_some_and(|value| value.contains("Draft Aurora follow-up")));
    }

    #[test]
    fn rejects_unsupported_action_types() {
        assert_eq!(
            normalize_action_type(Some("follow_up_email_draft")).as_deref(),
            Ok("follow_up_email_draft")
        );
        assert_eq!(
            normalize_action_type(Some("queue_crm_update")).as_deref(),
            Ok("update_crm")
        );
        let err = normalize_action_type(Some("send_email_now")).unwrap_err();
        assert!(err.contains("Unsupported action type: send_email_now"));
        assert!(err.contains("follow_up_email_draft"));
    }
}

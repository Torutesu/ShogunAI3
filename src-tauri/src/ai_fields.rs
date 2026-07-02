use crate::memory_store;
use rusqlite::{params, Connection};
use serde_json::{json, Map, Value};

pub(crate) fn ensure_ai_fields_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ai_fields (
          id TEXT PRIMARY KEY,
          owner_entity_id TEXT NOT NULL,
          field_name TEXT NOT NULL,
          instruction TEXT NOT NULL,
          current_value TEXT NOT NULL DEFAULT '',
          confidence REAL,
          evidence_event_ids_json TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          last_updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ai_fields_owner_entity_id
          ON ai_fields(owner_entity_id);
        CREATE INDEX IF NOT EXISTS idx_ai_fields_last_updated_at
          ON ai_fields(last_updated_at DESC);",
    )
    .map_err(|e| e.to_string())
}

fn normalize_confidence(value: Option<f64>) -> Option<f64> {
    value.filter(|v| v.is_finite()).map(|v| v.clamp(0.0, 1.0))
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

fn row_to_ai_field(
    id: String,
    owner_entity_id: String,
    field_name: String,
    instruction: String,
    current_value: String,
    confidence: Option<f64>,
    evidence_event_ids_json: String,
    created_at: i64,
    last_updated_at: i64,
) -> Value {
    let evidence_event_ids: Vec<String> =
        serde_json::from_str(&evidence_event_ids_json).unwrap_or_default();
    let mut map = Map::new();
    map.insert("id".to_string(), json!(id));
    map.insert("ownerEntityId".to_string(), json!(owner_entity_id));
    map.insert("fieldName".to_string(), json!(field_name));
    map.insert("instruction".to_string(), json!(instruction));
    map.insert("currentValue".to_string(), json!(current_value));
    map.insert(
        "confidence".to_string(),
        confidence.map_or(Value::Null, Value::from),
    );
    map.insert("evidenceEventIds".to_string(), json!(evidence_event_ids));
    map.insert("createdAt".to_string(), json!(created_at));
    map.insert("lastUpdatedAt".to_string(), json!(last_updated_at));
    Value::Object(map)
}

pub(crate) fn list_ai_fields(payload: &Value) -> Result<Value, String> {
    let conn = memory_store::open_conn()?;
    list_ai_fields_with_conn(&conn, payload)
}

fn list_ai_fields_with_conn(conn: &Connection, payload: &Value) -> Result<Value, String> {
    let id = payload
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

    let mut items = Vec::new();
    if let Some(id) = id {
        let mut stmt = conn
            .prepare(
                "SELECT id, owner_entity_id, field_name, instruction, current_value, confidence,
                        evidence_event_ids_json, created_at, last_updated_at
                 FROM ai_fields
                 WHERE id = ?1
                 LIMIT ?2",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![id, limit], |row| {
                Ok(row_to_ai_field(
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
        items.extend(rows.filter_map(Result::ok));
    } else if let Some(owner) = owner_entity_id {
        let like = format!("%{}%", query);
        if query.is_empty() {
            let mut stmt = conn
                .prepare(
                    "SELECT id, owner_entity_id, field_name, instruction, current_value, confidence,
                            evidence_event_ids_json, created_at, last_updated_at
                     FROM ai_fields
                     WHERE owner_entity_id = ?1
                     ORDER BY last_updated_at DESC
                     LIMIT ?2",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![owner, limit], |row| {
                    Ok(row_to_ai_field(
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
            items.extend(rows.filter_map(Result::ok));
        } else {
            let mut stmt = conn
                .prepare(
                    "SELECT id, owner_entity_id, field_name, instruction, current_value, confidence,
                            evidence_event_ids_json, created_at, last_updated_at
                     FROM ai_fields
                     WHERE owner_entity_id = ?1
                       AND (field_name LIKE ?2 OR instruction LIKE ?2 OR current_value LIKE ?2)
                     ORDER BY last_updated_at DESC
                     LIMIT ?3",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![owner, like, limit], |row| {
                    Ok(row_to_ai_field(
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
            items.extend(rows.filter_map(Result::ok));
        }
    } else if query.is_empty() {
        let mut stmt = conn
            .prepare(
                "SELECT id, owner_entity_id, field_name, instruction, current_value, confidence,
                        evidence_event_ids_json, created_at, last_updated_at
                 FROM ai_fields
                 ORDER BY last_updated_at DESC
                 LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![limit], |row| {
                Ok(row_to_ai_field(
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
        items.extend(rows.filter_map(Result::ok));
    } else {
        let like = format!("%{}%", query);
        let mut stmt = conn
            .prepare(
                "SELECT id, owner_entity_id, field_name, instruction, current_value, confidence,
                        evidence_event_ids_json, created_at, last_updated_at
                 FROM ai_fields
                 WHERE field_name LIKE ?1 OR instruction LIKE ?1 OR current_value LIKE ?1
                 ORDER BY last_updated_at DESC
                 LIMIT ?2",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![like, limit], |row| {
                Ok(row_to_ai_field(
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
        items.extend(rows.filter_map(Result::ok));
    }

    Ok(json!({ "items": items, "total": items.len() }))
}

pub(crate) fn upsert_ai_field(payload: &Value) -> Result<Value, String> {
    let conn = memory_store::open_conn()?;
    let result = upsert_ai_field_with_conn(&conn, payload)?;
    crate::app_events::emit_action_layer_refresh("ai-field-upserted", Some(result.clone()));
    Ok(result)
}

fn upsert_ai_field_with_conn(conn: &Connection, payload: &Value) -> Result<Value, String> {
    let owner_entity_id = payload
        .get("ownerEntityId")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "ownerEntityId is required".to_string())?;
    let field_name = payload
        .get("fieldName")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "fieldName is required".to_string())?;
    let instruction = payload
        .get("instruction")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "instruction is required".to_string())?;
    let id = payload
        .get("id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(String::from)
        .unwrap_or_else(|| format!("af_{}", memory_store::now_ms()));
    let current_value = payload
        .get("currentValue")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let confidence = normalize_confidence(payload.get("confidence").and_then(|v| v.as_f64()));
    let evidence_event_ids = normalize_evidence_ids(payload.get("evidenceEventIds"));
    let evidence_event_ids_json =
        serde_json::to_string(&evidence_event_ids).map_err(|e| e.to_string())?;
    let now = memory_store::now_ms() as i64;
    let created_at = conn
        .query_row(
            "SELECT created_at FROM ai_fields WHERE id = ?1",
            params![id.clone()],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(now);

    conn.execute(
        "INSERT INTO ai_fields
          (id, owner_entity_id, field_name, instruction, current_value, confidence, evidence_event_ids_json, created_at, last_updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
           owner_entity_id = excluded.owner_entity_id,
           field_name = excluded.field_name,
           instruction = excluded.instruction,
           current_value = excluded.current_value,
           confidence = excluded.confidence,
           evidence_event_ids_json = excluded.evidence_event_ids_json,
           last_updated_at = excluded.last_updated_at",
        params![
            id.clone(),
            owner_entity_id,
            field_name,
            instruction,
            current_value,
            confidence,
            evidence_event_ids_json,
            created_at,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;

    let item = conn
        .query_row(
            "SELECT id, owner_entity_id, field_name, instruction, current_value, confidence,
                    evidence_event_ids_json, created_at, last_updated_at
             FROM ai_fields WHERE id = ?1",
            params![id],
            |row| {
                Ok(row_to_ai_field(
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
            },
        )
        .map_err(|e| e.to_string())?;

    Ok(json!({ "item": item }))
}

#[cfg(test)]
mod tests {
    use super::{ensure_ai_fields_schema, list_ai_fields_with_conn, upsert_ai_field_with_conn};
    use rusqlite::Connection;
    use serde_json::json;

    #[test]
    fn upsert_and_list_ai_fields_round_trip() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        ensure_ai_fields_schema(&conn).expect("schema");
        let saved = upsert_ai_field_with_conn(
            &conn,
            &json!({
              "ownerEntityId": "deal:acme",
              "fieldName": "next_action",
              "instruction": "Track the next action for the deal.",
              "currentValue": "Send security memo",
              "confidence": 0.82,
              "evidenceEventIds": ["m_1", "m_2"]
            }),
        )
        .expect("upsert");
        assert_eq!(saved["item"]["ownerEntityId"].as_str(), Some("deal:acme"));
        assert_eq!(saved["item"]["fieldName"].as_str(), Some("next_action"));

        let list = list_ai_fields_with_conn(&conn, &json!({ "limit": 5 })).expect("list");
        assert_eq!(list["total"].as_u64(), Some(1));
        assert_eq!(
            list["items"][0]["currentValue"].as_str(),
            Some("Send security memo")
        );
    }

    #[test]
    fn upsert_clamps_confidence() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        ensure_ai_fields_schema(&conn).expect("schema");
        let saved = upsert_ai_field_with_conn(
            &conn,
            &json!({
              "ownerEntityId": "company:acme",
              "fieldName": "blocker",
              "instruction": "Track blockers.",
              "confidence": 9.0
            }),
        )
        .expect("upsert");
        assert_eq!(saved["item"]["confidence"].as_f64(), Some(1.0));
    }

    #[test]
    fn list_filters_by_id() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        ensure_ai_fields_schema(&conn).expect("schema");
        let first = upsert_ai_field_with_conn(
            &conn,
            &json!({
              "ownerEntityId": "deal:acme",
              "fieldName": "next_action",
              "instruction": "Track the next action for the deal."
            }),
        )
        .expect("upsert first");
        let second = upsert_ai_field_with_conn(
            &conn,
            &json!({
              "ownerEntityId": "company:beta",
              "fieldName": "blocker",
              "instruction": "Track blockers."
            }),
        )
        .expect("upsert second");

        let list = list_ai_fields_with_conn(
            &conn,
            &json!({ "id": first["item"]["id"].as_str().expect("first id"), "limit": 5 }),
        )
        .expect("list");
        assert_eq!(list["total"].as_u64(), Some(1));
        assert_eq!(
            list["items"][0]["id"].as_str(),
            first["item"]["id"].as_str()
        );
        assert_ne!(
            list["items"][0]["id"].as_str(),
            second["item"]["id"].as_str()
        );
    }
}

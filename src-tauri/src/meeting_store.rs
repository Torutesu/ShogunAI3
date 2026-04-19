//! Meetings / transcripts / note blocks / templates — same SQLite DB as KIOKU (`memory.db`).
//! Embeddings use **BLOB** (little-endian `f32` slices), consistent with `mem_items`.

use crate::memory_store;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use uuid::Uuid;

pub(crate) fn ensure_meeting_schema(conn: &Connection) -> Result<(), String> {
  conn
    .execute_batch(
      r#"
      CREATE TABLE IF NOT EXISTS meeting_templates (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        sections_json TEXT NOT NULL,
        enhance_instruction TEXT NOT NULL,
        is_builtin INTEGER NOT NULL DEFAULT 0,
        created_by TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        app_bundle_id TEXT,
        template_id TEXT REFERENCES meeting_templates(id),
        title TEXT,
        participants_json TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL DEFAULT 'recording',
        embedding BLOB
      );

      CREATE TABLE IF NOT EXISTS meeting_transcript_segments (
        id TEXT PRIMARY KEY NOT NULL,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        speaker TEXT NOT NULL,
        text TEXT NOT NULL,
        confidence REAL,
        is_final INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS meeting_note_blocks (
        id TEXT PRIMARY KEY NOT NULL,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        ord INTEGER NOT NULL,
        content TEXT NOT NULL,
        origin TEXT NOT NULL,
        source_segment_ids_json TEXT NOT NULL DEFAULT '[]',
        embedding BLOB
      );

      CREATE INDEX IF NOT EXISTS idx_mts_meeting ON meeting_transcript_segments(meeting_id);
      CREATE INDEX IF NOT EXISTS idx_mnb_meeting ON meeting_note_blocks(meeting_id);
    "#,
    )
    .map_err(|e| e.to_string())?;

  seed_builtin_templates(conn)?;
  Ok(())
}

fn seed_builtin_templates(conn: &Connection) -> Result<(), String> {
  let builtins: &[(&str, &str, &str, &str)] = &[
    (
      "tmpl-1on1",
      "1-on-1",
      "Manager sync",
      r#"[{"title":"Check-in","guidance":"mood, workload"},{"title":"Priorities","guidance":"this week"},{"title":"Blockers","guidance":"needs help"}]"#,
    ),
    (
      "tmpl-standup",
      "Standup",
      "Daily standup",
      r#"[{"title":"Yesterday","guidance":"done"},{"title":"Today","guidance":"plan"},{"title":"Blockers","guidance":""}]"#,
    ),
    (
      "tmpl-weekly",
      "Weekly Team Meeting",
      "Weekly sync",
      r#"[{"title":"Highlights","guidance":""},{"title":"Risks","guidance":""},{"title":"Decisions","guidance":""}]"#,
    ),
    (
      "tmpl-interview",
      "Customer Interview",
      "Discovery",
      r#"[{"title":"Context","guidance":"company role"},{"title":"Pain","guidance":"quotes"},{"title":"Next steps","guidance":""}]"#,
    ),
    (
      "tmpl-sales",
      "Sales Call",
      "Pipeline",
      r#"[{"title":"Discovery","guidance":""},{"title":"Objections","guidance":""},{"title":"Close","guidance":""}]"#,
    ),
    (
      "tmpl-design",
      "Design Review",
      "Critique",
      r#"[{"title":"Goals","guidance":""},{"title":"Feedback","guidance":""},{"title":"Actions","guidance":""}]"#,
    ),
  ];

  let now = memory_store::now_ms() as i64;
  for (id, name, desc, sections) in builtins {
    conn
      .execute(
        r#"INSERT OR IGNORE INTO meeting_templates
          (id, name, description, sections_json, enhance_instruction, is_builtin, created_by, created_at)
          VALUES (?1, ?2, ?3, ?4, ?5, 1, NULL, ?6)"#,
        params![
          id,
          name,
          desc,
          sections,
          "You are assisting with meeting notes. Respect user-written blocks; add only AI blocks with transcript citations. Do not invent facts.",
          now
        ],
      )
      .map_err(|e| e.to_string())?;
  }
  Ok(())
}

fn parse_segment_ids_json(s: &str) -> Value {
  serde_json::from_str(s).unwrap_or_else(|_| json!([]))
}

pub fn meeting_insert(
  id: &str,
  started_at_ms: u64,
  template_id: Option<&str>,
  app_bundle_id: Option<&str>,
  title: Option<&str>,
) -> Result<(), String> {
  let conn = memory_store::open_conn()?;
  conn
    .execute(
      r#"INSERT INTO meetings (id, started_at, ended_at, app_bundle_id, template_id, title, participants_json, state, embedding)
         VALUES (?1, ?2, NULL, ?3, ?4, ?5, '[]', 'recording', NULL)"#,
      params![
        id,
        started_at_ms as i64,
        app_bundle_id,
        template_id,
        title.unwrap_or("Untitled meeting"),
      ],
    )
    .map_err(|e| e.to_string())?;
  Ok(())
}

pub fn meeting_stop(meeting_id: &str, ended_at_ms: u64) -> Result<(), String> {
  let conn = memory_store::open_conn()?;
  conn
    .execute(
      "UPDATE meetings SET ended_at = ?1, state = 'done' WHERE id = ?2",
      params![ended_at_ms as i64, meeting_id],
    )
    .map_err(|e| e.to_string())?;
  Ok(())
}

pub fn meeting_set_state(meeting_id: &str, state: &str) -> Result<(), String> {
  let conn = memory_store::open_conn()?;
  conn
    .execute(
      "UPDATE meetings SET state = ?1 WHERE id = ?2",
      params![state, meeting_id],
    )
    .map_err(|e| e.to_string())?;
  Ok(())
}

pub fn insert_transcript_segment(
  meeting_id: &str,
  seg_id: &str,
  start_ms: u64,
  end_ms: u64,
  speaker: &str,
  text: &str,
  confidence: Option<f32>,
  is_final: bool,
) -> Result<(), String> {
  let conn = memory_store::open_conn()?;
  conn
    .execute(
      r#"INSERT INTO meeting_transcript_segments
        (id, meeting_id, start_ms, end_ms, speaker, text, confidence, is_final)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"#,
      params![
        seg_id,
        meeting_id,
        start_ms as i64,
        end_ms as i64,
        speaker,
        text,
        confidence,
        if is_final { 1 } else { 0 },
      ],
    )
    .map_err(|e| e.to_string())?;
  Ok(())
}

#[allow(dead_code)]
pub fn delete_transcript_for_meeting(meeting_id: &str) -> Result<(), String> {
  let conn = memory_store::open_conn()?;
  conn
    .execute(
      "DELETE FROM meeting_transcript_segments WHERE meeting_id = ?1",
      params![meeting_id],
    )
    .map_err(|e| e.to_string())?;
  Ok(())
}

pub fn list_transcript_final(meeting_id: &str) -> Result<Vec<Value>, String> {
  let conn = memory_store::open_conn()?;
  let mut stmt = conn
    .prepare(
      r#"SELECT id, meeting_id, start_ms, end_ms, speaker, text, confidence, is_final
         FROM meeting_transcript_segments WHERE meeting_id = ?1 AND is_final = 1
         ORDER BY start_ms ASC"#,
    )
    .map_err(|e| e.to_string())?;
  let rows = stmt
    .query_map(params![meeting_id], |r| {
      Ok(json!({
        "segment_id": r.get::<_, String>(0)?,
        "meeting_id": r.get::<_, String>(1)?,
        "start_ms": r.get::<_, i64>(2)? as u64,
        "end_ms": r.get::<_, i64>(3)? as u64,
        "speaker": r.get::<_, String>(4)?,
        "text": r.get::<_, String>(5)?,
        "confidence": r.get::<_, Option<f32>>(6)?,
        "is_final": r.get::<_, i64>(7)? == 1,
      }))
    })
    .map_err(|e| e.to_string())?;
  let mut out = Vec::new();
  for row in rows {
    out.push(row.map_err(|e| e.to_string())?);
  }
  Ok(out)
}

pub fn list_note_blocks(meeting_id: &str) -> Result<Vec<Value>, String> {
  let conn = memory_store::open_conn()?;
  let mut stmt = conn
    .prepare(
      r#"SELECT id, meeting_id, ord, content, origin, source_segment_ids_json
         FROM meeting_note_blocks WHERE meeting_id = ?1 ORDER BY ord ASC, id ASC"#,
    )
    .map_err(|e| e.to_string())?;
  let rows = stmt
    .query_map(params![meeting_id], |r| {
      let seg_json: String = r.get(5)?;
      Ok(json!({
        "id": r.get::<_, String>(0)?,
        "meeting_id": r.get::<_, String>(1)?,
        "order": r.get::<_, i64>(2)? as u32,
        "content": r.get::<_, String>(3)?,
        "origin": r.get::<_, String>(4)?,
        "source_segments": parse_segment_ids_json(&seg_json),
      }))
    })
    .map_err(|e| e.to_string())?;
  let mut out = Vec::new();
  for row in rows {
    out.push(row.map_err(|e| e.to_string())?);
  }
  Ok(out)
}

pub fn insert_note_block(
  meeting_id: &str,
  block_id: &str,
  ord: i64,
  content: &str,
  origin: &str,
  source_segment_ids: &[String],
) -> Result<(), String> {
  let conn = memory_store::open_conn()?;
  let seg_json = serde_json::to_string(source_segment_ids).map_err(|e| e.to_string())?;
  conn
    .execute(
      r#"INSERT INTO meeting_note_blocks
        (id, meeting_id, ord, content, origin, source_segment_ids_json, embedding)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)"#,
      params![block_id, meeting_id, ord, content, origin, seg_json],
    )
    .map_err(|e| e.to_string())?;
  Ok(())
}

pub fn update_note_block(block_id: &str, content: &str, origin: &str, source_segment_ids: &[String]) -> Result<(), String> {
  let conn = memory_store::open_conn()?;
  let seg_json = serde_json::to_string(source_segment_ids).map_err(|e| e.to_string())?;
  conn
    .execute(
      "UPDATE meeting_note_blocks SET content = ?1, origin = ?2, source_segment_ids_json = ?3 WHERE id = ?4",
      params![content, origin, seg_json, block_id],
    )
    .map_err(|e| e.to_string())?;
  Ok(())
}

pub fn delete_note_block(block_id: &str) -> Result<(), String> {
  let conn = memory_store::open_conn()?;
  conn
    .execute("DELETE FROM meeting_note_blocks WHERE id = ?1", params![block_id])
    .map_err(|e| e.to_string())?;
  Ok(())
}

pub fn get_note_block(block_id: &str) -> Result<Option<Value>, String> {
  let conn = memory_store::open_conn()?;
  let row = conn
    .query_row(
      r#"SELECT id, meeting_id, ord, content, origin, source_segment_ids_json
         FROM meeting_note_blocks WHERE id = ?1"#,
      params![block_id],
      |r| {
        let seg_json: String = r.get(5)?;
        Ok(json!({
          "id": r.get::<_, String>(0)?,
          "meeting_id": r.get::<_, String>(1)?,
          "order": r.get::<_, i64>(2)? as u32,
          "content": r.get::<_, String>(3)?,
          "origin": r.get::<_, String>(4)?,
          "source_segments": parse_segment_ids_json(&seg_json),
        }))
      },
    )
    .optional()
    .map_err(|e| e.to_string())?;
  Ok(row)
}

pub fn next_block_order(meeting_id: &str) -> Result<i64, String> {
  let conn = memory_store::open_conn()?;
  let n: i64 = conn
    .query_row(
      "SELECT COALESCE(MAX(ord), -1) + 1 FROM meeting_note_blocks WHERE meeting_id = ?1",
      params![meeting_id],
      |r| r.get(0),
    )
    .map_err(|e| e.to_string())?;
  Ok(n)
}

#[allow(dead_code)]
pub fn reorder_note_block_orders(meeting_id: &str, orders: &[(String, i64)]) -> Result<(), String> {
  let conn = memory_store::open_conn()?;
  let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
  for (id, ord) in orders {
    tx.execute(
      "UPDATE meeting_note_blocks SET ord = ?1 WHERE id = ?2 AND meeting_id = ?3",
      params![ord, id, meeting_id],
    )
    .map_err(|e| e.to_string())?;
  }
  tx.commit().map_err(|e| e.to_string())?;
  Ok(())
}

pub fn purge_meeting(meeting_id: &str) -> Result<(), String> {
  let conn = memory_store::open_conn()?;
  conn
    .execute("DELETE FROM meetings WHERE id = ?1", params![meeting_id])
    .map_err(|e| e.to_string())?;
  Ok(())
}

fn row_meeting_list(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
  let participants_raw: String = r.get(6)?;
  let participants: Value = serde_json::from_str(&participants_raw).unwrap_or(json!([]));
  Ok(json!({
    "id": r.get::<_, String>(0)?,
    "started_at": r.get::<_, i64>(1)? as u64,
    "ended_at": r.get::<_, Option<i64>>(2)?.map(|x| x as u64),
    "app_bundle_id": r.get::<_, Option<String>>(3)?,
    "template_id": r.get::<_, Option<String>>(4)?,
    "title": r.get::<_, Option<String>>(5)?,
    "participants": participants,
    "state": r.get::<_, String>(7)?,
  }))
}

pub fn list_meetings(from_ms: Option<u64>, to_ms: Option<u64>, limit: usize) -> Result<Vec<Value>, String> {
  let conn = memory_store::open_conn()?;
  let lim = limit.clamp(1, 200) as i64;
  let mut out = Vec::new();
  match (from_ms, to_ms) {
    (Some(f), Some(t)) => {
      let mut stmt = conn
        .prepare(
          r#"SELECT id, started_at, ended_at, app_bundle_id, template_id, title, participants_json, state
             FROM meetings WHERE started_at >= ?1 AND started_at <= ?2
             ORDER BY started_at DESC LIMIT ?3"#,
        )
        .map_err(|e| e.to_string())?;
      for row in stmt
        .query_map(params![f as i64, t as i64, lim], row_meeting_list)
        .map_err(|e| e.to_string())?
      {
        out.push(row.map_err(|e| e.to_string())?);
      }
    }
    (Some(f), None) => {
      let mut stmt = conn
        .prepare(
          r#"SELECT id, started_at, ended_at, app_bundle_id, template_id, title, participants_json, state
             FROM meetings WHERE started_at >= ?1
             ORDER BY started_at DESC LIMIT ?2"#,
        )
        .map_err(|e| e.to_string())?;
      for row in stmt
        .query_map(params![f as i64, lim], row_meeting_list)
        .map_err(|e| e.to_string())?
      {
        out.push(row.map_err(|e| e.to_string())?);
      }
    }
    (None, Some(t)) => {
      let mut stmt = conn
        .prepare(
          r#"SELECT id, started_at, ended_at, app_bundle_id, template_id, title, participants_json, state
             FROM meetings WHERE started_at <= ?1
             ORDER BY started_at DESC LIMIT ?2"#,
        )
        .map_err(|e| e.to_string())?;
      for row in stmt
        .query_map(params![t as i64, lim], row_meeting_list)
        .map_err(|e| e.to_string())?
      {
        out.push(row.map_err(|e| e.to_string())?);
      }
    }
    (None, None) => {
      let mut stmt = conn
        .prepare(
          r#"SELECT id, started_at, ended_at, app_bundle_id, template_id, title, participants_json, state
             FROM meetings ORDER BY started_at DESC LIMIT ?1"#,
        )
        .map_err(|e| e.to_string())?;
      for row in stmt
        .query_map(params![lim], row_meeting_list)
        .map_err(|e| e.to_string())?
      {
        out.push(row.map_err(|e| e.to_string())?);
      }
    }
  }
  Ok(out)
}

pub fn get_meeting_detail(meeting_id: &str) -> Result<Option<Value>, String> {
  let conn = memory_store::open_conn()?;
  let row = conn
    .query_row(
      r#"SELECT id, started_at, ended_at, app_bundle_id, template_id, title, participants_json, state
         FROM meetings WHERE id = ?1"#,
      params![meeting_id],
      |r| {
        let participants_raw: String = r.get(6)?;
        let participants: Value = serde_json::from_str(&participants_raw).unwrap_or(json!([]));
        Ok(json!({
          "id": r.get::<_, String>(0)?,
          "started_at": r.get::<_, i64>(1)? as u64,
          "ended_at": r.get::<_, Option<i64>>(2)?.map(|x| x as u64),
          "app_bundle_id": r.get::<_, Option<String>>(3)?,
          "template_id": r.get::<_, Option<String>>(4)?,
          "title": r.get::<_, Option<String>>(5)?,
          "participants": participants,
          "state": r.get::<_, String>(7)?,
        }))
      },
    )
    .optional()
    .map_err(|e| e.to_string())?;
  Ok(row)
}

/// Memory-search compatible rows (`source: meeting`) for unified `shogun_memory_search`.
pub fn search_meeting_memory_hits(query: &str, limit: usize) -> Result<Vec<Value>, String> {
  let raw = search_meetings_fts(query, limit)?;
  let mut out = Vec::new();
  for r in raw {
    let id = r
      .get("meeting_id")
      .and_then(|x| x.as_str())
      .unwrap_or("")
      .to_string();
    let title = r
      .get("title")
      .and_then(|x| x.as_str())
      .unwrap_or("Meeting")
      .to_string();
    let started = r.get("started_at").and_then(|x| x.as_u64()).unwrap_or(0);
    out.push(json!({
      "id": format!("meet_{}", id),
      "title": title,
      "snippet": format!("Meeting match · {}", query.chars().take(80).collect::<String>()),
      "source": "meeting",
      "kinds": ["meeting"],
      "created_at": started,
    }));
  }
  Ok(out)
}

pub fn search_meetings_fts(query: &str, limit: usize) -> Result<Vec<Value>, String> {
  let q = query.trim();
  if q.is_empty() {
    return Ok(Vec::new());
  }
  let conn = memory_store::open_conn()?;
  let lim = limit.clamp(1, 100) as i64;
  let needle = format!("%{}%", q);
  let mut stmt = conn
    .prepare(
      r#"SELECT DISTINCT m.id, m.started_at, m.title
         FROM meetings m
         LEFT JOIN meeting_transcript_segments s ON s.meeting_id = m.id
         LEFT JOIN meeting_note_blocks b ON b.meeting_id = m.id
         WHERE m.title LIKE ?1
            OR s.text LIKE ?1
            OR b.content LIKE ?1
         ORDER BY m.started_at DESC
         LIMIT ?2"#,
    )
    .map_err(|e| e.to_string())?;
  let rows = stmt
    .query_map(params![needle, lim], |r| {
      Ok(json!({
        "meeting_id": r.get::<_, String>(0)?,
        "started_at": r.get::<_, i64>(1)? as u64,
        "title": r.get::<_, Option<String>>(2)?,
        "snippet": "",
      }))
    })
    .map_err(|e| e.to_string())?;
  let mut out = Vec::new();
  for row in rows {
    out.push(row.map_err(|e| e.to_string())?);
  }
  Ok(out)
}

pub fn segments_for_block(block_id: &str) -> Result<Vec<Value>, String> {
  let block = get_note_block(block_id)?.ok_or_else(|| "block not found".to_string())?;
  let meeting_id = block
    .get("meeting_id")
    .and_then(|x| x.as_str())
    .ok_or_else(|| "meeting_id missing".to_string())?;
  let ids: Vec<String> = block
    .get("source_segments")
    .and_then(|x| x.as_array())
    .map(|a| {
      a.iter()
        .filter_map(|v| v.as_str().map(String::from))
        .collect()
    })
    .unwrap_or_default();
  if ids.is_empty() {
    return Ok(Vec::new());
  }
  let conn = memory_store::open_conn()?;
  let mut out = Vec::new();
  for sid in ids {
    let row = conn
      .query_row(
        r#"SELECT id, meeting_id, start_ms, end_ms, speaker, text, confidence, is_final
           FROM meeting_transcript_segments WHERE id = ?1 AND meeting_id = ?2"#,
        params![sid, meeting_id],
        |r| {
          Ok(json!({
            "segment_id": r.get::<_, String>(0)?,
            "meeting_id": r.get::<_, String>(1)?,
            "start_ms": r.get::<_, i64>(2)? as u64,
            "end_ms": r.get::<_, i64>(3)? as u64,
            "speaker": r.get::<_, String>(4)?,
            "text": r.get::<_, String>(5)?,
            "confidence": r.get::<_, Option<f32>>(6)?,
            "is_final": r.get::<_, i64>(7)? == 1,
          }))
        },
      )
      .optional()
      .map_err(|e| e.to_string())?;
    if let Some(v) = row {
      out.push(v);
    }
  }
  Ok(out)
}

pub fn list_templates() -> Result<Vec<Value>, String> {
  let conn = memory_store::open_conn()?;
  let mut stmt = conn
    .prepare(
      "SELECT id, name, description, sections_json, enhance_instruction, is_builtin FROM meeting_templates ORDER BY is_builtin DESC, name ASC",
    )
    .map_err(|e| e.to_string())?;
  let rows = stmt
    .query_map([], |r| {
      let sections: Value =
        serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or(json!([]));
      Ok(json!({
        "id": r.get::<_, String>(0)?,
        "name": r.get::<_, String>(1)?,
        "description": r.get::<_, String>(2)?,
        "sections": sections,
        "enhance_instruction": r.get::<_, String>(4)?,
        "is_builtin": r.get::<_, i64>(5)? == 1,
      }))
    })
    .map_err(|e| e.to_string())?;
  let mut out = Vec::new();
  for row in rows {
    out.push(row.map_err(|e| e.to_string())?);
  }
  Ok(out)
}

pub fn new_uuid() -> String {
  Uuid::new_v4().to_string()
}

/// Insert one user note block per template section (Markdown heading + empty body).
pub fn seed_note_from_template(meeting_id: &str, template_id: &str) -> Result<(), String> {
  let conn = memory_store::open_conn()?;
  let sections_json: String = conn
    .query_row(
      "SELECT sections_json FROM meeting_templates WHERE id = ?1",
      params![template_id],
      |r| r.get(0),
    )
    .map_err(|_| "template not found".to_string())?;
  let sections: Vec<Value> = serde_json::from_str(&sections_json).unwrap_or_default();
  let mut ord: i64 = 0;
  for sec in sections {
    let title = sec
      .get("title")
      .and_then(|x| x.as_str())
      .unwrap_or("Section");
    let guidance = sec.get("guidance").and_then(|x| x.as_str()).unwrap_or("");
    let body = if guidance.is_empty() {
      format!("## {}\n\n", title)
    } else {
      format!("## {}\n\n_{}_\n\n", title, guidance)
    };
    let bid = new_uuid();
    insert_note_block(meeting_id, &bid, ord, &body, "user", &[])?;
    ord += 1;
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn new_uuid_is_non_empty() {
    let u = new_uuid();
    assert_eq!(u.len(), 36);
  }
}

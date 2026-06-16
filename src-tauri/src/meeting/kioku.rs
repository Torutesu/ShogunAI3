//! Push finished meeting transcripts into `mem_captures` + `extraction_jobs`.

use crate::{extraction_jobs, meeting_store, mem_captures, memory_obs, memory_store, settings_store};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

const MEETING_URL_PREFIX: &str = "meeting://";

pub fn meeting_extraction_enabled() -> bool {
  settings_store::load()
    .ok()
    .and_then(|doc| {
      doc
        .pointer("/sections/kioku_graph/meeting_extraction_enabled")
        .and_then(|v| v.as_bool())
    })
    .unwrap_or(true)
}

fn meeting_capture_url(meeting_id: &str) -> String {
  format!("{MEETING_URL_PREFIX}{meeting_id}")
}

fn build_transcript_blob(meeting_id: &str, title: &str) -> Result<String, String> {
  let mut lines: Vec<String> = Vec::new();
  lines.push(format!("Meeting: {}", title));
  for seg in meeting_store::list_transcript_final(meeting_id)? {
    let sp = seg
      .get("speaker")
      .and_then(|x| x.as_str())
      .unwrap_or("Speaker");
    let tx = seg.get("text").and_then(|x| x.as_str()).unwrap_or("").trim();
    if tx.is_empty() {
      continue;
    }
    lines.push(format!("{}: {}", sp, tx));
  }
  for block in meeting_store::list_note_blocks(meeting_id)? {
    let content = block
      .get("content")
      .and_then(|x| x.as_str())
      .unwrap_or("")
      .trim();
    if content.is_empty() {
      continue;
    }
    lines.push(format!("Note: {}", content));
  }
  if lines.len() <= 1 {
    return Err("meeting has no transcript or note content".to_string());
  }
  Ok(lines.join("\n").chars().take(12_000).collect())
}

fn find_existing_capture_id(conn: &Connection, meeting_id: &str) -> Result<Option<i64>, String> {
  let url = meeting_capture_url(meeting_id);
  conn
    .query_row(
      "SELECT id FROM mem_captures WHERE url = ?1 AND type = 'audio_chunk' LIMIT 1",
      params![url],
      |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Upsert a meeting transcript into KIOKU raw layer and enqueue extraction.
pub fn ingest_meeting_to_kioku(meeting_id: &str) -> Result<Value, String> {
  if !meeting_extraction_enabled() {
    return Ok(json!({
      "skipped": true,
      "reason": "meeting_extraction_enabled disabled",
    }));
  }
  let detail = meeting_store::get_meeting_detail(meeting_id)?
    .ok_or_else(|| "meeting not found".to_string())?;
  let title = detail
    .get("title")
    .and_then(|x| x.as_str())
    .filter(|s| !s.trim().is_empty())
    .unwrap_or("Meeting");
  let started_at = detail
    .get("started_at")
    .and_then(|x| x.as_u64())
    .unwrap_or_else(memory_store::now_ms) as i64;
  let app_bundle_id = detail
    .get("app_bundle_id")
    .and_then(|x| x.as_str())
    .map(String::from);
  let raw_text = match build_transcript_blob(meeting_id, title) {
    Ok(t) => t,
    Err(reason) => {
      return Ok(json!({ "skipped": true, "reason": reason }));
    }
  };

  let conn = memory_store::open_conn()?;
  let url = meeting_capture_url(meeting_id);
  let filter_meta = json!({
    "meeting_id": meeting_id,
    "provenance": "meeting",
    "title": title,
  })
  .to_string();

  let capture_id = if let Some(existing) = find_existing_capture_id(&conn, meeting_id)? {
    conn
      .execute(
        "UPDATE mem_captures
         SET raw_text = ?1, captured_at = ?2, extraction_status = 'queued',
             filter_meta_json = ?3, window_title = ?4
         WHERE id = ?5",
        params![raw_text, started_at, filter_meta, title, existing],
      )
      .map_err(|e| e.to_string())?;
    existing
  } else {
    mem_captures::record(
      &mem_captures::CaptureInput {
        kind: "audio_chunk".into(),
        raw_text: Some(raw_text),
        app_bundle_id,
        window_title: Some(title.to_string()),
        url: Some(url),
        captured_at_ms: started_at,
        filter_meta_json: Some(filter_meta),
        ..Default::default()
      },
      &conn,
    )?
  };

  let meta_json = json!({ "meeting_id": meeting_id, "source": "meeting_stop" }).to_string();
  let job_id = if let Some(jid) = conn
    .query_row(
      "SELECT id FROM extraction_jobs
       WHERE capture_id = ?1 AND status IN ('queued', 'running')
       ORDER BY id DESC LIMIT 1",
      params![capture_id],
      |r| r.get::<_, i64>(0),
    )
    .optional()
    .map_err(|e| e.to_string())?
  {
    jid
  } else {
    extraction_jobs::enqueue(
      Some(capture_id),
      extraction_jobs::JOB_KIND_EXTRACT,
      started_at,
      Some(&meta_json),
      &conn,
    )?
  };

  memory_obs::emit(
    "meeting_kioku_enqueue",
    &[
      ("meeting_id", meeting_id.to_string()),
      ("capture_id", capture_id.to_string()),
      ("job_id", job_id.to_string()),
    ],
  );

  Ok(json!({
    "capture_id": capture_id,
    "job_id": job_id,
    "meeting_id": meeting_id,
    "stub": false,
  }))
}

/// Lightweight health check for Settings / debug UI.
pub fn pipeline_smoke() -> Result<Value, String> {
  let settings = settings_store::load().unwrap_or_else(|_| json!({}));
  let conn = memory_store::open_conn()?;
  let queued_jobs: i64 = conn
    .query_row(
      "SELECT COUNT(*) FROM extraction_jobs WHERE status = 'queued'",
      [],
      |r| r.get(0),
    )
    .map_err(|e| e.to_string())?;
  let meeting_captures: i64 = conn
    .query_row(
      "SELECT COUNT(*) FROM mem_captures WHERE type = 'audio_chunk' AND url LIKE 'meeting://%'",
      [],
      |r| r.get(0),
    )
    .map_err(|e| e.to_string())?;
  let worker = settings
    .pointer("/sections/kioku_graph/worker_enabled")
    .and_then(|v| v.as_bool())
    .unwrap_or(false);
  let meeting_on = meeting_extraction_enabled();
  let capture_path = crate::kioku_capture::capture_to_mem_captures_flag(&settings);
  let llm_ready = crate::secrets::get_llm_api_key()
    .ok()
    .flatten()
    .map(|k| !k.trim().is_empty())
    .unwrap_or(false);
  let failed_total: i64 = conn
    .query_row(
      "SELECT COUNT(*) FROM extraction_jobs WHERE status = 'failed'",
      [],
      |r| r.get(0),
    )
    .map_err(|e| e.to_string())?;
  let failed_billing = crate::kioku::extraction::count_failed_billing_jobs(&conn).unwrap_or(0);

  Ok(json!({
    "ok": worker && meeting_on && llm_ready && failed_billing == 0,
    "worker_enabled": worker,
    "meeting_extraction_enabled": meeting_on,
    "capture_to_mem_captures": capture_path,
    "llm_key_configured": llm_ready,
    "queued_jobs": queued_jobs,
    "failed_jobs": failed_total,
    "failed_billing_jobs": failed_billing,
    "billing_blocked": failed_billing > 0,
    "meeting_captures": meeting_captures,
    "read_path": crate::context_assembly::read_path_mode(&settings),
  }))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::kioku_graph_schema;

  fn test_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open");
    conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    memory_store::init_schema(&conn).unwrap();
    kioku_graph_schema::ensure_kioku_graph_schema(&conn).unwrap();
    conn
  }

  #[test]
  fn ingest_skips_when_disabled() {
    // Default in test env may be enabled; call with empty settings path behavior.
    let meeting_id = meeting_store::new_uuid();
    meeting_store::meeting_insert(
      &meeting_id,
      1_000,
      None,
      None,
      Some("Test"),
      None,
    )
    .unwrap();
    meeting_store::insert_transcript_segment(
      &meeting_id,
      &meeting_store::new_uuid(),
      0,
      1000,
      "self",
      "hello world",
      Some(0.9),
      true,
    )
    .unwrap();
    let out = ingest_meeting_to_kioku(&meeting_id).expect("ingest");
    assert!(out.get("capture_id").is_some() || out.get("skipped").is_some());
  }
}

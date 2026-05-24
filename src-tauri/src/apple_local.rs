//! Read-only Apple Calendar / Reminders sync via macOS Calendar.app & Reminders.app (AppleScript).
//! Requires Automation permission for SHOGUN to control Calendar / Reminders.

use crate::memory_store;
use serde_json::{json, Value};
use std::process::Command;

const CALENDAR_PROVIDER: &str = "apple_calendar";
const REMINDERS_PROVIDER: &str = "apple_reminders";

fn run_osascript(script: &str) -> Result<String, String> {
  let out = Command::new("osascript")
    .arg("-e")
    .arg(script)
    .output()
    .map_err(|e| format!("osascript failed: {e}"))?;
  if !out.status.success() {
    let stderr = String::from_utf8_lossy(&out.stderr);
    let stdout = String::from_utf8_lossy(&out.stdout);
    let clip: String = format!("{stderr}{stdout}")
      .chars()
      .take(400)
      .collect();
    return Err(format!(
      "AppleScript error (grant Automation for Calendar/Reminders in System Settings): {clip}"
    ));
  }
  Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(target_os = "macos")]
pub fn probe_calendar() -> Result<(), String> {
  let _ = run_osascript(
    r#"tell application "Calendar" to get (count of calendars)"#,
  )?;
  Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn probe_calendar() -> Result<(), String> {
  Err("Apple Calendar sync is only available on macOS.".to_string())
}

#[cfg(target_os = "macos")]
pub fn probe_reminders() -> Result<(), String> {
  let _ = run_osascript(
    r#"tell application "Reminders" to get (count of lists)"#,
  )?;
  Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn probe_reminders() -> Result<(), String> {
  Err("Apple Reminders sync is only available on macOS.".to_string())
}

fn parse_pipe_rows(raw: &str) -> Vec<Vec<String>> {
  raw
    .lines()
    .filter_map(|line| {
      let t = line.trim();
      if t.is_empty() {
        return None;
      }
      Some(t.split("|||").map(|s| s.trim().to_string()).collect())
    })
    .collect()
}

fn ingest_row(
  provider: &str,
  title: &str,
  snippet: &str,
  entity_id: &str,
  kinds: &[&str],
) -> Result<bool, String> {
  let payload = json!({
    "title": title.chars().take(200).collect::<String>(),
    "snippet": snippet.chars().take(4000).collect::<String>(),
    "source": provider,
    "entity_id": entity_id,
    "provenance": "connector",
    "kinds": kinds,
  });
  match memory_store::ingest(&payload) {
    Ok(v) => Ok(v.get("skipped").and_then(|x| x.as_bool()).unwrap_or(false)),
    Err(e) => {
      let _ = crate::dead_letter::record(provider, &payload, &e);
      Err(e)
    }
  }
}

pub fn sync_calendar_to_memory(max_events: usize) -> Result<Value, String> {
  #[cfg(not(target_os = "macos"))]
  {
    return Err("Apple Calendar sync is only available on macOS.".to_string());
  }
  #[cfg(target_os = "macos")]
  {
    probe_calendar()?;
    let cap = max_events.clamp(1, 500);
    let script = format!(
      r#"tell application "Calendar"
  set pastDate to (current date) - (7 * days)
  set futureDate to (current date) + (30 * days)
  set outLines to {{}}
  repeat with cal in calendars
    set calName to name of cal
    try
      set evs to (every event of cal whose start date >= pastDate and start date <= futureDate)
      repeat with ev in evs
        set evTitle to summary of ev
        set evStart to start date of ev as string
        set evEnd to end date of ev as string
        set evUid to uid of ev
        set end of outLines to evTitle & "|||" & evStart & "|||" & evEnd & "|||" & calName & "|||" & evUid
        if (count of outLines) >= {cap} then exit repeat
      end repeat
    end try
    if (count of outLines) >= {cap} then exit repeat
  end repeat
  set AppleScript's text item delimiters to linefeed
  return outLines as string
end tell"#
    );
    let raw = run_osascript(&script)?;
    let mut ingested = 0u32;
    let mut skipped = 0u32;
    for parts in parse_pipe_rows(&raw).into_iter().take(cap) {
      if parts.len() < 5 {
        continue;
      }
      let title = parts[0].clone();
      if title.is_empty() {
        continue;
      }
      let snippet = format!(
        "Calendar: {}\nStart: {}\nEnd: {}",
        parts[3], parts[1], parts[2]
      );
      let entity = format!("applecal:{}", parts[4]);
      match ingest_row(CALENDAR_PROVIDER, &format!("Apple Calendar: {}", title), &snippet, &entity, &["calendar"]) {
        Ok(true) => skipped += 1,
        Ok(false) => ingested += 1,
        Err(e) => return Err(e),
      }
    }
    return Ok(json!({
      "ingested": ingested,
      "skipped": skipped,
      "provider": CALENDAR_PROVIDER,
      "stub": false,
    }));
  }
}

pub fn sync_reminders_to_memory(max_items: usize) -> Result<Value, String> {
  #[cfg(not(target_os = "macos"))]
  {
    return Err("Apple Reminders sync is only available on macOS.".to_string());
  }
  #[cfg(target_os = "macos")]
  {
    probe_reminders()?;
    let cap = max_items.clamp(1, 300);
    let script = format!(
      r#"tell application "Reminders"
  set outLines to {{}}
  repeat with lst in lists
    set listName to name of lst
    try
      set rs to (reminders of lst whose completed is false)
      repeat with r in rs
        set rName to name of r
        set rBody to body of r
        set rDue to ""
        try
          set rDue to due date of r as string
        end try
        set rId to id of r
        set end of outLines to rName & "|||" & rBody & "|||" & rDue & "|||" & listName & "|||" & rId
        if (count of outLines) >= {cap} then exit repeat
      end repeat
    end try
    if (count of outLines) >= {cap} then exit repeat
  end repeat
  set AppleScript's text item delimiters to linefeed
  return outLines as string
end tell"#
    );
    let raw = run_osascript(&script)?;
    let mut ingested = 0u32;
    let mut skipped = 0u32;
    for parts in parse_pipe_rows(&raw).into_iter().take(cap) {
      if parts.len() < 5 {
        continue;
      }
      let title = parts[0].clone();
      if title.is_empty() {
        continue;
      }
      let snippet = format!(
        "List: {}\nDue: {}\n\n{}",
        parts[3],
        parts[2],
        parts[1].chars().take(3000).collect::<String>()
      );
      let entity = format!("applerem:{}", parts[4]);
      match ingest_row(
        REMINDERS_PROVIDER,
        &format!("Reminders: {}", title),
        &snippet,
        &entity,
        &["task", "reminder"],
      ) {
        Ok(true) => skipped += 1,
        Ok(false) => ingested += 1,
        Err(e) => return Err(e),
      }
    }
    return Ok(json!({
      "ingested": ingested,
      "skipped": skipped,
      "provider": REMINDERS_PROVIDER,
      "stub": false,
    }));
  }
}

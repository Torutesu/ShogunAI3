//! Phase 1 summarizer: connector (mail/calendar) アイテムの要約を生成する。
//! 1. heuristic_priority_guess で明らかな low を LLM 前に検出 (pre-filter)
//! 2. それ以外は LLM tool_use で構造化要約を生成 (Task 6 で追加)
//! 3. LLM 失敗時は heuristic_fallback が medium 固定で返す

use crate::summarizer_store::{Summary, SCHEMA_VERSION};
use serde_json::{json, Value};

pub const SUMMARIZER_MODEL: &str = "claude-sonnet-4-6";

/// Anthropic tool_use で使う schema。emit_memory_summary ツール 1 本。
pub fn emit_memory_summary_tool() -> Value {
  json!({
    "name": "emit_memory_summary",
    "description": "Emit a single memory summary for display to the user.",
    "input_schema": {
      "type": "object",
      "properties": {
        "title":       { "type": "string", "maxLength": 80 },
        "key_points":  {
          "type": "array",
          "items": { "type": "string", "maxLength": 140 },
          "minItems": 1,
          "maxItems": 5
        },
        "source_type": {
          "type": "string",
          "enum": ["mail", "calendar", "meeting", "screen_session", "screen_day"]
        },
        "priority":    { "type": "string", "enum": ["high", "medium", "low"] },
        "reason":      { "type": "string", "maxLength": 60 }
      },
      "required": ["title", "key_points", "source_type", "priority"]
    }
  })
}

/// Base system prompt (language-agnostic parts). Language-specific instructions
/// are appended by `system_prompt_for_lang`.
const SYSTEM_PROMPT_BASE: &str = r#"You are a memory summarizer for a personal assistant app. Your job is to produce a JUDGMENT-oriented summary of a single connector memory item (an email or a calendar event) so the user can decide in seconds what, if anything, to do about it.

Rules:
- Always emit via the emit_memory_summary tool. Never respond with plain text.
- title: <= 80 chars, single line. For emails: include sender short-name when possible. For calendar events: include event title + start time when within the next week.
- key_points: 2-4 short bullets (<= 140 chars each). DO NOT just restate the subject. The first bullet MUST state the USER'S ACTION. Subsequent bullets carry the actual content (deadline, figures, attendees, decision needed, key numbers). Skip boilerplate. For purely marketing/auto-notification items, one action bullet + one content bullet is enough.
- priority (required):
    HIGH   = reply/decision required within ~48h, calendar event starts within 24h, or message from a known frequent correspondent needing action.
    MEDIUM = informational but relevant (newsletter you follow, meeting invite >24h out, calendar event this week, order/receipt worth noting).
    LOW    = automated notifications, bulk marketing, past events without follow-up, generic no-reply addresses.
- reason: one short sentence (<= 60 chars) explaining WHY this priority was chosen — grounded in the content, not the category label.
- source_type: 'mail' for Gmail input, 'calendar' for Google Calendar input, 'meeting' for a meeting transcript / notes.
- For meeting items: action label signals follow-ups, not reply. Examples of first bullet: "No action needed" (meeting closed), "Action required: <owner + task>" (an action item was assigned), "FYI only" (informational sync). Subsequent bullets carry decisions made, action items with owners, key figures, next steps — not a play-by-play of the transcript."#;

/// Build the full SYSTEM_PROMPT for the user's configured UI language.
/// Accepted codes: "en", "jp", "bi" (bilingual = match source content).
fn system_prompt_for_lang(lang: &str) -> String {
  let lang_directive = match lang {
    "jp" => r#"
- OUTPUT LANGUAGE: Always Japanese, regardless of the source content's language. If the email is in English, still summarize in Japanese.
- Action label (first bullet) — use these Japanese phrases verbatim:
    * 「返信不要」 for automated notifications, marketing, receipts, FYI
    * 「返信推奨」 when a human response is expected. Append deadline if stated: 「返信推奨 · 4/28まで」
    * 「確認のみ」 for calendar invites already accepted, informational meetings
    * 「要対応: <短い説明>」 for specific tasks/decisions requested
"#,
    "bi" => r#"
- OUTPUT LANGUAGE: Match the source content's language. If the email is in Japanese, summarize in Japanese. If English, summarize in English.
- Action label (first bullet) — use the matching set:
    English: "No action needed" / "Reply recommended" (append "· by <date>") / "FYI only" / "Action required: <phrase>"
    Japanese: 「返信不要」 / 「返信推奨」 (append "· <日付>まで") / 「確認のみ」 / 「要対応: <短い説明>」
"#,
    // "en" and any unknown value fall through to English (safe default)
    _ => r#"
- OUTPUT LANGUAGE: Always English, regardless of the source content's language. If the email is in Japanese, still summarize in English.
- Action label (first bullet) — use these English phrases verbatim:
    * "No action needed" — automated notification, marketing, receipt, FYI
    * "Reply recommended" — a human response is expected. Append deadline if stated: "Reply recommended · by Apr 28"
    * "FYI only" — calendar invites already accepted, informational meetings
    * "Action required: <short phrase>" — a specific task/decision is requested
"#,
  };
  format!("{}{}", SYSTEM_PROMPT_BASE, lang_directive)
}

/// heuristic が自信を持って判定できた時のショートカット結果。
#[derive(Debug, Clone)]
pub struct PriorityGuess {
  pub priority: String, // Phase 1 では "low" のみ返す
  pub reason: String,
  pub title_hint: String,
}

/// Localized short strings used by heuristic paths (no LLM needed).
/// Covers: automated notification reason, past-event reason/title-hint, LLM-fallback reason.
fn loc(lang: &str, en: &str, jp: &str) -> String {
  match lang {
    "jp" => jp.to_string(),
    _ => en.to_string(), // "en" and "bi" both default to English short strings
  }
}

/// Item が bulk / 自動通知 / 過去カレンダーかを判定。
/// Some(guess) なら LLM スキップ、None なら LLM 実行。
pub fn heuristic_priority_guess(item: &Value, lang: &str) -> Option<PriorityGuess> {
  let source = item.get("source").and_then(|v| v.as_str()).unwrap_or("");
  let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("");
  let snippet = item.get("snippet").and_then(|v| v.as_str()).unwrap_or("");

  // Shortcut is purely for FILTERING. Low-priority items are hidden from the
  // River, so an LLM summary would never be read by the user. Save the tokens.
  match source {
    "gmail" => gmail_heuristic(title, snippet, lang),
    "google_calendar" => calendar_heuristic(snippet, lang),
    _ => None,
  }
}

fn gmail_heuristic(title: &str, snippet: &str, lang: &str) -> Option<PriorityGuess> {
  let lower_body = snippet.to_lowercase();
  let has_unsubscribe = lower_body.contains("unsubscribe") || lower_body.contains("配信停止");

  let from_line_lower = snippet
    .lines()
    .find(|l| l.starts_with("From:"))
    .map(|l| l.to_lowercase())
    .unwrap_or_default();
  let is_no_reply = from_line_lower.contains("no-reply@")
    || from_line_lower.contains("noreply@")
    || from_line_lower.contains("donotreply@");
  let is_github_noreply = from_line_lower.contains("noreply@github.com")
    || from_line_lower.contains("notifications@github.com");
  let is_ci_sender = from_line_lower.contains("builds@")
    || from_line_lower.contains("ci@")
    || from_line_lower.contains("actions@github.com");

  if has_unsubscribe || is_no_reply || is_github_noreply || is_ci_sender {
    return Some(PriorityGuess {
      priority: "low".to_string(),
      reason: loc(lang, "Automated notification", "自動通知"),
      title_hint: title_first_line(title, 60),
    });
  }
  None
}


fn calendar_heuristic(snippet: &str, lang: &str) -> Option<PriorityGuess> {
  // Calendar snippet 例: "Google Calendar · 2026-05-01T09:00:00+09:00 · https://..."
  // 過去の event かつ最近更新されてない = low 扱い
  let start_ms = parse_calendar_start_ms(snippet)?;
  let now_ms = crate::memory_store::now_ms() as i64;
  if start_ms < now_ms - 24 * 3600 * 1000 {
    return Some(PriorityGuess {
      priority: "low".to_string(),
      reason: loc(lang, "Past event, >24h ago", "過去のイベント"),
      title_hint: loc(lang, "Calendar (past)", "カレンダー（過去）"),
    });
  }
  None
}

/// snippet 内の ISO-8601 datetime 文字列を ms に変換。解析失敗なら None。
fn parse_calendar_start_ms(snippet: &str) -> Option<i64> {
  // "Google Calendar · 2026-05-01T09:00:00+09:00 · https://..." のように
  // 区切り文字 (空白 / '·') で分割してトークンを取り出し RFC3339 で試す。
  for token in snippet.split(|c: char| c.is_whitespace() || c == '·' || c == '·') {
    let token = token.trim();
    if !token.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
      continue;
    }
    // RFC3339: "T" を含む 20 文字以上のトークンが datetime 候補
    if token.len() >= 20 && token.contains('T') {
      if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(token) {
        return Some(dt.timestamp_millis());
      }
    }
    // All-day event: YYYY-MM-DD only (no T)
    if token.len() == 10 && token.chars().filter(|&c| c == '-').count() == 2 {
      if let Ok(d) = chrono::NaiveDate::parse_from_str(token, "%Y-%m-%d") {
        if let Some(ndt) = d.and_hms_opt(0, 0, 0) {
          return Some(ndt.and_utc().timestamp_millis());
        }
      }
    }
  }
  None
}

/// タイトルを 1 行化 + 長さ制限。
fn title_first_line(s: &str, max: usize) -> String {
  let first_line = s.lines().next().unwrap_or(s);
  first_line.chars().take(max).collect()
}

/// LLM 失敗時のフォールバック要約。medium 固定、タイトル/snippet を truncate。
pub fn heuristic_fallback(item: &Value, source_type: &str, lang: &str) -> Summary {
  let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
  let title_raw = item.get("title").and_then(|v| v.as_str()).unwrap_or("");
  let snippet_raw = item.get("snippet").and_then(|v| v.as_str()).unwrap_or("");

  let title = title_first_line(title_raw, 60);
  let first_sentence = snippet_raw
    .split(|c| c == '。' || c == '.' || c == '\n')
    .next()
    .unwrap_or(snippet_raw)
    .chars()
    .take(140)
    .collect::<String>();
  let no_title = loc(lang, "(no title)", "（無題）");
  let no_content = loc(lang, "(no content)", "（本文なし）");
  let fallback_reason = loc(lang, "LLM unavailable, heuristic fallback", "LLM 不使用 / 暫定要約");

  Summary {
    target_kind: "item".into(),
    target_id: id,
    title: if title.is_empty() { no_title } else { title },
    key_points: vec![if first_sentence.is_empty() { no_content } else { first_sentence }],
    source_type: source_type.to_string(),
    priority: "medium".into(),
    reason: Some(fallback_reason),
    model: "heuristic".into(),
    schema_version: SCHEMA_VERSION,
    generated_at: crate::memory_store::now_ms() as i64,
    raw_json: json!({"fallback": true}).to_string(),
    lang: lang.to_string(),
  }
}

/// heuristic_priority_guess が Some を返した時、Summary に変換。
pub fn summary_from_guess(item: &Value, source_type: &str, guess: &PriorityGuess, lang: &str) -> Summary {
  let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
  Summary {
    target_kind: "item".into(),
    target_id: id,
    title: guess.title_hint.clone(),
    key_points: vec![guess.reason.clone()],
    source_type: source_type.to_string(),
    priority: guess.priority.clone(),
    reason: Some(guess.reason.clone()),
    model: "heuristic_prefilter".into(),
    schema_version: SCHEMA_VERSION,
    generated_at: crate::memory_store::now_ms() as i64,
    raw_json: json!({"prefilter": true, "reason": guess.reason}).to_string(),
    lang: lang.to_string(),
  }
}

/// item.source から source_type enum 値へ正規化。
pub fn derive_source_type(source: &str) -> &'static str {
  match source {
    "gmail" => "mail",
    "google_calendar" => "calendar",
    "meetings" | "meeting_note" | "audio_meeting" => "meeting",
    _ => "mail", // 未知ソースは mail fallback (Phase 1 の enum にない場合)
  }
}

/// Item を summary に変換する。Phase 1 のメインエントリ。
///
/// Flow:
/// 1. heuristic_priority_guess で明らかな low 判定ならそれを使う (LLM スキップ)
/// 2. LLM 呼び出し (anthropic_tool_complete) で構造化要約を取得
/// 3. LLM 失敗時は heuristic_fallback で medium 固定の要約
pub async fn summarize_item(item: &Value, lang: &str) -> Result<Summary, String> {
  let source = item.get("source").and_then(|v| v.as_str()).unwrap_or("");
  let source_type = derive_source_type(source);

  // 1. Heuristic pre-filter (returns localized action labels)
  if let Some(guess) = heuristic_priority_guess(item, lang) {
    return Ok(summary_from_guess(item, source_type, &guess, lang));
  }

  // 2. LLM tool_use call (prompt respects user's UI language)
  let user_content = render_item_for_llm(item);
  let tool = emit_memory_summary_tool();
  let system = system_prompt_for_lang(lang);

  match crate::llm::anthropic_tool_complete(&system, &user_content, &tool, SUMMARIZER_MODEL).await {
    Ok(tool_input) => match build_summary_from_tool_input(item, source_type, &tool_input, lang) {
      Ok(s) => Ok(s),
      Err(e) => {
        log::warn!("summarizer tool_input parse error for {}: {}", target_id_of(item), e);
        Ok(heuristic_fallback(item, source_type, lang))
      }
    },
    Err(e) => {
      log::warn!("summarizer LLM error for {}: {}", target_id_of(item), e);
      Ok(heuristic_fallback(item, source_type, lang))
    }
  }
}

fn target_id_of(item: &Value) -> String {
  item.get("id").and_then(|v| v.as_str()).unwrap_or("unknown").to_string()
}

/// LLM に渡す user メッセージを組み立てる。source 別にフィールドを整形。
fn render_item_for_llm(item: &Value) -> String {
  let source = item.get("source").and_then(|v| v.as_str()).unwrap_or("");
  let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("");
  let snippet = item.get("snippet").and_then(|v| v.as_str()).unwrap_or("");
  // snippet は 4000 文字で truncate (prompt 肥大化防止)
  let snippet_trim: String = snippet.chars().take(4000).collect();
  match source {
    "gmail" => format!("Source: Gmail\n\nTitle: {}\n\nBody:\n{}", title, snippet_trim),
    "google_calendar" => format!("Source: Google Calendar\n\nTitle: {}\n\nDetails:\n{}", title, snippet_trim),
    "meetings" | "meeting_note" | "audio_meeting" => format!(
      "Source: Meeting\n\nTitle: {}\n\nTranscript/Notes:\n{}",
      title, snippet_trim
    ),
    _ => format!("Source: {}\n\nTitle: {}\n\nBody:\n{}", source, title, snippet_trim),
  }
}

/// LLM が返した tool_input JSON (= emit_memory_summary の input) を Summary に変換。
fn build_summary_from_tool_input(item: &Value, source_type: &str, input: &Value, lang: &str) -> Result<Summary, String> {
  let title = input
    .get("title")
    .and_then(|v| v.as_str())
    .ok_or_else(|| "tool_input.title missing".to_string())?
    .to_string();

  let key_points: Vec<String> = input
    .get("key_points")
    .and_then(|v| v.as_array())
    .ok_or_else(|| "tool_input.key_points missing or not array".to_string())?
    .iter()
    .filter_map(|v| v.as_str().map(String::from))
    .collect();

  if key_points.is_empty() {
    return Err("tool_input.key_points empty after parse".into());
  }

  let priority = input
    .get("priority")
    .and_then(|v| v.as_str())
    .ok_or_else(|| "tool_input.priority missing".to_string())?
    .to_string();

  if !matches!(priority.as_str(), "high" | "medium" | "low") {
    return Err(format!("invalid priority: {}", priority));
  }

  let reason = input
    .get("reason")
    .and_then(|v| v.as_str())
    .map(String::from);

  Ok(Summary {
    target_kind: "item".into(),
    target_id: target_id_of(item),
    title,
    key_points,
    source_type: source_type.to_string(),
    priority,
    reason,
    model: SUMMARIZER_MODEL.to_string(),
    schema_version: SCHEMA_VERSION,
    generated_at: crate::memory_store::now_ms() as i64,
    raw_json: serde_json::to_string(input).unwrap_or_default(),
    lang: lang.to_string(),
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn gmail_with_unsubscribe_is_low() {
    let item = json!({
      "id": "m_1",
      "source": "gmail",
      "title": "Gmail: Sale ends tonight!",
      "snippet": "Subject: Sale ends\nFrom: promo@shop.com\nClick here to unsubscribe at any time.",
    });
    let guess = heuristic_priority_guess(&item, "en").expect("should match");
    assert_eq!(guess.priority, "low");
    assert!(guess.reason.contains("Automated"));
  }

  #[test]
  fn gmail_github_noreply_is_low() {
    let item = json!({
      "id": "m_2",
      "source": "gmail",
      "title": "Gmail: [org/repo] PR opened",
      "snippet": "Subject: PR\nFrom: noreply@github.com\nYou were mentioned in...",
    });
    let guess = heuristic_priority_guess(&item, "en").expect("should match");
    assert_eq!(guess.priority, "low");
  }

  #[test]
  fn gmail_personal_is_none() {
    let item = json!({
      "id": "m_3",
      "source": "gmail",
      "title": "Gmail: Q2 review needed",
      "snippet": "Subject: Q2 review\nFrom: alice@example.com\nCan you approve by Friday?",
    });
    assert!(heuristic_priority_guess(&item, "en").is_none());
  }

  #[test]
  fn calendar_future_is_none() {
    // 30 days in the future
    let future_ms = (crate::memory_store::now_ms() as i64) + 30 * 24 * 3600 * 1000;
    let future_iso = chrono::TimeZone::timestamp_millis_opt(&chrono::Utc, future_ms)
      .unwrap()
      .to_rfc3339();
    let item = json!({
      "id": "m_4",
      "source": "google_calendar",
      "title": "Calendar: Future meeting",
      "snippet": format!("Google Calendar · {} · https://calendar.google.com/...", future_iso),
    });
    assert!(heuristic_priority_guess(&item, "en").is_none());
  }

  #[test]
  fn calendar_past_is_low() {
    // 2 days in the past
    let past_ms = (crate::memory_store::now_ms() as i64) - 2 * 24 * 3600 * 1000;
    let past_iso = chrono::TimeZone::timestamp_millis_opt(&chrono::Utc, past_ms)
      .unwrap()
      .to_rfc3339();
    let item = json!({
      "id": "m_5",
      "source": "google_calendar",
      "title": "Calendar: Past meeting",
      "snippet": format!("Google Calendar · {} · https://...", past_iso),
    });
    let guess = heuristic_priority_guess(&item, "en").expect("past should match");
    assert_eq!(guess.priority, "low");
  }

  #[test]
  fn heuristic_fallback_always_returns_medium() {
    let item = json!({
      "id": "m_99",
      "source": "gmail",
      "title": "Whatever",
      "snippet": "Some content here. More content.",
    });
    let s = heuristic_fallback(&item, "mail", "en");
    assert_eq!(s.priority, "medium");
    assert_eq!(s.model, "heuristic");
    assert_eq!(s.target_id, "m_99");
    assert_eq!(s.target_kind, "item");
    assert_eq!(s.key_points.len(), 1);
  }

  #[test]
  fn derive_source_type_maps_known() {
    assert_eq!(derive_source_type("gmail"), "mail");
    assert_eq!(derive_source_type("google_calendar"), "calendar");
    assert_eq!(derive_source_type("meeting_note"), "meeting");
    assert_eq!(derive_source_type("unknown"), "mail");
  }

  #[test]
  fn gmail_japanese_unsubscribe_is_low() {
    let item = json!({
      "id": "m_jp",
      "source": "gmail",
      "title": "Gmail: メルマガ",
      "snippet": "Subject: メルマガ\nFrom: news@shop.co.jp\n配信停止はこちら",
    });
    let guess = heuristic_priority_guess(&item, "en").expect("Japanese unsubscribe should match");
    assert_eq!(guess.priority, "low");
  }

  #[test]
  fn gmail_body_mention_of_noreply_is_not_low() {
    // Personal email that mentions a noreply address in the body should NOT be low.
    let item = json!({
      "id": "m_body_mention",
      "source": "gmail",
      "title": "Gmail: Re: vendor setup",
      "snippet": "Subject: Re: vendor setup\nFrom: alice@example.com\nHey, the vendor's no-reply@vendor.com address is down; use support@vendor.com instead.",
    });
    assert!(heuristic_priority_guess(&item, "en").is_none(), "body mention should not trigger low");
  }

  #[test]
  fn calendar_all_day_past_is_low() {
    // All-day past event (YYYY-MM-DD only)
    let item = json!({
      "id": "m_allday",
      "source": "google_calendar",
      "title": "Calendar: Holiday",
      "snippet": "Google Calendar · 2020-01-01 · https://calendar.google.com/...",
    });
    let guess = heuristic_priority_guess(&item, "en").expect("past all-day should match");
    assert_eq!(guess.priority, "low");
  }

  #[test]
  fn build_summary_from_tool_input_ok() {
    let item = json!({ "id": "m_10" });
    let input = json!({
      "title": "Q2 予算レビュー (Alice)",
      "key_points": ["金曜までに承認要", "前年比 +8%"],
      "source_type": "mail",
      "priority": "high",
      "reason": "Deadline Friday"
    });
    let s = build_summary_from_tool_input(&item, "mail", &input, "en").unwrap();
    assert_eq!(s.title, "Q2 予算レビュー (Alice)");
    assert_eq!(s.priority, "high");
    assert_eq!(s.key_points.len(), 2);
    assert_eq!(s.model, SUMMARIZER_MODEL);
  }

  #[test]
  fn build_summary_rejects_invalid_priority() {
    let item = json!({ "id": "m_11" });
    let input = json!({
      "title": "t",
      "key_points": ["a"],
      "source_type": "mail",
      "priority": "urgent"
    });
    assert!(build_summary_from_tool_input(&item, "mail", &input, "en").is_err());
  }

  #[test]
  fn build_summary_rejects_empty_key_points() {
    let item = json!({ "id": "m_12" });
    let input = json!({
      "title": "t",
      "key_points": [],
      "source_type": "mail",
      "priority": "medium"
    });
    assert!(build_summary_from_tool_input(&item, "mail", &input, "en").is_err());
  }
}

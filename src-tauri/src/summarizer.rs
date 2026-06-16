//! Phase 1 summarizer: connector (mail/calendar) アイテムの要約を生成する。
//! 1. heuristic_priority_guess で明らかな low を LLM 前に検出 (pre-filter)
//! 2. それ以外は LLM tool_use で構造化要約を生成 (Task 6 で追加)
//! 3. LLM 失敗時は heuristic_fallback が medium 固定で返す

use crate::summarizer_store::{Summary, SCHEMA_VERSION};
use serde_json::{json, Value};

pub const SUMMARIZER_MODEL: &str = "gemini-2.5-flash";

/// Model for summarizer tool_use — settings override, else provider default.
pub fn resolve_summarizer_model() -> String {
  crate::llm::resolve_tool_model(Some("/sections/llm/summarizerModel"))
    .or_else(|_| crate::llm::resolve_tool_model(None))
    .unwrap_or_else(|_| SUMMARIZER_MODEL.to_string())
}

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
  let fallback_reason = loc(lang, "Draft summary (local)", "暫定要約（ローカル）");

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
    user_priority: None,
    acknowledged_at: None,
    snooze_until: None,
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
    user_priority: None,
    acknowledged_at: None,
    snooze_until: None,
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
  let model = resolve_summarizer_model();

  match crate::llm::anthropic_tool_complete(&system, &user_content, &tool, &model).await {
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
    model: resolve_summarizer_model(),
    schema_version: SCHEMA_VERSION,
    generated_at: crate::memory_store::now_ms() as i64,
    raw_json: serde_json::to_string(input).unwrap_or_default(),
    lang: lang.to_string(),
    user_priority: None,
    acknowledged_at: None,
    snooze_until: None,
  })
}

// ---- Phase 3: entity rollup ----------------------------------------------

fn entity_rollup_system_prompt(lang: &str) -> String {
  let base = r#"You are creating an ENTITY ROLLUP digest of a user's memory — one synthesized story summarizing recent activity related to a single person, project, or topic. The user wants to scan this and answer "what's the state of things with X."

Rules:
- Always emit via the emit_memory_summary tool. Never respond with plain text.
- title: <= 80 chars. The entity's name + a short qualifier (e.g. "Alex — recent threads", "Project Aurora — Q2 status"). The entity name is given in the user message as `Entity:`.
- key_points: 3-6 bullets (<= 140 chars each). Synthesize across the items: outstanding action items / replies awaited, key decisions made, deadlines coming up, themes / project state. Use chronological ordering only when meaningful — group by theme otherwise. Skip routine notifications.
- priority: always "medium" for entity rollups (they're ambient context, not individually actionable).
- reason: one short sentence on what makes this entity notable right now.
- source_type: always "entity_rollup"."#;

  let lang_directive = match lang {
    "jp" => "\n- OUTPUT LANGUAGE: Japanese.",
    "bi" => "\n- OUTPUT LANGUAGE: Match the dominant language of the source items.",
    _ => "\n- OUTPUT LANGUAGE: English.",
  };
  format!("{}{}", base, lang_directive)
}

/// Generate (or regenerate) an entity rollup. target_id = entity_id directly,
/// target_kind = "entity_rollup". Empty entities get a "Quiet" summary
/// without an LLM call.
pub async fn summarize_entity_rollup(
  entity_id: &str,
  entity_label: &str,
  lang: &str,
) -> Result<Summary, String> {
  let items = crate::summarizer_store::get_summaries_for_entity(entity_id, lang, 40)?;

  if items.is_empty() {
    return Ok(Summary {
      target_kind: "entity_rollup".into(),
      target_id: entity_id.to_string(),
      title: loc(
        lang,
        &format!("{} — no recent activity", entity_label),
        &format!("{}: 最近の動きなし", entity_label),
      ),
      key_points: vec![loc(
        lang,
        "No indexed items linked to this entity.",
        "このエンティティに紐づくアイテムなし",
      )],
      source_type: "entity_rollup".into(),
      priority: "low".into(),
      reason: Some(loc(lang, "Empty entity window", "対象アイテムなし")),
      model: "heuristic".into(),
      schema_version: SCHEMA_VERSION,
      generated_at: crate::memory_store::now_ms() as i64,
      raw_json: json!({"entity_rollup": "empty", "entity_id": entity_id}).to_string(),
      lang: lang.to_string(),
      user_priority: None,
      acknowledged_at: None,
    snooze_until: None,
    });
  }

  // Render context: entity name + items list (priority + source + title + first key point).
  let mut user_content = format!(
    "Entity: {}\nEntity ID: {}\n\nRecent items linked to this entity (sorted by priority):\n",
    entity_label, entity_id
  );
  for (idx, s) in items.iter().enumerate() {
    user_content.push_str(&format!(
      "\n[{}] [{}] {} — {}\n  · {}\n",
      idx + 1,
      s.priority.to_uppercase(),
      s.source_type,
      s.title,
      s.key_points.join("; "),
    ));
  }

  let tool = emit_memory_summary_tool();
  let system = entity_rollup_system_prompt(lang);
  let model = resolve_summarizer_model();

  match crate::llm::anthropic_tool_complete(&system, &user_content, &tool, &model).await {
    Ok(tool_input) => {
      let title = tool_input
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or(entity_label)
        .to_string();
      let key_points: Vec<String> = tool_input
        .get("key_points")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
      if key_points.is_empty() {
        return Ok(entity_heuristic_fallback(entity_id, entity_label, &items, lang));
      }
      let reason = tool_input.get("reason").and_then(|v| v.as_str()).map(String::from);
      Ok(Summary {
        target_kind: "entity_rollup".into(),
        target_id: entity_id.to_string(),
        title,
        key_points,
        source_type: "entity_rollup".into(),
        priority: "medium".into(),
        reason,
        model: resolve_summarizer_model(),
        schema_version: SCHEMA_VERSION,
        generated_at: crate::memory_store::now_ms() as i64,
        raw_json: serde_json::to_string(&tool_input).unwrap_or_default(),
        lang: lang.to_string(),
        user_priority: None,
        acknowledged_at: None,
    snooze_until: None,
      })
    }
    Err(e) => {
      log::warn!("entity rollup LLM error for {}: {}", entity_id, e);
      Ok(entity_heuristic_fallback(entity_id, entity_label, &items, lang))
    }
  }
}

fn entity_heuristic_fallback(
  entity_id: &str,
  entity_label: &str,
  items: &[Summary],
  lang: &str,
) -> Summary {
  let high_count = items.iter().filter(|s| s.priority == "high").count();
  let med_count = items.iter().filter(|s| s.priority == "medium").count();
  let total = items.len();

  let summary_line = match lang {
    "jp" => format!(
      "{} 件 (要対応 {} / 注目 {})",
      total, high_count, med_count
    ),
    _ => format!(
      "{} item(s) indexed (HIGH {}, MED {})",
      total, high_count, med_count
    ),
  };
  let mut key_points = vec![summary_line];
  for s in items.iter().take(3) {
    key_points.push(format!("· {}", s.title));
  }

  Summary {
    target_kind: "entity_rollup".into(),
    target_id: entity_id.to_string(),
    title: loc(
      lang,
      &format!("{} — recent activity", entity_label),
      &format!("{}: 最近の動き", entity_label),
    ),
    key_points,
    source_type: "entity_rollup".into(),
    priority: "medium".into(),
    reason: Some(loc(lang, "Local rollup (draft)", "ローカル集計（暫定）")),
    model: "heuristic".into(),
    schema_version: SCHEMA_VERSION,
    generated_at: crate::memory_store::now_ms() as i64,
    raw_json: json!({"entity_rollup": "heuristic", "items": items.len()}).to_string(),
    lang: lang.to_string(),
    user_priority: None,
    acknowledged_at: None,
    snooze_until: None,
  }
}

// ---- Phase 3: meeting auto-summary ----------------------------------------

/// Build a synthetic item Value from a stored meeting's detail / transcript /
/// notes, then run it through the standard `summarize_item` pipeline so
/// meetings share the same LLM path, cache, lang-handling, and priority
/// flow as connector items.
///
/// Returns the generated Summary (also persisted by the caller).
/// target_id = `mtg_<meeting_id>` so it doesn't collide with mem_items in
/// the shared `target_kind="item"` namespace.
pub async fn summarize_meeting(meeting_id: &str, lang: &str) -> Result<Summary, String> {
  let detail = crate::meeting_store::get_meeting_detail(meeting_id)?
    .ok_or_else(|| format!("meeting {} not found", meeting_id))?;
  let title = detail
    .get("title")
    .and_then(|v| v.as_str())
    .filter(|s| !s.is_empty())
    .map(|s| s.to_string())
    .unwrap_or_else(|| "Meeting".to_string());

  // Participants → comma-separated string.
  let participants = detail
    .get("participants")
    .and_then(|v| v.as_array())
    .map(|arr| {
      arr.iter()
        .filter_map(|p| p.as_str().map(String::from).or_else(|| {
          p.get("name").and_then(|n| n.as_str()).map(String::from)
        }))
        .collect::<Vec<_>>()
        .join(", ")
    })
    .unwrap_or_default();

  // Transcript final segments → single speaker-annotated transcript block,
  // truncated to keep prompt bounded.
  let segments = crate::meeting_store::list_transcript_final(meeting_id).unwrap_or_default();
  let mut transcript = String::new();
  for seg in &segments {
    let speaker = seg.get("speaker").and_then(|v| v.as_str()).unwrap_or("?");
    let text = seg.get("text").and_then(|v| v.as_str()).unwrap_or("");
    transcript.push_str(&format!("{}: {}\n", speaker, text));
    if transcript.chars().count() > 3500 {
      transcript.push_str("… (truncated)\n");
      break;
    }
  }

  // Manually authored notes, if any.
  let note_blocks = crate::meeting_store::list_note_blocks(meeting_id).unwrap_or_default();
  let notes: String = note_blocks
    .iter()
    .filter_map(|b| b.get("content").and_then(|v| v.as_str()))
    .collect::<Vec<_>>()
    .join("\n")
    .chars()
    .take(500)
    .collect();

  let mut snippet = String::new();
  if !participants.is_empty() {
    snippet.push_str(&format!("Participants: {}\n\n", participants));
  }
  if !notes.is_empty() {
    snippet.push_str(&format!("Notes:\n{}\n\n", notes));
  }
  if !transcript.is_empty() {
    snippet.push_str(&format!("Transcript:\n{}", transcript));
  } else if snippet.is_empty() {
    snippet.push_str("(No transcript or notes captured.)");
  }

  let synthetic = json!({
    "id": format!("mtg_{}", meeting_id),
    "title": title,
    "snippet": snippet,
    "source": "meetings",
  });
  summarize_item(&synthetic, lang).await
}

// ---- Phase 2 / 2.5: rollup digests (week + day) ---------------------------

/// Build the rollup SYSTEM_PROMPT for a given UI language + scope.
fn rollup_system_prompt_for_lang(lang: &str, kind: RollupKind) -> String {
  let (scope_title_format, scope_desc, emphasis) = match kind {
    RollupKind::Week => (
      r#""Week of <Mon date>" (e.g., "Week of Apr 20")"#,
      "this week",
      "group related threads, surface pending action items with owners, flag any deadlines this week or next week, and note notable decisions",
    ),
    RollupKind::Day => (
      r#""<Day-of-week date>" (e.g., "Fri Apr 24") or simply "Today""#,
      "today",
      "surface what moved forward, what's still pending for tomorrow, and any explicit decisions made today. Tighter than a weekly roll-up — 3-4 bullets is usually enough",
    ),
    RollupKind::Month => (
      r#""<MonthName> <Year>" (e.g., "April 2026")"#,
      "this month",
      "synthesize activity across weeks: key projects, decisions finalized, milestones hit, and outstanding items rolling into next month",
    ),
    RollupKind::Year => (
      r#""<Year>" (e.g., "2026")"#,
      "this year",
      "synthesize high-level themes: major projects completed, key decisions made, and patterns in how the year unfolded",
    ),
  };
  let target_kind = kind.target_kind();

  let base = format!(
    r#"You are creating a {scope_desc_upper} ROLLUP digest of a user's memory — one synthesized summary that captures the {scope_desc}'s themes, action items, and decisions from a batch of per-item summaries already produced for this window.

Rules:
- Always emit via the emit_memory_summary tool. Never respond with plain text.
- title: <= 80 chars. Use the format {scope_title_format} or the locale-appropriate equivalent.
- key_points: 3-6 short bullets (<= 140 chars each). DO NOT just list the items. Synthesize: {emphasis}. Skip items with no follow-up.
- priority: always "medium" for rollups (rollups themselves are ambient context, not individually actionable).
- reason: one short sentence describing what made {scope_desc} notable.
- source_type: always "{target_kind}"."#,
    scope_desc = scope_desc,
    scope_desc_upper = scope_desc.to_uppercase(),
    scope_title_format = scope_title_format,
    emphasis = emphasis,
    target_kind = target_kind,
  );

  let lang_directive = match (lang, kind) {
    ("jp", RollupKind::Week) => "\n- OUTPUT LANGUAGE: Japanese. title の形式は「今週（Mon月Dd日週）」のように日本語化する。",
    ("jp", RollupKind::Day) => "\n- OUTPUT LANGUAGE: Japanese. title の形式は「M月D日（曜日）」のように日本語化する。",
    ("jp", RollupKind::Month) => "\n- OUTPUT LANGUAGE: Japanese. title の形式は「YYYY年M月」のように日本語化する。",
    ("jp", RollupKind::Year) => "\n- OUTPUT LANGUAGE: Japanese. title の形式は「YYYY年」のように日本語化する。",
    ("bi", _) => "\n- OUTPUT LANGUAGE: Match the dominant language of the source items.",
    _ => "\n- OUTPUT LANGUAGE: English.",
  };
  format!("{}{}", base, lang_directive)
}

/// Format an ISO week's Monday (00:00 local) as `YYYY-MM-DD`.
pub fn format_week_id(week_start_ms: i64) -> String {
  let secs = (week_start_ms / 1000) as i64;
  let dt = chrono::DateTime::<chrono::Utc>::from_timestamp(secs, 0)
    .unwrap_or_else(chrono::Utc::now);
  dt.format("%Y-%m-%d").to_string()
}

/// Format `YYYY-MM` for the calendar month containing `month_start_ms` (local).
pub fn format_month_id(month_start_ms: i64) -> String {
  let secs = month_start_ms / 1000;
  let dt = chrono::DateTime::<chrono::Local>::from(
    chrono::DateTime::<chrono::Utc>::from_timestamp(secs, 0).unwrap_or_else(chrono::Utc::now),
  );
  dt.format("%Y-%m").to_string()
}

/// Format `YYYY` for the calendar year containing `year_start_ms` (local).
pub fn format_year_id(year_start_ms: i64) -> String {
  let secs = year_start_ms / 1000;
  let dt = chrono::DateTime::<chrono::Local>::from(
    chrono::DateTime::<chrono::Utc>::from_timestamp(secs, 0).unwrap_or_else(chrono::Utc::now),
  );
  dt.format("%Y").to_string()
}

/// Returns `(start_ms, end_ms)` for the calendar month containing `month_start_ms`.
/// `end_ms` = first ms of the following month in local time.
fn month_window(month_start_ms: i64) -> (i64, i64) {
  use chrono::{Datelike, TimeZone};
  let secs = month_start_ms / 1000;
  let local = chrono::Local
    .timestamp_opt(secs, 0)
    .single()
    .unwrap_or_else(chrono::Local::now);
  let (y, m) = (local.year(), local.month());
  let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
  let next_start = chrono::Local
    .with_ymd_and_hms(ny, nm, 1, 0, 0, 0)
    .single()
    .map(|d| d.timestamp_millis())
    .unwrap_or(month_start_ms + 31 * 24 * 3600 * 1000);
  (month_start_ms, next_start)
}

/// Returns `(start_ms, end_ms)` for the calendar year containing `year_start_ms`.
/// `end_ms` = Jan 1 of the following year @ 00:00 local.
fn year_window(year_start_ms: i64) -> (i64, i64) {
  use chrono::{Datelike, TimeZone};
  let secs = year_start_ms / 1000;
  let local = chrono::Local
    .timestamp_opt(secs, 0)
    .single()
    .unwrap_or_else(chrono::Local::now);
  let next_start = chrono::Local
    .with_ymd_and_hms(local.year() + 1, 1, 1, 0, 0, 0)
    .single()
    .map(|d| d.timestamp_millis())
    .unwrap_or(year_start_ms + 366 * 24 * 3600 * 1000);
  (year_start_ms, next_start)
}

/// True iff `s` was produced by the empty-window short-circuit in
/// `summarize_rollup` (raw_json contains `{"rollup":"empty"}`). Reused
/// by the Year compositor to skip months with no indexed activity.
fn is_empty_rollup(s: &Summary) -> bool {
  serde_json::from_str::<serde_json::Value>(&s.raw_json)
    .ok()
    .and_then(|v| v.get("rollup").and_then(|r| r.as_str()).map(|s| s == "empty"))
    .unwrap_or(false)
}

/// Generate (or regenerate) a week-rollup summary for `[week_start_ms, week_start_ms + 7d)`.
/// Looks up item summaries in that window, synthesizes them via the LLM, and
/// caches the result with target_kind="week_rollup".
pub async fn summarize_week_rollup(week_start_ms: i64, lang: &str) -> Result<Summary, String> {
  let end_ms = week_start_ms + 7 * 24 * 3600 * 1000;
  summarize_rollup(week_start_ms, end_ms, RollupKind::Week, lang).await
}

/// Phase 2.5: daily rollup over a 24h window. target_id is `YYYY-MM-DD` for
/// the calendar day starting at `day_start_ms` (UTC).
pub async fn summarize_day_rollup(day_start_ms: i64, lang: &str) -> Result<Summary, String> {
  let end_ms = day_start_ms + 24 * 3600 * 1000;
  summarize_rollup(day_start_ms, end_ms, RollupKind::Day, lang).await
}

/// Monthly rollup over a calendar month `[month_start_ms, month_window.end)`.
/// `target_id` is `YYYY-MM`. Same items→LLM pipeline as week, wider cap.
pub async fn summarize_month_rollup(month_start_ms: i64, lang: &str) -> Result<Summary, String> {
  let (start, end) = month_window(month_start_ms);
  summarize_rollup(start, end, RollupKind::Month, lang).await
}

/// Year rollup is composed from the 12 monthly rollups within the year, NOT
/// from raw items. On miss, the corresponding `summarize_month_rollup` is
/// invoked (and cached) before composition. Future months are skipped.
pub async fn summarize_year_rollup(year_start_ms: i64, lang: &str) -> Result<Summary, String> {
  let (year_start, year_end) = year_window(year_start_ms);
  let id = format_year_id(year_start);

  let monthly = collect_monthly_rollups_for_year(year_start, year_end, lang).await?;

  // All months either missing-and-future, or empty: short-circuit.
  if monthly.is_empty() || monthly.iter().all(is_empty_rollup) {
    return Ok(Summary {
      target_kind: RollupKind::Year.target_kind().into(),
      target_id: id,
      title: loc(lang, "Quiet year", "静かな年"),
      key_points: vec![loc(lang, "No activity this year.", "今年のアクティビティなし")],
      source_type: RollupKind::Year.target_kind().into(),
      priority: "low".into(),
      reason: Some(loc(lang, "No indexed activity in this window", "インデックス済みの活動なし")),
      model: "heuristic".into(),
      schema_version: SCHEMA_VERSION,
      generated_at: crate::memory_store::now_ms() as i64,
      raw_json: json!({"rollup": "empty", "kind": RollupKind::Year.target_kind()}).to_string(),
      lang: lang.to_string(),
      user_priority: None,
      acknowledged_at: None,
      snooze_until: None,
    });
  }

  let user_content = render_year_context(&monthly, &id);
  let tool = emit_memory_summary_tool();
  let system = rollup_system_prompt_for_lang(lang, RollupKind::Year);
  let model = resolve_summarizer_model();

  match crate::llm::anthropic_tool_complete(&system, &user_content, &tool, &model).await {
    Ok(tool_input) => match build_rollup_from_tool_input(&id, RollupKind::Year, &tool_input, lang) {
      Ok(s) => Ok(s),
      Err(e) => {
        log::warn!("year rollup tool_input parse error for {}: {}", id, e);
        Ok(year_heuristic_fallback(&id, &monthly, lang))
      }
    },
    Err(e) => {
      log::warn!("year rollup LLM error for {}: {}", id, e);
      Ok(year_heuristic_fallback(&id, &monthly, lang))
    }
  }
}

/// Walk each calendar month in `[year_start, year_end)`, return the cached
/// month rollup or generate-then-upsert if missing. Future months
/// (month_start > now) are skipped and not included in the result.
async fn collect_monthly_rollups_for_year(
  year_start: i64,
  year_end: i64,
  lang: &str,
) -> Result<Vec<Summary>, String> {
  use chrono::{Datelike, TimeZone};
  let mut out: Vec<Summary> = Vec::with_capacity(12);
  let now_ms = crate::memory_store::now_ms() as i64;

  let mut cursor_ms = year_start;
  while cursor_ms < year_end {
    if cursor_ms > now_ms {
      break; // future months — nothing to roll up yet
    }
    let month_id = format_month_id(cursor_ms);
    let cached = crate::summarizer_store::get_cached("month_rollup", &month_id, lang)?;
    let rollup = if let Some(c) = cached {
      c
    } else {
      let s = summarize_month_rollup(cursor_ms, lang).await?;
      crate::summarizer_store::upsert(&s)?;
      s
    };
    out.push(rollup);

    // Advance to the first ms of the next month.
    let secs = cursor_ms / 1000;
    let local = chrono::Local
      .timestamp_opt(secs, 0)
      .single()
      .ok_or_else(|| "invalid timestamp".to_string())?;
    let (y, m) = (local.year(), local.month());
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    cursor_ms = chrono::Local
      .with_ymd_and_hms(ny, nm, 1, 0, 0, 0)
      .single()
      .map(|d| d.timestamp_millis())
      .ok_or_else(|| "invalid next month".to_string())?;
  }
  Ok(out)
}

/// Render the LLM context for a year rollup: each monthly rollup labeled
/// with its full month name + year, followed by the month's title and
/// key points. Empty months (no indexed activity) are dropped from the
/// LLM context entirely so the model isn't fed "Quiet month" filler —
/// the surrounding non-empty months tell a tighter story.
fn render_year_context(monthly: &[Summary], year_id: &str) -> String {
  let active: Vec<&Summary> = monthly.iter().filter(|s| !is_empty_rollup(s)).collect();
  let total = monthly.len();
  let skipped = total - active.len();

  let mut buf = format!("Year: {}\n\n", year_id);
  if skipped > 0 {
    buf.push_str(&format!(
      "(showing {} active months out of {}; the remaining months had no indexed activity)\n\n",
      active.len(),
      total,
    ));
  }
  buf.push_str("Monthly rollups (chronological):\n");
  for s in active {
    let label = month_label_full(&s.target_id);
    buf.push_str(&format!(
      "\n[{}] {}\n  · {}\n",
      label,
      s.title,
      s.key_points.join("; "),
    ));
  }
  buf
}

/// "YYYY-MM" → "April 2026" (full month name). Used for human-readable
/// labels in rollup titles, year context, and fallback summaries.
fn month_label_full(month_id: &str) -> String {
  let parts: Vec<&str> = month_id.split('-').collect();
  if parts.len() != 2 {
    return month_id.to_string();
  }
  let year = parts[0];
  let mo: u32 = parts[1].parse().unwrap_or(0);
  let name = month_name_full(mo);
  format!("{} {}", name, year)
}

fn month_name_full(mo: u32) -> &'static str {
  match mo {
    1 => "January", 2 => "February", 3 => "March", 4 => "April",
    5 => "May", 6 => "June", 7 => "July", 8 => "August",
    9 => "September", 10 => "October", 11 => "November", 12 => "December",
    _ => "?",
  }
}

/// "YYYY-MM" → "2026年4月". JP-localized month label, drops leading zero.
fn format_month_jp(month_id: &str) -> String {
  let parts: Vec<&str> = month_id.split('-').collect();
  if parts.len() != 2 {
    return month_id.to_string();
  }
  let mo = parts[1].trim_start_matches('0');
  format!("{}年{}月", parts[0], mo)
}

/// Heuristic fallback for year rollups when the LLM fails or returns
/// unparseable output. Lists month count and the first few non-empty
/// monthly titles.
fn year_heuristic_fallback(id: &str, monthly: &[Summary], lang: &str) -> Summary {
  let active_months: Vec<&Summary> = monthly.iter().filter(|m| !is_empty_rollup(m)).collect();
  let title = RollupKind::Year.fallback_title(id, lang);
  let summary_line = match lang {
    "jp" => format!("{} ヶ月分の記録（活動あり {} ヶ月）", monthly.len(), active_months.len()),
    _ => format!("{} months indexed ({} active)", monthly.len(), active_months.len()),
  };
  let mut key_points = vec![summary_line];
  if !active_months.is_empty() {
    key_points.push(loc(lang, "Notable months:", "主要な月:"));
    for s in active_months.iter().take(4) {
      let label = month_label_full(&s.target_id);
      key_points.push(format!("· {} — {}", label, s.title));
    }
  }
  Summary {
    target_kind: RollupKind::Year.target_kind().into(),
    target_id: id.to_string(),
    title,
    key_points,
    source_type: RollupKind::Year.target_kind().into(),
    priority: "medium".into(),
    reason: Some(loc(
      lang,
      "Local year rollup (draft)",
      "ヒューリスティック年次サマリ（LLM未到達）",
    )),
    model: "heuristic".into(),
    schema_version: SCHEMA_VERSION,
    generated_at: crate::memory_store::now_ms() as i64,
    raw_json: json!({"rollup": "fallback", "kind": "year_rollup"}).to_string(),
    lang: lang.to_string(),
    user_priority: None,
    acknowledged_at: None,
    snooze_until: None,
  }
}

/// Shared rollup pipeline: lookup → empty-case → LLM call → fallback.
async fn summarize_rollup(
  start_ms: i64,
  end_ms: i64,
  kind: RollupKind,
  lang: &str,
) -> Result<Summary, String> {
  let items = crate::summarizer_store::get_summaries_in_window(start_ms, end_ms, lang)?;
  let id = match kind {
    RollupKind::Week | RollupKind::Day => format_week_id(start_ms),
    RollupKind::Month => format_month_id(start_ms),
    RollupKind::Year => format_year_id(start_ms),
  };

  if items.is_empty() {
    let indexed = crate::memory_store::count_items_in_window(start_ms, end_ms).unwrap_or(0);
    if indexed > 0 {
      let (title_en, title_jp) = match kind {
        RollupKind::Week => ("Summaries pending", "要約待ち"),
        RollupKind::Day => ("Summaries pending", "要約待ち"),
        RollupKind::Month => ("Summaries pending", "要約待ち"),
        RollupKind::Year => ("Summaries pending", "要約待ち"),
      };
      let (body_en, body_jp) = match kind {
        RollupKind::Week => (
          format!(
            "{indexed} memories indexed this week — open Memory → River to refresh summaries."
          ),
          format!("{indexed} 件の記憶がインデックス済み — Memory → River で要約を更新できます"),
        ),
        RollupKind::Day => (
          format!(
            "{indexed} memories indexed today — open Memory → River to refresh summaries."
          ),
          format!("{indexed} 件の記憶がインデックス済み — Memory → River で要約を更新できます"),
        ),
        RollupKind::Month => (
          format!(
            "{indexed} memories indexed this month — open Memory → River to refresh summaries."
          ),
          format!("{indexed} 件の記憶がインデックス済み — Memory → River で要約を更新できます"),
        ),
        RollupKind::Year => (
          format!(
            "{indexed} memories indexed this year — open Memory → River to refresh summaries."
          ),
          format!("{indexed} 件の記憶がインデックス済み — Memory → River で要約を更新できます"),
        ),
      };
      return Ok(Summary {
        target_kind: kind.target_kind().into(),
        target_id: id,
        title: loc(lang, title_en, title_jp),
        key_points: vec![loc(lang, &body_en, &body_jp)],
        source_type: kind.target_kind().into(),
        priority: "medium".into(),
        reason: Some(loc(
          lang,
          "Indexed memories exist; LLM summaries pending",
          "記憶はあるが LLM 要約が未生成",
        )),
        model: "heuristic".into(),
        schema_version: SCHEMA_VERSION,
        generated_at: crate::memory_store::now_ms() as i64,
        raw_json: json!({"rollup": "pending", "indexed": indexed, "kind": kind.target_kind()}).to_string(),
        lang: lang.to_string(),
        user_priority: None,
        acknowledged_at: None,
        snooze_until: None,
      });
    }
    let (title_en, title_jp) = match kind {
      RollupKind::Week => ("Quiet week", "静かな週"),
      RollupKind::Day => ("Quiet day", "静かな一日"),
      RollupKind::Month => ("Quiet month", "静かな月"),
      RollupKind::Year => ("Quiet year", "静かな一年"),
    };
    let (no_items_en, no_items_jp) = match kind {
      RollupKind::Week => ("No activity this week.", "今週のアクティビティなし"),
      RollupKind::Day => ("No activity today.", "今日のアクティビティなし"),
      RollupKind::Month => ("No activity this month.", "今月のアクティビティなし"),
      RollupKind::Year => ("No activity this year.", "今年のアクティビティなし"),
    };
    return Ok(Summary {
      target_kind: kind.target_kind().into(),
      target_id: id,
      title: loc(lang, title_en, title_jp),
      key_points: vec![loc(lang, no_items_en, no_items_jp)],
      source_type: kind.target_kind().into(),
      priority: "low".into(),
      reason: Some(loc(lang, "No indexed activity in this window", "インデックス済みの活動なし")),
      model: "heuristic".into(),
      schema_version: SCHEMA_VERSION,
      generated_at: crate::memory_store::now_ms() as i64,
      raw_json: json!({"rollup": "empty", "kind": kind.target_kind()}).to_string(),
      lang: lang.to_string(),
    user_priority: None,
    acknowledged_at: None,
    snooze_until: None,
    });
  }

  // Keep prompt bounded: cap context window size by scope. Day needs fewer.
  let cap = match kind {
    RollupKind::Week => 40,
    RollupKind::Day => 20,
    RollupKind::Month => 60,
    RollupKind::Year => 100,
  };
  let context_items: Vec<&Summary> = items.iter().take(cap).collect();
  let user_content = render_rollup_context(&context_items, &id, kind);
  let tool = emit_memory_summary_tool();
  let system = rollup_system_prompt_for_lang(lang, kind);
  let model = resolve_summarizer_model();

  match crate::llm::anthropic_tool_complete(&system, &user_content, &tool, &model).await {
    Ok(tool_input) => match build_rollup_from_tool_input(&id, kind, &tool_input, lang) {
      Ok(s) => Ok(s),
      Err(e) => {
        log::warn!("rollup tool_input parse error for {}: {}", id, e);
        Ok(rollup_heuristic_fallback(&id, &items, kind, lang))
      }
    },
    Err(e) => {
      log::warn!("rollup LLM error for {}: {}", id, e);
      Ok(rollup_heuristic_fallback(&id, &items, kind, lang))
    }
  }
}

/// Identifies a rollup scope (week vs day). Drives target_kind, prompt text,
/// and fallback titling. Added in Phase 2.5 to avoid duplicating rollup
/// plumbing between weekly and daily digests.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RollupKind { Week, Day, Month, Year }

impl RollupKind {
  pub fn target_kind(&self) -> &'static str {
    match self {
      Self::Week => "week_rollup",
      Self::Day => "day_rollup",
      Self::Month => "month_rollup",
      Self::Year => "year_rollup",
    }
  }
  fn window_label(&self) -> &'static str {
    match self {
      Self::Week => "Week starting",
      Self::Day => "Day",
      Self::Month => "Month",
      Self::Year => "Year",
    }
  }
  fn items_intro(&self) -> &'static str {
    match self {
      Self::Week => "Items this week (sorted by priority):",
      Self::Day => "Items today (sorted by priority):",
      Self::Month => "Items this month (sorted by priority):",
      Self::Year => "Monthly rollups this year (chronological):",
    }
  }
  fn fallback_title(&self, id: &str, lang: &str) -> String {
    match (self, lang) {
      (Self::Week, "jp") => format!("今週（{}週）", id),
      (Self::Day, "jp") => format!("{} の記録", id),
      (Self::Month, "jp") => format_month_jp(id),
      (Self::Year, "jp") => format!("{}年", id),
      (Self::Week, _) => format!("Week of {}", id),
      (Self::Day, _) => format!("Day of {}", id),
      (Self::Month, _) => month_label_full(id),
      (Self::Year, _) => id.to_string(),
    }
  }
}

fn render_rollup_context(items: &[&Summary], id: &str, kind: RollupKind) -> String {
  let mut buf = format!(
    "{}: {}\n\n{}\n",
    kind.window_label(),
    id,
    kind.items_intro()
  );
  for (idx, s) in items.iter().enumerate() {
    buf.push_str(&format!(
      "\n[{}] [{}] {} — {}\n  · {}\n",
      idx + 1,
      s.priority.to_uppercase(),
      s.source_type,
      s.title,
      s.key_points.join("; "),
    ));
  }
  buf
}

fn build_rollup_from_tool_input(id: &str, kind: RollupKind, input: &Value, lang: &str) -> Result<Summary, String> {
  let title = input
    .get("title")
    .and_then(|v| v.as_str())
    .ok_or_else(|| "tool_input.title missing".to_string())?
    .to_string();
  let key_points: Vec<String> = input
    .get("key_points")
    .and_then(|v| v.as_array())
    .ok_or_else(|| "tool_input.key_points missing".to_string())?
    .iter()
    .filter_map(|v| v.as_str().map(String::from))
    .collect();
  if key_points.is_empty() {
    return Err("tool_input.key_points empty".into());
  }
  let reason = input.get("reason").and_then(|v| v.as_str()).map(String::from);

  Ok(Summary {
    target_kind: kind.target_kind().into(),
    target_id: id.to_string(),
    title,
    key_points,
    source_type: kind.target_kind().into(),
    priority: "medium".into(), // rollups are ambient, never HIGH
    reason,
    model: resolve_summarizer_model(),
    schema_version: SCHEMA_VERSION,
    generated_at: crate::memory_store::now_ms() as i64,
    raw_json: serde_json::to_string(input).unwrap_or_default(),
    lang: lang.to_string(),
    user_priority: None,
    acknowledged_at: None,
    snooze_until: None,
  })
}

fn rollup_heuristic_fallback(id: &str, items: &[Summary], kind: RollupKind, lang: &str) -> Summary {
  let high_count = items.iter().filter(|s| s.priority == "high").count();
  let med_count = items.iter().filter(|s| s.priority == "medium").count();
  let total = items.len();

  let title = kind.fallback_title(id, lang);
  let summary_line = match lang {
    "jp" => format!("{} 件の要記録（要対応 {} / 注目 {}）", total, high_count, med_count),
    _ => format!("{} items indexed (HIGH: {}, MED: {})", total, high_count, med_count),
  };
  let top_titles: Vec<String> = items.iter().take(3).map(|s| s.title.clone()).collect();

  let mut key_points = vec![summary_line];
  if !top_titles.is_empty() {
    key_points.push(loc(lang, "Top items:", "主要項目:"));
    for t in top_titles {
      key_points.push(format!("· {}", t));
    }
  }

  Summary {
    target_kind: kind.target_kind().into(),
    target_id: id.to_string(),
    title,
    key_points,
    source_type: kind.target_kind().into(),
    priority: "medium".into(),
    reason: Some(loc(lang, "Local rollup (draft)", "ローカル集計（暫定）")),
    model: "heuristic".into(),
    schema_version: SCHEMA_VERSION,
    generated_at: crate::memory_store::now_ms() as i64,
    raw_json: json!({"rollup": "heuristic", "items": items.len()}).to_string(),
    lang: lang.to_string(),
    user_priority: None,
    acknowledged_at: None,
    snooze_until: None,
  }
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

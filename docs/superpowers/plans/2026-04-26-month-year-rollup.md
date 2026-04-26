# Memory Rollup — Month / Year Span Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Month and Year rollup banners to the Memory timeline, mirroring the existing Day/Week rollup pattern. Year rollups are composed from cached monthly rollups (cascading generation on miss).

**Architecture:** Extend the existing `RollupKind` enum + `summarize_rollup` pipeline in `summarizer.rs` for Month (raw items, wider window). Add a separate `summarize_year_rollup` pipeline that composes from monthly rollups. Two new tauri commands, two new IPC actions, two new React state slots + effects + JSX banners — pattern-symmetric with the existing Week banner.

**Tech Stack:** Rust (Tauri commands, chrono date math, anthropic SDK), JavaScript (React 19, Tauri IPC), Python (verification scripts).

**Spec:** `docs/superpowers/specs/2026-04-26-month-year-rollup-design.md`

---

## File Map

**Modified:**
- `src-tauri/src/summarizer.rs` — extend RollupKind enum, add helpers, add 2 summarize functions
- `src-tauri/src/commands.rs` — add 2 tauri commands (~end of file, after line 1635)
- `src-tauri/src/lib.rs` — register 2 commands in `invoke_handler![…]` (line ~232)
- `hifi/lib/shogun-api.js` — add 2 api method bindings (after line 38)
- `hifi/lib/action-registry.js` — register 2 new action keys (after line 74)
- `hifi/action-map.md` — add 2 entries to the bottom registry list (~line 137)
- `hifi/screens-a.jsx` — add state (line ~1697), effects (line ~2085), UI banners (line ~2607)

**No new files. No tests in scope** (spec § 6 defers automated tests). Verification is `cargo check` + `npm run check:*` + manual eye-test.

---

## Task 1: Extend RollupKind + add Month/Year helpers

**Files:**
- Modify: `src-tauri/src/summarizer.rs:753-777` (enum + impl), append helpers after line ~688

- [ ] **Step 1: Extend the enum (line 754)**

Replace:
```rust
pub enum RollupKind { Week, Day }
```

With:
```rust
pub enum RollupKind { Week, Day, Month, Year }
```

- [ ] **Step 2: Update `target_kind()` match (line 757-759)**

Replace:
```rust
  pub fn target_kind(&self) -> &'static str {
    match self { Self::Week => "week_rollup", Self::Day => "day_rollup" }
  }
```

With:
```rust
  pub fn target_kind(&self) -> &'static str {
    match self {
      Self::Week => "week_rollup",
      Self::Day => "day_rollup",
      Self::Month => "month_rollup",
      Self::Year => "year_rollup",
    }
  }
```

- [ ] **Step 3: Update `window_label()` match (line 760-762)**

Replace:
```rust
  fn window_label(&self) -> &'static str {
    match self { Self::Week => "Week starting", Self::Day => "Day" }
  }
```

With:
```rust
  fn window_label(&self) -> &'static str {
    match self {
      Self::Week => "Week starting",
      Self::Day => "Day",
      Self::Month => "Month",
      Self::Year => "Year",
    }
  }
```

- [ ] **Step 4: Update `items_intro()` match (line 763-768)**

Replace:
```rust
  fn items_intro(&self) -> &'static str {
    match self {
      Self::Week => "Items this week (sorted by priority):",
      Self::Day => "Items today (sorted by priority):",
    }
  }
```

With:
```rust
  fn items_intro(&self) -> &'static str {
    match self {
      Self::Week => "Items this week (sorted by priority):",
      Self::Day => "Items today (sorted by priority):",
      Self::Month => "Items this month (sorted by priority):",
      Self::Year => "Monthly rollups this year (chronological):",
    }
  }
```

- [ ] **Step 5: Update `fallback_title()` match (line 769-776)**

Replace:
```rust
  fn fallback_title(&self, id: &str, lang: &str) -> String {
    match (self, lang) {
      (Self::Week, "jp") => format!("今週（{}週）", id),
      (Self::Day, "jp") => format!("{} の記録", id),
      (Self::Week, _) => format!("Week of {}", id),
      (Self::Day, _) => format!("Day of {}", id),
    }
  }
```

With:
```rust
  fn fallback_title(&self, id: &str, lang: &str) -> String {
    match (self, lang) {
      (Self::Week, "jp") => format!("今週（{}週）", id),
      (Self::Day, "jp") => format!("{} の記録", id),
      (Self::Month, "jp") => format!("今月（{}）", id),
      (Self::Year, "jp") => format!("今年（{}年）", id),
      (Self::Week, _) => format!("Week of {}", id),
      (Self::Day, _) => format!("Day of {}", id),
      (Self::Month, _) => format!("Month of {}", id),
      (Self::Year, _) => format!("Year of {}", id),
    }
  }
```

- [ ] **Step 6: Add period helpers after `format_week_id` (after line 673)**

Insert after line 673:
```rust
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
```

- [ ] **Step 7: Run cargo check**

Run: `cd /Users/torutano/ShogunAI3/ShogunAI3 && npm run check:rust 2>&1 | tail -30`
Expected: PASS (warnings about unused `format_month_id` / `format_year_id` / `is_empty_rollup` / `month_window` / `year_window` are OK at this point — they're consumed by Tasks 2-3).

- [ ] **Step 8: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/summarizer.rs
git commit -m "feat(memory-rollup): extend RollupKind enum with Month and Year"
```

---

## Task 2: summarize_month_rollup + update summarize_rollup match arms

**Files:**
- Modify: `src-tauri/src/summarizer.rs:685-748` (summarize_rollup body), line ~688 (after summarize_day_rollup), line ~626-665 (system prompt)

- [ ] **Step 1: Update empty-state titles in `summarize_rollup` (lines 700-708)**

Replace:
```rust
  if items.is_empty() {
    let (title_en, title_jp) = match kind {
      RollupKind::Week => ("Quiet week", "静かな週"),
      RollupKind::Day => ("Quiet day", "静かな一日"),
    };
    let (no_items_en, no_items_jp) = match kind {
      RollupKind::Week => ("No activity this week.", "今週のアクティビティなし"),
      RollupKind::Day => ("No activity today.", "今日のアクティビティなし"),
    };
```

With:
```rust
  if items.is_empty() {
    let (title_en, title_jp) = match kind {
      RollupKind::Week => ("Quiet week", "静かな週"),
      RollupKind::Day => ("Quiet day", "静かな一日"),
      RollupKind::Month => ("Quiet month", "静かな月"),
      RollupKind::Year => ("Quiet year", "静かな年"),
    };
    let (no_items_en, no_items_jp) = match kind {
      RollupKind::Week => ("No activity this week.", "今週のアクティビティなし"),
      RollupKind::Day => ("No activity today.", "今日のアクティビティなし"),
      RollupKind::Month => ("No activity this month.", "今月のアクティビティなし"),
      RollupKind::Year => ("No activity this year.", "今年のアクティビティなし"),
    };
```

(Note: `RollupKind::Year` is included here for completeness, but Year never goes through `summarize_rollup` — it has its own `summarize_year_rollup` path. Including the arm prevents non-exhaustive-match compile errors and keeps the empty-state semantics consistent if `summarize_rollup` is ever called with `Year` directly.)

- [ ] **Step 2: Update the `id` derivation in `summarize_rollup` (line 698)**

Replace:
```rust
  let id = format_week_id(start_ms); // YYYY-MM-DD works for both scopes
```

With:
```rust
  let id = match kind {
    RollupKind::Week | RollupKind::Day => format_week_id(start_ms),
    RollupKind::Month => format_month_id(start_ms),
    RollupKind::Year => format_year_id(start_ms),
  };
```

- [ ] **Step 3: Update the `cap` match (line 729)**

Replace:
```rust
  let cap = match kind { RollupKind::Week => 40, RollupKind::Day => 20 };
```

With:
```rust
  let cap = match kind {
    RollupKind::Week => 40,
    RollupKind::Day => 20,
    RollupKind::Month => 60,
    RollupKind::Year => 60, // unused — Year uses summarize_year_rollup, not this path
  };
```

- [ ] **Step 4: Add `summarize_month_rollup` after `summarize_day_rollup` (after line 688)**

Insert after line 688:
```rust
/// Monthly rollup over a calendar month `[month_start_ms, month_window.end)`.
/// `target_id` is `YYYY-MM`. Same items→LLM pipeline as week, wider cap.
pub async fn summarize_month_rollup(month_start_ms: i64, lang: &str) -> Result<Summary, String> {
  let (start, end) = month_window(month_start_ms);
  summarize_rollup(start, end, RollupKind::Month, lang).await
}
```

- [ ] **Step 5: Update `rollup_system_prompt_for_lang` for Month (line 627-637)**

Replace:
```rust
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
  };
```

With:
```rust
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
      r#""<Month> <Year>" (e.g., "April 2026")"#,
      "this month",
      "identify the month's main threads and arcs, list significant decisions and shipped milestones, surface still-open commitments, and call out any people or projects that recurred prominently",
    ),
    RollupKind::Year => (
      r#""<Year>" (e.g., "2026")"#,
      "this year",
      "extract the year's defining themes, milestones, and turning points from the monthly digests provided. Be selective — 4-6 high-altitude bullets, not a month-by-month recap",
    ),
  };
```

- [ ] **Step 6: Update language directive match (line 658-663)**

Replace:
```rust
  let lang_directive = match (lang, kind) {
    ("jp", RollupKind::Week) => "\n- OUTPUT LANGUAGE: Japanese. title の形式は「今週（Mon月Dd日週）」のように日本語化する。",
    ("jp", RollupKind::Day) => "\n- OUTPUT LANGUAGE: Japanese. title の形式は「M月D日（曜日）」のように日本語化する。",
    ("bi", _) => "\n- OUTPUT LANGUAGE: Match the dominant language of the source items.",
    _ => "\n- OUTPUT LANGUAGE: English.",
  };
```

With:
```rust
  let lang_directive = match (lang, kind) {
    ("jp", RollupKind::Week) => "\n- OUTPUT LANGUAGE: Japanese. title の形式は「今週（Mon月Dd日週）」のように日本語化する。",
    ("jp", RollupKind::Day) => "\n- OUTPUT LANGUAGE: Japanese. title の形式は「M月D日（曜日）」のように日本語化する。",
    ("jp", RollupKind::Month) => "\n- OUTPUT LANGUAGE: Japanese. title の形式は「YYYY年M月」のように日本語化する。",
    ("jp", RollupKind::Year) => "\n- OUTPUT LANGUAGE: Japanese. title の形式は「YYYY年」のように日本語化する。",
    ("bi", _) => "\n- OUTPUT LANGUAGE: Match the dominant language of the source items.",
    _ => "\n- OUTPUT LANGUAGE: English.",
  };
```

- [ ] **Step 7: Run cargo check**

Run: `cd /Users/torutano/ShogunAI3/ShogunAI3 && npm run check:rust 2>&1 | tail -20`
Expected: PASS. `summarize_month_rollup` warning about unused function is OK (consumed by Task 4).

- [ ] **Step 8: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/summarizer.rs
git commit -m "feat(memory-rollup): add summarize_month_rollup + extend prompt arms"
```

---

## Task 3: summarize_year_rollup (compositional pipeline)

**Files:**
- Modify: `src-tauri/src/summarizer.rs` — append after `summarize_month_rollup` (added in Task 2) and after the existing `rollup_heuristic_fallback`

- [ ] **Step 1: Add `summarize_year_rollup` after `summarize_month_rollup`**

Insert immediately after the `summarize_month_rollup` function added in Task 2:
```rust
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

  match crate::llm::anthropic_tool_complete(&system, &user_content, &tool, SUMMARIZER_MODEL).await {
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
/// with its short month name + year, followed by the month's title and
/// key points.
fn render_year_context(monthly: &[Summary], year_id: &str) -> String {
  let mut buf = format!("Year: {}\n\nMonthly rollups (chronological):\n", year_id);
  for s in monthly {
    // s.target_id is "YYYY-MM"; produce "Apr 2026" style label.
    let label = month_label_for_id(&s.target_id);
    buf.push_str(&format!(
      "\n[{}] {}\n  · {}\n",
      label,
      s.title,
      s.key_points.join("; "),
    ));
  }
  buf
}

fn month_label_for_id(month_id: &str) -> String {
  // month_id format "YYYY-MM"; degrade gracefully if malformed.
  let parts: Vec<&str> = month_id.split('-').collect();
  if parts.len() != 2 {
    return month_id.to_string();
  }
  let year = parts[0];
  let mo: u32 = parts[1].parse().unwrap_or(0);
  let name = match mo {
    1 => "Jan", 2 => "Feb", 3 => "Mar", 4 => "Apr",
    5 => "May", 6 => "Jun", 7 => "Jul", 8 => "Aug",
    9 => "Sep", 10 => "Oct", 11 => "Nov", 12 => "Dec",
    _ => "?",
  };
  format!("{} {}", name, year)
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
      let label = month_label_for_id(&s.target_id);
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
      "Heuristic year summary (LLM unavailable)",
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
```

- [ ] **Step 2: Run cargo check**

Run: `cd /Users/torutano/ShogunAI3/ShogunAI3 && npm run check:rust 2>&1 | tail -30`
Expected: PASS. Functions `summarize_year_rollup` warning about unused is OK (consumed by Task 4).

- [ ] **Step 3: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/summarizer.rs
git commit -m "feat(memory-rollup): add compositional year rollup (cascades from monthly)"
```

---

## Task 4: Tauri commands + lib.rs registration

**Files:**
- Modify: `src-tauri/src/commands.rs` — append after line 1635 (after `shogun_memory_day_rollup_get`)
- Modify: `src-tauri/src/lib.rs:229-232` — add 2 commands to the `invoke_handler!` list

- [ ] **Step 1: Add `shogun_memory_month_rollup_get` after line 1635**

Insert after the closing `}` of `shogun_memory_day_rollup_get`:
```rust
/// 月次ロールアップ要約を取得 (キャッシュヒット時は即返、無ければ生成)。
///
/// payload: { "monthStartMs": i64, "lang"?: "en" | "jp" | "bi", "regenerate"?: bool }
/// monthStartMs は対象月の1日 00:00 (local) の ms。UI で計算して渡す。
#[tauri::command]
pub async fn shogun_memory_month_rollup_get(payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let month_start_ms = payload
    .get("monthStartMs")
    .and_then(|v| v.as_i64())
    .ok_or_else(|| "monthStartMs is required".to_string())?;
  let lang = payload
    .get("lang")
    .and_then(|v| v.as_str())
    .unwrap_or("en")
    .to_string();
  let regenerate = payload
    .get("regenerate")
    .and_then(|v| v.as_bool())
    .unwrap_or(false);

  let month_id = crate::summarizer::format_month_id(month_start_ms);

  if !regenerate {
    if let Some(cached) = crate::summarizer_store::get_cached("month_rollup", &month_id, &lang)? {
      return Ok(serde_json::json!({ "rollup": cached.to_json(), "cached": true }));
    }
  }

  let rollup = crate::summarizer::summarize_month_rollup(month_start_ms, &lang).await?;
  crate::summarizer_store::upsert(&rollup)?;
  Ok(serde_json::json!({ "rollup": rollup.to_json(), "cached": false }))
}

/// 年次ロールアップ要約 — 構成元は当年内の月次ロールアップ12件。
/// 未キャッシュの月は内部で月次生成→upsert してから合成。
///
/// payload: { "yearStartMs": i64, "lang"?: "en" | "jp" | "bi", "regenerate"?: bool }
/// yearStartMs は対象年の1月1日 00:00 (local) の ms。UI で計算して渡す。
/// regenerate=true は YEAR キャッシュのみ無効化する。月次キャッシュは保持。
#[tauri::command]
pub async fn shogun_memory_year_rollup_get(payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let year_start_ms = payload
    .get("yearStartMs")
    .and_then(|v| v.as_i64())
    .ok_or_else(|| "yearStartMs is required".to_string())?;
  let lang = payload
    .get("lang")
    .and_then(|v| v.as_str())
    .unwrap_or("en")
    .to_string();
  let regenerate = payload
    .get("regenerate")
    .and_then(|v| v.as_bool())
    .unwrap_or(false);

  let year_id = crate::summarizer::format_year_id(year_start_ms);

  if !regenerate {
    if let Some(cached) = crate::summarizer_store::get_cached("year_rollup", &year_id, &lang)? {
      return Ok(serde_json::json!({ "rollup": cached.to_json(), "cached": true }));
    }
  }

  let rollup = crate::summarizer::summarize_year_rollup(year_start_ms, &lang).await?;
  crate::summarizer_store::upsert(&rollup)?;
  Ok(serde_json::json!({ "rollup": rollup.to_json(), "cached": false }))
}
```

- [ ] **Step 2: Register the two new commands in `lib.rs:231-232`**

Replace:
```rust
      commands::shogun_memory_rollup_get,
      commands::shogun_memory_day_rollup_get,
      commands::shogun_memory_summary_set_priority,
```

With:
```rust
      commands::shogun_memory_rollup_get,
      commands::shogun_memory_day_rollup_get,
      commands::shogun_memory_month_rollup_get,
      commands::shogun_memory_year_rollup_get,
      commands::shogun_memory_summary_set_priority,
```

- [ ] **Step 3: Run cargo check**

Run: `cd /Users/torutano/ShogunAI3/ShogunAI3 && npm run check:rust 2>&1 | tail -30`
Expected: PASS, no warnings about unused `summarize_month_rollup` / `summarize_year_rollup` / `format_month_id` / `format_year_id` etc. — all should now be reachable from a `#[tauri::command]`.

- [ ] **Step 4: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(memory-rollup): expose month/year rollup tauri commands"
```

---

## Task 5: Frontend IPC plumbing

**Files:**
- Modify: `hifi/lib/shogun-api.js:38-39` (after `memoryDayRollupGet`)
- Modify: `hifi/lib/action-registry.js:74-75` (after `memory.rollup.day.get`)
- Modify: `hifi/action-map.md:137` (after `- ` `memory.embed_backfill_cancel` `)

- [ ] **Step 1: Add API bindings (shogun-api.js line 39)**

Replace:
```js
      memoryRollupGet: (input) => call("shogun_memory_rollup_get", input, READ),
      memoryDayRollupGet: (input) => call("shogun_memory_day_rollup_get", input, READ),
      memorySummarySetPriority: (input) => call("shogun_memory_summary_set_priority", input, WRITE),
```

With:
```js
      memoryRollupGet: (input) => call("shogun_memory_rollup_get", input, READ),
      memoryDayRollupGet: (input) => call("shogun_memory_day_rollup_get", input, READ),
      memoryMonthRollupGet: (input) => call("shogun_memory_month_rollup_get", input, READ),
      memoryYearRollupGet: (input) => call("shogun_memory_year_rollup_get", input, READ),
      memorySummarySetPriority: (input) => call("shogun_memory_summary_set_priority", input, WRITE),
```

- [ ] **Step 2: Register actions (action-registry.js line 75)**

Replace:
```js
    register("memory.rollup.get", (payload) => api.memoryRollupGet(payload));
    register("memory.rollup.day.get", (payload) => api.memoryDayRollupGet(payload));
    register("memory.summary.set_priority", (payload) => api.memorySummarySetPriority(payload));
```

With:
```js
    register("memory.rollup.get", (payload) => api.memoryRollupGet(payload));
    register("memory.rollup.day.get", (payload) => api.memoryDayRollupGet(payload));
    register("memory.rollup.month.get", (payload) => api.memoryMonthRollupGet(payload));
    register("memory.rollup.year.get", (payload) => api.memoryYearRollupGet(payload));
    register("memory.summary.set_priority", (payload) => api.memorySummarySetPriority(payload));
```

- [ ] **Step 3: Add to action-map.md (line 137 area, the bottom registry list)**

Locate the existing tail of the `- ` `memory.*` ` list (lines 135-136 currently):
```
- `memory.embed_backfill`
- `memory.embed_backfill_cancel`
```

Append two lines so it reads:
```
- `memory.embed_backfill`
- `memory.embed_backfill_cancel`
- `memory.rollup.month.get`
- `memory.rollup.year.get`
```

- [ ] **Step 4: Run check:ipc-mock**

Run: `cd /Users/torutano/ShogunAI3/ShogunAI3 && npm run check:ipc-mock 2>&1 | tail -10`
Expected: PASS. The new commands aren't in either mock file (consistent with existing rollup commands), so no drift.

- [ ] **Step 5: Run check:actions and verify only the two new keys are accounted for**

Run: `cd /Users/torutano/ShogunAI3/ShogunAI3 && python3 hifi/scripts/check-actions.py 2>&1 | tail -40`
Expected: still fails on PRE-EXISTING missing keys (memory.rollup.get, memory.rollup.day.get, etc.), but `memory.rollup.month.get` and `memory.rollup.year.get` should NOT appear in the missing list (they're now in action-map.md). If they DO appear, fix the action-map line addition.

- [ ] **Step 6: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/lib/shogun-api.js hifi/lib/action-registry.js hifi/action-map.md
git commit -m "feat(memory-rollup): wire month/year rollup IPC actions"
```

---

## Task 6: Frontend state + fetch effects

**Files:**
- Modify: `hifi/screens-a.jsx:1696-1697` (state declarations), line ~2085 (after the day-rollup useEffect)

- [ ] **Step 1: Add state declarations (screens-a.jsx line 1697)**

Replace:
```js
  const [dayRollup, setDayRollup] = useState(null); // { title, keyPoints, reason, generatedAt } or null
  const [dayRollupLoading, setDayRollupLoading] = useState(false);
  const [scrubIdx, setScrubIdx] = useState(0);
```

With:
```js
  const [dayRollup, setDayRollup] = useState(null); // { title, keyPoints, reason, generatedAt } or null
  const [dayRollupLoading, setDayRollupLoading] = useState(false);
  const [monthRollup, setMonthRollup] = useState(null);
  const [monthRollupLoading, setMonthRollupLoading] = useState(false);
  const [yearRollup, setYearRollup] = useState(null);
  const [yearRollupLoading, setYearRollupLoading] = useState(false);
  const [scrubIdx, setScrubIdx] = useState(0);
```

- [ ] **Step 2: Add Month + Year rollup fetch effects (line ~2085, between day-rollup effect and the `memorySettingsLoaded` effect)**

Use Edit with `old_string` set to the unique 3-line anchor (the closing of the day-rollup effect immediately followed by the next effect's opener):

```js
    return () => { cancelled = true; };
  }, [timelineSpan, timelineCursor, summaryEnabled, batchSummarizing]);
  useEffect(() => {
    if (!memorySettingsLoaded) return;
```

Set `new_string` to the same anchor with the two new effects spliced in:

```js
    return () => { cancelled = true; };
  }, [timelineSpan, timelineCursor, summaryEnabled, batchSummarizing]);
  // Month rollup — same shape as day/week, calendar-month window.
  useEffect(() => {
    if (!summaryEnabled || timelineSpan !== 'month') {
      setMonthRollup(null);
      return;
    }
    const cursor = new Date(timelineCursor);
    const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1, 0, 0, 0, 0);
    const monthStartMs = monthStart.getTime();
    let cancelled = false;
    setMonthRollupLoading(true);
    (async () => {
      try {
        const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
        const res = await runRuntimeActionA('memory.rollup.month.get', { monthStartMs, lang }, { silentError: true });
        if (cancelled) return;
        if (res?.ok && res.data?.rollup) {
          setMonthRollup(res.data.rollup);
        } else {
          setMonthRollup(null);
        }
      } finally {
        if (!cancelled) setMonthRollupLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [timelineSpan, timelineCursor, summaryEnabled, batchSummarizing]);

  // Year rollup — composed from monthly rollups (cascading on miss).
  useEffect(() => {
    if (!summaryEnabled || timelineSpan !== 'year') {
      setYearRollup(null);
      return;
    }
    const cursor = new Date(timelineCursor);
    const yearStart = new Date(cursor.getFullYear(), 0, 1, 0, 0, 0, 0);
    const yearStartMs = yearStart.getTime();
    let cancelled = false;
    setYearRollupLoading(true);
    (async () => {
      try {
        const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
        const res = await runRuntimeActionA('memory.rollup.year.get', { yearStartMs, lang }, { silentError: true });
        if (cancelled) return;
        if (res?.ok && res.data?.rollup) {
          setYearRollup(res.data.rollup);
        } else {
          setYearRollup(null);
        }
      } finally {
        if (!cancelled) setYearRollupLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [timelineSpan, timelineCursor, summaryEnabled, batchSummarizing]);
  useEffect(() => {
    if (!memorySettingsLoaded) return;
```

- [ ] **Step 3: Verify no JS syntax error**

Visual check the file in an editor for a clean diff. Optional: open `app.jsx` in the running browser dev server (already running on http://127.0.0.1:4173) and confirm Vite/static-server reload reports no parse errors. (No bundler — Hi-Fi runs JSX via in-browser babel; syntax errors will appear in DevTools console.)

- [ ] **Step 4: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/screens-a.jsx
git commit -m "feat(memory-rollup): fetch month/year rollups on span change"
```

---

## Task 7: Frontend UI banners

**Files:**
- Modify: `hifi/screens-a.jsx:2607` (insert two new banner JSX blocks after the existing Week banner closer)

- [ ] **Step 1: Insert Month + Year banner JSX after the Week banner (line ~2608)**

Use Edit with `old_string` set to the unique anchor (the Week banner's closing `)}` followed by a blank line and the River view comment):

```jsx
      )}

      {/* River view: two-card split + hourly timeline scrubber */}
```

Set `new_string` to the same anchor with the two new banners spliced in between:

```jsx
      )}

      {/* Month rollup banner — synthesized digest for the selected calendar month. */}
      {timelineSpan === 'month' && summaryEnabled && (monthRollup || monthRollupLoading) && (
        <div style={{padding:'4px 40px 16px'}}>
          <div style={{
            padding:'14px 18px', borderRadius:12,
            border:'1px solid var(--border)',
            background:'color-mix(in srgb, var(--gold) 4%, var(--surface-2))',
            display:'flex', flexDirection:'column', gap:10,
          }}>
            <div style={{display:'flex', alignItems:'center', gap:10}}>
              <Icon name="memory" size={14} className="gold"/>
              <span className="t-mono" style={{fontSize:11, color:'var(--text-mute)', letterSpacing:'0.14em'}}>
                <span className="en-only">MONTH ROLLUP</span>
                <span className="jp">今月のまとめ</span>
              </span>
              {monthRollupLoading && !monthRollup && (
                <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)', marginLeft:'auto'}}>
                  <span className="en-only">generating…</span>
                  <span className="jp">生成中…</span>
                </span>
              )}
              {monthRollup && (
                <button
                  type="button"
                  onClick={async () => {
                    const cursor = new Date(timelineCursor);
                    const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1, 0, 0, 0, 0);
                    setMonthRollupLoading(true);
                    setMonthRollup(null);
                    const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
                    const res = await runRuntimeActionA('memory.rollup.month.get', {
                      monthStartMs: monthStart.getTime(), lang, regenerate: true,
                    }, { silentError: true });
                    if (res?.ok && res.data?.rollup) setMonthRollup(res.data.rollup);
                    setMonthRollupLoading(false);
                  }}
                  style={{
                    marginLeft:'auto',
                    padding:'2px 0', border:'none', background:'transparent',
                    color:'var(--text-dim)', fontSize:10, cursor:'pointer',
                    fontFamily:'inherit', textDecoration:'underline',
                  }}
                  title="Regenerate this month's rollup"
                >Regenerate</button>
              )}
            </div>
            {monthRollup && (
              <>
                <div style={{fontSize:16, fontWeight:600, lineHeight:1.3, wordBreak:'break-word'}}>
                  {monthRollup.title}
                </div>
                {Array.isArray(monthRollup.keyPoints) && monthRollup.keyPoints.length > 0 && (
                  <ul style={{margin:0, paddingLeft:16, display:'flex', flexDirection:'column', gap:4}}>
                    {monthRollup.keyPoints.slice(0, 6).map((k, i) => (
                      <li key={i} style={{fontSize:13, color:'var(--text)', lineHeight:1.5}}>{k}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Year rollup banner — composed from the year's 12 monthly rollups. */}
      {timelineSpan === 'year' && summaryEnabled && (yearRollup || yearRollupLoading) && (
        <div style={{padding:'4px 40px 16px'}}>
          <div style={{
            padding:'14px 18px', borderRadius:12,
            border:'1px solid var(--border)',
            background:'color-mix(in srgb, var(--gold) 4%, var(--surface-2))',
            display:'flex', flexDirection:'column', gap:10,
          }}>
            <div style={{display:'flex', alignItems:'center', gap:10}}>
              <Icon name="memory" size={14} className="gold"/>
              <span className="t-mono" style={{fontSize:11, color:'var(--text-mute)', letterSpacing:'0.14em'}}>
                <span className="en-only">YEAR ROLLUP</span>
                <span className="jp">今年のまとめ</span>
              </span>
              {yearRollupLoading && !yearRollup && (
                <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)', marginLeft:'auto'}}>
                  <span className="en-only">generating…</span>
                  <span className="jp">生成中…</span>
                </span>
              )}
              {yearRollup && (
                <button
                  type="button"
                  onClick={async () => {
                    const cursor = new Date(timelineCursor);
                    const yearStart = new Date(cursor.getFullYear(), 0, 1, 0, 0, 0, 0);
                    setYearRollupLoading(true);
                    setYearRollup(null);
                    const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
                    const res = await runRuntimeActionA('memory.rollup.year.get', {
                      yearStartMs: yearStart.getTime(), lang, regenerate: true,
                    }, { silentError: true });
                    if (res?.ok && res.data?.rollup) setYearRollup(res.data.rollup);
                    setYearRollupLoading(false);
                  }}
                  style={{
                    marginLeft:'auto',
                    padding:'2px 0', border:'none', background:'transparent',
                    color:'var(--text-dim)', fontSize:10, cursor:'pointer',
                    fontFamily:'inherit', textDecoration:'underline',
                  }}
                  title="Regenerate this year's rollup (cached monthly rollups are reused)"
                >Regenerate</button>
              )}
            </div>
            {yearRollup && (
              <>
                <div style={{fontSize:16, fontWeight:600, lineHeight:1.3, wordBreak:'break-word'}}>
                  {yearRollup.title}
                </div>
                {Array.isArray(yearRollup.keyPoints) && yearRollup.keyPoints.length > 0 && (
                  <ul style={{margin:0, paddingLeft:16, display:'flex', flexDirection:'column', gap:4}}>
                    {yearRollup.keyPoints.slice(0, 6).map((k, i) => (
                      <li key={i} style={{fontSize:13, color:'var(--text)', lineHeight:1.5}}>{k}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* River view: two-card split + hourly timeline scrubber */}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/screens-a.jsx
git commit -m "feat(memory-rollup): add Month/Year rollup banners to Memory timeline"
```

---

## Task 8: Restart desktop app + manual verification

The user's Tauri dev process from the prior session was started with `nohup ./target/debug/app` against the static server on `:4173`. After backend code changes, the binary needs to be rebuilt and relaunched. Frontend (Hi-Fi static JSX) hot-reloads via the static server only — no bundler.

- [ ] **Step 1: Stop the running app and static server**

Run:
```bash
pkill -f "target/debug/app" 2>/dev/null
pkill -f "tauri-dev-static-server.sh" 2>/dev/null
pkill -f "python3 -m http.server 4173" 2>/dev/null
sleep 1
ps aux | grep -E "target/debug/app|http.server 4173" | grep -v grep
```

Expected: empty output (no processes left).

- [ ] **Step 2: Rebuild the rust binary**

Run:
```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -20
```

Expected: `Finished dev [unoptimized + debuginfo] target(s) in N.NNs` with no errors. Warnings are OK.

- [ ] **Step 3: Restart static server (background, detached)**

Run:
```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
nohup bash scripts/tauri-dev-static-server.sh > /tmp/shogun3-server.log 2>&1 &
disown
sleep 2
curl -s -o /dev/null -w "HTTP %{http_code}\n" "http://127.0.0.1:4173/SHOGUN%20Hi-Fi%20UI.html"
```

Expected: `HTTP 200`.

- [ ] **Step 4: Restart the app (background, detached)**

Run:
```bash
cd /Users/torutano/ShogunAI3/ShogunAI3/src-tauri
nohup ./target/debug/app > /tmp/shogun3-app.log 2>&1 &
disown
sleep 4
ps aux | grep "target/debug/app" | grep -v grep
```

Expected: one running process. The Shogun AI window should be visible.

- [ ] **Step 5: Eye-test all four spans in the Memory screen**

Manual checklist (ask the user to confirm):
1. Day span: existing DAY ROLLUP banner still renders. ✓
2. Week span: existing WEEK ROLLUP banner still renders. ✓
3. **Month span: MONTH ROLLUP banner appears** below the month cards. Title + bullets render. Regenerate works.
4. **Year span: YEAR ROLLUP banner appears**. First load may be slow (cascades up to 12 monthly rollups). Subsequent loads are instant (cached). Regenerate works (re-composes from cached monthly rollups).

If banners do not appear:
- Check `/tmp/shogun3-app.log` for `rollup … error` lines
- Open DevTools (`Cmd-Opt-I` in the Tauri window) and look for runtime action errors in the console
- Verify in the browser console that `runRuntimeActionA('memory.rollup.month.get', {monthStartMs: Date.now()})` returns `{ok: true, data: {rollup: …}}`

- [ ] **Step 6: No commit needed for verification.** If a bug surfaces, fix it as a follow-up commit referencing the failing case.

//! Background sampler: macOS frontmost app name ingested as memory (no screenshots).
//! Optional Accessibility-rich snapshot when `sections.capture.axRichCapture` is true.
//! Honors `sections.privacy.excludedApps` / `excludedSites` on every sample.
//!
//! Most helpers here are only reachable through the macOS sampler loop or
//! from unit tests; non-macOS library builds see them as dead. Silencing
//! `dead_code` there keeps `cargo check` quiet on Linux / Windows without
//! hiding genuine dead code on the Mac (where CI runs).

#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

#[cfg(target_os = "macos")]
use crate::macos_ax;
use crate::macos_frontmost::frontmost_focus_snapshot;
use crate::{memory_store, settings_store};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{hash_map::DefaultHasher, BTreeMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
#[cfg(target_os = "macos")]
use tauri::Emitter;
use tauri::Manager;

const RATE_LIMIT_MS: u64 = 120_000;

static LAST_SIG: Mutex<Option<u64>> = Mutex::new(None);
static LAST_AX_SIG: Mutex<Option<u64>> = Mutex::new(None);
static LAST_AX_INGEST_MS: Mutex<Option<u64>> = Mutex::new(None);
#[cfg(target_os = "macos")]
static LAST_AX_EMPTY_LOG_MS: Mutex<Option<u64>> = Mutex::new(None);
#[cfg(target_os = "macos")]
static LAST_AX_TREE_FALLBACK_LOG_MS: Mutex<Option<u64>> = Mutex::new(None);
#[cfg(target_os = "macos")]
static LAST_AX_NOT_TRUSTED_LOG_MS: Mutex<Option<u64>> = Mutex::new(None);
static LAST_INGEST_ERROR_LOG_MS: Mutex<Option<u64>> = Mutex::new(None);
static LAST_FILTER_DROP_LOG_MS: Mutex<Option<u64>> = Mutex::new(None);
static LAST_SAMPLER_DECISION: Mutex<Option<SamplerDecisionSnapshot>> = Mutex::new(None);
static SAMPLER_DECISION_HISTORY: Mutex<VecDeque<SamplerDecisionSnapshot>> =
    Mutex::new(VecDeque::new());

const SAMPLER_DECISION_HISTORY_CAP: usize = 200;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SamplerDecisionSnapshot {
    pub captured_at_ms: u64,
    pub outcome: String,
    pub reason: String,
    pub app_name: Option<String>,
    pub bundle_id: Option<String>,
    pub window_title: Option<String>,
    pub ax_source: Option<String>,
    pub ax_reason: Option<String>,
    pub ax_text_signal_keys: Vec<String>,
    pub ax_text_signal_quality: Option<String>,
    pub text_chars: Option<usize>,
    pub spatial_present: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SamplerCoverageSnapshot {
    pub total: usize,
    pub text_readable: usize,
    pub strong_text_readable: usize,
    pub partial_text_readable: usize,
    pub weak_text_readable: usize,
    pub focus_only: usize,
    pub empty: usize,
    pub skipped: usize,
    pub by_app: Vec<SamplerCoverageApp>,
    pub by_source: Vec<SamplerCoverageSource>,
    pub by_issue: Vec<SamplerCoverageIssue>,
    pub recent: Vec<SamplerDecisionSnapshot>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SamplerCoverageApp {
    pub app_name: String,
    pub bundle_id: Option<String>,
    pub total: usize,
    pub text_readable: usize,
    pub strong_text_readable: usize,
    pub partial_text_readable: usize,
    pub weak_text_readable: usize,
    pub unreadable: usize,
    pub actionable_samples: usize,
    pub focus_only: usize,
    pub empty: usize,
    pub skipped: usize,
    pub latest_at_ms: Option<u64>,
    pub latest_outcome: Option<String>,
    pub latest_reason: Option<String>,
    pub latest_ax_source: Option<String>,
    pub latest_text_chars: Option<usize>,
    pub latest_actionable_at_ms: Option<u64>,
    pub latest_actionable_reason: Option<String>,
    pub latest_actionable_ax_reason: Option<String>,
    pub latest_actionable_ax_source: Option<String>,
    pub latest_actionable_ax_text_signal_keys: Vec<String>,
    pub latest_actionable_recommended_action: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SamplerCoverageSource {
    pub source: String,
    pub total: usize,
    pub text_readable: usize,
    pub strong_text_readable: usize,
    pub partial_text_readable: usize,
    pub weak_text_readable: usize,
    pub empty: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SamplerCoverageIssue {
    pub reason: String,
    pub ax_reason: Option<String>,
    pub severity: String,
    pub recommended_action: String,
    pub total: usize,
    pub text_readable: usize,
    pub strong_text_readable: usize,
    pub partial_text_readable: usize,
    pub weak_text_readable: usize,
    pub unreadable: usize,
    pub actionable: bool,
    pub latest_at_ms: Option<u64>,
    pub latest_app_name: Option<String>,
    pub latest_bundle_id: Option<String>,
    pub latest_window_title: Option<String>,
    pub latest_ax_source: Option<String>,
    pub latest_ax_text_signal_keys: Vec<String>,
}

pub fn last_sampler_decision_snapshot() -> Option<SamplerDecisionSnapshot> {
    LAST_SAMPLER_DECISION
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

fn record_sampler_decision(snapshot: SamplerDecisionSnapshot) {
    if let Ok(mut guard) = LAST_SAMPLER_DECISION.lock() {
        *guard = Some(snapshot.clone());
    }
    if let Ok(mut history) = SAMPLER_DECISION_HISTORY.lock() {
        if history.len() >= SAMPLER_DECISION_HISTORY_CAP {
            history.pop_front();
        }
        history.push_back(snapshot);
    }
}

pub fn sampler_decision_coverage_snapshot(limit: usize) -> SamplerCoverageSnapshot {
    let recent = SAMPLER_DECISION_HISTORY
        .lock()
        .ok()
        .map(|history| {
            history
                .iter()
                .rev()
                .take(limit.min(SAMPLER_DECISION_HISTORY_CAP))
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    sampler_coverage_from_decisions(&recent)
}

fn sampler_coverage_from_decisions(
    decisions: &[SamplerDecisionSnapshot],
) -> SamplerCoverageSnapshot {
    #[derive(Default)]
    struct AppAcc {
        bundle_id: Option<String>,
        total: usize,
        text_readable: usize,
        strong_text_readable: usize,
        partial_text_readable: usize,
        weak_text_readable: usize,
        unreadable: usize,
        actionable_samples: usize,
        focus_only: usize,
        empty: usize,
        skipped: usize,
        latest_at_ms: Option<u64>,
        latest_outcome: Option<String>,
        latest_reason: Option<String>,
        latest_ax_source: Option<String>,
        latest_text_chars: Option<usize>,
        latest_actionable_at_ms: Option<u64>,
        latest_actionable_reason: Option<String>,
        latest_actionable_ax_reason: Option<String>,
        latest_actionable_ax_source: Option<String>,
        latest_actionable_ax_text_signal_keys: Vec<String>,
        latest_actionable_recommended_action: Option<String>,
    }

    #[derive(Default)]
    struct SourceAcc {
        total: usize,
        text_readable: usize,
        strong_text_readable: usize,
        partial_text_readable: usize,
        weak_text_readable: usize,
        empty: usize,
    }

    #[derive(Default)]
    struct IssueAcc {
        reason: String,
        ax_reason: Option<String>,
        total: usize,
        text_readable: usize,
        strong_text_readable: usize,
        partial_text_readable: usize,
        weak_text_readable: usize,
        latest_at_ms: Option<u64>,
        latest_app_name: Option<String>,
        latest_bundle_id: Option<String>,
        latest_window_title: Option<String>,
        latest_ax_source: Option<String>,
        latest_ax_text_signal_keys: Vec<String>,
    }

    let mut total = 0;
    let mut text_readable = 0;
    let mut strong_text_readable = 0;
    let mut partial_text_readable = 0;
    let mut weak_text_readable = 0;
    let mut focus_only = 0;
    let mut empty = 0;
    let mut skipped = 0;
    let mut by_app: BTreeMap<String, AppAcc> = BTreeMap::new();
    let mut by_source: BTreeMap<String, SourceAcc> = BTreeMap::new();
    let mut by_issue: BTreeMap<String, IssueAcc> = BTreeMap::new();

    for decision in decisions {
        total += 1;
        let readable = sampler_decision_has_text(decision);
        let text_quality = sampler_decision_text_quality(decision);
        let focus = sampler_decision_is_focus_only(decision);
        let empty_sample = sampler_decision_is_empty(decision);
        if readable {
            text_readable += 1;
            match text_quality {
                "strong" => strong_text_readable += 1,
                "partial" => partial_text_readable += 1,
                "weak" => weak_text_readable += 1,
                _ => {}
            }
        }
        if focus {
            focus_only += 1;
        }
        if empty_sample {
            empty += 1;
        }
        if decision.outcome == "skipped" {
            skipped += 1;
        }

        let app_key = decision
            .app_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("unknown")
            .to_string();
        let app_acc = by_app.entry(app_key).or_default();
        app_acc.total += 1;
        if app_acc.bundle_id.is_none() {
            app_acc.bundle_id = decision.bundle_id.clone();
        }
        if readable {
            app_acc.text_readable += 1;
            match text_quality {
                "strong" => app_acc.strong_text_readable += 1,
                "partial" => app_acc.partial_text_readable += 1,
                "weak" => app_acc.weak_text_readable += 1,
                _ => {}
            }
        } else {
            app_acc.unreadable += 1;
        }
        if focus {
            app_acc.focus_only += 1;
        }
        if empty_sample {
            app_acc.empty += 1;
        }
        if decision.outcome == "skipped" {
            app_acc.skipped += 1;
        }
        if app_acc
            .latest_at_ms
            .is_none_or(|latest| decision.captured_at_ms > latest)
        {
            app_acc.latest_at_ms = Some(decision.captured_at_ms);
            app_acc.latest_outcome = Some(decision.outcome.clone());
            app_acc.latest_reason = Some(decision.reason.clone());
            app_acc.latest_ax_source = decision.ax_source.clone();
            app_acc.latest_text_chars = decision.text_chars;
        }

        let source_key = decision
            .ax_source
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("none")
            .to_string();
        let source_acc = by_source.entry(source_key).or_default();
        source_acc.total += 1;
        if readable {
            source_acc.text_readable += 1;
            match text_quality {
                "strong" => source_acc.strong_text_readable += 1,
                "partial" => source_acc.partial_text_readable += 1,
                "weak" => source_acc.weak_text_readable += 1,
                _ => {}
            }
        }
        if empty_sample {
            source_acc.empty += 1;
        }

        let weak_readable_issue =
            readable && text_quality == "weak" && decision.outcome != "skipped";
        if !readable || decision.outcome == "skipped" || weak_readable_issue {
            let reason = if weak_readable_issue {
                "weak_text_signal".to_string()
            } else {
                clean_nonempty(Some(decision.reason.as_str()))
                    .unwrap_or("unknown")
                    .to_string()
            };
            let ax_reason = decision
                .ax_reason
                .as_deref()
                .and_then(|reason| clean_nonempty(Some(reason)))
                .map(str::to_string);
            let issue_text_readable = usize::from(readable);
            let issue_unreadable = usize::from(!readable);
            let (severity, recommended_action) =
                issue_recommendation(&reason, ax_reason.as_deref(), issue_text_readable);
            let actionable = issue_is_actionable(
                &reason,
                ax_reason.as_deref(),
                severity,
                issue_text_readable,
                issue_unreadable,
            );
            if actionable {
                app_acc.actionable_samples += 1;
                if app_acc
                    .latest_actionable_at_ms
                    .is_none_or(|latest| decision.captured_at_ms > latest)
                {
                    app_acc.latest_actionable_at_ms = Some(decision.captured_at_ms);
                    app_acc.latest_actionable_reason = Some(reason.clone());
                    app_acc.latest_actionable_ax_reason = ax_reason.clone();
                    app_acc.latest_actionable_ax_source = decision.ax_source.clone();
                    app_acc.latest_actionable_ax_text_signal_keys =
                        decision.ax_text_signal_keys.clone();
                    app_acc.latest_actionable_recommended_action =
                        Some(recommended_action.to_string());
                }
            }
            let issue_key = format!("{}|{}", reason, ax_reason.as_deref().unwrap_or(""));
            let issue_acc = by_issue.entry(issue_key).or_insert_with(|| IssueAcc {
                reason,
                ax_reason,
                ..IssueAcc::default()
            });
            issue_acc.total += 1;
            if readable {
                issue_acc.text_readable += 1;
                match text_quality {
                    "strong" => issue_acc.strong_text_readable += 1,
                    "partial" => issue_acc.partial_text_readable += 1,
                    "weak" => issue_acc.weak_text_readable += 1,
                    _ => {}
                }
            }
            if issue_acc
                .latest_at_ms
                .is_none_or(|latest| decision.captured_at_ms > latest)
            {
                issue_acc.latest_at_ms = Some(decision.captured_at_ms);
                issue_acc.latest_app_name = decision.app_name.clone();
                issue_acc.latest_bundle_id = decision.bundle_id.clone();
                issue_acc.latest_window_title = decision.window_title.clone();
                issue_acc.latest_ax_source = decision.ax_source.clone();
                issue_acc.latest_ax_text_signal_keys = decision.ax_text_signal_keys.clone();
            }
        }
    }

    let mut by_app = by_app
        .into_iter()
        .map(|(app_name, acc)| SamplerCoverageApp {
            app_name,
            bundle_id: acc.bundle_id,
            total: acc.total,
            text_readable: acc.text_readable,
            strong_text_readable: acc.strong_text_readable,
            partial_text_readable: acc.partial_text_readable,
            weak_text_readable: acc.weak_text_readable,
            unreadable: acc.unreadable,
            actionable_samples: acc.actionable_samples,
            focus_only: acc.focus_only,
            empty: acc.empty,
            skipped: acc.skipped,
            latest_at_ms: acc.latest_at_ms,
            latest_outcome: acc.latest_outcome,
            latest_reason: acc.latest_reason,
            latest_ax_source: acc.latest_ax_source,
            latest_text_chars: acc.latest_text_chars,
            latest_actionable_at_ms: acc.latest_actionable_at_ms,
            latest_actionable_reason: acc.latest_actionable_reason,
            latest_actionable_ax_reason: acc.latest_actionable_ax_reason,
            latest_actionable_ax_source: acc.latest_actionable_ax_source,
            latest_actionable_ax_text_signal_keys: acc.latest_actionable_ax_text_signal_keys,
            latest_actionable_recommended_action: acc.latest_actionable_recommended_action,
        })
        .collect::<Vec<_>>();
    by_app.sort_by(|a, b| {
        b.actionable_samples
            .cmp(&a.actionable_samples)
            .then_with(|| b.unreadable.cmp(&a.unreadable))
            .then_with(|| b.total.cmp(&a.total))
            .then_with(|| a.app_name.cmp(&b.app_name))
    });
    by_app.truncate(12);

    let mut by_source = by_source
        .into_iter()
        .map(|(source, acc)| SamplerCoverageSource {
            source,
            total: acc.total,
            text_readable: acc.text_readable,
            strong_text_readable: acc.strong_text_readable,
            partial_text_readable: acc.partial_text_readable,
            weak_text_readable: acc.weak_text_readable,
            empty: acc.empty,
        })
        .collect::<Vec<_>>();
    by_source.sort_by(|a, b| b.total.cmp(&a.total).then_with(|| a.source.cmp(&b.source)));

    let mut by_issue = by_issue
        .into_values()
        .map(|acc| {
            let unreadable = acc.total.saturating_sub(acc.text_readable);
            let (severity, recommended_action) =
                issue_recommendation(&acc.reason, acc.ax_reason.as_deref(), acc.text_readable);
            let actionable = issue_is_actionable(
                &acc.reason,
                acc.ax_reason.as_deref(),
                severity,
                acc.text_readable,
                unreadable,
            );
            SamplerCoverageIssue {
                reason: acc.reason,
                ax_reason: acc.ax_reason,
                severity: severity.to_string(),
                recommended_action: recommended_action.to_string(),
                total: acc.total,
                text_readable: acc.text_readable,
                strong_text_readable: acc.strong_text_readable,
                partial_text_readable: acc.partial_text_readable,
                weak_text_readable: acc.weak_text_readable,
                unreadable,
                actionable,
                latest_at_ms: acc.latest_at_ms,
                latest_app_name: acc.latest_app_name,
                latest_bundle_id: acc.latest_bundle_id,
                latest_window_title: acc.latest_window_title,
                latest_ax_source: acc.latest_ax_source,
                latest_ax_text_signal_keys: acc.latest_ax_text_signal_keys,
            }
        })
        .collect::<Vec<_>>();
    by_issue.sort_by(|a, b| {
        b.actionable
            .cmp(&a.actionable)
            .then_with(|| issue_severity_rank(&b.severity).cmp(&issue_severity_rank(&a.severity)))
            .then_with(|| b.unreadable.cmp(&a.unreadable))
            .then_with(|| b.total.cmp(&a.total))
            .then_with(|| b.latest_at_ms.cmp(&a.latest_at_ms))
            .then_with(|| a.reason.cmp(&b.reason))
    });
    by_issue.truncate(12);

    SamplerCoverageSnapshot {
        total,
        text_readable,
        strong_text_readable,
        partial_text_readable,
        weak_text_readable,
        focus_only,
        empty,
        skipped,
        by_app,
        by_source,
        by_issue,
        recent: decisions.to_vec(),
    }
}

fn sampler_decision_has_text(decision: &SamplerDecisionSnapshot) -> bool {
    decision.text_chars.unwrap_or(0) > 0
        && decision
            .ax_source
            .as_deref()
            .map(|source| source != "empty")
            .unwrap_or(false)
}

fn sampler_decision_text_quality(decision: &SamplerDecisionSnapshot) -> &str {
    decision
        .ax_text_signal_quality
        .as_deref()
        .map(str::trim)
        .filter(|quality| matches!(*quality, "strong" | "partial" | "weak" | "none"))
        .unwrap_or("none")
}

fn sampler_decision_is_focus_only(decision: &SamplerDecisionSnapshot) -> bool {
    !sampler_decision_has_text(decision)
        && matches!(decision.reason.as_str(), "focus" | "focus_after_ax_empty")
}

fn sampler_decision_is_empty(decision: &SamplerDecisionSnapshot) -> bool {
    decision.reason == "ax_empty"
        || decision.ax_source.as_deref() == Some("empty")
        || (!sampler_decision_has_text(decision)
            && matches!(
                decision.ax_reason.as_deref(),
                Some("focused_element_fields_empty" | "focused_element_unavailable")
            ))
}

fn issue_is_actionable(
    reason: &str,
    ax_reason: Option<&str>,
    severity: &str,
    text_readable: usize,
    unreadable: usize,
) -> bool {
    if issue_is_expected_policy_block(reason, ax_reason) {
        return false;
    }

    matches!(severity, "error" | "warn") || unreadable > 0 || text_readable > 0
}

fn issue_is_expected_policy_block(reason: &str, ax_reason: Option<&str>) -> bool {
    matches!(
        reason,
        "excluded_app"
            | "excluded_site"
            | "payment_screen"
            | "incognito_window"
            | "time_block"
            | "sensitive_filter"
            | "secure_text_field"
            | "browser_preview"
    ) || matches!(ax_reason, Some("secure_text_field" | "browser_preview"))
}

fn issue_severity_rank(severity: &str) -> u8 {
    match severity {
        "error" => 3,
        "warn" => 2,
        "info" => 1,
        _ => 0,
    }
}

fn issue_recommendation(
    reason: &str,
    ax_reason: Option<&str>,
    text_readable: usize,
) -> (&'static str, &'static str) {
    let normalized_ax_reason = ax_reason.unwrap_or_default();

    if reason == "accessibility_untrusted" || normalized_ax_reason == "accessibility_untrusted" {
        return (
            "error",
            "Grant macOS Accessibility permission, then refresh the context audit.",
        );
    }

    if reason == "secure_text_field" || normalized_ax_reason == "secure_text_field" {
        return (
            "info",
            "Expected privacy guard for password or secure text fields.",
        );
    }

    match reason {
        "excluded_app" => (
            "info",
            "Privacy exclusion is active for this app; remove it only if capture is desired.",
        ),
        "excluded_site" => (
            "info",
            "Privacy site exclusion is active for this URL or domain.",
        ),
        "payment_screen" | "incognito_window" | "time_block" | "sensitive_filter" => (
            "info",
            "Sensitive-content policy intentionally blocked capture.",
        ),
        "no_frontmost_focus" => (
            "warn",
            "Retry with a normal app window active; if it repeats, inspect frontmost-window detection.",
        ),
        "focused_element_unavailable" => (
            "warn",
            "Keep the target window frontmost; if it repeats, extend window-level AX fallback for this app.",
        ),
        "focused_element_fields_empty" | "focus_after_ax_empty" | "ax_empty" => {
            match normalized_ax_reason {
                "focused_element_unavailable" => (
                    "warn",
                    "Focused AX element is missing; add or tune app/window fallback for the latest app.",
                ),
                "focused_element_fields_empty" => (
                    "warn",
                    "AX element exists but text fields are empty; add child traversal or text-range fallback for the latest app.",
                ),
                "focused_tree_fallback" => (
                    "warn",
                    "Tree fallback ran but found no text; inspect the latest app's AX hierarchy.",
                ),
                _ => (
                    "warn",
                    "No readable AX text captured; inspect the latest app/window and add a targeted fallback.",
                ),
            }
        }
        "focused_tree_fallback" => (
            "warn",
            "Tree fallback was needed; verify the latest app still captures stable text.",
        ),
        "weak_text_signal" => (
            "warn",
            "Only weak AX text signals were captured; add a content-text fallback for the latest app.",
        ),
        _ if text_readable > 0 => (
            "info",
            "Text was readable but capture was skipped; inspect the policy or filter decision.",
        ),
        _ => (
            "warn",
            "No readable text captured; inspect AX source and diagnostic reason for the latest app.",
        ),
    }
}

fn sampler_decision(
    outcome: &str,
    reason: &str,
    app_name: Option<&str>,
    bundle_id: Option<&str>,
    window_title: Option<&str>,
    ax_source: Option<&str>,
    ax_reason: Option<&str>,
    ax_text_signal_keys: &[String],
    ax_text_signal_quality: Option<&str>,
    text_chars: Option<usize>,
    spatial_present: bool,
) -> SamplerDecisionSnapshot {
    SamplerDecisionSnapshot {
        captured_at_ms: now_ms(),
        outcome: outcome.to_string(),
        reason: reason.to_string(),
        app_name: clean_nonempty(app_name).map(str::to_string),
        bundle_id: clean_nonempty(bundle_id).map(str::to_string),
        window_title: clean_nonempty(window_title).map(str::to_string),
        ax_source: clean_nonempty(ax_source).map(str::to_string),
        ax_reason: clean_nonempty(ax_reason).map(str::to_string),
        ax_text_signal_keys: ax_text_signal_keys.to_vec(),
        ax_text_signal_quality: clean_nonempty(ax_text_signal_quality).map(str::to_string),
        text_chars,
        spatial_present,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum IngestOutcome {
    Attempted,
    Deduped,
    Throttled,
}

impl IngestOutcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Attempted => "ingest_attempted",
            Self::Deduped => "deduped",
            Self::Throttled => "throttled",
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Returns true and records `now` when at least `interval_ms` has passed since
/// the stored timestamp (or it is missing). Returns false otherwise.
fn should_trigger_now(last: &Mutex<Option<u64>>, now: u64, interval_ms: u64) -> bool {
    let Ok(mut guard) = last.lock() else {
        return false;
    };
    let ready = guard
        .map(|t| now.saturating_sub(t) >= interval_ms)
        .unwrap_or(true);
    if ready {
        *guard = Some(now);
    }
    ready
}

#[cfg(target_os = "macos")]
struct AxCaptureText {
    text: Option<String>,
    source: &'static str,
    diagnostics: crate::macos_ax::AxDiagnostics,
}

#[cfg(target_os = "macos")]
fn maybe_log_ax_snapshot_empty(frontmost_app: &str, diagnostics: &crate::macos_ax::AxDiagnostics) {
    let trusted = diagnostics.trusted;
    if trusted == Some(false) {
        return;
    }
    if !should_trigger_now(&LAST_AX_EMPTY_LOG_MS, now_ms(), RATE_LIMIT_MS) {
        return;
    }
    if trusted == Some(true) {
        log::info!(
      "capture: axRichCapture on but AX snapshot empty for frontmost={} reason={} role={} focused={} (Accessibility trusted)",
      frontmost_app,
      diagnostics.reason,
      diagnostics.focused_role.as_deref().unwrap_or(""),
      diagnostics.focused_element_present
    );
    } else {
        log::info!(
      "capture: axRichCapture on but AX snapshot empty for frontmost={} reason={} role={} focused={}",
      frontmost_app,
      diagnostics.reason,
      diagnostics.focused_role.as_deref().unwrap_or(""),
      diagnostics.focused_element_present
    );
    }
}

#[cfg(target_os = "macos")]
fn maybe_log_ax_tree_fallback(
    frontmost_app: &str,
    source: &str,
    diagnostics: &crate::macos_ax::AxDiagnostics,
) {
    if diagnostics.reason != "focused_tree_fallback" {
        return;
    }
    if !should_trigger_now(&LAST_AX_TREE_FALLBACK_LOG_MS, now_ms(), RATE_LIMIT_MS) {
        return;
    }
    log::info!(
        "capture: axRichCapture using tree fallback source={} frontmost={} role={} window={}",
        source,
        frontmost_app,
        diagnostics.focused_role.as_deref().unwrap_or(""),
        diagnostics.focused_window_title.as_deref().unwrap_or("")
    );
}

#[cfg(target_os = "macos")]
fn maybe_warn_ax_not_trusted(app: &AppHandle) {
    if !should_trigger_now(&LAST_AX_NOT_TRUSTED_LOG_MS, now_ms(), RATE_LIMIT_MS) {
        return;
    }
    log::warn!(
    "capture: axRichCapture is enabled but Accessibility trust is missing — allow this app in System Settings → Privacy & Security → Accessibility"
  );
    let _ = app.emit(
    "shogun-capture-ax-not-trusted",
    json!({
      "message": "Accessibility permission is required for axRichCapture. Allow this app in System Settings → Privacy & Security → Accessibility.",
    }),
  );
}

fn maybe_log_ingest_error(source: &str, err: &str) {
    if !should_trigger_now(&LAST_INGEST_ERROR_LOG_MS, now_ms(), RATE_LIMIT_MS) {
        return;
    }
    log::warn!("capture: memory ingest failed (source={}): {}", source, err);
}

fn maybe_log_filter_drop(reason: &str) {
    if !should_trigger_now(&LAST_FILTER_DROP_LOG_MS, now_ms(), RATE_LIMIT_MS) {
        return;
    }
    log::info!("capture: dropped by sensitive_filter (reason={})", reason);
}

fn fnv_hash(s: &str) -> u64 {
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

fn clean_nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|s| !s.is_empty())
}

fn clip_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

fn resolve_window_title(primary: Option<&str>, fallback: Option<&str>, app_label: &str) -> String {
    clean_nonempty(primary)
        .or_else(|| clean_nonempty(fallback))
        .unwrap_or_else(|| app_label.trim())
        .to_string()
}

fn focus_title(app: &str, window_title: &str) -> String {
    let app = app.trim();
    let window_title = window_title.trim();
    if window_title.is_empty() || window_title.eq_ignore_ascii_case(app) || window_title == app {
        format!("Focus · {app}")
    } else {
        format!("Focus · {app} — {}", clip_chars(window_title, 64))
    }
}

fn focus_capture_text(app: &str, window_title: &str) -> String {
    let app = app.trim();
    let window_title = window_title.trim();
    if window_title.is_empty() || window_title.eq_ignore_ascii_case(app) || window_title == app {
        format!("Frontmost app (capture sampler): {app}")
    } else {
        format!("Frontmost app (capture sampler): {app}\nwindow={window_title}")
    }
}

/// Pure check on a loaded settings document: is the sampler allowed to run?
///
/// Reads only `sections.capture.paused`. Missing defaults to **running** for MVP
/// ship (install → leave → search). Explicit `paused: true` stops capture.
fn sampler_should_run_for(doc: &Value) -> bool {
    let paused = doc
        .pointer("/sections/capture/paused")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    !paused
}

fn pipeline_should_run() -> bool {
    let Ok(doc) = settings_store::load() else {
        return false;
    };
    sampler_should_run_for(&doc)
}

/// Public wrapper for macOS input helpers.
pub fn pipeline_should_run_public() -> bool {
    pipeline_should_run()
}

fn capture_retention_days() -> u64 {
    settings_store::load()
        .ok()
        .and_then(|d| {
            d.pointer("/sections/capture/retentionDays")
                .and_then(|v| v.as_u64())
        })
        .unwrap_or(30)
        .clamp(1, 3650)
}

fn ax_rich_capture_enabled() -> bool {
    settings_store::load()
        .ok()
        .and_then(|d| {
            d.pointer("/sections/capture/axRichCapture")
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(true)
}

/// Seconds between sampler wakeups when no input event fired (idle fallback).
/// Clamped 4–600, default 5 (screenpipe-style passive capture).
fn idle_sample_interval_secs() -> u64 {
    settings_store::load()
        .ok()
        .and_then(|d| {
            d.pointer("/sections/capture/sampleIntervalSecs")
                .or_else(|| d.pointer("/sections/capture/idleSampleIntervalSecs"))
                .and_then(|v| v.as_u64())
        })
        .unwrap_or(5)
        .clamp(4, 600)
}

/// Minimum seconds between AX memory ingests when content changes (0 = no time gate, hash dedup only).
fn ax_min_interval_secs() -> u64 {
    settings_store::load()
        .ok()
        .and_then(|d| {
            d.pointer("/sections/capture/axMinIntervalSecs")
                .and_then(|v| v.as_u64())
        })
        .unwrap_or(0)
        .clamp(0, 600)
}

/// Normalized privacy filters derived from `sections.privacy.excludedApps` /
/// `excludedSites` with `enabled: true`. Empty collections mean "no filter".
#[derive(Default, Debug, Clone, PartialEq, Eq)]
pub struct PrivacyFilters {
    pub excluded_apps: Vec<String>,
    pub excluded_hosts: Vec<String>,
}

fn normalize_app(s: &str) -> String {
    s.trim().to_ascii_lowercase()
}

fn normalize_host(s: &str) -> String {
    s.trim().trim_end_matches('.').to_ascii_lowercase()
}

fn row_enabled(row: &Value) -> bool {
    // Treat missing `enabled` as true: rows without the key default to active.
    row.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true)
}

fn collect_enabled_strings(arr: &[Value], key: &str, normalize: fn(&str) -> String) -> Vec<String> {
    arr.iter()
        .filter(|row| row_enabled(row))
        .filter_map(|row| row.get(key).and_then(|v| v.as_str()))
        .map(normalize)
        .filter(|s| !s.is_empty())
        .collect()
}

pub fn filters_from_settings(doc: &Value) -> PrivacyFilters {
    let excluded_apps = doc
        .pointer("/sections/privacy/excludedApps")
        .and_then(|v| v.as_array())
        .map(|arr| collect_enabled_strings(arr, "name", normalize_app))
        .unwrap_or_default();
    let excluded_hosts = doc
        .pointer("/sections/privacy/excludedSites")
        .and_then(|v| v.as_array())
        .map(|arr| collect_enabled_strings(arr, "host", normalize_host))
        .unwrap_or_default();
    PrivacyFilters {
        excluded_apps,
        excluded_hosts,
    }
}

pub fn load_privacy_filters() -> PrivacyFilters {
    settings_store::load()
        .ok()
        .as_ref()
        .map(filters_from_settings)
        .unwrap_or_default()
}

fn load_filter_config() -> crate::sensitive_filter::FilterConfig {
    settings_store::load()
        .ok()
        .as_ref()
        .map(crate::sensitive_filter::from_settings)
        .unwrap_or_default()
}

fn current_local_minute_of_week() -> u16 {
    use chrono::{Datelike, Local, Timelike};
    let now = Local::now();
    let day = now.weekday().num_days_from_sunday() as u16; // 0=Sun..6=Sat
    let minute = (now.hour() * 60 + now.minute()) as u16;
    day * 1440 + minute
}

pub fn app_excluded(filters: &PrivacyFilters, app_name: &str, bundle_id: Option<&str>) -> bool {
    let app_needle = normalize_app(app_name);
    let bundle_needle = bundle_id.map(normalize_app);
    filters.excluded_apps.iter().any(|excluded| {
        (!app_needle.is_empty() && excluded == &app_needle)
            || bundle_needle.as_deref() == Some(excluded.as_str())
    })
}

/// Checks whether any excluded host appears in the AX text. Matches the host
/// of any parseable URL as well as bounded bare-hostname tokens, using suffix
/// matching so `internal.corp.example` excludes `mail.internal.corp.example`
/// too. Dotless entries are ignored so a list entry like `internal` cannot
/// accidentally match the English word. `not-internal.corp.example` is
/// rejected because the token before the excluded suffix must end on a label
/// boundary (a dot), not a hyphen.
pub fn ax_text_excluded(filters: &PrivacyFilters, text: &str) -> bool {
    if filters.excluded_hosts.is_empty() || text.is_empty() {
        return false;
    }
    let hosts: Vec<&str> = filters
        .excluded_hosts
        .iter()
        .filter(|h| h.contains('.'))
        .map(String::as_str)
        .collect();
    if hosts.is_empty() {
        return false;
    }
    let lower = text.to_ascii_lowercase();

    for tok in lower.split_whitespace() {
        if !tok.contains("://") {
            continue;
        }
        let clean = tok.trim_end_matches(|c: char| {
            matches!(
                c,
                '.' | ',' | ';' | ')' | ']' | '>' | '"' | '\'' | '!' | '?'
            )
        });
        if let Ok(url) = url::Url::parse(clean) {
            if let Some(h) = url.host_str() {
                if hosts.iter().any(|ex| host_suffix_match(h, ex)) {
                    return true;
                }
            }
        }
    }

    let bytes = lower.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if !is_host_byte(bytes[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && is_host_byte(bytes[i]) {
            i += 1;
        }
        let token = lower[start..i].trim_matches(|c: char| c == '.' || c == '-');
        if token.contains('.') && hosts.iter().any(|ex| host_suffix_match(token, ex)) {
            return true;
        }
    }
    false
}

fn is_host_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-' || b == b'.'
}

/// Returns true when `actual` equals `excluded` or is a subdomain of it
/// (ends with `.<excluded>`). All inputs are expected to be lower-case.
fn host_suffix_match(actual: &str, excluded: &str) -> bool {
    if actual == excluded {
        return true;
    }
    actual.len() > excluded.len()
        && actual.as_bytes()[actual.len() - excluded.len() - 1] == b'.'
        && actual.ends_with(excluded)
}

fn capture_entity_id(prefix: &str, content: &str) -> String {
    format!("{prefix}:{:016x}", fnv_hash(content))
}

#[cfg(target_os = "macos")]
fn build_ax_capture_text() -> AxCaptureText {
    let mut parts: Vec<String> = Vec::new();
    let mut snapshot_present = false;
    let mut tree_present = false;
    let mut window_tree_present = false;
    if let Some(focus) = macos_ax::focused_ax_snapshot() {
        let t = focus.trim();
        if !t.is_empty() {
            snapshot_present = true;
            parts.push(t.to_string());
        }
    }
    if let Some(tree) = macos_ax::focused_ax_tree(3, 48, 4_000) {
        let t = tree.trim();
        if !t.is_empty() {
            tree_present = true;
            parts.push(t.to_string());
        }
    }
    let needs_window_tree = macos_ax::ax_text_needs_deeper_fallback(&parts.join("\n\n"));
    if needs_window_tree {
        if let Some(tree) = macos_ax::focused_window_ax_tree(5, 160, 12_000) {
            let t = tree.trim();
            if !t.is_empty() {
                window_tree_present = true;
                parts.push(t.to_string());
            }
        }
    }
    let diagnostics =
        macos_ax::focused_ax_diagnostics(snapshot_present, tree_present || window_tree_present);
    let source = if snapshot_present {
        if window_tree_present {
            "focused_element_plus_window_tree"
        } else {
            "focused_element"
        }
    } else if tree_present {
        if window_tree_present {
            "focused_tree_plus_window_tree"
        } else {
            "focused_tree"
        }
    } else if window_tree_present {
        "focused_window_tree"
    } else {
        "empty"
    };
    AxCaptureText {
        text: if parts.is_empty() {
            None
        } else {
            Some(parts.join("\n\n"))
        },
        source,
        diagnostics,
    }
}

fn snippet_with_spatial(base: &str, spatial: Option<&str>) -> String {
    let spatial = spatial.map(str::trim).filter(|s| !s.is_empty());
    match spatial {
        Some(s) => format!("spatial={s}\n\n{base}"),
        None => base.to_string(),
    }
}

fn upsert_capture_row(
    app: Option<&AppHandle>,
    app_label: &str,
    source: &str,
    title: &str,
    snippet: &str,
    entity_id: &str,
    kinds: &[&str],
    live_kind: &str,
    live_detail: &str,
) {
    crate::capture_events::record_live(app_label, live_kind, live_detail);
    let mut payload = json!({
      "title": title,
      "snippet": snippet,
      "source": source,
      "kinds": kinds,
      "entity_id": entity_id,
    });
    if let Some(handle) = app {
        if let Some(state) = handle.try_state::<crate::meeting_session::MeetingSessionState>() {
            if let Ok(Some((_id, _started, offset_ms))) = state.active_capture_offset() {
                if let Some(obj) = payload.as_object_mut() {
                    obj.insert("meeting_id".to_string(), json!(_id));
                    obj.insert("meeting_offset_ms".to_string(), json!(offset_ms));
                }
            }
        }
    }
    if let Err(e) = memory_store::ingest_capture_upsert(&payload) {
        maybe_log_ingest_error(source, &e);
    }
}

fn meeting_tags_for_mem_captures(app: Option<&AppHandle>) -> Option<(String, u64)> {
    let handle = app?;
    let state = handle.try_state::<crate::meeting_session::MeetingSessionState>()?;
    let (id, _started, offset) = state.active_capture_offset().ok()??;
    Some((id, offset))
}

fn capture_filter_meta_json(
    meeting_tags: Option<(String, u64)>,
    ax_source: Option<&str>,
    ax_reason: Option<&str>,
    ax_text_signal_keys: &[String],
    ax_text_signal_quality: Option<&str>,
) -> Option<String> {
    let mut meta = serde_json::Map::new();
    if let Some((id, offset)) = meeting_tags {
        meta.insert("meeting_id".to_string(), json!(id));
        meta.insert("meeting_offset_ms".to_string(), json!(offset));
    }
    if let Some(source) = clean_nonempty(ax_source) {
        meta.insert("ax_source".to_string(), json!(source));
    }
    if let Some(reason) = clean_nonempty(ax_reason) {
        meta.insert("ax_reason".to_string(), json!(reason));
    }
    let keys: Vec<&str> = ax_text_signal_keys
        .iter()
        .filter_map(|key| clean_nonempty(Some(key.as_str())))
        .collect();
    if !keys.is_empty() {
        meta.insert("ax_text_signal_keys".to_string(), json!(keys));
    }
    if let Some(quality) = clean_nonempty(ax_text_signal_quality) {
        meta.insert("ax_text_signal_quality".to_string(), json!(quality));
    }
    if meta.is_empty() {
        None
    } else {
        Some(Value::Object(meta).to_string())
    }
}

fn capture_meta_line(
    ax_source: Option<&str>,
    ax_reason: Option<&str>,
    ax_text_signal_keys: &[String],
    ax_text_signal_quality: Option<&str>,
) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(source) = clean_nonempty(ax_source) {
        parts.push(format!("ax_source={source}"));
    }
    if let Some(reason) = clean_nonempty(ax_reason) {
        parts.push(format!("ax_reason={reason}"));
    }
    if let Some(quality) = clean_nonempty(ax_text_signal_quality) {
        parts.push(format!("ax_text_signal_quality={quality}"));
    }
    let keys: Vec<&str> = ax_text_signal_keys
        .iter()
        .filter_map(|key| clean_nonempty(Some(key.as_str())))
        .collect();
    if !keys.is_empty() {
        parts.push(format!("ax_text_signal_keys={}", keys.join(",")));
    }
    if parts.is_empty() {
        None
    } else {
        Some(format!("capture_meta={}", parts.join(" ")))
    }
}

fn maybe_ingest_focus(
    app_handle: Option<&AppHandle>,
    app: &str,
    app_bundle_id: Option<&str>,
    window_title: &str,
    spatial_context_json: Option<String>,
) -> IngestOutcome {
    let sig = fnv_hash(&format!(
        "{}|{}|{}",
        app_bundle_id.unwrap_or(app),
        app,
        window_title
    ));
    if let Ok(mut last) = LAST_SIG.lock() {
        if *last == Some(sig) {
            return IngestOutcome::Deduped;
        }
        *last = Some(sig);
    }

    let settings = settings_store::load().unwrap_or_else(|_| serde_json::json!({}));
    let title = focus_title(app, window_title);
    if crate::kioku_capture::capture_to_mem_captures_flag(&settings) {
        let snippet = focus_capture_text(app, window_title);
        let meeting_meta = meeting_tags_for_mem_captures(app_handle).map(|(id, offset)| {
            json!({ "meeting_id": id, "meeting_offset_ms": offset }).to_string()
        });
        let input = crate::mem_captures::CaptureInput {
            kind: "screen_app".into(),
            raw_text: Some(snippet),
            app_bundle_id: app_bundle_id.map(str::to_string),
            window_title: Some(window_title.to_string()),
            url: None,
            captured_at_ms: now_ms() as i64,
            spatial_context_json: spatial_context_json.clone(),
            filter_meta_json: meeting_meta,
            ..Default::default()
        };
        match memory_store::open_conn() {
            Ok(conn) => {
                if let Err(e) = crate::kioku_capture::route_capture(&input, &conn) {
                    maybe_log_ingest_error("capture_sampler", &e);
                }
            }
            Err(e) => maybe_log_ingest_error("capture_sampler", &e),
        }
        return IngestOutcome::Attempted;
    }

    let entity = capture_entity_id(
        "app",
        &format!("{}|{}|{}", app_bundle_id.unwrap_or(app), app, window_title),
    );
    let snippet = snippet_with_spatial(
        &focus_capture_text(app, window_title),
        spatial_context_json.as_deref(),
    );
    upsert_capture_row(
        app_handle,
        app,
        "capture_sampler",
        &title,
        &snippet,
        &entity,
        &["screen", "focus"],
        "app",
        &title,
    );
    IngestOutcome::Attempted
}

fn maybe_ingest_ax(
    app: &AppHandle,
    text: &str,
    app_label: &str,
    app_bundle_id: Option<&str>,
    window_title: &str,
    ax_source: Option<&str>,
    ax_reason: Option<&str>,
    ax_text_signal_keys: &[String],
    ax_text_signal_quality: Option<&str>,
    spatial_context_json: Option<String>,
) -> IngestOutcome {
    let sig = fnv_hash(&format!(
        "{}|{}|{}|{}",
        app_bundle_id.unwrap_or(app_label),
        app_label,
        window_title,
        text,
    ));
    if let Ok(last_sig) = LAST_AX_SIG.lock() {
        if *last_sig == Some(sig) {
            return IngestOutcome::Deduped;
        }
    }
    let min_iv = ax_min_interval_secs();
    if min_iv > 0 {
        let now = now_ms();
        if let Ok(last_t) = LAST_AX_INGEST_MS.lock() {
            if last_t
                .map(|t| now.saturating_sub(t) < min_iv.saturating_mul(1000))
                .unwrap_or(false)
            {
                return IngestOutcome::Throttled;
            }
        }
    }
    if let Ok(mut last_sig) = LAST_AX_SIG.lock() {
        *last_sig = Some(sig);
    }
    if min_iv > 0 {
        if let Ok(mut last_t) = LAST_AX_INGEST_MS.lock() {
            *last_t = Some(now_ms());
        }
    }
    let snippet_body = text.chars().take(4000).collect::<String>();
    let title = focus_title(app_label, window_title);

    let settings = settings_store::load().unwrap_or_else(|_| serde_json::json!({}));
    if crate::kioku_capture::capture_to_mem_captures_flag(&settings) {
        let filter_meta_json = capture_filter_meta_json(
            meeting_tags_for_mem_captures(Some(app)),
            ax_source,
            ax_reason,
            ax_text_signal_keys,
            ax_text_signal_quality,
        );
        let input = crate::mem_captures::CaptureInput {
            kind: "screen_ax".into(),
            raw_text: Some(snippet_body.clone()),
            app_bundle_id: app_bundle_id.map(str::to_string),
            window_title: Some(window_title.to_string()),
            url: None,
            captured_at_ms: now_ms() as i64,
            spatial_context_json: spatial_context_json.clone(),
            filter_meta_json,
            ..Default::default()
        };
        match memory_store::open_conn() {
            Ok(conn) => {
                if let Err(e) = crate::kioku_capture::route_capture(&input, &conn) {
                    maybe_log_ingest_error("capture_ax", &e);
                }
            }
            Err(e) => maybe_log_ingest_error("capture_ax", &e),
        }
        return IngestOutcome::Attempted;
    }

    let entity = capture_entity_id(
        "ax",
        &format!(
            "{}|{}|{}|{}",
            app_bundle_id.unwrap_or(app_label),
            app_label,
            window_title,
            text,
        ),
    );
    let snippet_with_meta = match capture_meta_line(
        ax_source,
        ax_reason,
        ax_text_signal_keys,
        ax_text_signal_quality,
    ) {
        Some(meta) => format!("{meta}\n\n{snippet_body}"),
        None => snippet_body,
    };
    let snippet = snippet_with_spatial(&snippet_with_meta, spatial_context_json.as_deref());
    upsert_capture_row(
        Some(app),
        app_label,
        "capture_ax",
        &title,
        &snippet,
        &entity,
        &["screen", "accessibility"],
        "ax",
        &title,
    );
    IngestOutcome::Attempted
}

fn run_capture_tick(app: &AppHandle) {
    let filters = load_privacy_filters();
    let filter_cfg = load_filter_config();
    let now_minute_of_week = current_local_minute_of_week();
    if crate::sensitive_filter::is_inside_time_block(&filter_cfg.time_blocks, now_minute_of_week) {
        maybe_log_filter_drop(crate::sensitive_filter::ExclusionReason::TimeBlock.as_log_str());
        record_sampler_decision(sampler_decision(
            "skipped",
            crate::sensitive_filter::ExclusionReason::TimeBlock.as_log_str(),
            None,
            None,
            None,
            None,
            None,
            &[],
            None,
            None,
            false,
        ));
        return;
    }
    #[cfg(target_os = "macos")]
    {
        let frontmost = frontmost_focus_snapshot();
        let app_label = frontmost
            .as_ref()
            .map(|focus| focus.app_name.clone())
            .unwrap_or_else(|| "unknown".to_string());
        let frontmost_bundle_id = frontmost.as_ref().and_then(|focus| focus.bundle_id.clone());
        let frontmost_window_title_hint = frontmost
            .as_ref()
            .and_then(|focus| focus.window_title.clone());
        if let Some(ref focus) = frontmost {
            if app_excluded(&filters, &focus.app_name, focus.bundle_id.as_deref()) {
                record_sampler_decision(sampler_decision(
                    "skipped",
                    "excluded_app",
                    Some(&focus.app_name),
                    focus.bundle_id.as_deref(),
                    focus.window_title.as_deref(),
                    None,
                    None,
                    &[],
                    None,
                    None,
                    false,
                ));
                return;
            }
        }
        let spatial_for_ingest = if ax_rich_capture_enabled() {
            crate::spatial::capture_spatial_context()
        } else {
            None
        };
        let spatial_present = spatial_for_ingest
            .as_deref()
            .map(str::trim)
            .map(|s| !s.is_empty())
            .unwrap_or(false);
        let mut focus_reason = "focus";
        let mut focus_ax_source: Option<&str> = None;
        let mut focus_ax_reason: Option<String> = None;
        if ax_rich_capture_enabled() {
            let ax_trusted = macos_ax::accessibility_trust_status();
            if ax_trusted == Some(false) {
                maybe_warn_ax_not_trusted(app);
            }
            let ax_capture = build_ax_capture_text();
            if let Some(ax) = ax_capture.text.as_deref() {
                let t = ax.trim();
                if !t.is_empty() {
                    let ax_text_signal_keys = macos_ax::ax_text_signal_keys(t);
                    let ax_text_signal_quality =
                        macos_ax::ax_text_signal_quality_for_keys(&ax_text_signal_keys);
                    if ax_capture.source.contains("tree") {
                        maybe_log_ax_tree_fallback(
                            &app_label,
                            ax_capture.source,
                            &ax_capture.diagnostics,
                        );
                    }
                    if ax_text_excluded(&filters, t) {
                        record_sampler_decision(sampler_decision(
                            "skipped",
                            "excluded_site",
                            Some(&app_label),
                            frontmost_bundle_id.as_deref(),
                            frontmost_window_title_hint.as_deref(),
                            Some(ax_capture.source),
                            Some(&ax_capture.diagnostics.reason),
                            &ax_text_signal_keys,
                            Some(ax_text_signal_quality),
                            Some(t.chars().count()),
                            spatial_present,
                        ));
                        return;
                    }
                    let app_name_for_eval = frontmost
                        .as_ref()
                        .map(|focus| focus.app_name.as_str())
                        .unwrap_or(app_label.as_str());
                    let ax_window_title = crate::sensitive_filter::extract_window_title(t);
                    let resolved_window_title = resolve_window_title(
                        ax_window_title,
                        frontmost_window_title_hint.as_deref(),
                        &app_label,
                    );
                    let decision = crate::sensitive_filter::evaluate_capture(
                        &filter_cfg,
                        app_name_for_eval,
                        &resolved_window_title,
                        t,
                        now_minute_of_week,
                    );
                    if !decision.should_ingest {
                        let reason = decision
                            .reason
                            .as_ref()
                            .map(|reason| reason.as_log_str())
                            .unwrap_or("sensitive_filter");
                        record_sampler_decision(sampler_decision(
                            "skipped",
                            reason,
                            Some(app_name_for_eval),
                            frontmost_bundle_id.as_deref(),
                            Some(&resolved_window_title),
                            Some(ax_capture.source),
                            Some(&ax_capture.diagnostics.reason),
                            &ax_text_signal_keys,
                            Some(ax_text_signal_quality),
                            Some(t.chars().count()),
                            spatial_present,
                        ));
                        if let Some(reason) = decision.reason {
                            maybe_log_filter_drop(reason.as_log_str());
                        }
                        return;
                    }
                    let ingest_outcome = maybe_ingest_ax(
                        app,
                        t,
                        &app_label,
                        frontmost_bundle_id.as_deref(),
                        &resolved_window_title,
                        Some(ax_capture.source),
                        Some(&ax_capture.diagnostics.reason),
                        &ax_text_signal_keys,
                        Some(ax_text_signal_quality),
                        spatial_for_ingest.clone(),
                    );
                    record_sampler_decision(sampler_decision(
                        ingest_outcome.as_str(),
                        "ax",
                        Some(&app_label),
                        frontmost_bundle_id.as_deref(),
                        Some(&resolved_window_title),
                        Some(ax_capture.source),
                        Some(&ax_capture.diagnostics.reason),
                        &ax_text_signal_keys,
                        Some(ax_text_signal_quality),
                        Some(t.chars().count()),
                        spatial_present,
                    ));
                    return;
                }
                maybe_log_ax_snapshot_empty(&app_label, &ax_capture.diagnostics);
                focus_reason = "focus_after_ax_empty";
                focus_ax_source = Some(ax_capture.source);
                focus_ax_reason = Some(ax_capture.diagnostics.reason.to_string());
                record_sampler_decision(sampler_decision(
                    "skipped",
                    "ax_empty",
                    Some(&app_label),
                    frontmost_bundle_id.as_deref(),
                    frontmost_window_title_hint.as_deref(),
                    Some(ax_capture.source),
                    Some(&ax_capture.diagnostics.reason),
                    &[],
                    None,
                    None,
                    spatial_present,
                ));
            } else {
                maybe_log_ax_snapshot_empty(&app_label, &ax_capture.diagnostics);
                focus_reason = "focus_after_ax_empty";
                focus_ax_source = Some(ax_capture.source);
                focus_ax_reason = Some(ax_capture.diagnostics.reason.to_string());
                record_sampler_decision(sampler_decision(
                    "skipped",
                    "ax_empty",
                    Some(&app_label),
                    frontmost_bundle_id.as_deref(),
                    frontmost_window_title_hint.as_deref(),
                    Some(ax_capture.source),
                    Some(&ax_capture.diagnostics.reason),
                    &[],
                    None,
                    None,
                    spatial_present,
                ));
            }
        }
        if let Some(frontmost) = frontmost {
            let resolved_window_title =
                resolve_window_title(None, frontmost.window_title.as_deref(), &frontmost.app_name);
            let ingest_outcome = maybe_ingest_focus(
                Some(app),
                &frontmost.app_name,
                frontmost.bundle_id.as_deref(),
                &resolved_window_title,
                spatial_for_ingest.clone(),
            );
            record_sampler_decision(sampler_decision(
                ingest_outcome.as_str(),
                focus_reason,
                Some(&frontmost.app_name),
                frontmost.bundle_id.as_deref(),
                Some(&resolved_window_title),
                focus_ax_source,
                focus_ax_reason.as_deref(),
                &[],
                None,
                None,
                spatial_present,
            ));
        } else {
            record_sampler_decision(sampler_decision(
                "skipped",
                "no_frontmost_focus",
                None,
                None,
                None,
                None,
                None,
                &[],
                None,
                None,
                spatial_present,
            ));
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        record_sampler_decision(sampler_decision(
            "skipped",
            "unsupported_platform",
            None,
            None,
            None,
            None,
            None,
            &[],
            None,
            None,
            false,
        ));
        let _ = (&filters, &filter_cfg, &now_minute_of_week, app);
    }
}

fn start_retention_cleanup_thread() {
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(3600));
        let days = capture_retention_days();
        match memory_store::cleanup_capture_retention(days) {
            Ok(n) if n > 0 => log::info!("capture: retention cleanup removed {n} rows"),
            Err(e) => log::warn!("capture: retention cleanup failed: {e}"),
            _ => {}
        }
    });
}

pub fn start_background_sampler(app: AppHandle) {
    crate::macos_input::start_if_macos();
    start_retention_cleanup_thread();

    std::thread::spawn(move || loop {
        let wake = crate::macos_input::take_sampler_wake();
        let wait = if pipeline_should_run() {
            if wake {
                1
            } else {
                idle_sample_interval_secs()
            }
        } else {
            4
        };
        std::thread::sleep(Duration::from_secs(wait));
        if !pipeline_should_run() {
            continue;
        }
        run_capture_tick(&app);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc_with_privacy(privacy: Value) -> Value {
        json!({ "sections": { "privacy": privacy } })
    }

    #[test]
    fn snippet_with_spatial_prefixes_json() {
        let out = snippet_with_spatial("Frontmost app: Safari", Some(r#"{"quadrant":"NE"}"#));
        assert!(out.starts_with("spatial="));
        assert!(out.contains("Frontmost app: Safari"));
    }

    #[test]
    fn snippet_with_spatial_empty_is_unchanged() {
        assert_eq!(snippet_with_spatial("hello", None), "hello");
        assert_eq!(snippet_with_spatial("hello", Some("  ")), "hello");
    }

    #[test]
    fn capture_filter_meta_json_includes_ax_quality_and_meeting_tags() {
        let keys = vec!["text".to_string(), "value".to_string()];
        let meta = capture_filter_meta_json(
            Some(("meeting-1".to_string(), 42)),
            Some("focused_window_tree"),
            Some("focused_element_weak_signal"),
            &keys,
            Some("strong"),
        )
        .expect("meta json");
        let parsed: Value = serde_json::from_str(&meta).expect("valid json");
        assert_eq!(parsed["meeting_id"], json!("meeting-1"));
        assert_eq!(parsed["meeting_offset_ms"], json!(42));
        assert_eq!(parsed["ax_source"], json!("focused_window_tree"));
        assert_eq!(parsed["ax_reason"], json!("focused_element_weak_signal"));
        assert_eq!(parsed["ax_text_signal_keys"], json!(["text", "value"]));
        assert_eq!(parsed["ax_text_signal_quality"], json!("strong"));
    }

    #[test]
    fn capture_filter_meta_json_omits_empty_ax_fields() {
        assert_eq!(capture_filter_meta_json(None, None, None, &[], None), None);
        let keys = vec![" ".to_string(), "title".to_string()];
        let meta = capture_filter_meta_json(None, Some(" "), None, &keys, Some("weak"))
            .expect("non-empty quality and keys");
        let parsed: Value = serde_json::from_str(&meta).expect("valid json");
        assert!(parsed.get("ax_source").is_none());
        assert_eq!(parsed["ax_text_signal_keys"], json!(["title"]));
        assert_eq!(parsed["ax_text_signal_quality"], json!("weak"));
    }

    #[test]
    fn capture_meta_line_summarizes_ax_fields_for_legacy_capture() {
        let keys = vec!["title".to_string()];
        assert_eq!(
            capture_meta_line(
                Some("focused_element"),
                Some("focused_element_fields_empty"),
                &keys,
                Some("weak"),
            )
            .as_deref(),
            Some(
                "capture_meta=ax_source=focused_element ax_reason=focused_element_fields_empty ax_text_signal_quality=weak ax_text_signal_keys=title"
            )
        );
    }

    #[test]
    fn ax_text_has_content_signal_ignores_role_only_snapshot() {
        assert!(!crate::macos_ax::ax_text_has_content_signal(
            "role=AXGroup\nwindow=Inbox"
        ));
    }

    #[test]
    fn ax_text_has_content_signal_detects_window_tree_values() {
        assert!(crate::macos_ax::ax_text_has_content_signal(
            "ax_window_tree:\n- role=AXStaticText title=Message value=Quarterly plan"
        ));
    }

    fn sampler_decision_for_test(
        captured_at_ms: u64,
        outcome: &str,
        reason: &str,
        app_name: &str,
        ax_source: Option<&str>,
        text_chars: Option<usize>,
    ) -> SamplerDecisionSnapshot {
        SamplerDecisionSnapshot {
            captured_at_ms,
            outcome: outcome.to_string(),
            reason: reason.to_string(),
            app_name: Some(app_name.to_string()),
            bundle_id: Some(format!("com.example.{}", app_name.to_ascii_lowercase())),
            window_title: Some("Window".to_string()),
            ax_source: ax_source.map(str::to_string),
            ax_reason: None,
            ax_text_signal_keys: text_chars
                .map(|_| vec!["text".to_string()])
                .unwrap_or_default(),
            ax_text_signal_quality: text_chars.map(|_| "strong".to_string()),
            text_chars,
            spatial_present: false,
        }
    }

    #[test]
    fn sampler_coverage_groups_by_app_and_source() {
        let mut empty_decision = sampler_decision_for_test(
            2,
            "ingest_attempted",
            "focus_after_ax_empty",
            "Safari",
            Some("empty"),
            None,
        );
        empty_decision.ax_reason = Some("focused_element_fields_empty".to_string());
        let decisions = vec![
            sampler_decision_for_test(
                3,
                "ingest_attempted",
                "ax",
                "Safari",
                Some("focused_window_tree"),
                Some(120),
            ),
            empty_decision,
            sampler_decision_for_test(1, "skipped", "excluded_app", "Finder", None, None),
        ];
        let coverage = sampler_coverage_from_decisions(&decisions);
        assert_eq!(coverage.total, 3);
        assert_eq!(coverage.text_readable, 1);
        assert_eq!(coverage.strong_text_readable, 1);
        assert_eq!(coverage.partial_text_readable, 0);
        assert_eq!(coverage.weak_text_readable, 0);
        assert_eq!(coverage.focus_only, 1);
        assert_eq!(coverage.empty, 1);
        assert_eq!(coverage.skipped, 1);
        assert_eq!(coverage.by_app[0].app_name, "Safari");
        assert_eq!(coverage.by_app[0].text_readable, 1);
        assert_eq!(coverage.by_app[0].strong_text_readable, 1);
        assert_eq!(coverage.by_app[0].unreadable, 1);
        assert_eq!(coverage.by_app[0].actionable_samples, 1);
        assert_eq!(
            coverage.by_app[0].latest_actionable_reason.as_deref(),
            Some("focus_after_ax_empty")
        );
        assert_eq!(
            coverage.by_app[0].latest_actionable_ax_reason.as_deref(),
            Some("focused_element_fields_empty")
        );
        assert!(coverage.by_app[0]
            .latest_actionable_recommended_action
            .as_deref()
            .unwrap_or_default()
            .contains("text-range fallback"));
        assert_eq!(coverage.by_app[0].focus_only, 1);
        assert_eq!(coverage.by_source[0].source, "empty");
        assert_eq!(coverage.by_issue.len(), 2);
        assert_eq!(coverage.by_issue[0].reason, "focus_after_ax_empty");
        assert_eq!(
            coverage.by_issue[0].ax_reason.as_deref(),
            Some("focused_element_fields_empty")
        );
        assert_eq!(coverage.by_issue[0].text_readable, 0);
        assert_eq!(coverage.by_issue[0].strong_text_readable, 0);
        assert_eq!(coverage.by_issue[0].unreadable, 1);
        assert!(coverage.by_issue[0].actionable);
        assert_eq!(coverage.by_issue[0].severity, "warn");
        assert!(coverage.by_issue[0]
            .recommended_action
            .contains("text-range fallback"));
        assert_eq!(
            coverage.by_issue[0].latest_app_name.as_deref(),
            Some("Safari")
        );
        assert_eq!(coverage.by_issue[1].reason, "excluded_app");
        assert_eq!(coverage.by_issue[1].unreadable, 1);
        assert!(!coverage.by_issue[1].actionable);
        assert_eq!(coverage.by_issue[1].severity, "info");
        assert!(coverage.by_issue[1]
            .recommended_action
            .contains("Privacy exclusion"));
    }

    #[test]
    fn sampler_coverage_counts_text_signal_quality() {
        let mut weak = sampler_decision_for_test(
            3,
            "ingest_attempted",
            "ax",
            "Safari",
            Some("focused_element"),
            Some(20),
        );
        weak.ax_text_signal_quality = Some("weak".to_string());
        weak.ax_text_signal_keys = vec!["title".to_string()];
        let mut partial = sampler_decision_for_test(
            2,
            "ingest_attempted",
            "ax",
            "Mail",
            Some("focused_element"),
            Some(60),
        );
        partial.ax_text_signal_quality = Some("partial".to_string());
        let strong = sampler_decision_for_test(
            1,
            "ingest_attempted",
            "ax",
            "Notes",
            Some("focused_element"),
            Some(120),
        );
        let coverage = sampler_coverage_from_decisions(&[weak, partial, strong]);
        assert_eq!(coverage.text_readable, 3);
        assert_eq!(coverage.strong_text_readable, 1);
        assert_eq!(coverage.partial_text_readable, 1);
        assert_eq!(coverage.weak_text_readable, 1);
        let safari = coverage
            .by_app
            .iter()
            .find(|row| row.app_name == "Safari")
            .unwrap();
        assert_eq!(safari.weak_text_readable, 1);
        assert_eq!(safari.actionable_samples, 1);
        assert_eq!(
            safari.latest_actionable_reason.as_deref(),
            Some("weak_text_signal")
        );
        assert_eq!(
            safari.latest_actionable_ax_text_signal_keys,
            vec!["title".to_string()]
        );
        let source = coverage
            .by_source
            .iter()
            .find(|row| row.source == "focused_element")
            .unwrap();
        assert_eq!(source.strong_text_readable, 1);
        assert_eq!(source.partial_text_readable, 1);
        assert_eq!(source.weak_text_readable, 1);
        assert_eq!(coverage.by_issue.len(), 1);
        assert_eq!(coverage.by_issue[0].reason, "weak_text_signal");
        assert_eq!(coverage.by_issue[0].text_readable, 1);
        assert_eq!(coverage.by_issue[0].weak_text_readable, 1);
        assert_eq!(
            coverage.by_issue[0].latest_ax_text_signal_keys,
            vec!["title".to_string()]
        );
        assert_eq!(coverage.by_issue[0].unreadable, 0);
        assert!(coverage.by_issue[0].actionable);
        assert_eq!(coverage.by_issue[0].severity, "warn");
        assert!(coverage.by_issue[0]
            .recommended_action
            .contains("content-text fallback"));
    }

    #[test]
    fn sampler_coverage_includes_skipped_readable_samples_as_issues() {
        let decisions = vec![
            sampler_decision_for_test(
                2,
                "skipped",
                "sensitive_filter",
                "Mail",
                Some("focused_element"),
                Some(80),
            ),
            sampler_decision_for_test(
                1,
                "ingest_attempted",
                "ax",
                "Notes",
                Some("focused_element"),
                Some(120),
            ),
        ];
        let coverage = sampler_coverage_from_decisions(&decisions);
        assert_eq!(coverage.total, 2);
        assert_eq!(coverage.text_readable, 2);
        assert_eq!(coverage.skipped, 1);
        assert_eq!(coverage.by_issue.len(), 1);
        assert_eq!(coverage.by_issue[0].reason, "sensitive_filter");
        assert_eq!(coverage.by_issue[0].text_readable, 1);
        assert_eq!(coverage.by_issue[0].unreadable, 0);
        assert!(!coverage.by_issue[0].actionable);
        assert_eq!(coverage.by_issue[0].severity, "info");
        assert!(coverage.by_issue[0]
            .recommended_action
            .contains("Sensitive-content policy"));
        assert_eq!(
            coverage.by_issue[0].latest_app_name.as_deref(),
            Some("Mail")
        );
    }

    #[test]
    fn sampler_coverage_prioritizes_actionable_unreadable_issues() {
        let mut decisions = vec![
            sampler_decision_for_test(10, "skipped", "excluded_app", "Finder", None, None),
            sampler_decision_for_test(9, "skipped", "excluded_app", "Finder", None, None),
            sampler_decision_for_test(8, "skipped", "excluded_app", "Finder", None, None),
        ];
        let mut empty_decision = sampler_decision_for_test(
            1,
            "ingest_attempted",
            "focus_after_ax_empty",
            "Safari",
            Some("empty"),
            None,
        );
        empty_decision.ax_reason = Some("focused_element_fields_empty".to_string());
        decisions.push(empty_decision);

        let coverage = sampler_coverage_from_decisions(&decisions);
        assert_eq!(coverage.by_app[0].app_name, "Safari");
        assert_eq!(coverage.by_app[0].actionable_samples, 1);
        assert_eq!(coverage.by_app[0].unreadable, 1);
        assert_eq!(coverage.by_app[1].app_name, "Finder");
        assert_eq!(coverage.by_app[1].actionable_samples, 0);
        assert_eq!(coverage.by_app[1].unreadable, 3);
        assert_eq!(coverage.by_issue.len(), 2);
        assert_eq!(coverage.by_issue[0].reason, "focus_after_ax_empty");
        assert!(coverage.by_issue[0].actionable);
        assert_eq!(coverage.by_issue[0].unreadable, 1);
        assert_eq!(coverage.by_issue[1].reason, "excluded_app");
        assert!(!coverage.by_issue[1].actionable);
        assert_eq!(coverage.by_issue[1].unreadable, 3);
    }

    #[test]
    fn resolve_window_title_prefers_primary_then_fallback_then_app() {
        assert_eq!(
            resolve_window_title(Some("Inbox"), Some("Fallback"), "Safari"),
            "Inbox"
        );
        assert_eq!(
            resolve_window_title(None, Some("  Fallback  "), "Safari"),
            "Fallback"
        );
        assert_eq!(resolve_window_title(None, None, "Safari"), "Safari");
    }

    #[test]
    fn focus_title_and_text_include_window_when_distinct() {
        assert_eq!(focus_title("Safari", "Inbox"), "Focus · Safari — Inbox");
        assert_eq!(
            focus_capture_text("Safari", "Inbox"),
            "Frontmost app (capture sampler): Safari\nwindow=Inbox"
        );
    }

    #[test]
    fn focus_title_and_text_drop_duplicate_window_labels() {
        assert_eq!(focus_title("Safari", "Safari"), "Focus · Safari");
        assert_eq!(
            focus_capture_text("Safari", "Safari"),
            "Frontmost app (capture sampler): Safari"
        );
    }

    #[test]
    fn filters_from_settings_reads_enabled_rows_only() {
        let doc = doc_with_privacy(json!({
          "excludedApps": [
            { "name": "Finder", "enabled": true },
            { "name": "1Password", "enabled": true },
            { "name": "Banking", "enabled": false },
            { "name": "", "enabled": true },
          ],
          "excludedSites": [
            { "host": "internal.corp.example", "enabled": true },
            { "host": "pay.vendor.example", "enabled": false },
          ],
        }));
        let f = filters_from_settings(&doc);
        assert_eq!(f.excluded_apps, vec!["finder", "1password"]);
        assert_eq!(f.excluded_hosts, vec!["internal.corp.example"]);
    }

    #[test]
    fn filters_from_settings_tolerates_missing_privacy() {
        assert_eq!(filters_from_settings(&json!({})), PrivacyFilters::default());
        assert_eq!(
            filters_from_settings(&json!({ "sections": {} })),
            PrivacyFilters::default()
        );
    }

    #[test]
    fn filters_from_settings_defaults_missing_enabled_to_true() {
        let doc = doc_with_privacy(json!({
          "excludedApps": [{ "name": "Finder" }],
        }));
        let f = filters_from_settings(&doc);
        assert_eq!(f.excluded_apps, vec!["finder"]);
    }

    #[test]
    fn app_excluded_matches_case_insensitive() {
        let f = PrivacyFilters {
            excluded_apps: vec!["finder".to_string()],
            excluded_hosts: vec![],
        };
        assert!(app_excluded(&f, "Finder", None));
        assert!(app_excluded(&f, "  FINDER  ", None));
        assert!(!app_excluded(&f, "Safari", None));
    }

    #[test]
    fn app_excluded_returns_false_for_empty_input() {
        let f = PrivacyFilters {
            excluded_apps: vec!["finder".to_string()],
            excluded_hosts: vec![],
        };
        assert!(!app_excluded(&f, "", None));
        assert!(!app_excluded(&f, "   ", None));
    }

    #[test]
    fn app_excluded_matches_bundle_id_when_present() {
        let f = PrivacyFilters {
            excluded_apps: vec!["com.google.chrome".to_string()],
            excluded_hosts: vec![],
        };
        assert!(app_excluded(&f, "Google Chrome", Some("com.google.Chrome")));
    }

    #[test]
    fn ax_text_excluded_matches_url_host() {
        let f = PrivacyFilters {
            excluded_apps: vec![],
            excluded_hosts: vec!["internal.corp.example".to_string()],
        };
        assert!(ax_text_excluded(
            &f,
            "role=AXTextField\nvalue=Visit https://Internal.Corp.Example/path today"
        ));
    }

    #[test]
    fn ax_text_excluded_matches_bare_host() {
        let f = PrivacyFilters {
            excluded_apps: vec![],
            excluded_hosts: vec!["internal.corp.example".to_string()],
        };
        assert!(ax_text_excluded(
            &f,
            "window=Internal docs — internal.corp.example"
        ));
    }

    #[test]
    fn ax_text_excluded_ignores_non_matching_host() {
        let f = PrivacyFilters {
            excluded_apps: vec![],
            excluded_hosts: vec!["internal.corp.example".to_string()],
        };
        assert!(!ax_text_excluded(&f, "role=AXButton\nvalue=github.com/foo"));
    }

    #[test]
    fn ax_text_excluded_skips_dotless_hosts() {
        // Dotless entries are rejected to avoid matching arbitrary words.
        let f = PrivacyFilters {
            excluded_apps: vec![],
            excluded_hosts: vec!["internal".to_string()],
        };
        assert!(!ax_text_excluded(&f, "internal notes about this project"));
    }

    #[test]
    fn ax_text_excluded_respects_disabled_rows() {
        let doc = doc_with_privacy(json!({
          "excludedSites": [
            { "host": "internal.corp.example", "enabled": false },
          ],
        }));
        let f = filters_from_settings(&doc);
        assert!(!ax_text_excluded(
            &f,
            "value=https://internal.corp.example/"
        ));
    }

    #[test]
    fn ax_text_excluded_returns_false_when_no_hosts() {
        let f = PrivacyFilters::default();
        assert!(!ax_text_excluded(&f, "anything"));
    }

    #[test]
    fn ax_text_excluded_matches_subdomain_of_excluded_host() {
        let f = PrivacyFilters {
            excluded_apps: vec![],
            excluded_hosts: vec!["internal.corp.example".to_string()],
        };
        assert!(ax_text_excluded(
            &f,
            "value=https://mail.internal.corp.example/inbox"
        ));
        assert!(ax_text_excluded(
            &f,
            "window=Docs — mail.internal.corp.example"
        ));
    }

    #[test]
    fn ax_text_excluded_rejects_hyphen_prefixed_lookalike() {
        // `not-internal.corp.example` must NOT match `internal.corp.example`:
        // the character before the excluded suffix is a hyphen, not a label
        // boundary.
        let f = PrivacyFilters {
            excluded_apps: vec![],
            excluded_hosts: vec!["internal.corp.example".to_string()],
        };
        assert!(!ax_text_excluded(
            &f,
            "value=https://not-internal.corp.example/"
        ));
        assert!(!ax_text_excluded(&f, "window=not-internal.corp.example"));
    }

    #[test]
    fn ax_text_excluded_rejects_longer_tld_lookalike() {
        // `internal.corp.example.gov` is a different domain.
        let f = PrivacyFilters {
            excluded_apps: vec![],
            excluded_hosts: vec!["internal.corp.example".to_string()],
        };
        assert!(!ax_text_excluded(
            &f,
            "value=https://internal.corp.example.gov/"
        ));
        assert!(!ax_text_excluded(
            &f,
            "window=Public site internal.corp.example.gov"
        ));
    }

    #[test]
    fn ax_text_excluded_strips_trailing_url_punctuation() {
        let f = PrivacyFilters {
            excluded_apps: vec![],
            excluded_hosts: vec!["internal.corp.example".to_string()],
        };
        assert!(ax_text_excluded(
            &f,
            "value=See https://internal.corp.example/path."
        ));
        assert!(ax_text_excluded(
            &f,
            "value=(see https://internal.corp.example)"
        ));
    }

    #[test]
    fn ax_text_excluded_tolerates_non_ascii_separators() {
        // Em dash and Japanese punctuation must be treated as non-host bytes
        // without panicking on UTF-8 boundaries.
        let f = PrivacyFilters {
            excluded_apps: vec![],
            excluded_hosts: vec!["internal.corp.example".to_string()],
        };
        assert!(ax_text_excluded(
            &f,
            "window=社内 — internal.corp.example を開く"
        ));
        assert!(!ax_text_excluded(&f, "window=社内 — 別のドメイン"));
    }

    #[test]
    fn should_trigger_now_fires_on_first_call() {
        let slot: Mutex<Option<u64>> = Mutex::new(None);
        assert!(should_trigger_now(&slot, 1_000, 120_000));
        assert_eq!(*slot.lock().unwrap(), Some(1_000));
    }

    #[test]
    fn should_trigger_now_suppresses_within_interval() {
        let slot: Mutex<Option<u64>> = Mutex::new(None);
        assert!(should_trigger_now(&slot, 1_000, 120_000));
        assert!(!should_trigger_now(&slot, 1_000 + 119_999, 120_000));
        assert_eq!(*slot.lock().unwrap(), Some(1_000));
    }

    #[test]
    fn should_trigger_now_fires_again_after_interval() {
        let slot: Mutex<Option<u64>> = Mutex::new(None);
        assert!(should_trigger_now(&slot, 1_000, 120_000));
        assert!(should_trigger_now(&slot, 1_000 + 120_000, 120_000));
        assert_eq!(*slot.lock().unwrap(), Some(121_000));
    }

    #[test]
    fn sampler_on_on_fresh_install() {
        assert!(sampler_should_run_for(&json!({})));
        assert!(sampler_should_run_for(&json!({ "sections": {} })));
        assert!(sampler_should_run_for(
            &json!({ "sections": { "capture": {} } })
        ));
    }

    #[test]
    fn sampler_respects_paused_flag() {
        assert!(!sampler_should_run_for(
            &json!({ "sections": { "capture": { "paused": true } } })
        ));
        assert!(sampler_should_run_for(
            &json!({ "sections": { "capture": { "paused": false } } })
        ));
    }

    #[test]
    fn sampler_ignores_legacy_pipeline_available() {
        // Legacy key should have no effect: user's `paused` decision governs.
        assert!(sampler_should_run_for(&json!({
          "sections": { "capture": { "paused": false, "pipelineAvailable": false } }
        })));
        assert!(!sampler_should_run_for(&json!({
          "sections": { "capture": { "paused": true, "pipelineAvailable": true } }
        })));
    }

    #[test]
    fn sampler_off_when_paused_is_non_bool() {
        // Unparseable value → treat as missing → MVP default (on).
        assert!(sampler_should_run_for(
            &json!({ "sections": { "capture": { "paused": "yes" } } })
        ));
    }
}

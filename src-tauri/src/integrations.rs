//! Integration provider ids (normalized) and local-only connect rules for v1.

pub fn normalize_provider(raw: &str) -> String {
    raw.trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_whitespace() { '_' } else { c })
        .collect::<String>()
        .split('_')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("_")
}

/// Providers where "Connect" can mark local UX state without OAuth.
pub fn allows_local_connect(slug: &str) -> bool {
    matches!(slug, "arc_browser" | "raycast" | "obsidian")
}

/// Providers that accept API tokens via `app_integration_import_credentials`.
pub fn supports_token_import(slug: &str) -> bool {
    matches!(
        slug,
        "slack" | "notion" | "github" | "linear" | "zoom" | "outlook" | "figma" | "claude"
    )
}

/// Google OAuth providers (in-app flow via `shogun_oauth_google_start`).
pub fn supports_google_oauth(slug: &str) -> bool {
    matches!(slug, "gmail" | "google_calendar" | "google_drive")
}

/// macOS-only local Apple apps (Calendar.app / Reminders.app via AppleScript).
pub fn supports_apple_local(slug: &str) -> bool {
    matches!(slug, "apple_calendar" | "apple_reminders")
}

pub fn provider_connected_in_settings(slug: &str) -> Result<bool, String> {
    let doc = crate::settings_store::load()?;
    Ok(doc
        .pointer(&format!(
            "/sections/integrations/providers/{slug}/connected"
        ))
        .and_then(|v| v.as_bool())
        .unwrap_or(false))
}

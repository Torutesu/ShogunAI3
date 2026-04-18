//! Integration provider ids (normalized) and local-only connect rules for v1.

pub fn normalize_provider(raw: &str) -> String {
  raw
    .trim()
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

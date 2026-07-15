//! Clerk: the Hi-Fi UI loads `@clerk/clerk-js` in the main WebView and opens `Clerk.openSignIn` / `openSignUp` (embedded). This module still builds hosted sign-in URLs for **browser fallback** (`auth_open_browser_sign_in`).
//! Set `CLERK_PUBLISHABLE_KEY` and `CLERK_FRONTEND_API` (see repo `.env.example`).

use serde_json::{json, Value};
use std::env;

/// Registered in Clerk dashboard → Redirect URLs, and in `tauri.conf.json` deep-link schemes (`shogun-ai://`).
pub const CLERK_REDIRECT_URL: &str = "shogun-ai://clerk-callback";

pub fn clerk_config() -> Value {
    let pk = env::var("CLERK_PUBLISHABLE_KEY").unwrap_or_default();
    let fe = env::var("CLERK_FRONTEND_API").unwrap_or_default();
    let enabled = !pk.trim().is_empty() && !fe.trim().is_empty();
    let fe_trim = fe.trim().trim_end_matches('/').to_string();
    let clerk_js_url = if enabled {
        format!("{fe_trim}/npm/@clerk/clerk-js@5/dist/clerk.browser.js")
    } else {
        String::new()
    };
    json!({
      "enabled": enabled,
      "publishableKey": pk,
      "frontendApi": fe_trim,
      "clerkJsUrl": clerk_js_url,
      "redirectUrl": CLERK_REDIRECT_URL,
    })
}

fn require_clerk() -> Result<(String, String), String> {
    let c = clerk_config();
    if !c["enabled"].as_bool().unwrap_or(false) {
        return Err(
      "Clerk is not configured. Set CLERK_PUBLISHABLE_KEY and CLERK_FRONTEND_API (see .env.example)."
        .into(),
    );
    }
    let fe = c["frontendApi"]
        .as_str()
        .ok_or_else(|| "invalid CLERK_FRONTEND_API".to_string())?
        .to_string();
    Ok((fe, CLERK_REDIRECT_URL.to_string()))
}

pub fn sign_in_url() -> Result<String, String> {
    let (fe, redirect) = require_clerk()?;
    let enc = urlencoding::encode(&redirect);
    Ok(format!("{fe}/sign-in?redirect_url={enc}"))
}

pub fn sign_up_url() -> Result<String, String> {
    let (fe, redirect) = require_clerk()?;
    let enc = urlencoding::encode(&redirect);
    Ok(format!("{fe}/sign-up?redirect_url={enc}"))
}

/// Web onboarding / entitlement API base (e.g. https://app.shogun.ai or http://localhost:3001).
/// When unset, the desktop entitlement gate is bypassed (local dev).
pub fn billing_config() -> Value {
    let url = env::var("SHOGUN_WEB_APP_URL").unwrap_or_default();
    let trimmed = url.trim().trim_end_matches('/').to_string();
    let enabled = !trimmed.is_empty();
    // Audit F-4: when SHOGUN_BILLING_STRICT=1, a missing/blank web-app URL must
    // fail closed (paywall) instead of silently bypassing the gate — so a
    // release build that forgot to inject the URL doesn't ship an open paywall.
    let strict = env::var("SHOGUN_BILLING_STRICT")
        .map(|v| v.trim() == "1" || v.trim().eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    json!({
      "enabled": enabled,
      "webAppUrl": trimmed,
      "strict": strict,
    })
}

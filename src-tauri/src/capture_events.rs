//! In-memory ring buffer of recent capture events for the Capture UI live tail,
//! plus helpers to format timestamps and push from the sampler / input paths.

use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const RING_CAP: usize = 200;

#[derive(Clone, Debug)]
pub struct LiveEvent {
    pub ts_ms: u64,
    pub app: String,
    pub kind: String,
    pub detail: String,
}

static RING: Mutex<VecDeque<LiveEvent>> = Mutex::new(VecDeque::new());

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn format_hms(ts_ms: u64) -> String {
    let secs = (ts_ms / 1000) as i64;
    let h = (secs / 3600) % 24;
    let m = (secs / 60) % 60;
    let s = secs % 60;
    format!("{h:02}:{m:02}:{s:02}")
}

/// Push a live-tail row (most recent first in API output).
pub fn record_live(app: &str, kind: &str, detail: &str) {
    let ev = LiveEvent {
        ts_ms: now_ms(),
        app: app.trim().to_string(),
        kind: kind.trim().to_string(),
        detail: detail.trim().to_string(),
    };
    if let Ok(mut ring) = RING.lock() {
        ring.push_front(ev);
        while ring.len() > RING_CAP {
            ring.pop_back();
        }
    }
}

pub fn list_recent(limit: usize) -> Vec<Value> {
    let cap = limit.clamp(1, RING_CAP);
    RING.lock()
        .map(|ring| {
            ring.iter()
                .take(cap)
                .map(|ev| {
                    json!({
                      "time": format_hms(ev.ts_ms),
                      "ts_ms": ev.ts_ms,
                      "app": ev.app,
                      "kind": ev.kind,
                      "detail": ev.detail,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn events_last_minute() -> u64 {
    let cutoff = now_ms().saturating_sub(60_000);
    RING.lock()
        .map(|ring| ring.iter().filter(|e| e.ts_ms >= cutoff).count() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_respects_capacity() {
        for i in 0..250 {
            record_live("App", "test", &format!("e{i}"));
        }
        let rows = list_recent(300);
        assert!(rows.len() <= RING_CAP);
    }

    #[test]
    fn format_hms_is_stable() {
        assert_eq!(format_hms(0), "00:00:00");
    }
}

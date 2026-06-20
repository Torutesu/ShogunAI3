//! Dev-only ring buffer of recent LLM call traces. Populated alongside
//! the B-1 `memory_obs` emits; exposed to the frontend via
//! `shogun_memory_debug_recent_calls` (debug builds only).

#![allow(dead_code)]

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Mutex;

pub const RING_CAPACITY: usize = 50;

#[derive(Clone, Debug, Serialize)]
pub enum CallStatus {
    Ok,
    Err(String),
}

#[derive(Clone, Debug, Serialize)]
pub struct CallTrace {
    pub ts_ms: u64,
    pub route: &'static str,
    pub query_preview: String,
    pub query_len: usize,
    pub limit: u64,
    pub semantic: bool,
    pub hits_count: usize,
    pub provenance_counts: ProvenanceCounts,
    pub block_chars: usize,
    pub elapsed_ms: u64,
    pub status: CallStatus,
    pub assembled_block: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct ProvenanceCounts {
    pub screen: u32,
    pub connector: u32,
    pub meeting: u32,
    pub user: u32,
}

/// `tauri::State`-managed ring buffer. Cloned on snapshot.
#[derive(Default)]
pub struct RingBuffer {
    inner: Mutex<VecDeque<CallTrace>>,
}

impl RingBuffer {
    pub fn push(&self, trace: CallTrace) {
        if let Ok(mut q) = self.inner.lock() {
            if q.len() >= RING_CAPACITY {
                q.pop_front();
            }
            q.push_back(trace);
        }
    }

    pub fn snapshot(&self, limit: usize) -> Vec<CallTrace> {
        let Ok(q) = self.inner.lock() else {
            return Vec::new();
        };
        let n = limit.min(q.len());
        q.iter().rev().take(n).cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.inner.lock().map(|q| q.len()).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_trace(route: &'static str, ts_ms: u64) -> CallTrace {
        CallTrace {
            ts_ms,
            route,
            query_preview: String::new(),
            query_len: 0,
            limit: 12,
            semantic: false,
            hits_count: 0,
            provenance_counts: ProvenanceCounts::default(),
            block_chars: 0,
            elapsed_ms: 0,
            status: CallStatus::Ok,
            assembled_block: None,
        }
    }

    #[test]
    fn push_stores_and_snapshot_returns_newest_first() {
        let rb = RingBuffer::default();
        rb.push(mk_trace("chat.complete", 1));
        rb.push(mk_trace("brief.get", 2));
        rb.push(mk_trace("draft_reply", 3));
        let snap = rb.snapshot(10);
        assert_eq!(snap.len(), 3);
        assert_eq!(snap[0].ts_ms, 3);
        assert_eq!(snap[1].ts_ms, 2);
        assert_eq!(snap[2].ts_ms, 1);
    }

    #[test]
    fn push_evicts_oldest_when_full() {
        let rb = RingBuffer::default();
        for i in 0..(RING_CAPACITY + 5) as u64 {
            rb.push(mk_trace("chat.complete", i));
        }
        assert_eq!(rb.len(), RING_CAPACITY);
        let snap = rb.snapshot(RING_CAPACITY);
        // Newest first; oldest surviving is `5` (since 0..4 were evicted).
        assert_eq!(snap[0].ts_ms, (RING_CAPACITY + 4) as u64);
        assert_eq!(snap[RING_CAPACITY - 1].ts_ms, 5);
    }

    #[test]
    fn snapshot_respects_limit_smaller_than_queue() {
        let rb = RingBuffer::default();
        for i in 0..10u64 {
            rb.push(mk_trace("chat.complete", i));
        }
        let snap = rb.snapshot(3);
        assert_eq!(snap.len(), 3);
        assert_eq!(snap[0].ts_ms, 9);
        assert_eq!(snap[2].ts_ms, 7);
    }

    #[test]
    fn snapshot_on_empty_returns_empty_vec() {
        let rb = RingBuffer::default();
        assert!(rb.snapshot(10).is_empty());
    }
}

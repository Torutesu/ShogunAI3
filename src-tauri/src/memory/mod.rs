//! Memory storage layer (incremental split from `memory_store.rs`).
//!
//! `memory_store.rs` remains the implementation entry point; submodules hold
//! shared constants and will absorb connection/search/ingest over time.

pub mod schema;

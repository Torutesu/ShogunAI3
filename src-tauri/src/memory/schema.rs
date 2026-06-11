//! SQLite schema version registry for `memory.db`.
//!
//! Migrations run in `memory_store::open_conn()` via ordered `ensure_*` /
//! `migrate_*` helpers. Bump this when adding a new migration step and record
//! the function name in `MIGRATION_STEPS` for auditability.

/// Monotonic schema generation counter (not yet persisted — preparatory for
/// ordered migration framework in a later phase).
pub const MEMORY_DB_SCHEMA_VERSION: u32 = 1;

/// Human-readable migration order (newest last). Each entry is an `ensure_*` or
/// `migrate_*` invoked from `memory_store::open_conn()` or `kioku_graph_schema`.
pub const MIGRATION_STEPS: &[&str] = &[
  "memory_store::init_schema",
  "memory_store::ensure_embedding_column",
  "memory_store::ensure_context_layer_columns",
  "memory_store::migrate_json_if_needed",
  "kioku_graph_schema::ensure_kioku_graph_schema",
  "meeting_store::ensure_meetings_schema",
  "summarizer_store::ensure_summaries_schema",
  "dead_letter::ensure_dead_letter_schema",
];

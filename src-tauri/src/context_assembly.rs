//! Placeholder module referenced by `llm.rs`. The real context assembly
//! pipeline is maintained in a separate work stream; this stub keeps the
//! crate compiling with no runtime behavior.

#[derive(Debug, Clone)]
pub struct AssembleParams<'a> {
  pub query: &'a str,
  pub limit: u64,
  pub semantic: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Hit {
  pub title: String,
  pub snippet: String,
  pub ts: Option<i64>,
}

pub async fn assemble_memory_hits(_params: AssembleParams<'_>) -> Result<Vec<Hit>, String> {
  Ok(Vec::new())
}

pub fn format_hits_draft_context(_hits: &[Hit], _budget: usize) -> String {
  String::new()
}

pub fn format_hits_reply_draft(_hits: &[Hit]) -> String {
  String::new()
}

pub fn format_hits_brief_json_prompt(_hits: &[Hit], _budget: usize) -> String {
  String::new()
}

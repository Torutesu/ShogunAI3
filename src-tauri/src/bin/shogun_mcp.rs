//! shogun-mcp: Model Context Protocol stdio server exposing ShogunAI3
//! meeting tools to external MCP clients (Claude Desktop, etc.).
//!
//! Stdout is the MCP transport — never println!. All logs go to stderr.

use app_lib::{kioku_mcp, mcp_server, meeting_mcp, memory_mcp};
use rmcp::{
    ServerHandler,
    ErrorData as McpError,
    ServiceExt,
    model::{
        CallToolRequestParam, CallToolResult, Content, Implementation, ListToolsResult,
        PaginatedRequestParam, ProtocolVersion, ServerCapabilities, ServerInfo, Tool,
    },
    service::{RequestContext, RoleServer},
    transport::stdio,
};
use serde_json::Value;
use std::sync::Arc;

#[derive(Clone)]
struct ShogunService;

impl ServerHandler for ShogunService {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            protocol_version: ProtocolVersion::default(),
            capabilities: ServerCapabilities::builder().enable_tools().build(),
            server_info: Implementation {
                name: "shogun-mcp".to_string(),
                title: None,
                version: env!("CARGO_PKG_VERSION").to_string(),
                icons: None,
                website_url: None,
            },
            instructions: Some(
                "ShogunAI3 tools: meetings, memory items, and the kioku knowledge graph. All tools are read-only against the local SQLite DB."
                    .to_string(),
            ),
        }
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParam>,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        let mut arr: Vec<Value> = Vec::new();
        for getter in [
            meeting_mcp::tool_definitions,
            memory_mcp::tool_definitions,
            kioku_mcp::tool_definitions,
        ] {
            if let Some(items) = getter().as_array() {
                arr.extend(items.iter().cloned());
            }
        }
        let tools: Vec<Tool> = arr
            .into_iter()
            // Skip meeting_recipe_run for this MVP — async + LLM-dependent.
            .filter(|t: &Value| t.get("name").and_then(|n| n.as_str()) != Some("shogun.meeting_recipe_run"))
            .filter_map(|t: Value| {
                let name = t.get("name")?.as_str()?.to_string();
                let description = t.get("description")?.as_str()?.to_string();
                let schema = t.get("input_schema")?.clone();
                let schema_obj = schema.as_object()?.clone();
                Some(Tool {
                    name: name.into(),
                    title: None,
                    description: Some(description.into()),
                    input_schema: Arc::new(schema_obj),
                    output_schema: None,
                    annotations: None,
                    icons: None,
                })
            })
            .collect();
        Ok(ListToolsResult { tools, next_cursor: None })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParam,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let args = request
            .arguments
            .map(Value::Object)
            .unwrap_or(Value::Object(Default::default()));
        match mcp_server::dispatch(&request.name, &args) {
            Ok(payload) => {
                // dispatch returns { "content": [ { "type":"text", "text":"..." } ] }
                let texts = payload
                    .get("content")
                    .and_then(|c| c.as_array())
                    .cloned()
                    .unwrap_or_default();
                let content: Vec<Content> = texts
                    .into_iter()
                    .filter_map(|t| t.get("text").and_then(|x| x.as_str()).map(|s| Content::text(s.to_string())))
                    .collect();
                if content.is_empty() {
                    tracing::warn!(
                        tool = %request.name,
                        "dispatch returned Ok but content extraction produced no items; check content_text shape",
                    );
                }
                Ok(CallToolResult::success(content))
            }
            Err(msg) => Ok(CallToolResult::error(vec![Content::text(msg)])),
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let service = ShogunService.serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}

# Connecting ShogunAI3 to Claude Desktop via MCP

The `shogun-mcp` binary is a Model Context Protocol stdio server that exposes
ShogunAI3's meeting data to Claude Desktop. It reads the same local SQLite DB
the Tauri app writes to (WAL mode → safe to run with the app open).

## Build

From the repo root:

```bash
cargo build --manifest-path src-tauri/Cargo.toml --bin shogun-mcp --release
```

The binary lands at `src-tauri/target/release/shogun-mcp`.

## Configure Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` and add:

```json
{
  "mcpServers": {
    "shogun": {
      "command": "/Users/<you>/path/to/ShogunAI3/src-tauri/target/release/shogun-mcp"
    }
  }
}
```

Replace the path with your absolute path to the built binary. Restart Claude
Desktop. In a new chat, the 🛠 icon should show `shogun.meetings_list`,
`shogun.meeting_get`, `shogun.meeting_transcript`, `shogun.meeting_notes`,
`shogun.meetings_search`.

## What's exposed (and what isn't)

**Available now:**

Meeting tools:
- `shogun.meetings_list` — list saved meetings, optional time range
- `shogun.meeting_get` — meeting metadata + transcript + note blocks
- `shogun.meeting_transcript` — final transcript segments
- `shogun.meeting_notes` — note blocks (user / ai / ai_edited)
- `shogun.meetings_search` — keyword FTS across titles, transcripts, notes
- `shogun.meeting_recipe_run` — run a builtin LLM recipe on a meeting (coach-me, follow-up-email, action-items, feature-digest, prd-draft, decision-log). **Calls a remote LLM — costs API budget + adds several seconds of latency per call.**

Memory tools:
- `shogun.memory_search` — lexical search across memory items (notes, decisions, facts)
- `shogun.memory_fetch` — retrieve full content of memory items by ID
- `shogun.memory_entities` — search the entity catalog (people, organizations, projects)

Kioku tools:
- `shogun.kioku_debug_stats` — snapshot of memory subsystem health (queue, cost, graph, flags)
- `shogun.kioku_related` — find related memory items via graph traversal (give a query or seed_ids)

**Not available:**

## Auth

None. ShogunAI3 is a single-user desktop app and `shogun-mcp` is launched as a
stdio subprocess of Claude Desktop on the same machine. The OS process boundary
is the trust boundary; no Clerk, no OAuth, no tokens.

## Logs

`shogun-mcp` writes logs to **stderr** (stdout is the MCP transport). To see
them, launch the binary directly:

```bash
RUST_LOG=debug ./src-tauri/target/release/shogun-mcp
```

Then either pipe MCP frames manually or run via `npx @modelcontextprotocol/inspector`.

# MCP Setup Wizard (Phase 3) Implementation Plan

> **Status:** Implemented on branch `feat/onboarding-billing-web`

**Goal:** Guide new users through connecting Claude Desktop to SHOGUN via MCP after entitlement check passes.

**Architecture:** 4-step fullscreen wizard (`McpSetupGate`) after `EntitlementGate`. Rust helpers read/write `~/Library/Application Support/Claude/claude_desktop_config.json` and resolve the `shogun-mcp` binary path.

---

## App startup order

```
Consent → EntitlementGate → McpSetupGate → MainApp
```

Completion is stored in `settings.json` → `sections.onboarding.mcpComplete`.

---

## Files

| File | Role |
|---|---|
| `src-tauri/src/mcp_setup.rs` | Config merge, detect, verify |
| `src-tauri/src/commands/mcp.rs` | Tauri IPC commands |
| `src/app/McpSetupGate.tsx` | 4-step wizard UI |
| `src/app/AppCore.tsx` | Gate ordering |

## Tauri commands

| Command | Purpose |
|---|---|
| `mcp_setup_detect` | Claude install, config path, binary path |
| `mcp_setup_write_config` | Merge `mcpServers.shogun` + backup |
| `mcp_setup_verify` | Config exists + binary path valid |
| `mcp_setup_complete` | Set `mcpComplete: true` |
| `mcp_setup_open_claude_app` | Open `/Applications/Claude.app` |
| `mcp_setup_open_claude_config` | Reveal config folder in Finder |

---

## Wizard steps

1. **Intro** — Claude Desktop + config status
2. **Binary** — Confirm `shogun-mcp` path (auto-detected or `SHOGUN_MCP_BIN`)
3. **Write** — Merge config (backup created)
4. **Verify** — Restart Claude, optional verify, Done / Skip

---

## Configuration

```bash
# Optional dev override (.env)
SHOGUN_MCP_BIN=/path/to/shogun-mcp
```

Build binary:

```bash
cargo build --manifest-path src-tauri/Cargo.toml --bin shogun-mcp
```

---

## Tests

- Rust: `merge_shogun_server_*` in `mcp_setup.rs`
- TS: `McpSetupGate.test.ts`, `entitlement.test.ts`

---

## Next: Phase 4 — LP waitlist webhook

Connect [shogunai.lovable.app](https://shogunai.lovable.app/) form submissions to `web/` waitlist table.

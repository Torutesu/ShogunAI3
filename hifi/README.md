# SHOGUN Hi-Fi UI

Static **SHOGUN** hi-fi prototype: React via Babel in the browser, optional Tauri IPC, mock transport when Tauri is absent. Open `SHOGUN Hi-Fi UI.html` from the parent folder.

## Key paths

| Path | Purpose |
|------|---------|
| `lib/ipc-client.js` | Tauri `invoke` or mock (`shogun_brief_get`, `shogun_open_pack`, …) |
| `lib/shogun-api.js` | Thin wrappers around IPC commands |
| `lib/action-registry.js` | Maps UI action keys to API methods |
| `lib/morning-brief-contract.js` | Mock Morning Brief v1 (`getMorningBriefMockResponse`) |
| `lib/brief-telemetry.js` | Eval hooks: next-action click, dismiss, rating (`shogunBriefTelemetrySink`) |
| `screens-a.jsx` | Home screen including **Morning Brief (AMC)** card |
| `action-map.md` | Action inventory; keep in sync with `scripts/check-actions.py` |

## Morning Brief (AMC)

- On Home mount, calls `brief.get` and renders `data.brief` when present.
- Primary CTA per row: `next_action.mcp_tool.tool_name` (e.g. `shogun.open_pack`) with `arguments`.
- Production: implement `shogun_brief_get` in Rust/Tauri to return the same JSON shape as `amc-pipeline` (`version`, `headline`, `posture`, `items`, `deferred_count`).

## AMC pipeline (Node)

Candidate pool → LLM → rank → summary lives in **`amc-pipeline/`**. **System prompts are English**; brief text still follows AMC (JP/EN operator). **Model IDs:** set `ANTHROPIC_MODEL` / `ANTHROPIC_SUMMARY_MODEL` (defaults: `claude-opus-4-7` + `claude-sonnet-4-6` per Anthropic docs — see pipeline README).

```bash
cd amc-pipeline && npm install && npm run validate
```

Details: [amc-pipeline/README.md](./amc-pipeline/README.md).

## Checks

```bash
python3 scripts/check-actions.py
```

If the repo root defines Playwright E2E, follow that README for full UI smoke tests.

# AMC Composer (Morning Brief pipeline)

Node package that turns **Morning Brief candidates** into **Actionable Minimum Context (AMC)** items, ranks them with deterministic rules, and emits **Morning Brief JSON v1**. LLM output is constrained with Anthropic **tool_use**: `emit_brief_item` and `emit_brief_summary`.

**Prompting:** system and meta-instructions are **English**; brief lines are still tuned for a Japanese/English technical user per AMC rules (`prompts.js`).

## Quick start

```bash
cd amc-pipeline
npm install
npm run validate # dry run on fixtures + Zod validation
npm run brief:dry   # print full JSON to stdout
```

With a real model:

```bash
cp .env.example .env   # reference only — Node does not auto-load .env unless you use direnv/dotenv-cli
export ANTHROPIC_API_KEY=sk-ant-...
npm run brief:run
```

## Anthropic models (official IDs)

IDs below match the [Claude models overview](https://platform.claude.com/docs/en/about-claude/models/overview) (aliases track the latest snapshot).

| Role | Default env | Default model id |
|------|-------------|-------------------|
| **Composer** (per candidate, quality) | `ANTHROPIC_MODEL` | `claude-opus-4-7` |
| **Summary** (one headline + posture, latency) | `ANTHROPIC_SUMMARY_MODEL` | `claude-sonnet-4-6` |
| **Composer fallback** (overload retry) | `ANTHROPIC_MODEL_FALLBACK` | `claude-sonnet-4-6` |

**How to operate**

1. Set `ANTHROPIC_API_KEY`.
2. Leave defaults: Opus 4.7 for AMC items, Sonnet 4.6 for summary (cheap/fast last step).
3. To force **all Sonnet** (e.g. dev / cost cap): `export ANTHROPIC_MODEL=claude-sonnet-4-6`.
4. To use **Opus for summary too**: `export ANTHROPIC_SUMMARY_MODEL=claude-opus-4-7`.
5. On **429 / 529**, the composer automatically retries once with `ANTHROPIC_MODEL_FALLBACK` (default Sonnet 4.6) if it differs from the primary model.
6. Re-check the docs periodically; deprecated ids (e.g. `claude-*-4-20250514`) have retirement dates listed under [model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations).

Implementation: `src/model-defaults.js`, used by `src/composer.js` and `src/summary.js`.

## Layout

| Path | Role |
|------|------|
| `src/schemas.js` | Zod schemas + Anthropic `input_schema` (no top-level `$ref`) |
| `src/model-defaults.js` | Resolves model ids from env |
| `src/preprocess.js` | Relevance filter (drop below 0.5), duplicate merge, confidence `1 - Π(1-p)` |
| `src/prompts.js` | English system/user prompts + AMC rules |
| `src/composer.js` | One LLM call per candidate; overload fallback |
| `src/heuristic.js` | Dry-run / fallback template |
| `src/validator.js` | AMC rule checks |
| `src/ranker.js` | Spec-style scoring, P1–P3 caps, max 7 items |
| `src/summary.js` | Headline + posture |
| `src/orchestrator.js` | End-to-end, parallel batches of 5 |
| `src/cli.js` | `--dry`, `--validate-only`, `--fixture <path>` |
| `fixtures/mock-candidates.json` | Sample input (extend to ~20 JSONL for eval) |

## Contracts

- **In:** `MorningBriefCandidate` (`candidate_id`, `trigger_source`, `raw_data`, `related_kioku_hits`, `decision_graph_hits`, `available_mcp_tools`, optional `stuck_days`, `same_day_commitment_conflict`).
- **Out:** `MorningBriefJson` (`version: 1`, `headline`, `posture`, `items`, `deferred_count`, …).
- **`related_context.uri`:** `shogun://doc/{doc_id}`.
- **`priority`:** not produced by the LLM; assigned only by the ranker.

## Environment reference

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Required for live runs |
| `ANTHROPIC_MODEL` | Composer primary model (default `claude-opus-4-7`) |
| `ANTHROPIC_SUMMARY_MODEL` | Summary step (default `claude-sonnet-4-6`; does **not** inherit `ANTHROPIC_MODEL`) |
| `ANTHROPIC_MODEL_FALLBACK` | Composer retry model after 429/529 (default `claude-sonnet-4-6`) |

## Remaining product gaps (not “perfect” yet)

- Larger **JSONL** fixture set (~20 rows) for regression metrics.
- **Push / skip notifications** and weekend flows belong in **Tauri / notification** services, not in this package.

## Hi-Fi browser app

See [../README.md](../README.md) for `shogun_brief_get` mock shape and UI wiring.

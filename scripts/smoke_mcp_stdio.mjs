#!/usr/bin/env node
/**
 * smoke_mcp_stdio.mjs — Automated stdio smoke test for shogun-mcp.
 *
 * Usage:
 *   node scripts/smoke_mcp_stdio.mjs [--meeting-id <id>]
 *   SHOGUN_MCP_BIN=/path/to/shogun-mcp node scripts/smoke_mcp_stdio.mjs
 *
 * The script spawns the shogun-mcp binary, sends JSON-RPC frames over stdin
 * (newline-delimited, as used by rmcp's AsyncRwTransport), reads responses,
 * and asserts on the expected shape.
 *
 * Exit 0 if all assertions pass (or all non-blocked assertions pass).
 * Exit 1 if any assertion fails.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BINARY = process.env.SHOGUN_MCP_BIN ?? resolve(
  __dirname,
  "../src-tauri/target/debug/shogun-mcp"
);
const TIMEOUT_MS = 10_000;

// ── helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;
const results = [];

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
    results.push({ label, status: "PASS" });
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
    results.push({ label, status: "FAIL", detail });
  }
}

function skip(label, reason) {
  console.log(`  SKIP  ${label} — ${reason}`);
  skipped++;
  results.push({ label, status: "SKIP", reason });
}

// ── resolve meeting_id ────────────────────────────────────────────────────────

// Parse --meeting-id from argv
let MEETING_ID = null;
const midIdx = process.argv.indexOf("--meeting-id");
if (midIdx !== -1 && process.argv[midIdx + 1]) {
  MEETING_ID = process.argv[midIdx + 1];
}

// If not provided via CLI, try to fetch from DB
if (!MEETING_ID) {
  const DB = `${process.env.HOME}/Library/Application Support/ai.Shogun.ShogunAI3/memory.db`;
  try {
    const row = execFileSync("sqlite3", [DB, "SELECT id FROM meetings LIMIT 1;"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (row) {
      MEETING_ID = row;
      console.log(`  DB meeting_id: ${MEETING_ID}`);
    } else {
      console.log("  DB meeting count: 0 — frame 6 will be SKIPPED");
    }
  } catch (e) {
    console.log(`  Could not query DB: ${e.message} — frame 6 will be SKIPPED`);
  }
}

// ── spawn the binary ──────────────────────────────────────────────────────────

console.log(`\nshogun-mcp stdio smoke test`);
console.log(`binary: ${BINARY}\n`);

const proc = spawn(BINARY, [], {
  stdio: ["pipe", "pipe", "pipe"],
});

const stderrLines = [];
proc.stderr.on("data", (d) => {
  const s = d.toString();
  stderrLines.push(...s.split("\n").filter(Boolean));
});

// Collect stdout lines
const rl = createInterface({ input: proc.stdout });
const responseQueue = [];
const responseWaiters = [];

rl.on("line", (line) => {
  if (!line.trim()) return;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    console.error(`  [stdout non-JSON]: ${line}`);
    return;
  }
  if (responseWaiters.length > 0) {
    const resolve = responseWaiters.shift();
    resolve(parsed);
  } else {
    responseQueue.push(parsed);
  }
});

function nextResponse(timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (responseQueue.length > 0) {
      resolve(responseQueue.shift());
      return;
    }
    const timer = setTimeout(() => {
      const idx = responseWaiters.indexOf(resolve);
      if (idx !== -1) responseWaiters.splice(idx, 1);
      reject(new Error(`Timed out waiting for response after ${timeoutMs}ms`));
    }, timeoutMs);
    responseWaiters.push((val) => {
      clearTimeout(timer);
      resolve(val);
    });
  });
}

function send(frame) {
  proc.stdin.write(JSON.stringify(frame) + "\n");
}

let _callId = 100;
async function sendCall(toolName, args) {
  const id = _callId++;
  send({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });
  return nextResponse();
}

// ── run frames ────────────────────────────────────────────────────────────────

async function run() {
  // ── Frame 1: initialize ───────────────────────────────────────────────────
  console.log("Frame 1: initialize");
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "0.0.1" },
    },
  });

  let r1;
  try {
    r1 = await nextResponse();
  } catch (e) {
    assert("initialize: received response", false, e.message);
    return;
  }

  assert(
    "initialize: no error field",
    !r1.error,
    r1.error ? JSON.stringify(r1.error) : ""
  );
  assert(
    "initialize: result.serverInfo.name == 'shogun-mcp'",
    r1.result?.serverInfo?.name === "shogun-mcp",
    `got: ${r1.result?.serverInfo?.name}`
  );
  assert(
    "initialize: result.protocolVersion present",
    typeof r1.result?.protocolVersion === "string",
    `got: ${r1.result?.protocolVersion}`
  );
  assert(
    "initialize: capabilities.tools present",
    r1.result?.capabilities?.tools !== undefined,
    `capabilities: ${JSON.stringify(r1.result?.capabilities)}`
  );

  // ── Frame 2: initialized notification (no response expected) ─────────────
  console.log("\nFrame 2: notifications/initialized (no response expected)");
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  // Small delay to let the server process the notification
  await new Promise((r) => setTimeout(r, 100));

  // ── Frame 3: tools/list ───────────────────────────────────────────────────
  console.log("\nFrame 3: tools/list");
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

  let r3;
  try {
    r3 = await nextResponse();
  } catch (e) {
    assert("tools/list: received response", false, e.message);
    return;
  }

  assert(
    "tools/list: no error field",
    !r3.error,
    r3.error ? JSON.stringify(r3.error) : ""
  );
  const tools = r3.result?.tools ?? [];
  assert(
    "tools/list: result.tools is array",
    Array.isArray(tools),
    `got: ${typeof tools}`
  );
  assert(
    "tools/list: exactly 11 tools",
    tools.length === 11,
    `got ${tools.length}: ${tools.map((t) => t.name).join(", ")}`
  );

  const toolNames = tools.map((t) => t.name);
  const EXPECTED_TOOLS = [
    "shogun.meetings_list",
    "shogun.meeting_get",
    "shogun.meeting_transcript",
    "shogun.meeting_notes",
    "shogun.meetings_search",
    "shogun.memory_search",
    "shogun.memory_fetch",
    "shogun.memory_entities",
    "shogun.kioku_debug_stats",
    "shogun.kioku_related",
    "shogun.meeting_recipe_run",
  ];
  for (const name of EXPECTED_TOOLS) {
    assert(`tools/list: includes ${name}`, toolNames.includes(name));
  }

  // Check schema field name (inputSchema vs input_schema)
  const firstTool = tools[0];
  const schemaFieldName = firstTool?.inputSchema !== undefined
    ? "inputSchema"
    : firstTool?.input_schema !== undefined
    ? "input_schema"
    : "MISSING";
  console.log(`  [note] tools[0] schema field: ${schemaFieldName}`);

  // ── Frame 4: tools/call meetings_list ─────────────────────────────────────
  console.log("\nFrame 4: tools/call shogun.meetings_list");
  send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "shogun.meetings_list", arguments: { limit: 5 } },
  });

  let r4;
  try {
    r4 = await nextResponse();
  } catch (e) {
    assert("meetings_list: received response", false, e.message);
    return;
  }

  assert(
    "meetings_list: no top-level error",
    !r4.error,
    r4.error ? JSON.stringify(r4.error) : ""
  );
  // is_error / isError — accept either
  const mlIsError = r4.result?.isError ?? r4.result?.is_error ?? false;
  assert(
    "meetings_list: isError is false or absent",
    !mlIsError,
    `isError: ${mlIsError}`
  );
  const mlContent = r4.result?.content ?? [];
  assert(
    "meetings_list: content is non-empty array",
    Array.isArray(mlContent) && mlContent.length > 0,
    `content length: ${mlContent.length}`
  );
  const mlText = mlContent[0]?.text;
  assert(
    "meetings_list: content[0].type == 'text'",
    mlContent[0]?.type === "text",
    `type: ${mlContent[0]?.type}`
  );
  assert(
    "meetings_list: content[0].text is JSON array",
    (() => {
      try {
        const parsed = JSON.parse(mlText);
        return Array.isArray(parsed);
      } catch {
        return false;
      }
    })(),
    `text snippet: ${String(mlText).slice(0, 80)}`
  );

  // ── Frame 5: tools/call meeting_get with missing arg ──────────────────────
  console.log("\nFrame 5: tools/call shogun.meeting_get (missing meeting_id)");
  send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "shogun.meeting_get", arguments: {} },
  });

  let r5;
  try {
    r5 = await nextResponse();
  } catch (e) {
    assert("meeting_get/missing-arg: received response", false, e.message);
    return;
  }

  assert(
    "meeting_get/missing-arg: no top-level error",
    !r5.error,
    r5.error ? JSON.stringify(r5.error) : ""
  );
  const missingIsError = r5.result?.isError ?? r5.result?.is_error;
  assert(
    "meeting_get/missing-arg: isError == true",
    missingIsError === true,
    `isError: ${missingIsError}`
  );
  const missingText = r5.result?.content?.[0]?.text ?? "";
  assert(
    "meeting_get/missing-arg: content[0].text contains 'meeting_id'",
    missingText.includes("meeting_id"),
    `text: ${missingText}`
  );

  // ── Frame 6: tools/call meeting_get with real id ──────────────────────────
  console.log("\nFrame 6: tools/call shogun.meeting_get (real meeting_id)");
  if (!MEETING_ID) {
    skip(
      "meeting_get/real-id: non-error result",
      "no meetings in DB — create a meeting in the app and re-run"
    );
    skip("meeting_get/real-id: content[0].text is non-null JSON", "same reason");
  } else {
    send({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "shogun.meeting_get",
        arguments: { meeting_id: MEETING_ID },
      },
    });

    let r6;
    try {
      r6 = await nextResponse();
    } catch (e) {
      assert("meeting_get/real-id: received response", false, e.message);
      return;
    }

    assert(
      "meeting_get/real-id: no top-level error",
      !r6.error,
      r6.error ? JSON.stringify(r6.error) : ""
    );
    const realIsError = r6.result?.isError ?? r6.result?.is_error ?? false;
    assert(
      "meeting_get/real-id: isError is false or absent",
      !realIsError,
      `isError: ${realIsError}`
    );
    const realText = r6.result?.content?.[0]?.text ?? "";
    assert(
      "meeting_get/real-id: content[0].text is non-null JSON object",
      (() => {
        try {
          const parsed = JSON.parse(realText);
          return parsed !== null && typeof parsed === "object";
        } catch {
          return false;
        }
      })(),
      `text snippet: ${String(realText).slice(0, 80)}`
    );
  }

  // ── Frame 7: shogun.memory_search — happy path ────────────────────────────
  console.log("\nFrame 7: tools/call shogun.memory_search (query='x', limit=3)");
  let r7;
  try {
    r7 = await sendCall("shogun.memory_search", { query: "x", limit: 3 });
  } catch (e) {
    assert("memory_search: received response", false, e.message);
    return;
  }
  assert(
    "memory_search: no top-level error",
    !r7.error,
    r7.error ? JSON.stringify(r7.error) : ""
  );
  const msIsError = r7.result?.isError ?? r7.result?.is_error ?? false;
  assert(
    "memory_search: isError is false or absent",
    !msIsError,
    `isError: ${msIsError}`
  );
  const msText = r7.result?.content?.[0]?.text ?? "";
  assert(
    "memory_search: content[0].text is JSON with `hits` array",
    (() => {
      try {
        const parsed = JSON.parse(msText);
        return parsed !== null && typeof parsed === "object" && Array.isArray(parsed.hits);
      } catch {
        return false;
      }
    })(),
    `text snippet: ${String(msText).slice(0, 120)}`
  );

  // ── Frame 8: shogun.memory_fetch — empty ids (error path) ────────────────
  console.log("\nFrame 8: tools/call shogun.memory_fetch (empty ids — expect error)");
  let r8;
  try {
    r8 = await sendCall("shogun.memory_fetch", { ids: [] });
  } catch (e) {
    assert("memory_fetch/empty-ids: received response", false, e.message);
    return;
  }
  assert(
    "memory_fetch/empty-ids: no top-level error",
    !r8.error,
    r8.error ? JSON.stringify(r8.error) : ""
  );
  const mfIsError = r8.result?.isError ?? r8.result?.is_error;
  assert(
    "memory_fetch/empty-ids: isError == true",
    mfIsError === true,
    `isError: ${mfIsError}`
  );
  const mfText = r8.result?.content?.[0]?.text ?? "";
  assert(
    "memory_fetch/empty-ids: content[0].text contains 'ids'",
    mfText.includes("ids"),
    `text: ${mfText}`
  );

  // ── Frame 9: shogun.memory_entities — happy path ──────────────────────────
  console.log("\nFrame 9: tools/call shogun.memory_entities (q='test')");
  let r9;
  try {
    r9 = await sendCall("shogun.memory_entities", { q: "test" });
  } catch (e) {
    assert("memory_entities: received response", false, e.message);
    return;
  }
  assert(
    "memory_entities: no top-level error",
    !r9.error,
    r9.error ? JSON.stringify(r9.error) : ""
  );
  const meIsError = r9.result?.isError ?? r9.result?.is_error ?? false;
  assert(
    "memory_entities: isError is false or absent",
    !meIsError,
    `isError: ${meIsError}`
  );
  const meText = r9.result?.content?.[0]?.text ?? "";
  assert(
    "memory_entities: content[0].text is JSON with `entities` array",
    (() => {
      try {
        const parsed = JSON.parse(meText);
        return parsed !== null && typeof parsed === "object" && Array.isArray(parsed.entities);
      } catch {
        return false;
      }
    })(),
    `text snippet: ${String(meText).slice(0, 120)}`
  );

  // ── Frame 10: shogun.kioku_debug_stats — no args ──────────────────────────
  console.log("\nFrame 10: tools/call shogun.kioku_debug_stats (no args)");
  let r10;
  try {
    r10 = await sendCall("shogun.kioku_debug_stats", {});
  } catch (e) {
    assert("kioku_debug_stats: received response", false, e.message);
    return;
  }
  assert(
    "kioku_debug_stats: no top-level error",
    !r10.error,
    r10.error ? JSON.stringify(r10.error) : ""
  );
  const kdsIsError = r10.result?.isError ?? r10.result?.is_error ?? false;
  assert(
    "kioku_debug_stats: isError is false or absent",
    !kdsIsError,
    `isError: ${kdsIsError}`
  );
  const kdsText = r10.result?.content?.[0]?.text ?? "";
  assert(
    "kioku_debug_stats: content[0].text is JSON with queue/cost/graph/flags/now_ms keys",
    (() => {
      try {
        const parsed = JSON.parse(kdsText);
        return (
          parsed !== null &&
          typeof parsed === "object" &&
          "queue" in parsed &&
          "cost" in parsed &&
          "graph" in parsed &&
          "flags" in parsed &&
          "now_ms" in parsed
        );
      } catch {
        return false;
      }
    })(),
    `text snippet: ${String(kdsText).slice(0, 160)}`
  );

  // ── Frame 11: shogun.kioku_related — missing args (error path) ───────────
  console.log("\nFrame 11: tools/call shogun.kioku_related (no args — expect error)");
  let r11;
  try {
    r11 = await sendCall("shogun.kioku_related", {});
  } catch (e) {
    assert("kioku_related/no-args: received response", false, e.message);
    return;
  }
  assert(
    "kioku_related/no-args: no top-level error",
    !r11.error,
    r11.error ? JSON.stringify(r11.error) : ""
  );
  const kr1IsError = r11.result?.isError ?? r11.result?.is_error;
  assert(
    "kioku_related/no-args: isError == true",
    kr1IsError === true,
    `isError: ${kr1IsError}`
  );
  const kr1Text = r11.result?.content?.[0]?.text ?? "";
  assert(
    "kioku_related/no-args: content[0].text contains 'query' and 'seed_ids'",
    kr1Text.includes("query") && kr1Text.includes("seed_ids"),
    `text: ${kr1Text}`
  );

  // ── Frame 12: shogun.kioku_related — query='x' (happy path) ──────────────
  console.log("\nFrame 12: tools/call shogun.kioku_related (query='x')");
  let r12;
  try {
    r12 = await sendCall("shogun.kioku_related", { query: "x" });
  } catch (e) {
    assert("kioku_related/query: received response", false, e.message);
    return;
  }
  assert(
    "kioku_related/query: no top-level error",
    !r12.error,
    r12.error ? JSON.stringify(r12.error) : ""
  );
  const kr2IsError = r12.result?.isError ?? r12.result?.is_error ?? false;
  assert(
    "kioku_related/query: isError is false or absent",
    !kr2IsError,
    `isError: ${kr2IsError}`
  );
  const kr2Text = r12.result?.content?.[0]?.text ?? "";
  assert(
    "kioku_related/query: content[0].text is JSON with `hits` array",
    (() => {
      try {
        const parsed = JSON.parse(kr2Text);
        return parsed !== null && typeof parsed === "object" && Array.isArray(parsed.hits);
      } catch {
        return false;
      }
    })(),
    `text snippet: ${String(kr2Text).slice(0, 120)}`
  );

  // ── Frame 13: meeting_recipe_run — missing meeting_id (error path) ─────────
  console.log("\nFrame 13: tools/call shogun.meeting_recipe_run (missing meeting_id — expect error)");
  let r13;
  try {
    r13 = await sendCall("shogun.meeting_recipe_run", { recipe_id: "rec-coach-me" });
  } catch (e) {
    assert("meeting_recipe_run/missing-meeting-id: received response", false, e.message);
    return;
  }
  assert(
    "meeting_recipe_run/missing-meeting-id: no top-level error",
    !r13.error,
    r13.error ? JSON.stringify(r13.error) : ""
  );
  const mrr1IsError = r13.result?.isError ?? r13.result?.is_error;
  assert(
    "meeting_recipe_run/missing-meeting-id: isError == true",
    mrr1IsError === true,
    `isError: ${mrr1IsError}`
  );
  const mrr1Text = r13.result?.content?.[0]?.text ?? "";
  assert(
    "meeting_recipe_run/missing-meeting-id: content[0].text contains 'meeting_id'",
    mrr1Text.includes("meeting_id"),
    `text: ${mrr1Text}`
  );

  // ── Frame 14: meeting_recipe_run — unknown recipe_id (error path) ──────────
  console.log("\nFrame 14: tools/call shogun.meeting_recipe_run (unknown recipe_id — expect error)");
  let r14;
  try {
    r14 = await sendCall("shogun.meeting_recipe_run", { recipe_id: "nonexistent", meeting_id: "x" });
  } catch (e) {
    assert("meeting_recipe_run/unknown-recipe-id: received response", false, e.message);
    return;
  }
  assert(
    "meeting_recipe_run/unknown-recipe-id: no top-level error",
    !r14.error,
    r14.error ? JSON.stringify(r14.error) : ""
  );
  const mrr2IsError = r14.result?.isError ?? r14.result?.is_error;
  assert(
    "meeting_recipe_run/unknown-recipe-id: isError == true",
    mrr2IsError === true,
    `isError: ${mrr2IsError}`
  );
  const mrr2Text = r14.result?.content?.[0]?.text ?? "";
  assert(
    "meeting_recipe_run/unknown-recipe-id: content[0].text contains 'unknown recipe_id'",
    mrr2Text.includes("unknown recipe_id"),
    `text: ${mrr2Text}`
  );

  // ── Frame 15: meeting_recipe_run — empty args (error path) ────────────────
  console.log("\nFrame 15: tools/call shogun.meeting_recipe_run (empty args — expect error)");
  let r15;
  try {
    r15 = await sendCall("shogun.meeting_recipe_run", {});
  } catch (e) {
    assert("meeting_recipe_run/empty-args: received response", false, e.message);
    return;
  }
  assert(
    "meeting_recipe_run/empty-args: no top-level error",
    !r15.error,
    r15.error ? JSON.stringify(r15.error) : ""
  );
  const mrr3IsError = r15.result?.isError ?? r15.result?.is_error;
  assert(
    "meeting_recipe_run/empty-args: isError == true",
    mrr3IsError === true,
    `isError: ${mrr3IsError}`
  );
  const mrr3Text = r15.result?.content?.[0]?.text ?? "";
  assert(
    "meeting_recipe_run/empty-args: content[0].text contains 'recipe_id' or 'meeting_id'",
    mrr3Text.includes("recipe_id") || mrr3Text.includes("meeting_id"),
    `text: ${mrr3Text}`
  );
}

// ── teardown & summary ────────────────────────────────────────────────────────

async function main() {
  try {
    await run();
  } catch (e) {
    console.error(`\nUnhandled error during run: ${e.message}`);
    failed++;
  }

  // Close stdin so the server exits cleanly
  proc.stdin.end();

  // Wait up to 5s for exit
  await new Promise((resolve) => {
    const killTimer = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve();
    }, 5000);
    proc.on("exit", (code) => {
      clearTimeout(killTimer);
      resolve(code);
    });
  });

  console.log("\n─── Summary ───────────────────────────────────────");
  console.log(`  Passed:  ${passed}`);
  console.log(`  Failed:  ${failed}`);
  console.log(`  Skipped: ${skipped}`);

  if (stderrLines.length > 0) {
    console.log("\n─── stderr (first 50 lines) ───────────────────────");
    stderrLines.slice(0, 50).forEach((l) => console.log("  " + l));
  }

  if (failed > 0) {
    console.log("\nRESULT: FAIL");
    process.exit(1);
  } else if (skipped > 0) {
    console.log("\nRESULT: DONE_WITH_CONCERNS (skipped frames due to empty DB)");
    process.exit(0);
  } else {
    console.log("\nRESULT: DONE — all assertions passed");
    process.exit(0);
  }
}

main();

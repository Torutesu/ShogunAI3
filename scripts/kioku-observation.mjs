#!/usr/bin/env node
/**
 * KIOKU Stage 1 observation runner.
 *
 * Reads a user's `memory.db` and produces a Markdown report ready to paste
 * into `docs/kioku-cost-budget.md` §7 for the Stage 2 ship gate
 * (`migration-plan.md` §Select 確認チェックリスト C).
 *
 * Usage
 *   node scripts/kioku-observation.mjs [--db <path>] [--days N] [--user <label>]
 *
 *   --db    Path to memory.db. Defaults to the macOS app data dir for
 *           ai.Shogun.ShogunAI3.
 *   --days  Observation window in days (default 7). Counts are scoped to the
 *           last N days where applicable.
 *   --user  Free-text label for the observed user / device (e.g. "alex-mac").
 *           Embedded in the report so multi-user observations stay legible.
 *
 * Requires the `sqlite3` CLI on $PATH (ships with macOS; `apt install sqlite3`
 * on Debian / Ubuntu). We shell out instead of taking a native dependency so
 * the script runs without `npm install`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const out = { db: null, days: 7, user: os.userInfo().username || "unknown" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") out.db = argv[++i];
    else if (a === "--days") out.days = Number(argv[++i]) || 7;
    else if (a === "--user") out.user = argv[++i];
    else if (a === "-h" || a === "--help") {
      process.stdout.write(import.meta.url + "\nSee module docstring at the top of this file.\n");
      process.exit(0);
    }
  }
  return out;
}

function defaultDbPath() {
  // macOS: ~/Library/Application Support/ai.Shogun.ShogunAI3/memory.db
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "ai.Shogun.ShogunAI3",
      "memory.db",
    );
  }
  // Linux: ~/.local/share/ai.Shogun.ShogunAI3/memory.db
  if (process.platform === "linux") {
    return path.join(
      os.homedir(),
      ".local",
      "share",
      "ai.Shogun.ShogunAI3",
      "memory.db",
    );
  }
  // Windows: %APPDATA%\ai.Shogun.ShogunAI3\memory.db
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || os.homedir(),
      "ai.Shogun.ShogunAI3",
      "memory.db",
    );
  }
  return path.join(os.homedir(), "memory.db");
}

function runQuery(dbPath, sql) {
  const r = spawnSync("sqlite3", ["-readonly", "-cmd", ".mode tabs", dbPath, sql], {
    encoding: "utf8",
  });
  if (r.error) throw new Error(`sqlite3 invocation failed: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`sqlite3 exited ${r.status}: ${r.stderr.trim()}`);
  }
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
}

function tableExists(dbPath, name) {
  const r = runQuery(
    dbPath,
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='${name}' LIMIT 1`,
  );
  return r.length > 0;
}

function fmtNumber(n) {
  if (n == null) return "—";
  if (typeof n === "number") return n.toLocaleString("en-US");
  return String(n);
}

function fmtUsd(v) {
  return `$${(Number(v) || 0).toFixed(4)}`;
}

function reportHeader({ user, days, dbPath, dbExists, hasGraphSchema }) {
  const generatedAt = new Date().toISOString();
  return `## KIOKU observation — ${user} (${days}-day window)

Generated: ${generatedAt}
Source DB: \`${dbPath}\` ${dbExists ? "(found)" : "(missing — observation skipped)"}
Phase 2 schema present: ${hasGraphSchema ? "yes" : "no (running on Phase 1 baseline)"}
`;
}

function captureRateSection(dbPath, days) {
  // mem_items still exists in main; capture_sampler / capture_ax show pre-T4
  // ingestion rates. Once T4 ships and the flag flips, raw rows live in
  // mem_captures instead — both queries below run.
  const sinceMs = Date.now() - days * 86_400_000;
  const lines = ["### 1. Capture rate (last 7 days)\n"];

  if (tableExists(dbPath, "mem_items")) {
    const sourceCounts = runQuery(
      dbPath,
      `SELECT source, COUNT(*) FROM mem_items WHERE created_at >= ${sinceMs} GROUP BY source ORDER BY 2 DESC`,
    );
    if (sourceCounts.length === 0) {
      lines.push("- `mem_items` (legacy capture path): no rows in window");
    } else {
      lines.push("**`mem_items` rows by source (legacy capture path):**", "", "| source | rows | rows/day |", "| --- | --- | --- |");
      for (const [src, rows] of sourceCounts) {
        const rd = (Number(rows) / days).toFixed(1);
        lines.push(`| ${src} | ${fmtNumber(Number(rows))} | ${rd} |`);
      }
      lines.push("");
    }
  }

  if (tableExists(dbPath, "mem_captures")) {
    const captureCounts = runQuery(
      dbPath,
      `SELECT type, COUNT(*) FROM mem_captures WHERE captured_at >= ${sinceMs} GROUP BY type ORDER BY 2 DESC`,
    );
    if (captureCounts.length === 0) {
      lines.push("- `mem_captures` (Stage 2 path): no rows in window");
    } else {
      lines.push("**`mem_captures` rows by type (Stage 2 path):**", "", "| type | rows | rows/day |", "| --- | --- | --- |");
      for (const [t, rows] of captureCounts) {
        const rd = (Number(rows) / days).toFixed(1);
        lines.push(`| ${t} | ${fmtNumber(Number(rows))} | ${rd} |`);
      }
      lines.push("");
    }
  } else {
    lines.push("- `mem_captures` table not present (pre-Stage-2 build).");
    lines.push("");
  }

  return lines.join("\n");
}

function dedupSection(dbPath) {
  const lines = ["### 2. Dedup health (Stage 2 only)\n"];
  if (!tableExists(dbPath, "mem_captures")) {
    lines.push("- mem_captures absent — skipping.");
    return lines.join("\n") + "\n";
  }
  const rows = runQuery(
    dbPath,
    `SELECT extraction_status, COUNT(*) FROM mem_captures GROUP BY extraction_status ORDER BY 2 DESC`,
  );
  if (rows.length === 0) {
    lines.push("- No mem_captures rows.");
    return lines.join("\n") + "\n";
  }
  lines.push("| extraction_status | rows |", "| --- | --- |");
  for (const [s, n] of rows) lines.push(`| ${s} | ${fmtNumber(Number(n))} |`);
  // Skipped count = significance filter dropped them. Compare to total to get
  // a rough "filter aggressiveness" reading.
  const skipped = Number((rows.find((r) => r[0] === "skipped") || [, 0])[1]);
  const total = rows.reduce((a, r) => a + Number(r[1]), 0);
  if (total > 0) {
    const pct = ((skipped / total) * 100).toFixed(1);
    lines.push(`\n- Significance-filter skip rate: **${pct}%** (target ~65%, see cost-budget §3.2).`);
  }
  return lines.join("\n") + "\n";
}

function costSection(dbPath, days) {
  const lines = ["### 3. BYOK cost ledger\n"];
  if (!tableExists(dbPath, "cost_ledger")) {
    lines.push("- cost_ledger absent — skipping.");
    return lines.join("\n") + "\n";
  }
  const sinceMs = Date.now() - days * 86_400_000;
  const monthStart = (() => {
    const d = new Date();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  })();

  const window = runQuery(
    dbPath,
    `SELECT model, purpose, SUM(input_tokens), SUM(output_tokens), SUM(cost_usd), COUNT(*)
     FROM cost_ledger WHERE recorded_at >= ${sinceMs}
     GROUP BY model, purpose ORDER BY 5 DESC`,
  );
  if (window.length === 0) {
    lines.push("- No ledger rows in window.");
  } else {
    lines.push(`**Last ${days} days:**`, "", "| model | purpose | input_tok | output_tok | cost_usd | calls |", "| --- | --- | --- | --- | --- | --- |");
    let totalCost = 0;
    let totalCalls = 0;
    for (const row of window) {
      lines.push(`| ${row[0]} | ${row[1]} | ${fmtNumber(Number(row[2]))} | ${fmtNumber(Number(row[3]))} | ${fmtUsd(row[4])} | ${row[5]} |`);
      totalCost += Number(row[4]);
      totalCalls += Number(row[5]);
    }
    lines.push("");
    lines.push(`- ${days}-day total: **${fmtUsd(totalCost)}** across **${totalCalls}** calls.`);
    if (totalCalls > 0) {
      lines.push(`- Avg cost/call: ${fmtUsd(totalCost / totalCalls)} (cost-budget §2.3 expects ~$0.004 for Haiku).`);
    }
    if (days > 0) {
      const projected = (totalCost / days) * 30;
      lines.push(`- Linear monthly projection: **${fmtUsd(projected)}** (cap default $10).`);
    }
  }

  const monthSpent = runQuery(
    dbPath,
    `SELECT COALESCE(SUM(cost_usd), 0) FROM cost_ledger WHERE recorded_at >= ${monthStart}`,
  );
  if (monthSpent.length > 0) {
    lines.push(`- Month-to-date (UTC) total: **${fmtUsd(monthSpent[0][0])}**.`);
  }
  return lines.join("\n") + "\n";
}

function queueSection(dbPath) {
  const lines = ["### 4. Queue depth (right now)\n"];
  if (!tableExists(dbPath, "extraction_jobs")) {
    lines.push("- extraction_jobs absent — skipping.");
    return lines.join("\n") + "\n";
  }
  const rows = runQuery(
    dbPath,
    `SELECT status, COUNT(*) FROM extraction_jobs GROUP BY status ORDER BY 2 DESC`,
  );
  if (rows.length === 0) {
    lines.push("- No jobs.");
    return lines.join("\n") + "\n";
  }
  lines.push("| status | jobs |", "| --- | --- |");
  for (const [s, n] of rows) lines.push(`| ${s} | ${fmtNumber(Number(n))} |`);
  const oldestPending = runQuery(
    dbPath,
    `SELECT MIN(captured_at) FROM mem_captures WHERE extraction_status IN ('queued','failed')`,
  );
  if (oldestPending.length > 0 && oldestPending[0][0]) {
    const ts = new Date(Number(oldestPending[0][0])).toISOString();
    lines.push(`\n- Oldest pending capture: \`${ts}\``);
  }
  return lines.join("\n") + "\n";
}

function graphSection(dbPath) {
  const lines = ["### 5. Graph composition\n"];
  if (!tableExists(dbPath, "mem_edges")) {
    lines.push("- mem_edges absent — skipping.");
    return lines.join("\n") + "\n";
  }
  const nodeKinds = runQuery(
    dbPath,
    `SELECT COALESCE(node_kind, '(unset)'), COUNT(*) FROM mem_items
     WHERE valid_to IS NULL GROUP BY COALESCE(node_kind, '(unset)') ORDER BY 2 DESC`,
  );
  if (nodeKinds.length > 0) {
    lines.push("**Active mem_items by node_kind:**", "", "| node_kind | count |", "| --- | --- |");
    for (const [k, n] of nodeKinds) lines.push(`| ${k} | ${fmtNumber(Number(n))} |`);
    lines.push("");
  }
  const edges = runQuery(
    dbPath,
    `SELECT edge_type, COUNT(*) FROM mem_edges WHERE valid_to IS NULL GROUP BY edge_type ORDER BY 2 DESC`,
  );
  if (edges.length > 0) {
    lines.push("**Active mem_edges by edge_type:**", "", "| edge_type | count |", "| --- | --- |");
    for (const [k, n] of edges) lines.push(`| ${k} | ${fmtNumber(Number(n))} |`);
  } else {
    lines.push("- No active edges (extraction worker hasn't produced relations yet).");
  }
  return lines.join("\n") + "\n";
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = args.db || defaultDbPath();
  const dbExists = fs.existsSync(dbPath);
  let hasGraphSchema = false;
  if (dbExists) {
    try {
      hasGraphSchema = tableExists(dbPath, "mem_edges");
    } catch (e) {
      process.stderr.write(`[kioku-observation] sqlite probe failed: ${e.message}\n`);
    }
  }
  const sections = [reportHeader({ ...args, dbPath, dbExists, hasGraphSchema })];
  if (dbExists) {
    try {
      sections.push(captureRateSection(dbPath, args.days));
      sections.push(dedupSection(dbPath));
      sections.push(costSection(dbPath, args.days));
      sections.push(queueSection(dbPath));
      sections.push(graphSection(dbPath));
    } catch (e) {
      sections.push(`\n_Observation aborted: ${e.message}_\n`);
    }
  } else {
    sections.push(`\n_Database not found at \`${dbPath}\`. Pass \`--db <path>\` to point at one._\n`);
  }
  sections.push(
    "\n---\n\nNotes for reviewer: paste this section under `docs/kioku-cost-budget.md` §7 and add a bullet on whether the projection sits inside the configured cap.\n",
  );
  process.stdout.write(sections.join("\n"));
}

main();

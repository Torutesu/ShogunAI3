#!/usr/bin/env node
/**
 * KIOKU Stage 5 dry-run runner (Phase 2).
 *
 * Produces a Markdown report of what `shogun_kioku_stage5_apply` would do
 * if invoked. Read-only — does not touch any data. Output is meant to be
 * archived under `docs/kioku-stage5-${YYYY-MM-DD}-dryrun.txt` and reviewed
 * by Select before the matching apply command runs.
 *
 * Usage
 *   node scripts/kioku-stage5-dryrun.mjs [--db <path>]
 *
 * Requires the `sqlite3` CLI on $PATH. Reads in `-readonly` mode, so the
 * Tauri app does NOT need to be stopped (though running the apply command
 * does require a closed app).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LEGACY_SOURCES = ["capture_sampler", "capture_ax"];
const SOFT_RETIRE_GRACE_DAYS = 30;
const MS_PER_DAY = 86_400_000;

function parseArgs(argv) {
  const out = { db: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db") out.db = argv[++i];
    else if (argv[i] === "-h" || argv[i] === "--help") {
      process.stdout.write(import.meta.url + "\nSee module docstring at the top of this file.\n");
      process.exit(0);
    }
  }
  return out;
}

function defaultDbPath() {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "ai.Shogun.ShogunAI3",
      "memory.db",
    );
  }
  if (process.platform === "linux") {
    return path.join(os.homedir(), ".local", "share", "ai.Shogun.ShogunAI3", "memory.db");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || os.homedir(), "ai.Shogun.ShogunAI3", "memory.db");
  }
  return path.join(os.homedir(), "memory.db");
}

function runQuery(dbPath, sql) {
  const r = spawnSync("sqlite3", ["-readonly", "-cmd", ".mode tabs", dbPath, sql], {
    encoding: "utf8",
  });
  if (r.error) throw new Error(`sqlite3 invocation failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`sqlite3 exited ${r.status}: ${r.stderr.trim()}`);
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
}

function tableExists(dbPath, name) {
  return (
    runQuery(dbPath, `SELECT 1 FROM sqlite_master WHERE type='table' AND name='${name}' LIMIT 1`)
      .length > 0
  );
}

function quoteList(values) {
  return values.map((v) => `'${v.replace(/'/g, "''")}'`).join(",");
}

function fmtTs(ms) {
  if (ms == null || ms === "" || ms === "—") return "—";
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return new Date(n).toISOString();
}

function fmtBytes(n) {
  if (!n || n < 1024) return `${n || 0} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function diskSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function rawPathBytes(dbPath) {
  const rows = runQuery(
    dbPath,
    `SELECT raw_path FROM mem_captures WHERE raw_path IS NOT NULL AND raw_path != ''`,
  );
  let sum = 0;
  for (const [p] of rows) sum += diskSize(p);
  return sum;
}

function softRetireBlock(dbPath) {
  const sources = quoteList(LEGACY_SOURCES);
  const matching = Number(
    runQuery(dbPath, `SELECT COUNT(*) FROM mem_items WHERE source IN (${sources})`)[0][0],
  );
  const alreadyRetired = Number(
    runQuery(
      dbPath,
      `SELECT COUNT(*) FROM mem_items WHERE source IN (${sources}) AND valid_to IS NOT NULL`,
    )[0][0],
  );
  const oldest = runQuery(
    dbPath,
    `SELECT MIN(created_at) FROM mem_items WHERE source IN (${sources})`,
  );
  const newest = runQuery(
    dbPath,
    `SELECT MAX(created_at) FROM mem_items WHERE source IN (${sources})`,
  );
  const embeddingBlobs = Number(
    runQuery(
      dbPath,
      `SELECT COUNT(*) FROM mem_items WHERE source IN (${sources}) AND embedding IS NOT NULL`,
    )[0][0],
  );
  const sourceBreak = runQuery(
    dbPath,
    `SELECT source, COUNT(*) FROM mem_items WHERE source IN (${sources}) GROUP BY source ORDER BY 2 DESC`,
  );
  const lines = ["### [1] mem_items soft-retire 対象\n"];
  lines.push(`- 対象行数: **${matching}**`);
  lines.push(`- すでに valid_to が打たれている行: ${alreadyRetired}`);
  lines.push(`- 最古 created_at: ${fmtTs(oldest[0][0])}`);
  lines.push(`- 最新 created_at: ${fmtTs(newest[0][0])}`);
  lines.push(`- embedding を持つ行 (Phase 1 では capture_* は skip 想定): ${embeddingBlobs}`);
  lines.push("- provenance 内訳: 全 'screen' (legacy capture sources)");
  lines.push("- source 別:");
  for (const [src, n] of sourceBreak) lines.push(`  - \`${src}\`: ${n}`);
  return lines.join("\n") + "\n";
}

function ttlBlock(dbPath, dbExists, hasMemCaptures) {
  const lines = ["### [2] mem_captures TTL 経過 raw 削除対象\n"];
  if (!hasMemCaptures) {
    lines.push("- mem_captures table absent — Stage 2 schema not applied yet.");
    return lines.join("\n") + "\n";
  }
  const now = Date.now();
  const rowsWithRaw = Number(
    runQuery(
      dbPath,
      `SELECT COUNT(*) FROM mem_captures
       WHERE ttl_expires_at < ${now} AND extraction_status = 'done'
         AND (raw_text IS NOT NULL OR raw_path IS NOT NULL)`,
    )[0][0],
  );
  const rawPathFiles = Number(
    runQuery(
      dbPath,
      `SELECT COUNT(*) FROM mem_captures
       WHERE ttl_expires_at < ${now} AND extraction_status = 'done'
         AND raw_path IS NOT NULL AND raw_path != ''`,
    )[0][0],
  );
  const rawTextRows = Number(
    runQuery(
      dbPath,
      `SELECT COUNT(*) FROM mem_captures
       WHERE ttl_expires_at < ${now} AND extraction_status = 'done'
         AND raw_text IS NOT NULL`,
    )[0][0],
  );
  const fileBytes = rawPathBytes(dbPath);
  lines.push(`- 対象行数: **${rowsWithRaw}**`);
  lines.push(`- raw_path 削除対象 (filesystem): ${rawPathFiles}`);
  lines.push(`- raw_text 削除対象 (NULL 化): ${rawTextRows}`);
  lines.push(`- 合計 raw_path のディスク占有 (実測): **${fmtBytes(fileBytes)}**`);
  return lines.join("\n") + "\n";
}

function physicalDeleteBlock(dbPath, hasMemEdges, hasMemSummaries) {
  const lines = ["### [3] physical-delete 対象 (soft-retire から 30 日経過)\n"];
  const sources = quoteList(LEGACY_SOURCES);
  const cutoff = Date.now() - SOFT_RETIRE_GRACE_DAYS * MS_PER_DAY;
  const eligible = Number(
    runQuery(
      dbPath,
      `SELECT COUNT(*) FROM mem_items
       WHERE source IN (${sources}) AND valid_to IS NOT NULL AND valid_to < ${cutoff}`,
    )[0][0],
  );
  let cascadeEdges = 0;
  if (hasMemEdges) {
    cascadeEdges = Number(
      runQuery(
        dbPath,
        `SELECT COUNT(*) FROM mem_edges e
         JOIN mem_items m ON (e.from_node = m.id OR e.to_node = m.id)
         WHERE m.source IN (${sources}) AND m.valid_to IS NOT NULL AND m.valid_to < ${cutoff}`,
      )[0][0],
    );
  }
  let orphanedSummaries = 0;
  if (hasMemSummaries) {
    orphanedSummaries = Number(
      runQuery(
        dbPath,
        `SELECT COUNT(*) FROM mem_summaries s
         JOIN mem_items m ON s.target_id = m.id AND s.target_kind = 'item'
         WHERE m.source IN (${sources}) AND m.valid_to IS NOT NULL AND m.valid_to < ${cutoff}`,
      )[0][0],
    );
  }
  lines.push(`- 対象行数: **${eligible}**`);
  lines.push(`- 関連する mem_edges (ON DELETE CASCADE で消える): ${cascadeEdges}`);
  lines.push(
    `- 関連する mem_summaries (target_id 一致 — 別テーブルなので残るが UI から見えなくなる): ${orphanedSummaries}`,
  );
  return lines.join("\n") + "\n";
}

function storageBlock(dbPath, ttlFileBytes) {
  const dbBytes = diskSize(dbPath);
  const lines = ["### [4] storage 削減見込み\n"];
  lines.push(`- 現在の memory.db サイズ: **${fmtBytes(dbBytes)}**`);
  lines.push(`- raw_path ファイル合計 (Block 2): ${fmtBytes(ttlFileBytes)}`);
  lines.push("- DELETE 後 + VACUUM 削減見込み: 削除対象行 × 平均行サイズ。SQLite の VACUUM が実測値を出す。");
  return lines.join("\n") + "\n";
}

function sideEffectsBlock() {
  return `### [5] 副作用チェック

- 現行有効 mem_items (valid_to IS NULL) への影響: なし — 削除対象は legacy capture source の retired 行のみ
- mem_summaries への影響: target_id 孤立は UI フィルタ済み想定 (Block 3 のカウント参照)
- AMC pipeline への影響: なし — decision_graph_hits は node_kind='decision' から、screen 行は使っていない

`;
}

function backupBlock(dbPath) {
  const stamp = new Date().toISOString().slice(0, 10);
  const backupPath = `${dbPath}.pre-stage5-${stamp}`;
  return `### [6] バックアップ推奨

本実行前に以下のいずれかでバックアップ:

\`\`\`bash
# Tauri アプリ終了後に実行 (SQLite は単一ライター)
cp "${dbPath}" "${backupPath}"
\`\`\`

または \`Settings > Memory > Backup\` (Stage 5 着手前に追加実装予定) を経由。

[警告] 物理削除はロールバック不可です。バックアップなしで実行しないでください。
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = args.db || defaultDbPath();
  const dbExists = fs.existsSync(dbPath);
  const generatedAt = new Date().toISOString();

  const lines = ["=== KIOKU Stage 5 dry-run ===\n"];
  lines.push(`generated_at: ${generatedAt}`);
  lines.push(`memory.db path: \`${dbPath}\``);
  lines.push(`memory.db size before: ${fmtBytes(diskSize(dbPath))}\n`);

  if (!dbExists) {
    lines.push(`_Database not found at \`${dbPath}\`. Pass \`--db <path>\` to point at one._\n`);
    process.stdout.write(lines.join("\n"));
    return;
  }

  let hasMemCaptures = false;
  let hasMemEdges = false;
  let hasMemSummaries = false;
  try {
    hasMemCaptures = tableExists(dbPath, "mem_captures");
    hasMemEdges = tableExists(dbPath, "mem_edges");
    hasMemSummaries = tableExists(dbPath, "mem_summaries");
  } catch (e) {
    lines.push(`_sqlite probe failed: ${e.message}_\n`);
    process.stdout.write(lines.join("\n"));
    return;
  }

  try {
    lines.push(softRetireBlock(dbPath));
    lines.push(ttlBlock(dbPath, dbExists, hasMemCaptures));
    lines.push(physicalDeleteBlock(dbPath, hasMemEdges, hasMemSummaries));
    const ttlFileBytes = hasMemCaptures ? rawPathBytes(dbPath) : 0;
    lines.push(storageBlock(dbPath, ttlFileBytes));
    lines.push(sideEffectsBlock());
    lines.push(backupBlock(dbPath));
  } catch (e) {
    lines.push(`\n_Dry-run aborted: ${e.message}_\n`);
  }

  lines.push("=== END dry-run ===\n");
  process.stdout.write(lines.join("\n"));
}

main();

#!/usr/bin/env node
/**
 * CLI: dry-run pipeline or validate fixtures.
 * Usage:
 *   node src/cli.js --dry [--fixture path]
 *   node src/cli.js --validate-only
 *   node src/cli.js --stdin [--dry]      # JSON array of MorningBriefCandidate on stdin
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runMorningBriefPipeline } from "./orchestrator.js";
import { MorningBriefJsonSchema } from "./schemas.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readFixture(p) {
  const raw = fs.readFileSync(p, "utf8");
  if (p.endsWith(".jsonl")) {
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }
  const j = JSON.parse(raw);
  return Array.isArray(j) ? j : j.candidates || [];
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const buf = Buffer.concat(chunks).toString("utf8").trim();
  if (!buf) return [];
  const parsed = JSON.parse(buf);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.candidates)) return parsed.candidates;
  throw new Error(
    "--stdin expected a JSON array of MorningBriefCandidate or `{candidates: [...]}`"
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const dry = argv.includes("--dry") || !process.env.ANTHROPIC_API_KEY;
  const validateOnly = argv.includes("--validate-only");
  const useStdin = argv.includes("--stdin");
  const fi = argv.indexOf("--fixture");
  const fixturePath =
    fi >= 0 && argv[fi + 1]
      ? path.resolve(argv[fi + 1])
      : path.join(__dirname, "../fixtures/mock-candidates.json");

  let candidates;
  if (useStdin) {
    candidates = await readStdin();
  } else {
    if (!fs.existsSync(fixturePath)) {
      console.error("Fixture not found:", fixturePath);
      process.exit(1);
    }
    candidates = readFixture(fixturePath);
  }
  if (validateOnly) {
    const res = await runMorningBriefPipeline(candidates, { dryRun: true });
    if (res.skipped) {
      console.log(JSON.stringify(res, null, 2));
      process.exit(0);
    }
    const parsed = MorningBriefJsonSchema.safeParse(res.brief);
    if (!parsed.success) {
      console.error(parsed.error.format());
      process.exit(1);
    }
    console.log("OK", parsed.data.items.length, "items");
    process.exit(0);
  }

  const res = await runMorningBriefPipeline(candidates, { dryRun: dry });
  console.log(JSON.stringify(res, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

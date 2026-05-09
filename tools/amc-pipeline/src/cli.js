#!/usr/bin/env node
/**
 * CLI: dry-run pipeline or validate fixtures.
 * Usage:
 *   node src/cli.js --dry [--fixture path]
 *   node src/cli.js --validate-only
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

async function main() {
  const argv = process.argv.slice(2);
  const dry = argv.includes("--dry") || !process.env.ANTHROPIC_API_KEY;
  const validateOnly = argv.includes("--validate-only");
  const fi = argv.indexOf("--fixture");
  const fixturePath =
    fi >= 0 && argv[fi + 1]
      ? path.resolve(argv[fi + 1])
      : path.join(__dirname, "../fixtures/mock-candidates.json");

  if (!fs.existsSync(fixturePath)) {
    console.error("Fixture not found:", fixturePath);
    process.exit(1);
  }

  const candidates = readFixture(fixturePath);
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

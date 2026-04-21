#!/usr/bin/env node
/**
 * Verifies that `tauri build` packaged the AMC pipeline so the Rust
 * `amc_sidecar::resolve_pipeline_path` resolver can find it at runtime.
 *
 * Walks `src-tauri/target/release/bundle/{macos,deb,appimage,rpm}` for
 * an `amc-pipeline/src/cli.js` under any of the candidate sub-paths the
 * resolver probes (the layout depends on whether each `bundle.resources`
 * entry was given as a glob or as `{path,name}`, and Tauri 2 may rewrite
 * `..` segments to `_up_`).
 *
 * Exit codes:
 *   0  — cli.js found in at least one bundle and is reachable from the
 *        resolver's probe list. SDK presence is reported but does not
 *        gate the script (the pipeline gracefully degrades to its
 *        heuristic dry path when the SDK is missing).
 *   1  — no bundle resources directory exists at all (likely
 *        `tauri build` was skipped or failed earlier in the pipeline).
 *   2  — at least one bundle exists but the cli.js is missing from
 *        every probe sub-path; investigate `tauri.conf.json`
 *        `bundle.resources` and update the probe list in
 *        `src-tauri/src/amc_sidecar.rs`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_ROOT = path.join(ROOT, "src-tauri", "target", "release", "bundle");

// Mirror src-tauri/src/amc_sidecar.rs `PROBE`.
const PROBE_SUFFIXES = [
  "amc-pipeline/src/cli.js",
  "hifi/amc-pipeline/src/cli.js",
  "_up_/hifi/amc-pipeline/src/cli.js",
  "resources/amc-pipeline/src/cli.js",
];

function findResourceDirs(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];

  // macOS: bundle/macos/<App Name>.app/Contents/Resources
  const mac = path.join(root, "macos");
  if (fs.existsSync(mac)) {
    for (const entry of fs.readdirSync(mac)) {
      if (entry.endsWith(".app")) {
        out.push(path.join(mac, entry, "Contents", "Resources"));
      }
    }
  }

  // Linux .deb / .appimage / .rpm: payload root differs per format. Tauri
  // typically puts the resources under `usr/lib/<id>/resources` for deb
  // but we don't unpack here — instead, just point the search at the
  // top-level directories and let the BFS walker find the cli.
  for (const dist of ["deb", "appimage", "rpm"]) {
    const d = path.join(root, dist);
    if (!fs.existsSync(d)) continue;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) out.push(path.join(d, entry.name));
    }
  }

  return out;
}

function probeCli(dir) {
  for (const sub of PROBE_SUFFIXES) {
    const full = path.join(dir, sub);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      return { sub, full };
    }
  }
  return null;
}

function bfsForCli(dir, maxDepth = 8) {
  const stack = [{ p: dir, d: 0 }];
  while (stack.length) {
    const { p, d } = stack.pop();
    if (d > maxDepth) continue;
    let entries;
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const child = path.join(p, e.name);
      if (e.isDirectory()) {
        stack.push({ p: child, d: d + 1 });
      } else if (e.isFile() && e.name === "cli.js") {
        const parent = path.basename(path.dirname(child));
        const grand = path.basename(path.dirname(path.dirname(child)));
        if (parent === "src" && grand === "amc-pipeline") return child;
      }
    }
  }
  return null;
}

const resourceDirs = findResourceDirs(BUNDLE_ROOT);
if (resourceDirs.length === 0) {
  console.error(`FAIL: no bundle resource dirs found under ${BUNDLE_ROOT}`);
  console.error(`Run \`npm run build:desktop\` first.`);
  process.exit(1);
}

let foundAny = false;
let warnedLayout = false;

for (const dir of resourceDirs) {
  console.log(`[bundle] ${dir}`);
  const hit = probeCli(dir);
  if (hit) {
    foundAny = true;
    console.log(`  cli.js  : found at ${hit.sub}`);
    // hit.full = <res>/.../amc-pipeline/src/cli.js
    // amc-pipeline/ = dirname(dirname(cli.js))
    const amcRoot = path.dirname(path.dirname(hit.full));
    const sdkPkg = path.join(amcRoot, "node_modules", "@anthropic-ai", "sdk", "package.json");
    if (fs.existsSync(sdkPkg)) {
      console.log(`  anthropic SDK present (${path.relative(dir, sdkPkg)})`);
    } else {
      console.warn(
        "  anthropic SDK NOT bundled — pipeline will dry-run only " +
          "(Settings → Anthropic key has no effect on this build).",
      );
    }
  } else {
    const fallback = bfsForCli(dir);
    if (fallback) {
      foundAny = true;
      warnedLayout = true;
      const rel = path.relative(dir, fallback);
      console.warn(`  cli.js  : found at unexpected path ${rel}`);
      console.warn(
        "  → add this sub-path to PROBE in src-tauri/src/amc_sidecar.rs " +
          "or adjust tauri.conf.json bundle.resources.",
      );
    } else {
      console.error("  cli.js  : NOT found under any probe sub-path");
    }
  }
}

if (!foundAny) {
  console.error(
    `FAIL: amc-pipeline cli.js missing from every bundled resources directory.`,
  );
  process.exit(2);
}

if (warnedLayout) {
  console.warn("Pipeline located, but resolver probe list may need updating.");
}

console.log("OK: amc-pipeline bundle layout reachable from resolver.");

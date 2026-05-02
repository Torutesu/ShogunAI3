#!/usr/bin/env node
// Smoke test for hifi/lib/markdown-mini.js.
// Loads the file in a synthetic browser-like context and asserts a few
// representative inputs render to the expected HTML.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  path.join(__dirname, "..", "hifi", "lib", "markdown-mini.js"),
  "utf8",
);
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(src, ctx);

const md = ctx.window.shogunMarkdownMini;
if (typeof md !== "function") {
  console.error("FAIL: window.shogunMarkdownMini is not a function");
  process.exit(1);
}

const cases = [
  ["# Hello", "<h2>Hello</h2>"],
  ["## Sub", "<h3>Sub</h3>"],
  ["**bold** text", "<p><strong>bold</strong> text</p>"],
  ["- one\n- two", "<ul><li>one</li><li>two</li></ul>"],
  [
    "see [docs](https://example.com)",
    '<p>see <a href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a></p>',
  ],
  ["<script>alert(1)</script>", "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>"],
  ["plain paragraph", "<p>plain paragraph</p>"],
];

let failed = 0;
for (const [input, expected] of cases) {
  const actual = md(input);
  if (actual !== expected) {
    failed++;
    console.error(`FAIL: ${JSON.stringify(input)}`);
    console.error(`  expected: ${JSON.stringify(expected)}`);
    console.error(`  actual:   ${JSON.stringify(actual)}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length} cases failed`);
  process.exit(1);
}

console.log(`OK: ${cases.length} cases passed`);

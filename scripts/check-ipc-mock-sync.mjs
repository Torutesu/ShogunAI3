#!/usr/bin/env node
/**
 * Ensures mockTransport switch cases in `src/shared/ipc/ipc-client.ts` and `src/app/App.tsx`
 * (mockIpcInvoke) list the same Tauri command strings — catches drift when one is updated.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

function casesFromIpcClient(source) {
  const out = new Set();
  const reCase = /case\s+"([^"]+)"\s*:/g;
  let m;
  while ((m = reCase.exec(source)) !== null) {
    out.add(m[1]);
  }
  const reIf = /if\s*\(\s*command\s*===\s*"([^"]+)"/g;
  while ((m = reIf.exec(source)) !== null) {
    out.add(m[1]);
  }
  return out;
}

function casesFromAppMock(source) {
  const out = new Set();
  const re = /case\s+'([^']+)'\s*:/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    out.add(m[1]);
  }
  return out;
}

const ipcPath = path.join(repoRoot, "src", "shared", "ipc", "ipc-client.ts");
const appPath = path.join(repoRoot, "src", "app", "App.tsx");

const ipcSrc = fs.readFileSync(ipcPath, "utf8");
const appSrc = fs.readFileSync(appPath, "utf8");

const ipcCases = casesFromIpcClient(ipcSrc);
const appCases = casesFromAppMock(appSrc);

const onlyIpc = [...ipcCases].filter((c) => !appCases.has(c)).sort();
const onlyApp = [...appCases].filter((c) => !ipcCases.has(c)).sort();

if (onlyIpc.length > 0 || onlyApp.length > 0) {
  console.error("mock IPC case mismatch between ipc-client.js and app.jsx mockIpcInvoke.\n");
  if (onlyIpc.length > 0) {
    console.error("Only in ipc-client.js:", onlyIpc.join(", "));
  }
  if (onlyApp.length > 0) {
    console.error("Only in app.jsx:", onlyApp.join(", "));
  }
  process.exit(1);
}

console.log(`OK: ${ipcCases.size} mock IPC commands match in both files.`);

#!/usr/bin/env node
/**
 * Always run from repo root (where src-tauri/tauri.conf.json lives).
 * If your shell cwd is hifi/ or deeper, we walk up until we find it.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findTauriRoot(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 20; i++) {
    const marker = path.join(dir, "src-tauri", "tauri.conf.json");
    if (fs.existsSync(marker)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function main() {
  const root =
    findTauriRoot(process.cwd()) || findTauriRoot(path.join(__dirname, ".."));

  if (!root) {
    console.error(
      "[build:icons] リポジトリのルートが見つかりません（src-tauri/tauri.conf.json）。\n" +
        "次のフォルダで実行してください: 「Shogun AI (1)」直下（package.json がある場所）。\n" +
        '例: cd "/Users/…/Shogun AI (1)" && npm run build:icons',
    );
    process.exit(1);
  }

  process.chdir(root);
  console.log(`[build:icons] cwd: ${root}\n`);

  const pyScript = path.join(root, "scripts", "build-mac-app-icon.py");
  const py = spawnSync(process.platform === "win32" ? "py" : "python3", ["-u", pyScript], {
    stdio: "inherit",
    env: process.env,
  });
  if (py.status !== 0 && py.status !== null) {
    console.error(
      "\n[build:icons] Python ステップが失敗しました。Pillow があるか確認: python3 -m pip install --user Pillow",
    );
    process.exit(py.status);
  }
  if (py.error) {
    console.error("[build:icons] python3 を起動できません:", py.error.message);
    process.exit(1);
  }

  const icon = path.join(root, "hifi", "assets", "app-icon-mac-1024.png");
  const tauri = spawnSync("npx", ["tauri", "icon", icon], {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
    cwd: root,
  });
  if (tauri.status !== 0 && tauri.status !== null) {
    process.exit(tauri.status);
  }
  if (tauri.error) {
    console.error("[build:icons] npx tauri を起動できません:", tauri.error.message);
    process.exit(1);
  }

  console.log("\n[build:icons] 完了。src-tauri/icons/ を更新しました。`tauri build` で .app に反映してください。");
}

main();

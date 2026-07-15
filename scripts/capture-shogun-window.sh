#!/usr/bin/env bash
set -euo pipefail

OUT_PATH="${1:-/tmp/shogun-codex/shogun-window.png}"
APP_PID="${SHOGUN_APP_PID:-}"

if [[ -z "${APP_PID}" ]]; then
  APP_PID="$(pgrep -f 'target/debug/app' | tail -n 1 || true)"
fi

if [[ -z "${APP_PID}" ]]; then
  echo "Could not find a running SHOGUN desktop app process." >&2
  echo "Set SHOGUN_APP_PID=<pid> or start \`npm run dev:desktop\` first." >&2
  exit 1
fi

WINDOW_ID="$(
  swift -e '
import Cocoa

let targetPid = Int(CommandLine.arguments[1]) ?? -1
let opts = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] ?? []

let matches = list.filter {
  ($0[kCGWindowOwnerPID as String] as? Int) == targetPid
}

func windowScore(_ window: [String: Any]) -> Int {
  let name = (window[kCGWindowName as String] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  let layer = window[kCGWindowLayer as String] as? Int ?? 0
  var score = 0
  if !name.isEmpty { score += 10 }
  if layer == 0 { score += 5 }
  return score
}

if let best = matches.max(by: { windowScore($0) < windowScore($1) }),
   let number = best[kCGWindowNumber as String] {
  print(number)
}
' "${APP_PID}"
)"

if [[ -z "${WINDOW_ID}" ]]; then
  echo "Could not resolve a visible SHOGUN window for pid ${APP_PID}." >&2
  exit 1
fi

mkdir -p "$(dirname "${OUT_PATH}")"
screencapture -x -l "${WINDOW_ID}" "${OUT_PATH}"

echo "Captured SHOGUN window"
echo "pid=${APP_PID}"
echo "window_id=${WINDOW_ID}"
echo "path=${OUT_PATH}"

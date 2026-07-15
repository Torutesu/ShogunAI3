#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <relative-x> <relative-y>" >&2
  echo "Example: $0 120 230" >&2
  exit 1
fi

REL_X="$1"
REL_Y="$2"
APP_PID="${SHOGUN_APP_PID:-}"

if [[ -z "${APP_PID}" ]]; then
  APP_PID="$(pgrep -f 'target/debug/app' | tail -n 1 || true)"
fi

if [[ -z "${APP_PID}" ]]; then
  echo "Could not find a running SHOGUN desktop app process." >&2
  echo "Set SHOGUN_APP_PID=<pid> or start \`npm run dev:desktop\` first." >&2
  exit 1
fi

osascript -e 'tell application "System Events" to tell process "app" to set frontmost to true' >/dev/null 2>&1 || true
sleep 0.2

swift -e '
import Cocoa
import ApplicationServices

let targetPid = Int(CommandLine.arguments[1]) ?? -1
let relX = Double(CommandLine.arguments[2]) ?? 0
let relY = Double(CommandLine.arguments[3]) ?? 0

let opts = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] ?? []
let matches = list.filter { ($0[kCGWindowOwnerPID as String] as? Int) == targetPid }

func windowScore(_ window: [String: Any]) -> Int {
  let name = (window[kCGWindowName as String] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  let layer = window[kCGWindowLayer as String] as? Int ?? 0
  var score = 0
  if !name.isEmpty { score += 10 }
  if layer == 0 { score += 5 }
  return score
}

guard
  let best = matches.max(by: { windowScore($0) < windowScore($1) }),
  let bounds = best[kCGWindowBounds as String] as? [String: Any],
  let x = bounds["X"] as? Double,
  let y = bounds["Y"] as? Double
else {
  fputs("Could not resolve SHOGUN window bounds.\n", stderr)
  exit(1)
}

let point = CGPoint(x: x + relX, y: y + relY)

guard
  let mouseDown = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
  let mouseUp = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
else {
  fputs("Could not construct click events.\n", stderr)
  exit(1)
}

mouseDown.post(tap: .cghidEventTap)
usleep(80000)
mouseUp.post(tap: .cghidEventTap)

print("Clicked SHOGUN window at rel=(\(Int(relX)), \(Int(relY))) abs=(\(Int(point.x)), \(Int(point.y)))")
' "${APP_PID}" "${REL_X}" "${REL_Y}"

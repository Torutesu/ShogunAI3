#!/usr/bin/env python3
"""Build a 1024×1024 PNG master for `npx tauri icon` (macOS squircle-safe margins)."""
from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print(
        "Pillow が見つかりません。次を実行してください:\n"
        f"  {sys.executable} -m pip install --user Pillow",
        file=sys.stderr,
    )
    raise SystemExit(1)

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "hifi" / "assets" / "mark.png"
OUT = ROOT / "hifi" / "assets" / "app-icon-mac-1024.png"
SIZE = 1024
# Keep artwork inside ~88% so Dock / Finder mask does not clip the outer ring.
INSET_FRAC = 0.88


def main() -> int:
    if not SRC.is_file():
        print(f"missing source: {SRC}", file=sys.stderr)
        return 1
    src = Image.open(SRC).convert("RGBA")
    side = int(SIZE * INSET_FRAC)
    scaled = src.resize((side, side), Image.Resampling.LANCZOS)
    # Match typical mark background (near-black); avoids gray fringe in corners.
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 255))
    x = (SIZE - side) // 2
    y = (SIZE - side) // 2
    canvas.paste(scaled, (x, y), scaled)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT, format="PNG", optimize=True)
    print(f"wrote {OUT} ({SIZE}×{SIZE})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

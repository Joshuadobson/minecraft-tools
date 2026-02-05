#!/usr/bin/env python3
from __future__ import annotations
import shutil
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = PROJECT_ROOT / "minecraft_textures_source" / "block"
DEST_DIR   = PROJECT_ROOT / "site" / "textures"
BLOCKLIST  = PROJECT_ROOT / "blocklist.txt"

def read_blocklist(path: Path) -> list[str]:
    items = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        items.append(line)
    return items

def main() -> None:
    if not SOURCE_DIR.exists():
        raise SystemExit(f"Missing source dir: {SOURCE_DIR}")

    DEST_DIR.mkdir(parents=True, exist_ok=True)
    blocks = read_blocklist(BLOCKLIST)

    copied, missing = 0, []
    for name in blocks:
        src = SOURCE_DIR / f"{name}.png"
        dst = DEST_DIR / f"{name}.png"
        if not src.exists():
            missing.append(name)
            continue
        shutil.copy2(src, dst)
        copied += 1

    print(f"Copied {copied} textures into {DEST_DIR}")
    if missing:
        print("\nMissing textures (check names / version):")
        for m in missing[:50]:
            print(" -", m)
        if len(missing) > 50:
            print(f" ... and {len(missing)-50} more")

if __name__ == "__main__":
    main()

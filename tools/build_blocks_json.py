#!/usr/bin/env python3
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from PIL import Image

PROJECT_ROOT = Path(__file__).resolve().parents[1]
TEXTURE_DIR  = PROJECT_ROOT / "site" / "textures"
OUT_JSON     = PROJECT_ROOT / "site" / "data" / "blocks.json"

# --- Color conversion: sRGB -> linear -> XYZ -> Lab (D65) ---

def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    # c in [0,1]
    a = 0.055
    return np.where(c <= 0.04045, c / 12.92, ((c + a) / (1 + a)) ** 2.4)

def rgb_to_xyz(rgb_lin: np.ndarray) -> np.ndarray:
    # rgb_lin shape (...,3), linear RGB D65
    M = np.array([
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ], dtype=np.float64)
    return rgb_lin @ M.T

def f_lab(t: np.ndarray) -> np.ndarray:
    d = 6/29
    return np.where(t > d**3, np.cbrt(t), (t / (3*d**2)) + (4/29))

def xyz_to_lab(xyz: np.ndarray) -> np.ndarray:
    # D65 reference white
    Xn, Yn, Zn = 0.95047, 1.00000, 1.08883
    x = xyz[..., 0] / Xn
    y = xyz[..., 1] / Yn
    z = xyz[..., 2] / Zn
    fx, fy, fz = f_lab(x), f_lab(y), f_lab(z)
    L = (116 * fy) - 16
    a = 500 * (fx - fy)
    b = 200 * (fy - fz)
    return np.stack([L, a, b], axis=-1)

def image_avg_lab(path: Path) -> tuple[float, float, float]:
    img = Image.open(path).convert("RGBA")
    arr = np.asarray(img, dtype=np.float64) / 255.0  # [0,1]
    rgb = arr[..., :3]
    alpha = arr[..., 3]

    # keep pixels with alpha > 0 (ignore fully transparent)
    mask = alpha > 0.0
    if not np.any(mask):
        return (0.0, 0.0, 0.0)

    rgb = rgb[mask]

    # average in linear RGB (better than averaging gamma RGB)
    rgb_lin = srgb_to_linear(rgb)
    mean_rgb_lin = rgb_lin.mean(axis=0)

    xyz = rgb_to_xyz(mean_rgb_lin)
    lab = xyz_to_lab(xyz)

    return (float(lab[0]), float(lab[1]), float(lab[2]))

def pretty_name(stem: str) -> str:
    return stem.replace("_", " ").title()

def main() -> None:
    if not TEXTURE_DIR.exists():
        raise SystemExit(f"Missing textures dir: {TEXTURE_DIR}")

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)

    data: dict[str, dict] = {}
    pngs = sorted(TEXTURE_DIR.glob("*.png"))
    if not pngs:
        raise SystemExit(f"No .png files found in {TEXTURE_DIR}")

    for p in pngs:
        stem = p.stem
        L, a, b = image_avg_lab(p)
        data[stem] = {
            "name": pretty_name(stem),
            "avg_lab": [round(L, 3), round(a, 3), round(b, 3)],
            "img": f"textures/{p.name}",
        }

    OUT_JSON.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print(f"Wrote {len(data)} blocks -> {OUT_JSON}")

if __name__ == "__main__":
    main()

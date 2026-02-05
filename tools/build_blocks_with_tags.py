#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image

PROJECT_ROOT = Path(__file__).resolve().parents[1]

JAR_ROOT = PROJECT_ROOT / "minecraft_textures"

BLOCKSTATES = JAR_ROOT / "assets" / "minecraft" / "blockstates"
# NOTE: in your version it is tags/block (not tags/blocks)
TAGS_DIR = JAR_ROOT / "data" / "minecraft" / "tags" / "block"

TEXTURES_SRC = PROJECT_ROOT / "minecraft_textures_source" / "block"

OUT_JSON = PROJECT_ROOT / "site" / "data" / "blocks.json"
CREATIVE_OVERRIDES = PROJECT_ROOT / "tools" / "creative_only_overrides.json"

# NEW: full-block overrides (manual safety net)
FULL_BLOCK_OVERRIDES = PROJECT_ROOT / "tools" / "full_block_overrides.json"


# ---------- Color conversion: sRGB -> linear -> XYZ -> Lab (D65) ----------
def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    a = 0.055
    return np.where(c <= 0.04045, c / 12.92, ((c + a) / (1 + a)) ** 2.4)

def rgb_to_xyz(rgb: np.ndarray) -> np.ndarray:
    M = np.array([
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ], dtype=np.float64)
    return rgb @ M.T

def f_lab(t: np.ndarray) -> np.ndarray:
    d = 6/29
    return np.where(t > d**3, np.cbrt(t), (t / (3*d**2)) + (4/29))

def xyz_to_lab(xyz: np.ndarray) -> np.ndarray:
    Xn, Yn, Zn = 0.95047, 1.0, 1.08883
    x, y, z = xyz[..., 0] / Xn, xyz[..., 1] / Yn, xyz[..., 2] / Zn
    fx, fy, fz = f_lab(x), f_lab(y), f_lab(z)
    L = 116 * fy - 16
    a = 500 * (fx - fy)
    b = 200 * (fy - fz)
    return np.stack([L, a, b], axis=-1)


# ---------- Image analysis ----------
def analyse_texture(path: Path) -> dict | None:
    img = Image.open(path).convert("RGBA")
    arr = np.asarray(img, dtype=np.float64) / 255.0

    rgb = arr[..., :3]
    alpha = arr[..., 3]

    mask = alpha > 0.0
    if not np.any(mask):
        return None

    rgb_kept = rgb[mask]
    alpha_kept = alpha[mask]

    # avg colour (average in linear RGB -> Lab)
    rgb_lin = srgb_to_linear(rgb_kept)
    mean_lin = rgb_lin.mean(axis=0)
    lab_mean = xyz_to_lab(rgb_to_xyz(mean_lin))

    # noise = mean variance across Lab channels
    lab_pixels = xyz_to_lab(rgb_to_xyz(srgb_to_linear(rgb_kept)))
    noise = float(np.mean(np.var(lab_pixels, axis=0)))

    transparent = bool(np.any(alpha_kept < 1.0))

    return {
        "avg_lab": [round(float(x), 3) for x in lab_mean],
        "noise": round(noise, 3),
        "transparent": transparent,
    }


# ---------- Official tag parsing ----------
def load_official_block_tags(tags_dir: Path) -> dict[str, set[str]]:
    """
    Returns: dict[tag_id] -> set(block_id)
    tag_id examples: "minecraft:planks", "minecraft:mineable/axe"
    Supports nested "#minecraft:..." references.
    """
    if not tags_dir.exists():
        print(f"[warn] TAGS_DIR not found: {tags_dir} (skipping official tags)")
        return {}

    raw: dict[str, list] = {}

    for p in sorted(tags_dir.rglob("*.json")):
        rel = p.relative_to(tags_dir).with_suffix("")  # e.g. mineable/axe
        tag_id = f"minecraft:{rel.as_posix()}"
        obj = json.loads(p.read_text(encoding="utf-8"))
        raw[tag_id] = obj.get("values", [])

    memo: dict[str, set[str]] = {}
    visiting: set[str] = set()

    def norm_block(v: str) -> str | None:
        # "minecraft:oak_planks" -> "oak_planks"
        if ":" not in v:
            return None
        ns, name = v.split(":", 1)
        if ns != "minecraft":
            return None
        return name

    def resolve(tag_id: str) -> set[str]:
        if tag_id in memo:
            return memo[tag_id]
        if tag_id in visiting:
            return set()  # avoid cycles (rare)

        visiting.add(tag_id)
        out: set[str] = set()

        for v in raw.get(tag_id, []):
            if isinstance(v, dict):
                v = v.get("id", "")
            if not isinstance(v, str) or not v:
                continue

            if v.startswith("#"):
                out |= resolve(v[1:])
            else:
                b = norm_block(v)
                if b:
                    out.add(b)

        visiting.remove(tag_id)
        memo[tag_id] = out
        return out

    return {tid: resolve(tid) for tid in raw.keys()}


def invert_tag_map(tag_to_blocks: dict[str, set[str]]) -> dict[str, list[str]]:
    block_to_tags: dict[str, list[str]] = {}
    for tag_id, blocks in tag_to_blocks.items():
        for b in blocks:
            block_to_tags.setdefault(b, []).append(tag_id)
    for b in block_to_tags:
        block_to_tags[b].sort()
    return block_to_tags


def derive_tag_flags(official_tags: list[str], block_id: str) -> dict:
    s = set(official_tags)

    def has(tag: str) -> bool:
        return tag in s

    # Common groups (only set True if we see the tag)
    flags = {
        "planks": has("minecraft:planks"),
        "logs": has("minecraft:logs") or has("minecraft:logs_that_burn"),
        "leaves": has("minecraft:leaves"),
        "glass": has("minecraft:glass") or has("minecraft:impermeable"),
        "wool": has("minecraft:wool"),
        "terracotta": has("minecraft:terracotta"),
        "concrete": has("minecraft:concrete"),
        "mineable_pickaxe": has("minecraft:mineable/pickaxe"),
        "mineable_axe": has("minecraft:mineable/axe"),
        "mineable_shovel": has("minecraft:mineable/shovel"),
        "mineable_hoe": has("minecraft:mineable/hoe"),
        "flowers": has("minecraft:flowers"),
        "saplings": has("minecraft:saplings"),
        "ore": ("ore" in block_id),
        "slab": has("minecraft:slabs"),
        "stairs": has("minecraft:stairs"),
        "walls": has("minecraft:walls"),
        "fences": has("minecraft:fences"),
        "fence_gates": has("minecraft:fence_gates"),
        "rails": has("minecraft:rails"),
        "buttons": has("minecraft:buttons"),
        "pressure_plates": has("minecraft:pressure_plates"),
        "trapdoors": has("minecraft:trapdoors"),
        "doors": has("minecraft:doors"),
    }

    # A practical “redstone-ish” bucket (mostly for filtering)
    redstone_keywords = (
        "redstone", "repeater", "comparator", "lever", "observer", "dispenser",
        "dropper", "piston", "sticky_piston", "tripwire", "daylight_detector",
        "hopper", "target", "tnt", "note_block", "jukebox"
    )
    flags["redstone"] = any(k in block_id for k in redstone_keywords)

    # Plants bucket (useful for excluding messy textures)
    plant_keywords = ("sapling", "flower", "bush", "grass", "fern", "vine", "kelp", "seagrass", "cane", "moss", "fungus", "roots", "sprouts")
    flags["plantlike"] = any(k in block_id for k in plant_keywords) or flags["flowers"] or flags["saplings"]

    # Heuristic exclusions for "not a full cube"
    not_full_keywords = (
        "rail", "lantern", "torch", "wall_torch", "rod", "chain",
        "door", "trapdoor", "button", "pressure_plate",
        "slab", "stairs", "wall", "fence", "gate",
        "carpet", "pane", "glass_pane",
        "sign", "hanging_sign", "banner", "bed",
        "candle", "ladder", "lever", "tripwire", "hook",
        "flower", "sapling", "bush", "vine", "kelp", "seagrass", "cane", "moss",
        "skull", "head", "coral", "fan",

        # common non-full-cube “utility shapes”
        "stand",          # brewing_stand
        "anvil",
        "bell",
        "campfire",
        "cauldron",
        "grindstone",
        "lectern",
        "hopper",
        "end_rod",
        "conduit",        # <-- add here too, but override file is still the real guarantee
        "beacon",
    )
    is_not_full = any(k in block_id for k in not_full_keywords)

    flags["full_block"] = not (
        flags["slab"] or flags["stairs"] or flags["walls"] or flags["fences"] or flags["fence_gates"] or
        flags["rails"] or flags["buttons"] or flags["pressure_plates"] or flags["trapdoors"] or flags["doors"] or
        flags["plantlike"] or is_not_full
    )

    flags["building_block"] = flags["full_block"] and not flags["ore"] and not flags["redstone"]
    return flags


# ---------- Misc ----------
def pretty_name(stem: str) -> str:
    return stem.replace("_", " ").title()


# ---------- Main ----------
def main() -> None:
    if not BLOCKSTATES.exists():
        raise SystemExit(f"Missing blockstates folder: {BLOCKSTATES}")
    if not TEXTURES_SRC.exists():
        raise SystemExit(f"Missing texture source folder: {TEXTURES_SRC}")

    block_ids = sorted([p.stem for p in BLOCKSTATES.glob("*.json")])

    creative_overrides = {}
    if CREATIVE_OVERRIDES.exists():
        creative_overrides = json.loads(CREATIVE_OVERRIDES.read_text(encoding="utf-8"))

    # NEW: load full-block overrides
    full_block_overrides = {}
    if FULL_BLOCK_OVERRIDES.exists():
        raw = json.loads(FULL_BLOCK_OVERRIDES.read_text(encoding="utf-8"))
        # normalize keys to lowercase
        full_block_overrides = {k.lower(): v for k, v in raw.items()}

    tag_to_blocks = load_official_block_tags(TAGS_DIR)
    block_to_official = invert_tag_map(tag_to_blocks)

    data: dict[str, dict] = {}
    missing_texture = 0

    for block_id in block_ids:
        tex_path = TEXTURES_SRC / f"{block_id}.png"
        if not tex_path.exists():
            missing_texture += 1
            continue

        analysis = analyse_texture(tex_path)
        if analysis is None:
            missing_texture += 1
            continue

        noisy = analysis["noise"] > 120  # tweak later if needed

        official = block_to_official.get(block_id, [])

        # Compute flags then apply overrides (if present)
        flags = derive_tag_flags(official, block_id)

        if block_id in full_block_overrides:
            flags["full_block"] = bool(full_block_overrides[block_id])
            # keep building_block consistent if we force full_block
            flags["building_block"] = flags["full_block"] and not flags.get("ore", False) and not flags.get("redstone", False)

        data[block_id] = {
            "name": pretty_name(block_id),
            "img": f"textures/{block_id}.png",
            "avg_lab": analysis["avg_lab"],
            "noise": analysis["noise"],
            "tags": {
                "transparent": analysis["transparent"],
                "noisy": noisy,
                "creative_only": bool(creative_overrides.get(block_id, False)),
            },
            "official_tags": official,
            "tag_flags": flags,
        }

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(data, indent=2), encoding="utf-8")

    print(f"Wrote {len(data)} blocks -> {OUT_JSON}")
    print(f"Blocks skipped (no simple texture match): {missing_texture}")
    print(f"Official tag files loaded: {len(tag_to_blocks)} from {TAGS_DIR}")
    print(f"Full-block overrides loaded: {len(full_block_overrides)} from {FULL_BLOCK_OVERRIDES}")

if __name__ == "__main__":
    main()
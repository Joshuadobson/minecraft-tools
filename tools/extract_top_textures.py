#!/usr/bin/env python3
from __future__ import annotations

import json
import shutil
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]

JAR_ROOT = PROJECT_ROOT / "minecraft_textures"
MODELS_DIR = JAR_ROOT / "assets" / "minecraft" / "models"
MODELS_BLOCK_DIR = MODELS_DIR / "block"
TEXTURES_BLOCK_DIR = JAR_ROOT / "assets" / "minecraft" / "textures" / "block"
BLOCKSTATES_DIR = JAR_ROOT / "assets" / "minecraft" / "blockstates"

BLOCKS_JSON = PROJECT_ROOT / "site" / "data" / "blocks.json"
OUT_DIR = PROJECT_ROOT / "site" / "textures_top"
REPORT_JSON = PROJECT_ROOT / "site" / "data" / "top_textures_report.json"


def load_json(p: Path) -> dict:
    return json.loads(p.read_text(encoding="utf-8"))


def is_mapart_safe(meta: dict) -> bool:
    tags = meta.get("tags") or {}
    flags = meta.get("tag_flags") or {}

    if flags.get("full_block") is not True:
        return False
    if tags.get("transparent") is True:
        return False
    if flags.get("leaves") is True:
        return False
    if flags.get("glass") is True:
        return False

    return True


def resolve_model_ref(model_ref: str) -> Path | None:
    """
    model_ref examples:
      "minecraft:block/stone"
      "block/stone"
      "minecraft:block/cube_all"
    returns: MODELS_DIR/<path>.json
    """
    if not model_ref or not isinstance(model_ref, str):
        return None
    if ":" in model_ref:
        _, model_ref = model_ref.split(":", 1)
    # model_ref now like "block/stone" or "item/..."
    model_ref = model_ref.removeprefix("/")
    p = MODELS_DIR / f"{model_ref}.json"
    return p if p.exists() else None


def merge_dict(a: dict, b: dict) -> dict:
    out = dict(a)
    out.update(b)
    return out


def load_model_chain(model_path: Path, max_depth: int = 30) -> list[Path]:
    """Return parent chain, root->leaf (deduped)."""
    chain: list[Path] = []
    seen: set[Path] = set()
    cur: Path | None = model_path
    depth = 0
    while cur and cur.exists() and cur not in seen and depth < max_depth:
        seen.add(cur)
        chain.append(cur)
        obj = load_json(cur)
        parent_ref = obj.get("parent")
        cur = resolve_model_ref(parent_ref) if parent_ref else None
        depth += 1
    return list(reversed(chain))  # root -> leaf


def gather_textures_from_chain(chain: list[Path]) -> dict[str, str]:
    textures: dict[str, str] = {}
    for p in chain:
        obj = load_json(p)
        tex = obj.get("textures")
        if isinstance(tex, dict):
            textures = merge_dict(textures, tex)
    return textures


def norm_tex_value(v: str) -> str | None:
    """
    Normalize texture value to a stem.
      "minecraft:block/oak_planks" -> "oak_planks"
      "block/oak_planks" -> "oak_planks"
      "#side" -> keep as reference
    """
    if not v or not isinstance(v, str):
        return None
    if v.startswith("#"):
        return v
    if ":" in v:
        _, v = v.split(":", 1)
    v = v.removeprefix("block/")
    v = v.split("/")[-1]
    return v


def resolve_hash(textures: dict[str, str], v: str, max_hops: int = 30) -> str | None:
    cur = v
    hops = 0
    while isinstance(cur, str) and cur.startswith("#") and hops < max_hops:
        key = cur[1:]
        cur = textures.get(key)
        hops += 1
        if cur is None:
            return None
    return norm_tex_value(cur) if isinstance(cur, str) else None


def pick_model_from_blockstate(block_id: str) -> str | None:
    """
    Pick a reasonable default model from blockstates/<id>.json.
    Handles:
      - variants: {"": {"model": "..."} } or first entry
      - multipart: pick first apply model
    Returns model ref string, like "minecraft:block/stone"
    """
    p = BLOCKSTATES_DIR / f"{block_id}.json"
    if not p.exists():
        return None

    obj = load_json(p)

    if "variants" in obj and isinstance(obj["variants"], dict):
        variants = obj["variants"]

        # Prefer "" / "normal" if present
        for key in ("", "normal"):
            if key in variants:
                v = variants[key]
                if isinstance(v, dict) and "model" in v:
                    return v["model"]
                if isinstance(v, list) and v and isinstance(v[0], dict) and "model" in v[0]:
                    return v[0]["model"]

        # Otherwise pick first variant entry
        for v in variants.values():
            if isinstance(v, dict) and "model" in v:
                return v["model"]
            if isinstance(v, list) and v and isinstance(v[0], dict) and "model" in v[0]:
                return v[0]["model"]

    if "multipart" in obj and isinstance(obj["multipart"], list) and obj["multipart"]:
        first = obj["multipart"][0]
        apply = first.get("apply")
        if isinstance(apply, dict) and "model" in apply:
            return apply["model"]
        if isinstance(apply, list) and apply and isinstance(apply[0], dict) and "model" in apply[0]:
            return apply[0]["model"]

    return None


def find_up_face_texture_stem(model_path: Path) -> tuple[str | None, str | None]:
    """
    Return (texture_stem, debug_source)
    Prefers actual elements[].faces.up.texture resolution.
    Falls back to textures keys if model has no elements.
    """
    chain = load_model_chain(model_path)
    textures = gather_textures_from_chain(chain)

    # Use elements from LEAF model if present (most accurate)
    leaf_obj = load_json(chain[-1])
    elements = leaf_obj.get("elements")

    if isinstance(elements, list) and elements:
        for el in elements:
            faces = el.get("faces") if isinstance(el, dict) else None
            if not isinstance(faces, dict):
                continue
            up = faces.get("up")
            if isinstance(up, dict) and isinstance(up.get("texture"), str):
                raw = norm_tex_value(up["texture"])
                stem = resolve_hash(textures, raw) if raw else None
                if stem:
                    return stem, "elements.faces.up"

    # Fallback: guess from textures slots
    for key in ("top", "up", "end", "all"):
        if key in textures:
            raw = norm_tex_value(textures[key])
            stem = resolve_hash(textures, raw) if raw else None
            if stem:
                return stem, f"textures.{key}"

    return None, None


def main() -> None:
    # Sanity
    for p in (MODELS_BLOCK_DIR, TEXTURES_BLOCK_DIR, BLOCKSTATES_DIR):
        if not p.exists():
            raise SystemExit(f"Missing required folder: {p}")

    if not BLOCKS_JSON.exists():
        raise SystemExit(f"Missing {BLOCKS_JSON}. Run your blocks.json build script first.")

    blocks_meta = load_json(BLOCKS_JSON)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    REPORT_JSON.parent.mkdir(parents=True, exist_ok=True)

    block_ids = sorted([p.stem for p in BLOCKSTATES_DIR.glob("*.json")])

    report = {
        "written": 0,
        "skipped_not_in_blocks_json": [],
        "skipped_not_mapart_safe": [],
        "missing_blockstate_model": [],
        "missing_model_json": [],
        "missing_texture_png": [],
        "fallback_used_id_png": [],
        "map": {},
    }

    for bid in block_ids:
        meta = blocks_meta.get(bid)
        if not meta:
            report["skipped_not_in_blocks_json"].append(bid)
            continue

        if not is_mapart_safe(meta):
            report["skipped_not_mapart_safe"].append(bid)
            continue

        model_ref = pick_model_from_blockstate(bid)
        if not model_ref:
            report["missing_blockstate_model"].append(bid)
            continue

        model_path = resolve_model_ref(model_ref)
        if not model_path:
            report["missing_model_json"].append({"block_id": bid, "model_ref": model_ref})
            continue

        texture_stem, source = find_up_face_texture_stem(model_path)

        if not texture_stem:
            texture_stem = bid
            source = "fallback.block_id"
            report["fallback_used_id_png"].append(bid)

        src_png = TEXTURES_BLOCK_DIR / f"{texture_stem}.png"
        if not src_png.exists():
            report["missing_texture_png"].append({"block_id": bid, "texture_stem": texture_stem, "source": source})
            continue

        out_png = OUT_DIR / f"{bid}.png"
        shutil.copyfile(src_png, out_png)

        report["written"] += 1
        report["map"][bid] = {
            "model_ref": model_ref,
            "model_path": str(model_path.relative_to(PROJECT_ROOT)),
            "texture_stem": texture_stem,
            "source": source,
            "src_png": str(src_png.relative_to(PROJECT_ROOT)),
            "out_png": str(out_png.relative_to(PROJECT_ROOT)),
        }

    REPORT_JSON.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(f"✅ Wrote {report['written']} TRUE top-face textures -> {OUT_DIR}")
    print(f"🧾 Report -> {REPORT_JSON}")


if __name__ == "__main__":
    main()
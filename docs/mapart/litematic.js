/**
 * litematic.js — Litematica .litematic export for MapArt Converter
 *
 * Generates a valid .litematic file from a 128×128 block assignment array.
 * The build is a flat layer (Y=0) of 128×128 blocks — ready to paste with Litematica.
 *
 * Format reference: https://github.com/maruohon/litematica/wiki/File-formats
 * NBT spec: https://wiki.vg/NBT
 */

"use strict";

// ─── NBT encoding ────────────────────────────────────────────────────────────
// We implement just enough NBT to write a valid .litematic file.
// NBT tag type IDs
const TAG = {
  END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4,
  FLOAT: 5, DOUBLE: 6, BYTE_ARRAY: 7, STRING: 8,
  LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12
};

class NBTWriter {
  constructor() {
    this._chunks = [];
    this._size   = 0;
  }

  _push(buf) {
    this._chunks.push(buf);
    this._size += buf.byteLength;
  }

  _u8(v)  { const b = new Uint8Array(1);  b[0] = v & 0xFF; this._push(b.buffer); }
  _i16(v) { const b = new DataView(new ArrayBuffer(2)); b.setInt16(0, v, false); this._push(b.buffer); }
  _i32(v) { const b = new DataView(new ArrayBuffer(4)); b.setInt32(0, v, false); this._push(b.buffer); }
  _i64(hi, lo) {
    const b = new DataView(new ArrayBuffer(8));
    b.setInt32(0, hi, false);
    b.setInt32(4, lo, false);
    this._push(b.buffer);
  }

  _str(s) {
    const enc = new TextEncoder().encode(s);
    this._i16(enc.length);
    this._push(enc.buffer);
  }

  // Write a named tag header: type byte + name string
  _header(type, name) {
    this._u8(type);
    this._str(name);
  }

  tagByte(name, v)  { this._header(TAG.BYTE,  name); this._u8(v); }
  tagShort(name, v) { this._header(TAG.SHORT, name); this._i16(v); }
  tagInt(name, v)   { this._header(TAG.INT,   name); this._i32(v); }

  tagLong(name, hi, lo) {
    this._header(TAG.LONG, name);
    this._i64(hi, lo);
  }

  tagString(name, s) {
    this._header(TAG.STRING, name);
    this._str(s);
  }

  tagLongArray(name, longs) {
    // longs: array of [hi, lo] pairs
    this._header(TAG.LONG_ARRAY, name);
    this._i32(longs.length);
    for (const [hi, lo] of longs) this._i64(hi, lo);
  }

  tagIntArray(name, ints) {
    this._header(TAG.INT_ARRAY, name);
    this._i32(ints.length);
    for (const v of ints) this._i32(v);
  }

  compoundStart(name) { this._header(TAG.COMPOUND, name); }
  compoundEnd()       { this._u8(TAG.END); }

  listStart(name, itemType, count) {
    this._header(TAG.LIST, name);
    this._u8(itemType);
    this._i32(count);
  }

  // Unnamed compound inside a list
  listCompoundItem() { /* no header needed, already in list context */ }

  // For writing an unnamed string inside a list of strings
  listStringItem(s) { this._str(s); }

  // For writing an unnamed compound tag (used inside lists)
  unnamedCompoundStart() { /* list compounds have no name prefix */ }
  unnamedCompoundEnd()   { this._u8(TAG.END); }

  // Inside a list of compounds, each item is just the payload + TAG_END
  // We need named tags inside but NO outer type/name header
  namedInsideList_Byte(name, v)   { this._u8(TAG.BYTE);   this._str(name); this._u8(v); }
  namedInsideList_Int(name, v)    { this._u8(TAG.INT);     this._str(name); this._i32(v); }
  namedInsideList_String(name, s) { this._u8(TAG.STRING);  this._str(name); this._str(s); }
  namedInsideList_Long(name, hi, lo) { this._u8(TAG.LONG); this._str(name); this._i64(hi, lo); }

  toBlob() {
    const out = new Uint8Array(this._size);
    let offset = 0;
    for (const chunk of this._chunks) {
      out.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }
    return new Blob([out], { type: "application/octet-stream" });
  }
}

// ─── Bit-packed block state array (Litematica format) ────────────────────────
// Litematica packs block state indices into an array of 64-bit longs.
// Each long holds floor(64 / bitsPerBlock) indices, NOT crossing long boundaries.
function packBlockStates(indices, bitsPerBlock) {
  const indicesPerLong = Math.floor(64 / bitsPerBlock);
  const numLongs = Math.ceil(indices.length / indicesPerLong);
  const longs = [];

  for (let i = 0; i < numLongs; i++) {
    let lo = 0, hi = 0;
    for (let j = 0; j < indicesPerLong; j++) {
      const idx = i * indicesPerLong + j;
      if (idx >= indices.length) break;
      const val = indices[idx];
      const bitOffset = j * bitsPerBlock;

      if (bitOffset < 32) {
        // Value starts in the low 32 bits
        const bitsInLo = Math.min(bitsPerBlock, 32 - bitOffset);
        const maskLo = (1 << bitsInLo) - 1;
        lo = (lo | ((val & maskLo) * Math.pow(2, bitOffset))) >>> 0;
        if (bitsInLo < bitsPerBlock) {
          // Remaining bits spill into hi
          const bitsInHi = bitsPerBlock - bitsInLo;
          const maskHi = (1 << bitsInHi) - 1;
          hi = (hi | (((val >> bitsInLo) & maskHi))) >>> 0;
        }
      } else {
        // Value is entirely in the high 32 bits
        const hiOffset = bitOffset - 32;
        hi = (hi | (val * Math.pow(2, hiOffset))) >>> 0;
      }
    }

    // Convert unsigned 32-bit to signed 32-bit for NBT
    const hiSigned = hi | 0;
    const loSigned = lo | 0;
    longs.push([hiSigned, loSigned]);
  }

  return longs;
}

// ─── Main export function ─────────────────────────────────────────────────────
/**
 * buildLitematic(assign, size, blocks)
 *
 * assign: array of block IDs (strings, without minecraft: prefix), length = size*size
 * size:   128 (or other square size)
 * blocks: the BLOCKS object from blocks.json (for names etc.)
 *
 * Returns a Blob of the .litematic file.
 */
export function buildLitematic(assign, size, blocks) {
  // ── 1. Build palette: unique block IDs → index ──────────────────────────
  const paletteIds  = ["minecraft:air"]; // index 0 is always air
  const paletteMap  = new Map([["minecraft:air", 0]]);

  for (const id of assign) {
    if (!id) continue;
    const mcId = `minecraft:${id}`;
    if (!paletteMap.has(mcId)) {
      paletteMap.set(mcId, paletteIds.length);
      paletteIds.push(mcId);
    }
  }

  const paletteSize = paletteIds.length;
  const bitsPerBlock = Math.max(2, Math.ceil(Math.log2(paletteSize)));

  // ── 2. Build block index array (X, Y, Z order — Y is vertical) ──────────
  // For a flat map art: Y=0, X=col, Z=row
  // Litematica order: x + z*Width + y*Width*Length
  const W = size, H = 1, L = size;
  const blockIndices = new Array(W * H * L).fill(0);

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const assignIdx = row * size + col;
      const id = assign[assignIdx];
      if (!id) continue;
      const mcId = `minecraft:${id}`;
      const paletteIdx = paletteMap.get(mcId) || 0;
      // Litematica: index = x + z*W + y*W*L
      const litIdx = col + row * W + 0 * W * L;
      blockIndices[litIdx] = paletteIdx;
    }
  }

  // ── 3. Pack into long array ───────────────────────────────────────────────
  const packedLongs = packBlockStates(blockIndices, bitsPerBlock);

  // ── 4. Count total non-air blocks ─────────────────────────────────────────
  const blockCount = assign.filter(Boolean).length;

  // ── 5. Current time in ms as two 32-bit halves ────────────────────────────
  const now = Date.now();
  const timeHi = Math.floor(now / 0x100000000) | 0;
  const timeLo = (now >>> 0) | 0;

  // ── 6. Write NBT ──────────────────────────────────────────────────────────
  const w = new NBTWriter();

  // Root compound (unnamed in .litematic — name is empty string)
  w.compoundStart("");

    // Metadata
    w.compoundStart("Metadata");
      w.compoundStart("EnclosingSize");
        w.tagInt("x", W);
        w.tagInt("y", H);
        w.tagInt("z", L);
      w.compoundEnd();
      w.tagString("Author", "MapArt Converter");
      w.tagString("Description", "Generated by MapArt Converter — joshuadobson.github.io/minecraft-tools/mapart/");
      w.tagString("Name", `MapArt_${size}x${size}`);
      w.tagInt("RegionCount", 1);
      w.tagLong("TimeCreated", timeHi, timeLo);
      w.tagLong("TimeModified", timeHi, timeLo);
      w.tagInt("TotalBlocks", blockCount);
      w.tagInt("TotalVolume", W * H * L);

      // Software version info Litematica expects
      w.compoundStart("Software");
        w.tagString("Name", "MapArt Converter");
        w.tagString("Version", "1.0.0");
      w.compoundEnd();
    w.compoundEnd(); // Metadata

    // MinecraftDataVersion — 1.20.1 = 3465
    w.tagInt("MinecraftDataVersion", 3465);
    // Litematica schematic version
    w.tagInt("Version", 6);

    // Regions
    w.compoundStart("Regions");
      w.compoundStart("MapArt");

        // BlockStatePalette — list of compounds
        w.listStart("BlockStatePalette", TAG.COMPOUND, paletteSize);
        for (const mcId of paletteIds) {
          w.namedInsideList_String("Name", mcId);
          // Properties compound — empty for default state blocks
          w._u8(TAG.COMPOUND); w._str("Properties"); w._u8(TAG.END);
          w._u8(TAG.END); // end of this palette entry compound
        }

        // BlockStates — packed long array
        w.tagLongArray("BlockStates", packedLongs);

        // Position
        w.compoundStart("Position");
          w.tagInt("x", 0);
          w.tagInt("y", 0);
          w.tagInt("z", 0);
        w.compoundEnd();

        // Size
        w.compoundStart("Size");
          w.tagInt("x", W);
          w.tagInt("y", H);
          w.tagInt("z", L);
        w.compoundEnd();

        // Empty lists Litematica expects
        w.listStart("Entities",     TAG.COMPOUND, 0);
        w.listStart("TileEntities", TAG.COMPOUND, 0);
        w.listStart("PendingBlockTicks", TAG.COMPOUND, 0);
        w.listStart("PendingFluidTicks", TAG.COMPOUND, 0);

      w.compoundEnd(); // MapArt region
    w.compoundEnd(); // Regions

  w.compoundEnd(); // root

  return w.toBlob();
}

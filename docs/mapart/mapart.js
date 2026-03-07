"use strict";

// ─── Constants ────────────────────────────────────────────────────────────────
const TILE        = 16;
const VIEW_MIN    = 0.25;
const VIEW_MAX    = 12;
const VIEW_STEP   = 1.3;
const DATA_URL    = "../data/blocks.json";
const TEX_DIR     = "../textures_top";

// ─── State ────────────────────────────────────────────────────────────────────
let BLOCKS        = null;   // raw blocks.json
let PALETTE       = [];     // filtered, ready-to-match entries
let cropper       = null;
let IS_GENERATING = false;
let VIEW_SCALE    = 1;
let LAST_COUNTS   = null;
let LAST_SIZE     = 128;
let LAST_ASSIGN   = null;
let CURRENT_BLOB  = null;

const TEX_CACHE   = new Map(); // id → HTMLImageElement | null

// ─── Multi-map state ──────────────────────────────────────────────────────────
let IS_GRID_GENERATING = false;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const elFile          = $("fileInput");
const elImg           = $("sourceImg");
const elHint          = $("cropHint");
const elResetCrop     = $("resetCropBtn");
const elGenerate      = $("generateBtn");
const elSizeSelect    = $("sizeSelect");
const elPaletteSelect = $("paletteSelect");
const elCreative      = $("includeCreative");
const elDither        = $("enableDither");
const elSmooth        = $("smoothInput");
const elStatus        = $("statusMsg");
const elProgressWrap  = $("progressWrap");
const elProgressBar   = $("progressBar");
const outCanvas       = $("outCanvas");
const outCtx          = outCanvas?.getContext("2d", { willReadFrequently: true });
const zoomWrap        = document.querySelector(".zoom-wrap");
const elDownloadPng   = $("downloadPng");
const elDownloadJson  = $("downloadJson");
const elDownloadCsv   = $("downloadCsv");
const elZoomIn        = $("zoomIn");
const elZoomOut       = $("zoomOut");
const elZoomReset     = $("zoomReset");
const elCountsMeta    = $("countsMeta");
const elCountsTable   = $("countsTable");

// Multi-map refs
const elGridSelect    = $("gridSelect");
const elGridGenerate  = $("gridGenerateBtn");
const elGridStatus    = $("gridStatus");
const elGridPreview   = $("gridPreview");
const elGridDownload  = $("gridDownloadBtn");

// ─── Utility ──────────────────────────────────────────────────────────────────
function setStatus(msg) {
  if (elStatus) elStatus.textContent = msg;
}

function setProgress(pct) {
  // pct: 0–1, or null to hide
  if (!elProgressWrap || !elProgressBar) return;
  if (pct === null) {
    elProgressWrap.style.opacity = "0";
    return;
  }
  elProgressWrap.style.opacity = "1";
  elProgressBar.style.width = `${Math.round(pct * 100)}%`;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function downloadText(filename, text, mime = "text/plain") {
  downloadBlob(filename, new Blob([text], { type: mime }));
}

function countsToCsv(counts) {
  const lines = ["block_id,block_name,count"];
  for (const [id, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    const name = (BLOCKS?.[id]?.name || id).replaceAll('"', '""');
    lines.push(`${id},"${name}",${n}`);
  }
  return lines.join("\n");
}

// ─── Color math (sRGB → Linear → XYZ D65 → CIELAB) ──────────────────────────
function srgbToLinear(u) {
  return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4);
}

function rgbToLab(R, G, B) {
  const r = srgbToLinear(R / 255);
  const g = srgbToLinear(G / 255);
  const b = srgbToLinear(B / 255);

  // XYZ (D65 illuminant)
  const X = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
  const Y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
  const Z = r * 0.0193339 + g * 0.1191920 + b * 0.9503041;

  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const fx = f(X / 0.95047);
  const fy = f(Y / 1.00000);
  const fz = f(Z / 1.08883);

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labDist(a, b) {
  const dL = a[0] - b[0], da = a[1] - b[1], db = a[2] - b[2];
  return dL * dL + da * da + db * db; // squared — enough for comparisons
}

// ─── Texture loading ─────────────────────────────────────────────────────────
function texUrl(id) { return `${TEX_DIR}/${id}.png`; }

function loadTex(id) {
  if (TEX_CACHE.has(id)) return Promise.resolve(TEX_CACHE.get(id));
  return new Promise(resolve => {
    const img = new Image();
    img.onload  = () => { TEX_CACHE.set(id, img); resolve(img); };
    img.onerror = () => { TEX_CACHE.set(id, null); resolve(null); };
    img.src = texUrl(id);
  });
}

// ─── Palette building ─────────────────────────────────────────────────────────
// No more HEAD requests: we attempt texture loads lazily at render time.
// buildPalette just filters BLOCKS by the user's chosen mode.
async function buildPalette() {
  if (!BLOCKS) return;
  setStatus("Building palette…");

  const mode           = elPaletteSelect?.value || "full_solid";
  const incCreative    = !!elCreative?.checked;
  const arr            = [];

  for (const [id, b] of Object.entries(BLOCKS)) {
    if (!b?.avg_lab) continue;
    const tags  = b.tags       || {};
    const flags = b.tag_flags  || {};

    if (!incCreative && tags.creative_only) continue;

    if (mode === "full_solid") {
      if (flags.full_block !== true) continue;
      if (tags.transparent || tags.noisy)  continue;
    } else if (mode === "all_solid") {
      if (flags.full_block !== true) continue;
      if (tags.transparent)          continue;
    }
    // "everything": no extra filter

    arr.push({ id, name: b.name || id, lab: b.avg_lab });
  }

  arr.sort((a, b) => a.id.localeCompare(b.id));
  PALETTE = arr;
  setStatus(`Palette ready — ${PALETTE.length} blocks. Upload an image to start.`);
}

// ─── Nearest block (brute-force; fast enough for 128×128 with caching) ────────
function nearestBlock(lab) {
  let best = PALETTE[0], bestD = Infinity;
  for (const p of PALETTE) {
    const d = labDist(lab, p.lab);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

// ─── Cropper ─────────────────────────────────────────────────────────────────
function initCropper() {
  if (cropper) { cropper.destroy(); cropper = null; }

  if (window.Cropper && elImg) {
    cropper = new Cropper(elImg, {
      viewMode: 1,
      dragMode: "move",
      aspectRatio: 1,
      autoCropArea: 1,
      background: false,
      responsive: true,
      guides: true,
      center: true,
    });
    elResetCrop.disabled = false;
  }

  elGenerate.disabled = false;
  setStatus("Adjust crop, then click Generate.");
}

function getCroppedCanvas(size) {
  if (cropper) {
    // Always get the best quality crop then scale to requested size
    const raw = cropper.getCroppedCanvas({ imageSmoothingEnabled: true, imageSmoothingQuality: "high" });
    const c   = Object.assign(document.createElement("canvas"), { width: size, height: size });
    const cx  = c.getContext("2d", { willReadFrequently: true });
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = "high";
    cx.drawImage(raw, 0, 0, raw.width, raw.height, 0, 0, size, size);
    return c;
  }
  // Centre-crop fallback
  const sw = elImg.naturalWidth, sh = elImg.naturalHeight;
  const s  = Math.min(sw, sh);
  const c  = Object.assign(document.createElement("canvas"), { width: size, height: size });
  const cx = c.getContext("2d", { willReadFrequently: true });
  cx.imageSmoothingEnabled = true;
  cx.drawImage(elImg, Math.floor((sw - s) / 2), Math.floor((sh - s) / 2), s, s, 0, 0, size, size);
  return c;
}

// ─── Optional: mild blur to reduce high-frequency noise before matching ───────
function blurCanvas(src, radius = 0.8) {
  const c = Object.assign(document.createElement("canvas"), { width: src.width, height: src.height });
  const ctx = c.getContext("2d");
  ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(src, 0, 0);
  return c;
}

// ─── Floyd-Steinberg dithering ────────────────────────────────────────────────
// Operates in Lab space for perceptually uniform error diffusion.
// Returns assign[] (block id per pixel) and counts {}.
function ditherAssign(imgData, size) {
  const data = imgData.data;
  // Build a Float32 Lab buffer so we can diffuse errors
  const labBuf = new Float32Array(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    const [L, a, b] = rgbToLab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    labBuf[i * 3]     = L;
    labBuf[i * 3 + 1] = a;
    labBuf[i * 3 + 2] = b;
  }

  const assign = new Array(size * size).fill(null);
  const counts = {};

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      const off = idx * 3;
      const pixLab = [labBuf[off], labBuf[off + 1], labBuf[off + 2]];

      const picked = nearestBlock(pixLab);
      assign[idx]           = picked.id;
      counts[picked.id]     = (counts[picked.id] || 0) + 1;

      // Error = input − chosen block's Lab
      const eL = pixLab[0] - picked.lab[0];
      const ea = pixLab[1] - picked.lab[1];
      const eb = pixLab[2] - picked.lab[2];

      // Diffuse to right (7/16), bottom-left (3/16), below (5/16), bottom-right (1/16)
      const spread = [
        [x + 1, y,     7 / 16],
        [x - 1, y + 1, 3 / 16],
        [x,     y + 1, 5 / 16],
        [x + 1, y + 1, 1 / 16],
      ];
      for (const [nx, ny, w] of spread) {
        if (nx < 0 || nx >= size || ny >= size) continue;
        const ni = (ny * size + nx) * 3;
        labBuf[ni]     += eL * w;
        labBuf[ni + 1] += ea * w;
        labBuf[ni + 2] += eb * w;
      }
    }
  }

  return { assign, counts };
}

// ─── Simple (no dither) assign ────────────────────────────────────────────────
function simpleAssign(imgData, size) {
  const data   = imgData.data;
  const assign = new Array(size * size).fill(null);
  const counts = {};
  const cache  = new Map(); // rgb int → block

  for (let i = 0; i < size * size; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const a = data[i * 4 + 3];
    if (a === 0) continue;

    const key = (r << 16) | (g << 8) | b;
    let pick = cache.get(key);
    if (!pick) {
      pick = nearestBlock(rgbToLab(r, g, b));
      cache.set(key, pick);
    }
    assign[i]          = pick.id;
    counts[pick.id]    = (counts[pick.id] || 0) + 1;
  }

  return { assign, counts };
}

// ─── Render mosaic ────────────────────────────────────────────────────────────
async function renderMosaic(assign, size) {
  const W = size * TILE, H = size * TILE;
  outCanvas.width  = W;
  outCanvas.height = H;
  outCtx.imageSmoothingEnabled = false;
  outCtx.clearRect(0, 0, W, H);

  const usedIds = [...new Set(assign)].filter(Boolean);

  // Load textures in parallel
  await Promise.all(usedIds.map(loadTex));

  // Render row by row, yielding occasionally so the browser stays responsive
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const id  = assign[y * size + x];
      if (!id) continue;
      const tex = TEX_CACHE.get(id);
      if (tex) {
        outCtx.drawImage(tex, 0, 0, tex.width, tex.height, x * TILE, y * TILE, TILE, TILE);
      } else {
        // Fallback: draw the block's avg colour as a solid tile
        const b = BLOCKS?.[id];
        if (b?.avg_lab) {
          // Approximate Lab→RGB for a simple fallback swatch
          outCtx.fillStyle = labToHexApprox(b.avg_lab);
          outCtx.fillRect(x * TILE, y * TILE, TILE, TILE);
        }
      }
    }

    // Yield every 8 rows
    if (y % 8 === 0) {
      setProgress((y + 1) / size * 0.9 + 0.1);
      await new Promise(r => setTimeout(r, 0));
    }
  }
}

// Very rough Lab→hex fallback (only used when texture is missing)
function labToHexApprox([L, a, b]) {
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const f3 = t => t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787;
  const X  = f3(fx) * 0.95047;
  const Y  = f3(fy) * 1.00000;
  const Z  = f3(fz) * 1.08883;
  const toS = u => {
    const v = u <= 0.0031308 ? 12.92 * u : 1.055 * u ** (1 / 2.4) - 0.055;
    return clamp(Math.round(v * 255), 0, 255);
  };
  const R = toS( 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z);
  const G = toS(-0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z);
  const B = toS( 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z);
  return `#${[R, G, B].map(v => v.toString(16).padStart(2, "0")).join("")}`;
}

// ─── Counts UI ────────────────────────────────────────────────────────────────
function renderCounts(counts, total) {
  if (!elCountsTable) return;

  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    elCountsTable.innerHTML = `<p class="empty">No counts yet.</p>`;
    return;
  }

  elCountsTable.innerHTML = entries.map(([id, n]) => {
    const name = BLOCKS?.[id]?.name || id;
    const pct  = ((n / total) * 100).toFixed(1);
    return `
      <div class="count-row">
        <img class="count-thumb" src="${texUrl(id)}" alt="${name}" loading="lazy" />
        <div class="count-info">
          <span class="count-name">${name}</span>
          <span class="count-sub">${id} · ${pct}%</span>
        </div>
        <span class="count-num">${n.toLocaleString()}</span>
      </div>`;
  }).join("");
}

// ─── Zoom / Pan ───────────────────────────────────────────────────────────────
function applyScale() {
  if (!outCanvas) return;
  outCanvas.style.transformOrigin = "0 0";
  outCanvas.style.transform = `scale(${VIEW_SCALE})`;
  // Resize the virtual scroll container so scrollbars appear
  if (zoomWrap) {
    const cw = outCanvas.width  * VIEW_SCALE;
    const ch = outCanvas.height * VIEW_SCALE;
    outCanvas.style.width  = `${outCanvas.width}px`;
    outCanvas.style.height = `${outCanvas.height}px`;
  }
}

function fitToFrame() {
  if (!zoomWrap || !outCanvas || outCanvas.width === 0) return;
  const s = Math.min(
    zoomWrap.clientWidth  / outCanvas.width,
    zoomWrap.clientHeight / outCanvas.height
  );
  VIEW_SCALE = clamp(s, VIEW_MIN, VIEW_MAX);
  applyScale();
  zoomWrap.scrollLeft = Math.max(0, (outCanvas.width  * VIEW_SCALE - zoomWrap.clientWidth)  / 2);
  zoomWrap.scrollTop  = Math.max(0, (outCanvas.height * VIEW_SCALE - zoomWrap.clientHeight) / 2);
}

function zoomAt(factor) {
  if (!zoomWrap || !outCanvas) return;
  const ww = zoomWrap.clientWidth, wh = zoomWrap.clientHeight;
  const cx = zoomWrap.scrollLeft + ww / 2;
  const cy = zoomWrap.scrollTop  + wh / 2;
  const old = VIEW_SCALE;
  VIEW_SCALE = clamp(old * factor, VIEW_MIN, VIEW_MAX);
  applyScale();
  const ratio = VIEW_SCALE / old;
  zoomWrap.scrollLeft = cx * ratio - ww / 2;
  zoomWrap.scrollTop  = cy * ratio - wh / 2;
}

function enableDragPan(el) {
  let down = false, sx = 0, sy = 0, sl = 0, st = 0;
  el.addEventListener("mousedown",  e => { down = true; sx = e.pageX; sy = e.pageY; sl = el.scrollLeft; st = el.scrollTop; el.style.cursor = "grabbing"; });
  window.addEventListener("mouseup", () => { down = false; el.style.cursor = "grab"; });
  el.addEventListener("mousemove",  e => { if (!down) return; e.preventDefault(); el.scrollLeft = sl - (e.pageX - sx); el.scrollTop = st - (e.pageY - sy); });
  el.addEventListener("wheel", e => { e.preventDefault(); zoomAt(e.deltaY < 0 ? VIEW_STEP : 1 / VIEW_STEP); }, { passive: false });
}

// ─── Generate ─────────────────────────────────────────────────────────────────
async function generate() {
  if (IS_GENERATING) return;
  IS_GENERATING = true;
  elGenerate.disabled = true;
  elGenerate.textContent = "Generating…";

  try {
    if (!BLOCKS)          { setStatus("Blocks not loaded."); return; }
    if (!PALETTE.length)  { setStatus("Palette is empty — check palette settings."); return; }
    if (!elImg?.src)      { setStatus("Upload an image first."); return; }

    const size = parseInt(elSizeSelect?.value || "128", 10);
    LAST_SIZE  = size;

    setProgress(0);
    setStatus(`Cropping to ${size}×${size}…`);
    let src = getCroppedCanvas(size);
    if (elSmooth?.checked) src = blurCanvas(src, 0.8);

    // Read pixels
    const tmp = Object.assign(document.createElement("canvas"), { width: size, height: size });
    const tctx = tmp.getContext("2d", { willReadFrequently: true });
    tctx.drawImage(src, 0, 0);
    const imgData = tctx.getImageData(0, 0, size, size);

    setProgress(0.05);
    setStatus(`Matching pixels (${elDither?.checked ? "dithering" : "nearest"} mode)…`);

    await new Promise(r => setTimeout(r, 0)); // yield before heavy work

    const { assign, counts } = elDither?.checked
      ? ditherAssign(imgData, size)
      : simpleAssign(imgData, size);

    LAST_ASSIGN = assign;
    LAST_COUNTS = counts;

    setProgress(0.1);
    setStatus("Rendering mosaic…");
    await renderMosaic(assign, size);

    // UI
    const total  = size * size;
    const unique = Object.keys(counts).length;
    if (elCountsMeta) {
      elCountsMeta.textContent = `${total.toLocaleString()} blocks · ${unique} unique types · palette: ${PALETTE.length}`;
    }
    renderCounts(counts, total);

    elDownloadPng.disabled  = false;
    elDownloadJson.disabled = false;
    elDownloadCsv.disabled  = false;

    fitToFrame();
    setProgress(null);
    setStatus("Done ✓");
    if (elGridGenerate) elGridGenerate.disabled = false;
    setGridStatus("Ready — choose a grid size and click Generate Grid.");

  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err?.message || err}`);
    setProgress(null);
  } finally {
    IS_GENERATING        = false;
    elGenerate.disabled  = false;
    elGenerate.textContent = "Generate";
  }
}

// ─── Multi-map grid generation ────────────────────────────────────────────────
function setGridStatus(msg) {
  if (elGridStatus) elGridStatus.textContent = msg;
}

// Render a single 128×128 segment from assign[] into a new canvas and return it
async function renderSegmentCanvas(assign, size) {
  const W = size * TILE, H = size * TILE;
  const c = Object.assign(document.createElement("canvas"), { width: W, height: H });
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  const usedIds = [...new Set(assign)].filter(Boolean);
  await Promise.all(usedIds.map(loadTex));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const id  = assign[y * size + x];
      if (!id) continue;
      const tex = TEX_CACHE.get(id);
      if (tex) {
        ctx.drawImage(tex, 0, 0, tex.width, tex.height, x * TILE, y * TILE, TILE, TILE);
      } else {
        const b = BLOCKS?.[id];
        if (b?.avg_lab) { ctx.fillStyle = labToHexApprox(b.avg_lab); ctx.fillRect(x * TILE, y * TILE, TILE, TILE); }
      }
    }
  }
  return c;
}

// Convert canvas to PNG blob
function canvasToBlob(canvas) {
  return new Promise(resolve => canvas.toBlob(resolve, "image/png"));
}

async function generateGrid() {
  if (IS_GRID_GENERATING) return;
  if (!BLOCKS)         { setGridStatus("Blocks not loaded yet."); return; }
  if (!PALETTE.length) { setGridStatus("Palette is empty."); return; }
  if (!elImg?.src)     { setGridStatus("Upload an image first."); return; }

  IS_GRID_GENERATING = true;
  elGridGenerate.disabled = true;
  elGridGenerate.textContent = "Generating…";
  elGridDownload.disabled = true;
  if (elGridPreview) elGridPreview.innerHTML = "";

  try {
    const grid = parseInt(elGridSelect?.value || "2", 10);
    const totalSize = grid * 128;

    setGridStatus(`Cropping to ${totalSize}×${totalSize}…`);
    let src = getCroppedCanvas(totalSize);
    if (elSmooth?.checked) src = blurCanvas(src, 0.8);

    // Read full image pixels
    const tmp  = Object.assign(document.createElement("canvas"), { width: totalSize, height: totalSize });
    const tctx = tmp.getContext("2d", { willReadFrequently: true });
    tctx.drawImage(src, 0, 0);

    const segments = []; // { row, col, canvas, counts }
    const allCounts = {};

    for (let row = 0; row < grid; row++) {
      for (let col = 0; col < grid; col++) {
        setGridStatus(`Processing segment ${row * grid + col + 1} of ${grid * grid}…`);
        await new Promise(r => setTimeout(r, 0));

        // Extract 128×128 segment pixels
        const segData = tctx.getImageData(col * 128, row * 128, 128, 128);

        const { assign, counts } = elDither?.checked
          ? ditherAssign(segData, 128)
          : simpleAssign(segData, 128);

        // Merge counts
        for (const [id, n] of Object.entries(counts)) {
          allCounts[id] = (allCounts[id] || 0) + n;
        }

        const segCanvas = await renderSegmentCanvas(assign, 128);
        segments.push({ row, col, canvas: segCanvas, counts });
      }
    }

    // Build grid preview
    if (elGridPreview) {
      elGridPreview.innerHTML = "";
      elGridPreview.style.gridTemplateColumns = `repeat(${grid}, 1fr)`;

      for (const seg of segments) {
        const wrapper = document.createElement("div");
        wrapper.className = "grid-seg";

        const label = document.createElement("div");
        label.className = "grid-seg-label";
        label.textContent = `R${seg.row + 1} C${seg.col + 1}`;

        // Scale down for preview
        const preview = document.createElement("canvas");
        preview.width  = 128;
        preview.height = 128;
        preview.style.imageRendering = "pixelated";
        preview.style.width  = "100%";
        preview.style.height = "100%";
        const pctx = preview.getContext("2d");
        pctx.drawImage(seg.canvas, 0, 0, seg.canvas.width, seg.canvas.height, 0, 0, 128, 128);

        wrapper.appendChild(preview);
        wrapper.appendChild(label);
        elGridPreview.appendChild(wrapper);
      }
    }

    // Store segments for download
    elGridDownload._segments = segments;
    elGridDownload._grid     = grid;
    elGridDownload._counts   = allCounts;
    elGridDownload.disabled  = false;

    setGridStatus(`Done ✓ — ${grid}×${grid} grid (${grid * grid} maps)`);

  } catch (err) {
    console.error(err);
    setGridStatus(`Error: ${err?.message || err}`);
  } finally {
    IS_GRID_GENERATING = false;
    elGridGenerate.disabled  = false;
    elGridGenerate.textContent = "Generate Grid";
  }
}

async function downloadGridZip() {
  const segments = elGridDownload._segments;
  const grid     = elGridDownload._grid;
  const counts   = elGridDownload._counts;
  if (!segments || !grid) return;

  if (typeof JSZip === "undefined") {
    alert("JSZip not loaded — check your internet connection and refresh.");
    return;
  }

  elGridDownload.textContent = "Building zip…";
  elGridDownload.disabled = true;

  try {
    const zip = new JSZip();
    const folder = zip.folder(`mapart-${grid}x${grid}-grid`);

    for (const seg of segments) {
      const blob = await canvasToBlob(seg.canvas);
      folder.file(`map_row${seg.row + 1}_col${seg.col + 1}.png`, blob);
    }

    // Add a helpful README
    const readme = [
      `Minecraft Map Art — ${grid}×${grid} Grid`,
      `Generated by MapArt Converter (joshuadobson.github.io/minecraft-tools/mapart/)`,
      ``,
      `HOW TO USE:`,
      `Each PNG is one 128×128 Minecraft map.`,
      `Place them in your world in this layout:`,
      ``,
      ...Array.from({ length: grid }, (_, row) =>
        Array.from({ length: grid }, (_, col) =>
          `map_row${row + 1}_col${col + 1}.png`
        ).join("  |  ")
      ),
      ``,
      `BLOCK TOTALS (all segments combined):`,
      ...Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([id, n]) => `  ${(BLOCKS?.[id]?.name || id).padEnd(40)} ${n.toLocaleString()}`),
      ``,
      `If this tool saved you time, consider supporting on Ko-fi:`,
      `https://ko-fi.com/joshuadobson`,
    ].join("\n");

    folder.file("README.txt", readme);

    const blob = await zip.generateAsync({ type: "blob" });
    downloadBlob(`mapart-${grid}x${grid}-grid.zip`, blob);

  } finally {
    elGridDownload.textContent = "↓ Download ZIP";
    elGridDownload.disabled = false;
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  setStatus("Loading blocks.json…");
  try {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    BLOCKS = await res.json();
    await buildPalette();
  } catch (e) {
    console.error(e);
    setStatus("⚠ Could not load ../data/blocks.json. Make sure you're running a local server from /site.");
  }
}

// ─── Events ───────────────────────────────────────────────────────────────────
elFile?.addEventListener("change", e => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (CURRENT_BLOB) URL.revokeObjectURL(CURRENT_BLOB);
  CURRENT_BLOB = URL.createObjectURL(file);
  elImg.onload = () => {
    elHint.style.display = "none";
    elImg.style.opacity  = "1";
    initCropper();
  };
  elImg.src = CURRENT_BLOB;
});

elResetCrop?.addEventListener("click",  () => cropper?.reset());
elGenerate?.addEventListener("click",   generate);

elPaletteSelect?.addEventListener("change", async () => {
  await buildPalette();
  if (LAST_ASSIGN) generate();
});
elCreative?.addEventListener("change", async () => {
  await buildPalette();
  if (LAST_ASSIGN) generate();
});

elDownloadPng?.addEventListener("click", () => {
  if (!outCanvas) return;
  outCanvas.toBlob(blob => blob && downloadBlob(`mapart-${LAST_SIZE}x${LAST_SIZE}.png`, blob), "image/png");
});
elDownloadJson?.addEventListener("click", () => {
  if (LAST_COUNTS) downloadText(`block-counts-${LAST_SIZE}.json`, JSON.stringify(LAST_COUNTS, null, 2), "application/json");
});
elDownloadCsv?.addEventListener("click", () => {
  if (LAST_COUNTS) downloadText(`block-counts-${LAST_SIZE}.csv`, countsToCsv(LAST_COUNTS), "text/csv");
});

elGridGenerate?.addEventListener("click",  generateGrid);
elGridDownload?.addEventListener("click",  downloadGridZip);

elZoomIn?.addEventListener("click",    () => zoomAt(VIEW_STEP));
elZoomOut?.addEventListener("click",   () => zoomAt(1 / VIEW_STEP));
elZoomReset?.addEventListener("click", fitToFrame);

if (zoomWrap) enableDragPan(zoomWrap);

window.addEventListener("resize", () => {
  if (outCanvas?.width > 0) fitToFrame();
});
window.addEventListener("keydown", e => {
  if (e.key === "+" || e.key === "=") zoomAt(VIEW_STEP);
  if (e.key === "-")                  zoomAt(1 / VIEW_STEP);
});

init();

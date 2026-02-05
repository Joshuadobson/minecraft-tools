/* Map Art Converter (MapArt) — up-to-date, robust
 *
 * Features:
 * - Loads ../data/blocks.json (run server from /site)
 * - Crop-to-square via CropperJS (fallback: center-crop)
 * - Matches each pixel to nearest block avg_lab (Lab distance)
 * - Renders a TRUE texture mosaic using curated TOP textures (../textures_top/<id>.png)
 * - Block counts table + downloads (PNG / counts JSON / counts CSV)
 * - Pan by dragging (mouse) in preview window
 * - Zoom in/out/reset via buttons (no slider)
 *
 * Requirements:
 * - site/data/blocks.json exists
 * - curated textures exist at: site/textures_top/<block_id>.png
 * - index.html includes:
 *     <script src="libs/cropper.min.js"></script>
 *     <script src="mapart.js"></script>
 * - IMPORTANT: IDs in HTML must be unique (includeCreative, generateBtn etc.)
 */

"use strict";

let BLOCKS = null;
let PALETTE = []; // { id, name, lab:[L,a,b], tags, flags }
let cropper = null;

const TILE = 16; // render each chosen texture as a 16×16 tile
const TEX_CACHE = new Map(); // id -> HTMLImageElement
const TOP_TEX_OK = new Map(); // id -> boolean

let LAST_COUNTS = null;
let LAST_SIZE = 128;
let LAST_ASSIGN = null;

let IS_GENERATING = false;

// ---- DOM ----
const elFile = document.getElementById("fileInput");
const elImg = document.getElementById("sourceImg");
const elHint = document.getElementById("cropHint");
const elReset = document.getElementById("resetBtn");
const elGen = document.getElementById("generateBtn");
const elSize = document.getElementById("sizeSel");
const elPalette = document.getElementById("paletteSel");
const elCreative = document.getElementById("includeCreative");
const elTexPreview = document.getElementById("texturePreview"); // kept for UI; mosaic is always texture-based
const elStatus = document.getElementById("status");

const outCanvas = document.getElementById("outCanvas");
const outCtx = outCanvas?.getContext("2d", { willReadFrequently: true });

const elDownload = document.getElementById("downloadBtn");
const elCountsMeta = document.getElementById("countsMeta");
const elCountsTable = document.getElementById("countsTable");
const elDLCountsJson = document.getElementById("downloadCountsJson");
const elDLCountsCsv = document.getElementById("downloadCountsCsv");

const elZoomIn = document.getElementById("zoomInBtn");
const elZoomOut = document.getElementById("zoomOutBtn");
const elZoomReset = document.getElementById("zoomResetBtn");
const zoomWrap = document.querySelector(".zoomWrap");

// ---- View state (zoom/pan) ----
let VIEW_SCALE = 1;
const VIEW_MIN = 0.25;
const VIEW_MAX = 8;
const VIEW_STEP = 1.25;

const elSmooth = () => document.getElementById("smoothInput");

function getBlurredCanvas(srcCanvas, radius = 0.8){
  const c = document.createElement("canvas");
  c.width = srcCanvas.width;
  c.height = srcCanvas.height;

  const ctx = c.getContext("2d");
  ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(srcCanvas, 0, 0);
  ctx.filter = "none";

  return c;
}
// ---------- Utilities ----------
function setStatus(msg){
  if(elStatus) elStatus.textContent = msg;
}

function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

function downloadText(filename, text, mime="text/plain"){
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function countsToCsv(counts){
  const entries = Object.entries(counts).sort((a,b)=>b[1]-a[1]);
  const lines = ["block_id,block_name,count"];
  for(const [id, n] of entries){
    const name = (BLOCKS?.[id]?.name || id).replaceAll('"','""');
    lines.push(`${id},"${name}",${n}`);
  }
  return lines.join("\n");
}

function downloadCanvasPNG(canvas, filename){
  canvas.toBlob((blob) => {
    if(!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, "image/png");
}

// ---------- Lab conversion (sRGB -> linear -> XYZ -> Lab D65) ----------
function srgbToLinear(u){
  return (u <= 0.04045) ? (u / 12.92) : Math.pow((u + 0.055) / 1.055, 2.4);
}
function rgbToXyz(r, g, b){
  const x = r*0.4124564 + g*0.3575761 + b*0.1804375;
  const y = r*0.2126729 + g*0.7151522 + b*0.0721750;
  const z = r*0.0193339 + g*0.1191920 + b*0.9503041;
  return [x,y,z];
}
function fLab(t){
  const d = 6/29;
  const d3 = d*d*d;
  return (t > d3) ? Math.cbrt(t) : (t/(3*d*d) + 4/29);
}
function xyzToLab(x,y,z){
  const Xn = 0.95047, Yn = 1.0, Zn = 1.08883;
  const fx = fLab(x/Xn), fy = fLab(y/Yn), fz = fLab(z/Zn);
  const L = 116*fy - 16;
  const a = 500*(fx - fy);
  const b = 200*(fy - fz);
  return [L,a,b];
}
function rgbToLab255(R,G,B){
  const r = srgbToLinear(R/255);
  const g = srgbToLinear(G/255);
  const b = srgbToLinear(B/255);
  const [x,y,z] = rgbToXyz(r,g,b);
  return xyzToLab(x,y,z);
}
function distLab(a,b){
  const dL = a[0]-b[0], da = a[1]-b[1], db = a[2]-b[2];
  return Math.sqrt(dL*dL + da*da + db*db);
}

// ---------- Curated TOP textures ----------
function topTextureUrl(id){
  // mapart/ -> ../textures_top/
  return `../textures_top/${id}.png`;
}

async function topTextureExists(id){
  if(TOP_TEX_OK.has(id)) return TOP_TEX_OK.get(id);

  const url = topTextureUrl(id);
  try{
    const res = await fetch(url, { method: "HEAD", cache: "no-store" });
    const ok = res.ok;
    TOP_TEX_OK.set(id, ok);
    return ok;
  } catch {
    TOP_TEX_OK.set(id, false);
    return false;
  }
}

function loadTextureForBlock(id){
  if(TEX_CACHE.has(id)) return Promise.resolve(TEX_CACHE.get(id));

  const url = topTextureUrl(id);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      TEX_CACHE.set(id, img);
      resolve(img);
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// ---------- Cropper ----------
function initCropper(){
  if(cropper){
    cropper.destroy();
    cropper = null;
  }

  if(window.Cropper && elImg){
    cropper = new Cropper(elImg, {
      viewMode: 1,
      dragMode: "move",
      aspectRatio: 1,
      autoCropArea: 1,
      background: false,
      responsive: true,
      guides: true,
      center: true
    });
    if(elReset) elReset.disabled = false;
    if(elGen) elGen.disabled = false;
    return;
  }

  if(elReset) elReset.disabled = true;
  if(elGen) elGen.disabled = false;
  setStatus("CropperJS not found. Using center-crop fallback.");
}

function getCroppedCanvas(size){
  if(cropper){
    return cropper.getCroppedCanvas({
      width: size,
      height: size,
      imageSmoothingEnabled: true
    });
  }

  // Center-crop fallback
  const srcW = elImg.naturalWidth;
  const srcH = elImg.naturalHeight;
  const s = Math.min(srcW, srcH);
  const sx = Math.floor((srcW - s) / 2);
  const sy = Math.floor((srcH - s) / 2);

  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const cx = c.getContext("2d", { willReadFrequently: true });
  cx.imageSmoothingEnabled = true;
  cx.drawImage(elImg, sx, sy, s, s, 0, 0, size, size);
  return c;
}

// ---------- Palette building ----------
async function buildPalette(){
  if(!BLOCKS) return;

  setStatus("Building palette…");

  const mode = elPalette?.value || "full_solid";
  const includeCreative = !!elCreative?.checked;

  const ids = Object.keys(BLOCKS);
  const arr = [];

  // Only include blocks that have curated top textures present
  // (prevents falling back to old /textures)
  for(const id of ids){
    const b = BLOCKS[id];
    if(!b?.avg_lab) continue;

    const tags = b.tags || {};
    const flags = b.tag_flags || {};

    if(!includeCreative && tags.creative_only) continue;

    if(mode === "full_solid"){
      if(flags.full_block !== true) continue;
      if(tags.transparent) continue;
      if(tags.noisy) continue;
    } else if(mode === "all_solid"){
      if(flags.full_block !== true) continue;
      if(tags.transparent) continue;
    } // everything: no extra filters

    if(!(await topTextureExists(id))) continue;

    arr.push({
      id,
      name: b.name || id,
      lab: b.avg_lab,
      tags,
      flags
    });
  }

  arr.sort((a,b) => a.id.localeCompare(b.id));
  PALETTE = arr;

  setStatus(`Loaded blocks: ${Object.keys(BLOCKS).length}. Palette: ${PALETTE.length}.`);
}

// ---------- Matching ----------
function findNearestBlock(lab){
  let best = null;
  let bestD = Infinity;
  for(const p of PALETTE){
    const d = distLab(lab, p.lab);
    if(d < bestD){
      bestD = d;
      best = p;
    }
  }
  return best;
}

// ---------- Render mosaic ----------
async function renderTextureMosaic(assign, size){
  const W = size * TILE;
  const H = size * TILE;

  outCanvas.width = W;
  outCanvas.height = H;

  outCtx.imageSmoothingEnabled = false;
  outCtx.clearRect(0, 0, W, H);

  // load used textures
  const used = Array.from(new Set(assign)).filter(Boolean);
  await Promise.all(used.map(loadTextureForBlock));

  let p = 0;
  for(let y=0; y<size; y++){
    for(let x=0; x<size; x++){
      const id = assign[p++];
      if(!id) continue;

      const tex = TEX_CACHE.get(id);
      if(!tex) continue;

      outCtx.drawImage(tex, 0, 0, tex.width, tex.height, x*TILE, y*TILE, TILE, TILE);
    }
  }
}

// ---------- Counts UI ----------
function renderCounts(counts, total){
  if(!elCountsTable) return;

  const entries = Object.entries(counts).sort((a,b) => b[1]-a[1]);
  if(entries.length === 0){
    elCountsTable.innerHTML = `<div class="muted">No counts yet.</div>`;
    return;
  }

  elCountsTable.innerHTML = entries.map(([id, n]) => {
    const b = BLOCKS?.[id];
    const name = b?.name || id;
    const pct = ((n / total) * 100).toFixed(1);
    const img = topTextureUrl(id);

    return `
      <div class="countRow">
        <img class="countThumb" src="${img}" alt="${name}" />
        <div class="countName">
          ${name}
          <div class="muted" style="padding:0;margin:0;font-size:11px">${id} • ${pct}%</div>
        </div>
        <div class="countNum">${n.toLocaleString()}</div>
      </div>
    `;
  }).join("");
}

// ---------- View transform (zoom/pan) ----------
function applyViewTransform(){
  if(!outCanvas) return;
  outCanvas.style.transformOrigin = "0 0";
  outCanvas.style.transform = `scale(${VIEW_SCALE})`;
}

function fitToFrame(){
  if(!zoomWrap || !outCanvas) return;

  // After render, canvas has real pixel size (size*TILE).
  // Fit it into the visible wrapper.
  const cw = outCanvas.width;
  const ch = outCanvas.height;
  const ww = zoomWrap.clientWidth;
  const wh = zoomWrap.clientHeight;

  if(cw <= 0 || ch <= 0 || ww <= 0 || wh <= 0) return;

  const s = Math.min(ww / cw, wh / ch);
  VIEW_SCALE = clamp(s, VIEW_MIN, VIEW_MAX);
  applyViewTransform();

  // center
  zoomWrap.scrollLeft = Math.max(0, (cw * VIEW_SCALE - ww) / 2);
  zoomWrap.scrollTop  = Math.max(0, (ch * VIEW_SCALE - wh) / 2);
}

function zoomAtCenter(factor){
  if(!zoomWrap || !outCanvas) return;

  const ww = zoomWrap.clientWidth;
  const wh = zoomWrap.clientHeight;

  // current center in scroll space
  const cx = zoomWrap.scrollLeft + ww/2;
  const cy = zoomWrap.scrollTop + wh/2;

  const oldScale = VIEW_SCALE;
  const newScale = clamp(oldScale * factor, VIEW_MIN, VIEW_MAX);
  VIEW_SCALE = newScale;
  applyViewTransform();

  // keep center stable
  const ratio = newScale / oldScale;
  zoomWrap.scrollLeft = cx * ratio - ww/2;
  zoomWrap.scrollTop  = cy * ratio - wh/2;
}

function enableDragPan(container){
  let isDown = false;
  let startX = 0, startY = 0;
  let scrollLeft = 0, scrollTop = 0;

  container.style.cursor = "grab";

  container.addEventListener("mousedown", (e) => {
    isDown = true;
    container.style.cursor = "grabbing";
    startX = e.pageX;
    startY = e.pageY;
    scrollLeft = container.scrollLeft;
    scrollTop = container.scrollTop;
  });

  window.addEventListener("mouseup", () => {
    isDown = false;
    container.style.cursor = "grab";
  });

  container.addEventListener("mouseleave", () => {
    isDown = false;
    container.style.cursor = "grab";
  });

  container.addEventListener("mousemove", (e) => {
    if(!isDown) return;
    e.preventDefault();
    const dx = e.pageX - startX;
    const dy = e.pageY - startY;
    container.scrollLeft = scrollLeft - dx;
    container.scrollTop = scrollTop - dy;
  });
}

// ---------- Generate ----------
async function generate(){
  if(IS_GENERATING) return;
  IS_GENERATING = true;

  try{
    if(!BLOCKS){
      setStatus("Blocks not loaded yet.");
      return;
    }
    if(PALETTE.length === 0){
      setStatus("Palette is empty (adjust filters or textures_top is missing files).");
      return;
    }
    if(!elImg?.src){
      setStatus("Upload an image first.");
      return;
    }
    if(!outCanvas || !outCtx){
      setStatus("Missing output canvas (check HTML IDs).");
      return;
    }

    const size = parseInt(elSize?.value || "128", 10);
    LAST_SIZE = size;

    // 1) Crop to size×size pixels
    setStatus(`Cropping to ${size}×${size}…`);
    const cropCanvas = getCroppedCanvas(size);

    // 2) Smooth (optional) BEFORE matching
    const sourceCanvas = elSmooth()?.checked
      ? getBlurredCanvas(cropCanvas, 0.8)
      : cropCanvas;

    // 3) Read pixels from sourceCanvas
    const tmp = document.createElement("canvas");
    tmp.width = size;
    tmp.height = size;

    const tctx = tmp.getContext("2d", { willReadFrequently: true });
    tctx.imageSmoothingEnabled = true;
    tctx.clearRect(0, 0, size, size);
    tctx.drawImage(sourceCanvas, 0, 0);

    setStatus(`Matching ${size*size} pixels against ${PALETTE.length} blocks…`);
    const imgData = tctx.getImageData(0, 0, size, size);
    const data = imgData.data;

    const counts = {};
    const assign = new Array(size*size);

    // Cache nearest by RGB key
    const cache = new Map(); // int rgb -> paletteEntry
    let p = 0;

    for(let i=0; i<data.length; i+=4){
      const a = data[i+3];
      if(a === 0){
        assign[p++] = null;
        continue;
      }

      const r = data[i], g = data[i+1], b = data[i+2];
      const key = (r<<16) | (g<<8) | b;

      let pick = cache.get(key);
      if(!pick){
        const lab = rgbToLab255(r, g, b);
        pick = findNearestBlock(lab);
        cache.set(key, pick);
      }

      assign[p++] = pick.id;
      counts[pick.id] = (counts[pick.id] || 0) + 1;
    }

    LAST_COUNTS = counts;
    LAST_ASSIGN = assign;

    // 4) Render texture mosaic
    setStatus("Rendering texture mosaic…");
    await renderTextureMosaic(assign, size);

    // 5) UI updates
    const total = size * size;
    const unique = Object.keys(counts).length;

    if(elCountsMeta){
      elCountsMeta.textContent = `${total.toLocaleString()} blocks • ${unique} block types • palette: ${PALETTE.length}`;
    }
    renderCounts(counts, total);

    if(elDownload) elDownload.disabled = false;
    if(elDLCountsJson) elDLCountsJson.disabled = false;
    if(elDLCountsCsv) elDLCountsCsv.disabled = false;

    // Fit to frame after drawing
    fitToFrame();

    setStatus("Done.");
  } catch (e){
    console.error(e);
    setStatus(`Error: ${e?.message || e}`);
  } finally {
    IS_GENERATING = false;
  }
}

// ---------- Init ----------
async function init(){
  try{
    setStatus("Loading blocks…");
    const res = await fetch("../data/blocks.json", { cache: "no-store" });
    if(!res.ok) throw new Error(`blocks.json fetch failed: ${res.status}`);
    BLOCKS = await res.json();

    await buildPalette();

    setStatus("Loaded blocks. Upload an image to start.");
  } catch (e){
    console.error(e);
    setStatus("Failed to load ../data/blocks.json. Run the server from /site.");
  }
}

// ---------- Events ----------
elPalette?.addEventListener("change", async () => {
  await buildPalette();
  if(elImg?.src && LAST_ASSIGN) generate();
});

elCreative?.addEventListener("change", async () => {
  await buildPalette();
  if(elImg?.src && LAST_ASSIGN) generate();
});

let CURRENT_BLOB_URL = null;

elFile?.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if(!file) return;

  // revoke previous blob
  if(CURRENT_BLOB_URL){
    URL.revokeObjectURL(CURRENT_BLOB_URL);
    CURRENT_BLOB_URL = null;
  }

  const url = URL.createObjectURL(file);
  CURRENT_BLOB_URL = url;

  elImg.onload = () => {
    if(elHint) elHint.style.display = "none";
    elImg.style.opacity = "1";
    initCropper();
    setStatus("Adjust crop, then click Generate.");
    // DO NOT revoke here; user may re-crop
  };

  elImg.src = url;
});

elReset?.addEventListener("click", () => {
  if(cropper) cropper.reset();
});

elGen?.addEventListener("click", generate);

elDownload?.addEventListener("click", () => {
  if(!outCanvas) return;
  downloadCanvasPNG(outCanvas, `mapart-${LAST_SIZE}x${LAST_SIZE}-tiles.png`);
});

elDLCountsJson?.addEventListener("click", () => {
  if(!LAST_COUNTS) return;
  downloadText(`block-counts-${LAST_SIZE}.json`, JSON.stringify(LAST_COUNTS, null, 2), "application/json");
});

elDLCountsCsv?.addEventListener("click", () => {
  if(!LAST_COUNTS) return;
  downloadText(`block-counts-${LAST_SIZE}.csv`, countsToCsv(LAST_COUNTS), "text/csv");
});

// Zoom buttons
elZoomIn?.addEventListener("click", () => zoomAtCenter(VIEW_STEP));
elZoomOut?.addEventListener("click", () => zoomAtCenter(1 / VIEW_STEP));
elZoomReset?.addEventListener("click", () => fitToFrame());

// Enable drag pan
if(zoomWrap) enableDragPan(zoomWrap);

// Keep fit responsive
window.addEventListener("resize", () => {
  // only refit if something is rendered
  if(outCanvas && outCanvas.width > 0 && outCanvas.height > 0) fitToFrame();
});

// Optional: keyboard shortcuts when focused on page
window.addEventListener("keydown", (e) => {
  if(e.key === "+" || e.key === "=") zoomAtCenter(VIEW_STEP);
  if(e.key === "-") zoomAtCenter(1 / VIEW_STEP);
});

// Go
init();
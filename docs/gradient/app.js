/* ============================================================
   Minecraft Gradient Tool
   - Uses curated top-facing textures ONLY (textures_top/)
   - Uses blocks.json for colour + tags only
   - No fallback to /textures/
   ============================================================ */

let BLOCKS = null;

// ALL block ids from blocks.json
let ALL_IDS = [];
// After filters (full blocks, curated textures, etc.)
let CANDIDATE_IDS = [];

// ---------- DOM ----------
const elA = document.getElementById("blockA");
const elB = document.getElementById("blockB");
const elN = document.getElementById("nTransitions");
const elNLabel = document.getElementById("nLabel");
const elStrip = document.getElementById("strip");
const elStatus = document.getElementById("status");
const elAvoidDupes = document.getElementById("avoidDupes");
const elSwap = document.getElementById("swapBtn");
const elRandom = document.getElementById("randomBtn");
const elMode = document.getElementById("mode");
const elPreferBuilding = document.getElementById("preferBuilding");
const elFullBlocksOnly = document.getElementById("fullBlocksOnly");

const elAImg = document.getElementById("aImg");
const elBImg = document.getElementById("bImg");
const elAName = document.getElementById("aName");
const elBName = document.getElementById("bName");
const elCountPill = document.getElementById("countPill");
const elResultHint = document.getElementById("resultHint");

const elClearA = document.getElementById("clearA");
const elClearB = document.getElementById("clearB");

// ---------- helpers ----------
function setStatus(msg){
  elStatus.textContent = msg;
}

function normalizeId(input){
  if(!input) return "";
  return input.trim().toLowerCase().replace(/\s+/g, "_");
}

function distLab(a, b){
  const dL = a[0]-b[0], da = a[1]-b[1], db = a[2]-b[2];
  return Math.sqrt(dL*dL + da*da + db*db);
}

function lerpLab(A, B, t){
  return [
    (1-t)*A[0] + t*B[0],
    (1-t)*A[1] + t*B[1],
    (1-t)*A[2] + t*B[2]
  ];
}

// ---------- texture routing (CRITICAL) ----------
function getTextureFor(id){
  if(!BLOCKS?.[id]) return "icons/empty.png";
  return `textures_top/${id}.png`;
}

// ---------- selection ----------
function setSelection(inputEl, id){
  if(!BLOCKS?.[id]) return;
  inputEl.dataset.id = id;
  inputEl.value = BLOCKS[id].name;
}

// ---------- filtering ----------
function passesFilters(id){
  const b = BLOCKS[id];
  if(!b) return false;

  if(elFullBlocksOnly?.checked){
    if(b.tag_flags?.full_block !== true) return false;
  }

  return true;
}

async function rebuildCandidates(){
  const filtered = ALL_IDS.filter(passesFilters);

  // Only include blocks that exist in textures_top
  const keep = [];
  for(const id of filtered){
    try{
      const res = await fetch(`textures_top/${id}.png`, { method: "HEAD" });
      if(res.ok) keep.push(id);
    }catch{}
  }

  CANDIDATE_IDS = keep;
  elCountPill.textContent = `${CANDIDATE_IDS.length} blocks`;
  setStatus(`Loaded ${CANDIDATE_IDS.length} blocks.`);
}

// ---------- UI ----------
function setPickerUI(which, id){
  const img = which === "a" ? elAImg : elBImg;
  const name = which === "a" ? elAName : elBName;

  if(!BLOCKS?.[id]){
    img.src = "icons/empty.png";
    name.textContent = "—";
    return;
  }

  img.src = getTextureFor(id);
  img.alt = BLOCKS[id].name;
  name.textContent = BLOCKS[id].name;
}

function renderStrip(ids){
  elStrip.innerHTML = "";
  for(const id of ids){
    const b = BLOCKS[id];
    if(!b) continue;

    const card = document.createElement("div");
    card.className = "block";

    const img = document.createElement("img");
    img.className = "thumb";
    img.src = getTextureFor(id);
    img.alt = b.name;

    const name = document.createElement("div");
    name.className = "bname";
    name.textContent = b.name;

    card.appendChild(img);
    card.appendChild(name);
    elStrip.appendChild(card);
  }
}

// ---------- scoring ----------
function preferencePenalty(block, mode, preferBuilding){
  const f = block.tag_flags || {};
  const t = block.tags || {};
  let p = 0;

  if(mode === "anything") return 0;

  if(preferBuilding && !f.building_block) p += 6;
  if(f.plantlike) p += 5;
  if(f.redstone) p += 5;
  if(f.ore) p += 4;
  if(t.transparent) p += 4;
  if(t.noisy) p += 4;
  if(mode !== "creative" && t.creative_only) p += 8;

  return p;
}

function pickTransitions(idA, idB, n, avoidDupes){
  const A = BLOCKS[idA]?.avg_lab;
  const B = BLOCKS[idB]?.avg_lab;
  if(!A || !B) return [];

  const targets = [];
  for(let i=1;i<=n;i++){
    targets.push(lerpLab(A, B, i/(n+1)));
  }

  const used = new Set([idA, idB]);
  const picks = [];

  for(const T of targets){
    let bestId = null;
    let bestScore = Infinity;

    for(const id of CANDIDATE_IDS){
      if(avoidDupes && used.has(id)) continue;

      const lab = BLOCKS[id].avg_lab;
      let score = distLab(lab, T);
      score += preferencePenalty(BLOCKS[id], elMode.value, elPreferBuilding.checked);

      if(score < bestScore){
        bestScore = score;
        bestId = id;
      }
    }

    if(bestId){
      picks.push(bestId);
      used.add(bestId);
    }
  }

  return picks;
}

// ---------- update ----------
async function update(){
  if(!BLOCKS) return;

  await rebuildCandidates();

  const idA = elA.dataset.id || normalizeId(elA.value);
  const idB = elB.dataset.id || normalizeId(elB.value);

  const n = Math.min(parseInt(elN.value, 10), 14);
  elN.value = n;
  elNLabel.textContent = n;

  setPickerUI("a", idA);
  setPickerUI("b", idB);

  if(!BLOCKS[idA] || !BLOCKS[idB]){
    elStrip.innerHTML = "";
    elResultHint.textContent = "—";
    return;
  }

  const mids = pickTransitions(idA, idB, n, elAvoidDupes.checked);
  const full = [idA, ...mids, idB];

  renderStrip(full);
  elResultHint.textContent = `${full.length}/16 blocks`;
}

// ---------- random / swap ----------
function randomPair(){
  if(CANDIDATE_IDS.length < 2) return;
  const a = CANDIDATE_IDS[Math.floor(Math.random()*CANDIDATE_IDS.length)];
  let b = a;
  while(b === a) b = CANDIDATE_IDS[Math.floor(Math.random()*CANDIDATE_IDS.length)];
  setSelection(elA, a);
  setSelection(elB, b);
  update();
}

// ---------- init ----------
async function init(){
  try{
    setStatus("Loading blocks…");
    const res = await fetch("../data/blocks.json");
    BLOCKS = await res.json();

    ALL_IDS = Object.keys(BLOCKS).sort();

    setSelection(elA, "stone");
    setSelection(elB, "oak_planks");

    await update();

    elN.addEventListener("input", update);
    elAvoidDupes.addEventListener("change", update);
    elMode.addEventListener("change", update);
    elPreferBuilding.addEventListener("change", update);
    elFullBlocksOnly?.addEventListener("change", update);

    elSwap.addEventListener("click", () => {
      const a = elA.dataset.id;
      const b = elB.dataset.id;
      setSelection(elA, b);
      setSelection(elB, a);
      update();
    });

    elRandom.addEventListener("click", randomPair);
    elClearA.addEventListener("click", () => { elA.value=""; elA.dataset.id=""; update(); });
    elClearB.addEventListener("click", () => { elB.value=""; elB.dataset.id=""; update(); });

  } catch(e){
    console.error(e);
    setStatus("Failed to load blocks.json");
  }
}

init();
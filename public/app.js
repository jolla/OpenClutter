function devPage() {
  const host = location.hostname || "";
  const path = location.pathname || "";
  return (
    host.startsWith("dev--") ||
    host.startsWith("deploy-preview-") ||
    path === "/dev" ||
    path.startsWith("/dev/")
  );
}

function syncTerrainControls() {
  const dev = devPage();
  const row = document.getElementById("include-terrain-row");
  const input = document.getElementById("include-terrain");
  const terrainRes = document.getElementById("terrain-resolution");
  if (row) row.hidden = !dev;
  const on = !!(dev && input && input.checked);
  if (terrainRes) terrainRes.hidden = !on;
}

function terrainExportEnabled() {
  const row = document.getElementById("include-terrain-row");
  const input = document.getElementById("include-terrain");
  if (!row || row.hidden || !input) return true;
  return !!input.checked;
}

(function markDeployEnv() {
  const badge = document.getElementById("env-badge");
  if (badge && devPage()) badge.classList.add("on");
  syncTerrainControls();
  const ver = document.getElementById("app-version");
  if (ver && window.OPENCLUTTER_VERSION) ver.textContent = "v" + window.OPENCLUTTER_VERSION;
})();

const TERRAIN_STOPS = [
  { id: "auto", label: "Auto", cellM: null, maxGrid: 20, readout: "Auto · from draw" },
  { id: "default", label: "Default", cellM: 80, maxGrid: 12, readout: "Default · ~80 m" },
  { id: "fine", label: "Fine", cellM: 40, maxGrid: 16, readout: "Fine · ~40 m" },
  { id: "finest", label: "Finest", cellM: 25, maxGrid: 20, readout: "Finest · ~25 m" },
  { id: "20", label: "20 m", cellM: 20, maxGrid: 125 },
  { id: "15", label: "15 m", cellM: 15, maxGrid: 167 },
  { id: "10", label: "10 m", cellM: 10, maxGrid: 250 },
  { id: "5", label: "5 m", cellM: 5, maxGrid: 500 },
  { id: "1", label: "1 m", cellM: 1, maxGrid: 500 },
];
// Same paste budget and 1 m floor as autoAxisCount in netlify/lib/terrain.js.
// maxGrid on the meter stops matches TERRAIN_RESOLUTIONS there.
const TERRAIN_AUTO_MAX_GRID = 20;
const TERRAIN_AUTO_MIN_CELL_M = 1;
const TERRAIN_PASTE_SOFT_GRID = 20;
// Same first-pass quad budget as pastePlanQuadBudget() in netlify/lib/terrain.js
// (min of the 12000 build cap and floor(paste JSON ceiling / 240)).
const TERRAIN_PASTE_QUAD_BUDGET = 9429;
// Matches GROUND_METER_STRETCH in netlify/lib/geo-frame.js (~54°N).
const GROUND_METER_STRETCH_UI = 1.7;

function terrainStopIndex() {
  const input = document.getElementById("terrain-resolution-range");
  const n = input ? Number(input.value) : 0;
  if (n >= 1 && n < TERRAIN_STOPS.length && n === Math.round(n)) return n;
  return 0;
}

function autoAxisCountUi(spanM) {
  const span = spanM > 0 ? spanM : 800;
  const cellM = Math.max(TERRAIN_AUTO_MIN_CELL_M, span / TERRAIN_AUTO_MAX_GRID);
  let n = Math.round(span / cellM);
  if (!Number.isFinite(n)) n = TERRAIN_AUTO_MAX_GRID;
  n = Math.max(1, Math.min(TERRAIN_AUTO_MAX_GRID, n));
  while (n > 1 && span / n < TERRAIN_AUTO_MIN_CELL_M - 0.05) n -= 1;
  if (span >= 6 * TERRAIN_AUTO_MIN_CELL_M) n = Math.max(6, Math.min(TERRAIN_AUTO_MAX_GRID, n));
  return n;
}

function formatCellMUi(m) {
  const n = Number(m);
  if (!(n > 0)) return "1";
  const tenth = Math.round(n * 10) / 10;
  if (Math.abs(tenth - Math.round(tenth)) < 1e-6) return String(Math.round(tenth));
  return tenth.toFixed(1);
}

function drawSpans() {
  if (!bbox || typeof L === "undefined") return null;
  const w = L.latLng(bbox.south, bbox.west).distanceTo(L.latLng(bbox.south, bbox.east));
  const h = L.latLng(bbox.south, bbox.west).distanceTo(L.latLng(bbox.north, bbox.west));
  if (!(w > 0) || !(h > 0)) return null;
  return { w: w, h: h };
}

function uiMetersPerDeg(lat) {
  const rad = (lat * Math.PI) / 180;
  return { lon: 111320 * Math.cos(rad), lat: 110540 };
}

/**
 * Ground-meter size of the paste. At high latitude Esri's degree grid pads
 * the short axis until pixels are square in degrees, which is the frame the
 * aerial resample and the terrain lattice share.
 */
function pasteSpans() {
  const draw = drawSpans();
  if (!draw || !bbox) return null;
  const lat = (bbox.south + bbox.north) / 2;
  const mpd = uiMetersPerDeg(lat);
  const stretch = mpd.lon > 0 ? mpd.lat / mpd.lon : 1;
  let w = draw.w;
  let h = draw.h;
  if (stretch >= GROUND_METER_STRETCH_UI) {
    const lonSpan = bbox.east - bbox.west;
    const latSpan = bbox.north - bbox.south;
    const target = draw.w / draw.h;
    const current = lonSpan / latSpan;
    if (target > 0 && current > target) h = (lonSpan / target) * mpd.lat;
    else if (current > 0 && target > current) w = latSpan * target * mpd.lon;
  }
  return { w: w, h: h, highLat: stretch >= GROUND_METER_STRETCH_UI };
}

function squareMeterAxesUi(width, length, cell, cap) {
  let cols = Math.max(1, Math.round(width / cell));
  let rows = Math.max(1, Math.round(length / cell));
  const limit = Math.max(1, cap | 0);
  if (Math.max(cols, rows) > limit) {
    const scale = limit / Math.max(cols, rows);
    cols = Math.max(1, Math.round(cols * scale));
    rows = Math.max(1, Math.round(rows * scale));
    while ((cols > limit || rows > limit) && cols * rows > 1) {
      if (cols >= rows && cols > 1) cols -= 1;
      else if (rows > 1) rows -= 1;
      else break;
    }
  }
  return [cols, rows];
}

function fitPasteAxesUi(wantCols, wantRows, maxQuads) {
  const wantC = Math.max(1, wantCols | 0);
  const wantR = Math.max(1, wantRows | 0);
  const cap = Math.max(1, maxQuads | 0);
  if (wantC * wantR <= cap) return [wantC, wantR];
  const aspect = wantC / wantR;
  const scale = Math.sqrt(cap / (wantC * wantR));
  let cols = Math.max(1, Math.min(wantC, Math.floor(wantC * scale)));
  let rows = Math.max(1, Math.min(wantR, Math.floor(wantR * scale)));
  while (true) {
    const canC = cols < wantC && (cols + 1) * rows <= cap;
    const canR = rows < wantR && cols * (rows + 1) <= cap;
    if (!canC && !canR) break;
    if (canC && canR) {
      const errC = Math.abs((cols + 1) / rows - aspect);
      const errR = Math.abs(cols / (rows + 1) - aspect);
      if (errC <= errR) cols += 1;
      else rows += 1;
    } else if (canC) cols += 1;
    else rows += 1;
  }
  return [cols, rows];
}

function autoReadout() {
  const paste = pasteSpans();
  if (!paste) return "Auto · from draw";
  if (paste.highLat) {
    const cell = Math.max(TERRAIN_AUTO_MIN_CELL_M, Math.max(paste.w, paste.h) / TERRAIN_AUTO_MAX_GRID);
    const axes = squareMeterAxesUi(paste.w, paste.h, cell, TERRAIN_AUTO_MAX_GRID);
    const effective = (paste.w / axes[0] + paste.h / axes[1]) / 2;
    return "Auto · ~" + formatCellMUi(effective) + " m · " + axes[0] + "×" + axes[1];
  }
  const cols = autoAxisCountUi(paste.w);
  const rows = autoAxisCountUi(paste.h);
  const shown = (paste.w / cols + paste.h / rows) / 2;
  return "Auto · ~" + formatCellMUi(shown) + " m";
}

function manualReadout(stop) {
  const paste = pasteSpans();
  if (paste && paste.highLat && stop.cellM > 0 && stop.maxGrid > TERRAIN_PASTE_SOFT_GRID) {
    let axes = squareMeterAxesUi(paste.w, paste.h, stop.cellM, stop.maxGrid);
    axes = fitPasteAxesUi(axes[0], axes[1], TERRAIN_PASTE_QUAD_BUDGET);
    const cols = axes[0];
    const rows = axes[1];
    const cell = (paste.w / cols + paste.h / rows) / 2;
    let text = "~" + formatCellMUi(cell) + " m · " + cols + "×" + rows;
    if (cols > TERRAIN_PASTE_SOFT_GRID || rows > TERRAIN_PASTE_SOFT_GRID) text += " · past 20×20";
    const wantC = Math.max(1, Math.round(paste.w / stop.cellM));
    const wantR = Math.max(1, Math.round(paste.h / stop.cellM));
    if (wantC > cols || wantR > rows) text += " · requested " + stop.cellM + " m stepped up to fit";
    return text;
  }
  const draw = drawSpans();
  if (!draw || !(stop.cellM > 0)) {
    if (stop.maxGrid > TERRAIN_PASTE_SOFT_GRID && stop.cellM > 0) {
      const side = stop.cellM * TERRAIN_PASTE_SOFT_GRID;
      return "~" + stop.cellM + " m · covers ~" + side + "×" + side + " m";
    }
    return stop.readout;
  }
  const wantC = Math.max(6, Math.round(draw.w / stop.cellM));
  const wantR = Math.max(6, Math.round(draw.h / stop.cellM));
  const cols = Math.min(stop.maxGrid, wantC);
  const rows = Math.min(stop.maxGrid, wantR);
  const cell = (draw.w / cols + draw.h / rows) / 2;
  if (stop.maxGrid <= TERRAIN_PASTE_SOFT_GRID) {
    return stop.label + " · ~" + formatCellMUi(cell) + " m";
  }
  let text = "~" + formatCellMUi(cell) + " m · " + cols + "×" + rows;
  if (cols > TERRAIN_PASTE_SOFT_GRID || rows > TERRAIN_PASTE_SOFT_GRID) text += " · past 20×20";
  if (wantC > cols || wantR > rows) {
    const cover = Math.round(stop.maxGrid * stop.cellM);
    text += " · requested " + stop.cellM + " m covers ~" + cover + "×" + cover + " m";
  }
  return text;
}

function syncTerrainResolutionReadout() {
  const input = document.getElementById("terrain-resolution-range");
  const readout = document.getElementById("terrain-resolution-readout");
  const stop = TERRAIN_STOPS[terrainStopIndex()];
  if (readout && stop) readout.textContent = stop.id === "auto" ? autoReadout() : manualReadout(stop);
  if (input) input.setAttribute("aria-valuenow", String(terrainStopIndex()));
}

function selectedTerrainResolution() {
  const wrap = document.getElementById("terrain-resolution");
  if (!wrap || wrap.hidden) return null;
  const stop = TERRAIN_STOPS[terrainStopIndex()];
  return stop ? stop.id : "auto";
}

let bbox = null;
const terrainResolutionRange = document.getElementById("terrain-resolution-range");
if (terrainResolutionRange) {
  terrainResolutionRange.addEventListener("input", syncTerrainResolutionReadout);
  syncTerrainResolutionReadout();
}
const includeTerrainInput = document.getElementById("include-terrain");
if (includeTerrainInput) includeTerrainInput.addEventListener("change", syncTerrainControls);

const map = L.map("map").setView([36.128, -115.16], 15);
L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OSM &copy; CARTO",
  maxZoom: 20,
}).addTo(map);
L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  { opacity: 0.85, maxZoom: 19, attribution: "Esri" }
).addTo(map);

const OUTLINE = {
  color: "#3fb950",
  weight: 2,
  fillColor: "#3fb950",
  fillOpacity: 0.2,
  interactive: false,
};

const drawn = new L.FeatureGroup();
map.addLayer(drawn);

/** Finished outline; the chip returns here if a redraw is cancelled. */
let committedBounds = null;
/** Null uses the box L×W chip. A string is the polygon sq ft chip. */
let committedLabel = null;
let areaChip = null;
let sketchHidden = false;
let rubber = null;
let vertexMarks = [];
let activePointer = null;
const drawSession = OpenClutterDraw.createSession();
const statusEl = document.getElementById("status");
const exportBtn = document.getElementById("export");
const copyTerrainBtn = document.getElementById("copy-terrain");
let terrainPasteJson = "";

function chipBbox(bounds) {
  return {
    west: bounds.getWest(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    north: bounds.getNorth(),
  };
}

function hideAreaChip() {
  if (!areaChip) return;
  if (map.hasLayer(areaChip)) map.removeLayer(areaChip);
  const el = areaChip.getElement && areaChip.getElement();
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

function showAreaChip(bounds, label) {
  const text = label == null ? OpenClutterArea.formatBboxFeet(chipBbox(bounds)) : label;
  if (!text) {
    hideAreaChip();
    return;
  }
  if (!areaChip) {
    areaChip = L.tooltip({
      permanent: true,
      direction: "center",
      className: "area-chip",
      opacity: 1,
      interactive: false,
    });
  }
  areaChip.setLatLng(bounds.getCenter()).setContent(text);
  if (!map.hasLayer(areaChip)) areaChip.addTo(map);
}

function setStatus(msg, err) {
  statusEl.textContent = msg;
  statusEl.className = err ? "err" : "";
}

function clearRubber() {
  if (rubber) {
    map.removeLayer(rubber);
    rubber = null;
  }
  for (let i = 0; i < vertexMarks.length; i++) map.removeLayer(vertexMarks[i]);
  vertexMarks = [];
}

function concealCommitted() {
  if (!sketchHidden && map.hasLayer(drawn)) {
    map.removeLayer(drawn);
    sketchHidden = true;
  }
}

function restoreCommitted() {
  clearRubber();
  if (!map.hasLayer(drawn)) map.addLayer(drawn);
  sketchHidden = false;
  if (committedBounds) showAreaChip(committedBounds, committedLabel);
  else hideAreaChip();
}

function syncDrawMode() {
  const container = map.getContainer();
  if (drawSession.armed) {
    map.dragging.disable();
    if (map.doubleClickZoom) map.doubleClickZoom.disable();
    container.style.cursor = "crosshair";
  } else {
    map.dragging.enable();
    if (map.doubleClickZoom) map.doubleClickZoom.enable();
    container.style.cursor = "";
    activePointer = null;
  }
}

function applyExtent(bounds, label) {
  committedBounds = bounds;
  committedLabel = label == null ? null : label;
  bbox = chipBbox(bounds);
  showAreaChip(bounds, committedLabel);
  const w = L.latLng(bbox.south, bbox.west).distanceTo(L.latLng(bbox.south, bbox.east));
  const h = L.latLng(bbox.south, bbox.west).distanceTo(L.latLng(bbox.north, bbox.west));
  exportBtn.disabled = w > 2500 || h > 2500 || w < 40 || h < 40;
  if (exportBtn.disabled) setStatus("Area must be between 40 m and 2.5 km on a side.", true);
  else setStatus("Ready to export.");
  syncTerrainResolutionReadout();
}

function commitBox(start, end) {
  clearRubber();
  const bounds = L.latLngBounds([start.lat, start.lng], [end.lat, end.lng]);
  drawn.clearLayers();
  drawn.addLayer(L.rectangle(bounds, OUTLINE));
  if (!map.hasLayer(drawn)) map.addLayer(drawn);
  sketchHidden = false;
  applyExtent(bounds, null);
  syncDrawMode();
}

function commitPolygon(vertices) {
  clearRubber();
  const latlngs = [];
  for (let i = 0; i < vertices.length; i++) latlngs.push([vertices[i].lat, vertices[i].lng]);
  drawn.clearLayers();
  const layer = L.polygon(latlngs, OUTLINE);
  drawn.addLayer(layer);
  if (!map.hasLayer(drawn)) map.addLayer(drawn);
  sketchHidden = false;
  applyExtent(layer.getBounds(), OpenClutterArea.formatPolygonSqFt(vertices));
  syncDrawMode();
}

function showDragPreview(start, end) {
  concealCommitted();
  const bounds = L.latLngBounds([start.lat, start.lng], [end.lat, end.lng]);
  if (rubber && typeof rubber.setBounds === "function") rubber.setBounds(bounds);
  else {
    clearRubber();
    rubber = L.rectangle(bounds, OUTLINE).addTo(map);
  }
  showAreaChip(bounds);
}

function showVertexPreview(vertices) {
  concealCommitted();
  clearRubber();
  const latlngs = [];
  for (let i = 0; i < vertices.length; i++) latlngs.push([vertices[i].lat, vertices[i].lng]);
  if (latlngs.length >= 3) {
    rubber = L.polygon(latlngs, {
      color: OUTLINE.color,
      weight: 2,
      fillColor: OUTLINE.fillColor,
      fillOpacity: 0.08,
      dashArray: "5 6",
      interactive: false,
    }).addTo(map);
  } else if (latlngs.length === 2) {
    rubber = L.polyline(latlngs, { color: OUTLINE.color, weight: 2, interactive: false }).addTo(map);
  }
  for (let i = 0; i < latlngs.length; i++) {
    vertexMarks.push(
      L.circleMarker(latlngs[i], {
        radius: 4,
        color: "#3fb950",
        weight: 2,
        fillColor: "#3fb950",
        fillOpacity: 1,
        interactive: false,
      }).addTo(map)
    );
  }
  if (vertices.length >= 3) {
    showAreaChip(L.latLngBounds(latlngs), OpenClutterArea.formatPolygonSqFt(vertices));
  } else {
    hideAreaChip();
  }
}

function handleDraw(result) {
  if (!result || result.type === "ignore" || result.type === "down" || result.type === "abort-press") return;
  if (result.type === "drag") {
    showDragPreview(result.start, result.end);
    return;
  }
  if (result.type === "vertex") {
    showVertexPreview(result.vertices);
    const n = result.vertices.length;
    if (n < 3) setStatus("Corner " + n + ". Click the next corner. Right-click finishes, Esc cancels.");
    else setStatus("Corner " + n + ". Right-click to finish, Esc to cancel.");
    return;
  }
  if (result.type === "commit-box") {
    commitBox(result.start, result.end);
    return;
  }
  if (result.type === "commit-polygon") {
    commitPolygon(result.vertices);
    return;
  }
  if (result.type === "discard") {
    restoreCommitted();
    syncDrawMode();
    setStatus(
      bbox
        ? "Need at least 3 corners. The previous site is unchanged."
        : "Need at least 3 corners to close a polygon."
    );
    return;
  }
  if (result.type === "cancel") {
    restoreCommitted();
    syncDrawMode();
    if (!bbox) setStatus("Search, then draw the site.");
    else if (exportBtn.disabled) setStatus("Area must be between 40 m and 2.5 km on a side.", true);
    else setStatus("Ready to export.");
  }
}

function pointFromEvent(ev) {
  const rect = map.getContainer().getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  const ll = map.containerPointToLatLng(L.point(x, y));
  return { x: x, y: y, lat: ll.lat, lng: ll.lng, button: ev.button, ctrlKey: !!ev.ctrlKey };
}

const mapEl = map.getContainer();
mapEl.addEventListener(
  "pointerdown",
  (ev) => {
    if (!drawSession.armed || activePointer != null) return;
    if (ev.button !== 0 || ev.ctrlKey) return;
    if (ev.target.closest && ev.target.closest(".leaflet-control")) return;
    activePointer = ev.pointerId;
    try {
      mapEl.setPointerCapture(ev.pointerId);
    } catch (e) {
      /* capture is optional; the container still receives the gesture */
    }
    ev.preventDefault();
    handleDraw(OpenClutterDraw.pointerDown(drawSession, pointFromEvent(ev)));
  },
  { passive: false }
);

mapEl.addEventListener(
  "pointermove",
  (ev) => {
    if (ev.pointerId !== activePointer) return;
    ev.preventDefault();
    handleDraw(OpenClutterDraw.pointerMove(drawSession, pointFromEvent(ev)));
  },
  { passive: false }
);

mapEl.addEventListener("pointerup", (ev) => {
  if (ev.pointerId !== activePointer) return;
  activePointer = null;
  handleDraw(OpenClutterDraw.pointerUp(drawSession, pointFromEvent(ev)));
});

mapEl.addEventListener("pointercancel", (ev) => {
  if (ev.pointerId !== activePointer) return;
  activePointer = null;
  OpenClutterDraw.abortPress(drawSession);
  if (drawSession.vertices.length) showVertexPreview(drawSession.vertices.map((v) => ({ lat: v.lat, lng: v.lng })));
  else restoreCommitted();
});

mapEl.addEventListener("contextmenu", (ev) => {
  ev.preventDefault();
  if (!drawSession.armed) return;
  handleDraw(OpenClutterDraw.finish(drawSession));
});

window.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  const result = OpenClutterDraw.cancel(drawSession);
  if (result.type !== "cancel") return;
  activePointer = null;
  ev.preventDefault();
  handleDraw(result);
});

map.on("zoomend", () => {
  if (!drawSession.vertices.length) return;
  const pixels = [];
  for (let i = 0; i < drawSession.vertices.length; i++) {
    const v = drawSession.vertices[i];
    const p = map.latLngToContainerPoint([v.lat, v.lng]);
    pixels.push({ x: p.x, y: p.y });
  }
  OpenClutterDraw.setVertexPixels(drawSession, pixels);
});

document.getElementById("draw").onclick = () => {
  activePointer = null;
  clearRubber();
  OpenClutterDraw.arm(drawSession);
  restoreCommitted();
  syncDrawMode();
  setStatus("Drag a box, or click corners. Right-click finishes the polygon.");
};

document.getElementById("search").onsubmit = async (e) => {
  e.preventDefault();
  const q = document.getElementById("q").value.trim();
  setStatus("Searching…");
  try {
    const r = await fetch("/api/geocode?q=" + encodeURIComponent(q));
    const hits = await r.json();
    if (!r.ok) throw new Error(hits.error || "Geocode failed");
    if (!hits.length) throw new Error("No results");
    const hit = hits[0];
    map.setView([+hit.lat, +hit.lon], 16);
    setStatus("Draw the site.");
  } catch (err) {
    setStatus(err.message, true);
  }
};

async function detectCanopyTrees(b) {
  const T = globalThis.OpenClutterTrees;
  return T.fetchCanopyTrees(b, (url) => fetch(url, { signal: AbortSignal.timeout(8000) }), {
    maxTrees: T.maxTreesForBbox(b),
  });
}

async function detectRgbTrees(b) {
  const T = globalThis.OpenClutterTrees;
  const maxTrees = T.maxTreesForBbox(b);
  const imgW = 720;
  const imgH = Math.max(200, Math.round(imgW * ((b.north - b.south) / Math.max(1e-9, b.east - b.west))));
  const url =
    "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export" +
    `?bbox=${b.west},${b.south},${b.east},${b.north}&bboxSR=4326&imageSR=4326&size=${imgW},${imgH}&format=jpg&f=image`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const bmp = await createImageBitmap(await res.blob());
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const { data, width: w, height: h } = ctx.getImageData(0, 0, c.width, c.height);
  return T.detectTreesFromImageData(data, w, h, b, { maxTrees, minDist: maxTrees >= 400 ? 9 : 14 });
}

function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function b64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

function rememberTerrain(data) {
  const clip = data && data.terrainClipboard;
  const raised = clip && clip.raisedFloorZones ? clip.raisedFloorZones.length : 0;
  const sloped = clip && clip.slopedFloors ? clip.slopedFloors.length : 0;
  terrainPasteJson = raised || sloped ? JSON.stringify(clip) : "";
  if (copyTerrainBtn) copyTerrainBtn.hidden = !terrainPasteJson;
  return terrainPasteJson;
}

if (copyTerrainBtn) {
  copyTerrainBtn.onclick = async () => {
    if (!terrainPasteJson) return;
    try {
      await navigator.clipboard.writeText(terrainPasteJson);
      setStatus("Copied terrain. Paste it in Planner Plus. Do not import it as OpenIntent.");
    } catch (e) {
      setStatus("Could not copy terrain. Allow clipboard access and try Copy terrain again.", true);
    }
  };
}

function exportError(status, data) {
  if (status === 504 || status === 408) {
    const err = new Error("This area is too large to finish in one export. Draw a smaller area and try again.");
    err.noRetry = true;
    return err;
  }
  const err = new Error((data && data.error) || "Export failed (" + status + ")");
  err.noRetry = status === 400 || status === 413;
  return err;
}

async function exportOnce(trees, treesSource, canopyHits, includeFoliage, includeTerrain) {
  const foliage = includeFoliage === true;
  const terrain = includeTerrain !== false;
  const r = await fetch("/api/clutter", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      // A polygon exports as this axis-aligned box. The API frame is west/south/east/north.
      ...bbox,
      name: document.getElementById("q").value || "Site",
      includeFoliage: foliage,
      includeTerrain: terrain,
      terrainResolution: terrain ? selectedTerrainResolution() || undefined : undefined,
      trees: foliage ? trees : [],
      treesSource: foliage ? treesSource : "none",
      canopyHits: foliage && canopyHits && canopyHits.length ? canopyHits : undefined,
      format: "bundle",
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw exportError(r.status, data);
  return data;
}

document.getElementById("export").onclick = async () => {
  if (!bbox) return;
  exportBtn.disabled = true;
  const includeFoliage = document.getElementById("include-foliage").checked;
  const includeTerrain = terrainExportEnabled();
  setStatus(includeFoliage ? "Building map + buildings + canopy…" : "Building map + buildings…");
  try {
    let trees = [];
    let treesSource = "none";
    let canopyHits = null;
    if (includeFoliage) {
      const T = globalThis.OpenClutterTrees;
      const budget = T.maxTreesForBbox(bbox);
      let canopy = null;
      try {
        canopy = await detectCanopyTrees(bbox);
      } catch (e) {
        canopy = { trees: [], source: null, reason: "fetch-failed", parsed: { samples: 0, validCount: 0, hits: [] } };
      }
      let rgb = [];
      if (T.rgbFillNeeded(canopy, bbox, { maxTrees: budget })) {
        try {
          rgb = await detectRgbTrees(bbox);
        } catch (e) {
          rgb = [];
        }
      }
      const resolved = T.resolveTrees(bbox, canopy, rgb, { maxTrees: budget });
      trees = resolved.trees;
      treesSource = resolved.source;
      canopyHits =
        treesSource === "nlcd-canopy" && canopy && canopy.parsed && canopy.parsed.hits
          ? canopy.parsed.hits
          : null;
    }
    let data;
    try {
      data = await exportOnce(trees, treesSource, canopyHits, includeFoliage, includeTerrain);
    } catch (e) {
      if (e && e.noRetry) throw e;
      data = await exportOnce(trees, treesSource, canopyHits, includeFoliage, includeTerrain);
    }
    downloadBlob(b64ToBlob(data.zipBase64, "application/zip"), data.zipFilename || "openclutter.zip");
    const terrainOff = includeTerrain === false;
    if (terrainOff) {
      terrainPasteJson = "";
      if (copyTerrainBtn) copyTerrainBtn.hidden = true;
    } else {
      rememberTerrain(data);
    }
    const summary = (data.stats && data.stats.summary) || "";
    const terrainNote = terrainOff ? "Terrain off" : (data.terrainStatus || "");
    const warnLines = (Array.isArray(data.warnings) ? data.warnings.filter(Boolean) : [])
      .filter((line) => !terrainOff || !/terrain/i.test(line));
    setStatus(
      "Import this zip in Hamina (Projects → Import → OpenIntent)." +
        (terrainNote ? "\n" + terrainNote : "") +
        (summary ? "\n" + summary : "") +
        (warnLines.length ? "\n" + warnLines.join("\n") : "")
    );
  } catch (err) {
    setStatus(String(err && err.message ? err.message : "Export failed. Retry."), true);
  } finally {
    exportBtn.disabled = false;
  }
};

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
  const style = document.getElementById("terrain-style");
  const input = document.getElementById("include-terrain");
  if (row) row.hidden = !dev;
  if (style) style.hidden = !dev || !input || !input.checked;
}

function selectedTerrainStyle() {
  const picked = document.querySelector('#terrain-style input[name="terrain-style"]:checked');
  return picked && picked.value === "raised" ? "raised" : "sloped";
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

let bbox = null;
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
let closeHint = null;
let vertexMarks = [];
let activePointer = null;
let spacePan = false;
let panPointer = null;
let panLast = null;
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
  if (closeHint) {
    map.removeLayer(closeHint);
    closeHint = null;
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
  if (panPointer != null) {
    map.dragging.disable();
    container.style.cursor = "grabbing";
    return;
  }
  if (drawSession.armed) {
    map.dragging.disable();
    if (map.doubleClickZoom) map.doubleClickZoom.disable();
    container.style.cursor = spacePan ? "grab" : "crosshair";
  } else {
    map.dragging.enable();
    if (map.doubleClickZoom) map.doubleClickZoom.enable();
    container.style.cursor = spacePan ? "grab" : "";
    activePointer = null;
  }
}

function typingTarget(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return !!el.isContentEditable;
}

function panGesture(ev) {
  if (ev.button === 2) return true;
  if (ev.button !== 0) return false;
  return spacePan || !!ev.ctrlKey;
}

function committedExportBlocked() {
  if (!bbox) return true;
  const w = L.latLng(bbox.south, bbox.west).distanceTo(L.latLng(bbox.south, bbox.east));
  const h = L.latLng(bbox.south, bbox.west).distanceTo(L.latLng(bbox.north, bbox.west));
  return w > 2500 || h > 2500 || w < 40 || h < 40;
}

function syncExportReady() {
  const n = drawSession.phase === "polygon" ? drawSession.vertices.length : 0;
  if (n > 0) {
    exportBtn.disabled = false;
    return;
  }
  exportBtn.disabled = committedExportBlocked();
}

function enterDrawMode(message) {
  activePointer = null;
  clearRubber();
  OpenClutterDraw.arm(drawSession);
  restoreCommitted();
  syncDrawMode();
  syncExportReady();
  if (message) setStatus(message);
}

function resumeDrawMode() {
  if (drawSession.vertices.length || drawSession.down) return;
  if (!drawSession.armed) OpenClutterDraw.arm(drawSession);
  syncDrawMode();
  syncExportReady();
}

function applyExtent(bounds, label) {
  committedBounds = bounds;
  committedLabel = label == null ? null : label;
  bbox = chipBbox(bounds);
  showAreaChip(bounds, committedLabel);
  syncExportReady();
  if (exportBtn.disabled) setStatus("Area must be between 40 m and 2.5 km on a side.", true);
  else setStatus("Ready to export.");
}

function commitBox(start, end) {
  clearRubber();
  const bounds = L.latLngBounds([start.lat, start.lng], [end.lat, end.lng]);
  drawn.clearLayers();
  drawn.addLayer(L.rectangle(bounds, OUTLINE));
  if (!map.hasLayer(drawn)) map.addLayer(drawn);
  sketchHidden = false;
  applyExtent(bounds, null);
  resumeDrawMode();
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
  resumeDrawMode();
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
  if (latlngs.length >= 2) {
    rubber = L.polyline(latlngs, { color: OUTLINE.color, weight: 2, interactive: false }).addTo(map);
  }
  if (latlngs.length >= 3) {
    closeHint = L.polyline([latlngs[latlngs.length - 1], latlngs[0]], {
      color: OUTLINE.color,
      weight: 2,
      dashArray: "2 6",
      opacity: 0.8,
      interactive: false,
    }).addTo(map);
  }
  for (let i = 0; i < latlngs.length; i++) {
    const closeTarget = vertices.length >= 3 && i === 0;
    vertexMarks.push(
      L.circleMarker(latlngs[i], {
        radius: closeTarget ? 11 : 4,
        color: "#3fb950",
        weight: closeTarget ? 3 : 2,
        fillColor: closeTarget ? "#0e1116" : "#3fb950",
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
    syncExportReady();
    if (n < 3) setStatus("Corner " + n + ". Click the next corner. Esc cancels.");
    else setStatus("Corner " + n + ". Click the first corner to close. Double-click also finishes. Esc cancels.");
    return;
  }
  if (result.type === "short") {
    setStatus("Add another corner, then click the first corner to close. Esc cancels.");
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
    setStatus(
      bbox
        ? "Need at least 3 corners. The previous site is unchanged."
        : "Need at least 3 corners to close a polygon."
    );
    resumeDrawMode();
    return;
  }
  if (result.type === "cancel") {
    restoreCommitted();
    resumeDrawMode();
    if (!bbox) setStatus("Click the map to draw the site.");
    else if (exportBtn.disabled) setStatus("Area must be between 40 m and 2.5 km on a side.", true);
    else setStatus("Ready to export.");
  }
}

function pointFromEvent(ev) {
  const p = map.mouseEventToContainerPoint(ev);
  const ll = map.containerPointToLatLng(p);
  return {
    x: p.x,
    y: p.y,
    lat: ll.lat,
    lng: ll.lng,
    button: ev.button,
    ctrlKey: !!ev.ctrlKey,
    clicks: ev.detail > 1 ? ev.detail : 1,
  };
}

function refreshVertexPixels() {
  if (!drawSession.vertices.length) return;
  const pixels = [];
  for (let i = 0; i < drawSession.vertices.length; i++) {
    const v = drawSession.vertices[i];
    const p = map.latLngToContainerPoint([v.lat, v.lng]);
    pixels.push({ x: p.x, y: p.y });
  }
  OpenClutterDraw.setVertexPixels(drawSession, pixels);
}

function releaseDrawPress() {
  if (activePointer == null) return;
  OpenClutterDraw.abortPress(drawSession);
  activePointer = null;
  if (drawSession.vertices.length) showVertexPreview(drawSession.vertices.map((v) => ({ lat: v.lat, lng: v.lng })));
  else restoreCommitted();
}

function beginPan(ev) {
  panPointer = ev.pointerId;
  panLast = { x: ev.clientX, y: ev.clientY };
  try {
    mapEl.setPointerCapture(ev.pointerId);
  } catch (e) {
    /* capture is optional; the container still receives the gesture */
  }
  syncDrawMode();
}

function movePan(ev) {
  if (!panLast) return;
  const dx = ev.clientX - panLast.x;
  const dy = ev.clientY - panLast.y;
  panLast = { x: ev.clientX, y: ev.clientY };
  if (!dx && !dy) return;
  map.panBy(L.point(-dx, -dy), { animate: false });
}

function endPan() {
  panPointer = null;
  panLast = null;
  refreshVertexPixels();
  syncDrawMode();
}

const mapEl = map.getContainer();
mapEl.addEventListener(
  "pointerdown",
  (ev) => {
    if (ev.target.closest && ev.target.closest(".leaflet-control")) return;
    if (panGesture(ev)) {
      if (panPointer != null) return;
      releaseDrawPress();
      ev.preventDefault();
      beginPan(ev);
      return;
    }
    if (activePointer != null) return;
    if (ev.button !== 0) return;
    if (!drawSession.armed) {
      OpenClutterDraw.arm(drawSession);
      syncDrawMode();
    }
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
    if (ev.pointerId === panPointer) {
      ev.preventDefault();
      movePan(ev);
      return;
    }
    if (ev.pointerId !== activePointer) return;
    ev.preventDefault();
    handleDraw(OpenClutterDraw.pointerMove(drawSession, pointFromEvent(ev)));
  },
  { passive: false }
);

let blockMapDblClick = false;
let blockMapDblClickTimer = 0;

function holdMapDblClick() {
  blockMapDblClick = true;
  window.clearTimeout(blockMapDblClickTimer);
  blockMapDblClickTimer = window.setTimeout(() => {
    blockMapDblClick = false;
  }, 400);
}

mapEl.addEventListener("pointerup", (ev) => {
  if (ev.pointerId === panPointer) {
    endPan();
    return;
  }
  if (ev.pointerId !== activePointer) return;
  const drawing = drawSession.armed;
  activePointer = null;
  refreshVertexPixels();
  handleDraw(OpenClutterDraw.pointerUp(drawSession, pointFromEvent(ev)));
  if (drawing) holdMapDblClick();
});

mapEl.addEventListener("pointercancel", (ev) => {
  if (ev.pointerId === panPointer) {
    endPan();
    return;
  }
  if (ev.pointerId !== activePointer) return;
  activePointer = null;
  OpenClutterDraw.abortPress(drawSession);
  if (drawSession.vertices.length) showVertexPreview(drawSession.vertices.map((v) => ({ lat: v.lat, lng: v.lng })));
  else restoreCommitted();
});

mapEl.addEventListener(
  "contextmenu",
  (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  },
  true
);

mapEl.addEventListener(
  "dblclick",
  (ev) => {
    if (ev.button === 2) return;
    if (!drawSession.armed && !blockMapDblClick) return;
    ev.preventDefault();
    ev.stopPropagation();
    blockMapDblClick = false;
    if (!drawSession.armed || drawSession.vertices.length < 3) return;
    handleDraw(OpenClutterDraw.finish(drawSession));
  },
  true
);

window.addEventListener("keydown", (ev) => {
  if (ev.code === "Space" && !typingTarget(ev.target)) {
    spacePan = true;
    ev.preventDefault();
    if (panPointer == null) releaseDrawPress();
    syncDrawMode();
  }
  if (ev.key !== "Escape") return;
  const result = OpenClutterDraw.cancel(drawSession);
  if (result.type !== "cancel") return;
  activePointer = null;
  if (panPointer != null) endPan();
  ev.preventDefault();
  handleDraw(result);
});

window.addEventListener("keyup", (ev) => {
  if (ev.code !== "Space") return;
  spacePan = false;
  if (panPointer == null) syncDrawMode();
});

map.on("zoomend moveend", refreshVertexPixels);

document.getElementById("draw").onclick = () => {
  enterDrawMode("Click corners, then click the first corner to close. Right-drag or hold Space to pan.");
};

enterDrawMode("Click the map to draw. Drag a box, or click corners and click the first corner to close. Right-drag or hold Space to pan.");

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
    setStatus("Click the map to trace the site.");
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
      terrainResolution: terrain ? "auto" : undefined,
      terrainStyle: terrain ? selectedTerrainStyle() : undefined,
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

function openRingExportStatus(count) {
  if (count >= 3) return "Click the first corner to close the polygon before export. Export was not run.";
  const noun = count === 1 ? "corner" : "corners";
  return (
    "Open polygon has " +
    count +
    " " +
    noun +
    ". Add at least 3 corners and click the first corner to close, or press Esc. Export was not run."
  );
}

document.getElementById("export").onclick = async () => {
  const pending = OpenClutterDraw.prepareExport(drawSession);
  if (pending.type === "blocked") {
    syncExportReady();
    setStatus(openRingExportStatus(pending.count), true);
    return;
  }
  if (pending.type === "commit-polygon") {
    handleDraw(pending);
    if (!bbox || exportBtn.disabled) return;
  }
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
      // Canopy extent and height come from the height model on export.
      // Aerial color is not a tree source. NLCD hits only supplement dense cells.
      const resolved = T.resolveTrees(bbox, canopy, [], { maxTrees: budget });
      trees = resolved.trees;
      treesSource = resolved.source === "imagery-rgb" ? "none" : resolved.source || "none";
      canopyHits =
        canopy && canopy.parsed && Array.isArray(canopy.parsed.hits) && canopy.parsed.hits.length
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

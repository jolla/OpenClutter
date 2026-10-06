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
  const hint = document.getElementById("terrain-hint");
  if (row) row.hidden = !dev;
  if (hint) hint.hidden = !dev;
  syncMapQuality();
}

function syncMapQuality() {
  const dev = devPage();
  const row = document.getElementById("map-quality-row");
  const hint = document.getElementById("map-quality-hint");
  if (row) row.hidden = !dev;
  if (hint) hint.hidden = !dev;
}

function selectedImageryQuality() {
  const sel = document.getElementById("map-quality");
  const value = sel ? String(sel.value || "") : "";
  if (value === "low" || value === "standard" || value === "high" || value === "sharp") return value;
  return "auto";
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

// World Imagery's tile pyramid ends at level 23 (~0.02 m at the equator).
// Leaflet's default map zoom is 18, which is why a drawn site looked soft.
// On /dev the map follows that pyramid. A missing high level steps the
// native zoom down so the last good tiles scale up instead of breaking the map.
const ESRI_TILE_MAX_ZOOM = 23;
const mapZoom = devPage() ? ESRI_TILE_MAX_ZOOM : 18;
const map = L.map("map", { maxZoom: mapZoom }).setView([36.128, -115.16], 15);
// CARTO's keyless dark tiles now paint "API KEY REQUIRED" through the aerial.
// The draw sits on World Imagery. The page background shows where a tile misses.
const imageryTiles = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    opacity: 1,
    maxZoom: devPage() ? ESRI_TILE_MAX_ZOOM : 19,
    maxNativeZoom: devPage() ? ESRI_TILE_MAX_ZOOM : 19,
    attribution: "Tiles &copy; Esri",
  }
).addTo(map);
if (devPage()) {
  imageryTiles.on("tileerror", function (ev) {
    const z = ev.coords && ev.coords.z;
    const native = imageryTiles.options.maxNativeZoom;
    if (typeof z !== "number" || !(z > 19) || z < native) return;
    imageryTiles.options.maxNativeZoom = z - 1;
    imageryTiles.redraw();
  });
}

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
/** Null uses the box readout. A polygon readout is the closed ring. */
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
  const line = label == null ? OpenClutterArea.bboxReadout(chipBbox(bounds)) : label;
  const text = line && line.text;
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
  areaChip.setLatLng(bounds.getCenter()).setContent(line.html || text);
  if (!map.hasLayer(areaChip)) areaChip.addTo(map);
}

function exportHeadline(stats, warnings, foliageOn) {
  const bits = [];
  const buildings = stats && +stats.buildingsKept;
  const trees = stats && +stats.treesKept;
  if (Number.isFinite(buildings)) bits.push(buildings + (buildings === 1 ? " building" : " buildings"));
  if (foliageOn && Number.isFinite(trees)) bits.push(trees + (trees === 1 ? " tree" : " trees"));
  const mapLine = (warnings || []).find((w) => /^Map image /.test(String(w)));
  const px = mapLine && String(mapLine).match(/(\d+) px/);
  if (px) bits.push(px[1] + " px");
  if (!bits.length) return "Zip ready.";
  return "Zip ready. " + bits.join(", ") + ".";
}

function setStatus(msg, err) {
  const text = String(msg || "");
  const parts = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const lineEl = document.getElementById("status-line");
  const more = document.getElementById("status-more");
  const body = document.getElementById("status-body");
  statusEl.className = err ? "err" : "";
  if (!lineEl || !more || !body) {
    statusEl.textContent = text;
    return;
  }
  if (err || parts.length <= 1) {
    lineEl.textContent = err ? text : parts[0] || "";
    more.hidden = true;
    more.open = false;
    body.replaceChildren();
    return;
  }
  lineEl.textContent = parts[0];
  body.replaceChildren();
  for (let i = 1; i < parts.length; i++) {
    const p = document.createElement("p");
    p.textContent = parts[i];
    body.appendChild(p);
  }
  more.hidden = false;
  more.open = false;
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
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag !== "INPUT") return false;
  const type = String(el.type || "text").toLowerCase();
  return (
    type === "text" ||
    type === "search" ||
    type === "email" ||
    type === "url" ||
    type === "tel" ||
    type === "password" ||
    type === "number"
  );
}

function releasePanelFocus() {
  const el = document.activeElement;
  if (!el || el === document.body || typingTarget(el)) return;
  if (el.closest && el.closest(".panel")) el.blur();
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
  releasePanelFocus();
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
  applyExtent(layer.getBounds(), OpenClutterArea.polygonReadout(vertices));
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
    showAreaChip(L.latLngBounds(latlngs), OpenClutterArea.polygonReadout(vertices));
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
    releasePanelFocus();
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
    releasePanelFocus();
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
  enterDrawMode("Click the map to draw the site.");
};

enterDrawMode();

document.getElementById("search").onsubmit = async (e) => {
  e.preventDefault();
  const q = document.getElementById("q").value.trim();
  setStatus("Searching…");
  try {
    const r = await fetch("/api/geocode?q=" + encodeURIComponent(q));
    const hits = await r.json();
    if (!r.ok) throw new Error(hits.error || "Geocode failed");
    if (!hits.length) throw new Error("No results. Try the street address.");
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
  // A 502 or 504 is one try and a sentence on the page. It is not a draw
  // that is too large, and the status does not stay blank.
  return OpenClutterExport.failureError(status, data);
}

async function fetchTerrainPaste() {
  const body = JSON.stringify({
    ...bbox,
    name: document.getElementById("q").value || "Site",
    includeTerrain: true,
    terrainResolution: "auto",
    terrainStyle: "sloped",
    format: "terrain",
  });
  let last = { terrainClipboard: null, terrainStatus: "Terrain did not return. Export again." };
  // The first elevation response can come back empty while the elevation
  // service is still cold. One more request in this same export, so Copy
  // terrain does not wait on a second click.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch("/api/clutter", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data && data.terrainClipboard) return data;
      last = {
        terrainClipboard: null,
        terrainStatus: (data && data.terrainStatus) || "Terrain did not return. Export again.",
      };
    } catch {
      last = { terrainClipboard: null, terrainStatus: "Terrain did not return. Export again." };
    }
  }
  return last;
}

async function exportOnce(trees, treesSource, canopyHits, includeFoliage, includeTerrain, terrainPaste) {
  const foliage = includeFoliage === true;
  const terrain = includeTerrain !== false;
  const liftSamples =
    terrain && devPage() && terrainPaste && Array.isArray(terrainPaste.liftSamples)
      ? terrainPaste.liftSamples
      : undefined;
  const r = await fetch("/api/clutter", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      // A polygon exports as this axis-aligned box. The API frame is west/south/east/north.
      ...bbox,
      name: document.getElementById("q").value || "Site",
      includeFoliage: foliage,
      includeTerrain: terrain,
      deferTerrain: terrain && devPage(),
      terrainResolution: terrain ? "auto" : undefined,
      terrainStyle: terrain ? "sloped" : undefined,
      liftSamples,
      liftKind: liftSamples && terrainPaste.liftKind ? terrainPaste.liftKind : undefined,
      imageryQuality: devPage() ? selectedImageryQuality() : undefined,
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
  const terrainPromise = includeTerrain && devPage() ? fetchTerrainPaste() : null;
  if (terrainPromise) terrainPromise.catch(() => {});
  setStatus("Export is still working.");
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
    // The elevation read overlaps canopy detection. The zip then uses those
    // samples so building bottoms match the mesh that Copy terrain pastes.
    const paste = terrainPromise ? await terrainPromise : null;
    const data = await OpenClutterExport.runExportAttempts(() =>
      exportOnce(trees, treesSource, canopyHits, includeFoliage, includeTerrain, paste)
    );
    downloadBlob(b64ToBlob(data.zipBase64, "application/zip"), data.zipFilename || "openclutter.zip");
    if (paste && paste.terrainClipboard) {
      data.terrainClipboard = paste.terrainClipboard;
      data.terrainStatus = paste.terrainStatus || "";
      if (Array.isArray(data.warnings)) {
        data.warnings = data.warnings.filter((w) => !/terrain omitted|export budget spent/i.test(String(w)));
      }
    } else if (paste && !data.terrainClipboard) {
      data.terrainStatus = paste.terrainStatus || "Terrain did not return. Export again.";
    }
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
    const lines = [exportHeadline(data.stats, warnLines, includeFoliage)];
    lines.push("Import this zip in Hamina (Projects → Import → OpenIntent).");
    if (terrainNote) lines.push(terrainNote);
    if (summary) lines.push(summary);
    for (let i = 0; i < warnLines.length; i++) lines.push(warnLines[i]);
    setStatus(lines.join("\n"));
  } catch (err) {
    setStatus(OpenClutterExport.idleStatus(err), true);
  } finally {
    exportBtn.disabled = false;
  }
};

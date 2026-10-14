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

// Production gets the same export quality as /dev. Testing overrides
// (areaCap, terrainFloors, jsonBudget) and the dev badge stay on devPage().
function qualityPage() {
  if (devPage()) return true;
  const host = (location.hostname || "").toLowerCase();
  return (
    host === "openclutter.com" ||
    host === "www.openclutter.com" ||
    host === "openclutter.netlify.app" ||
    host === "main--openclutter.netlify.app"
  );
}

function syncDevPanel() {
  const dev = devPage();
  const sub = document.getElementById("panel-sub");
  if (sub) sub.hidden = dev;
}

function restoreAdvanced() {
  const details = document.getElementById("advanced");
  const howto = document.getElementById("howto");
  if (!details) return;
  let open = false;
  try {
    open = localStorage.getItem("openclutter-advanced") === "1";
  } catch (err) {
    open = false;
  }
  details.open = open;
  if (open && howto) howto.open = false;
  details.addEventListener("toggle", function () {
    if (details.open && howto) howto.open = false;
    try {
      localStorage.setItem("openclutter-advanced", details.open ? "1" : "0");
    } catch (err) {}
  });
  if (howto) {
    howto.addEventListener("toggle", function () {
      if (howto.open && details.open) details.open = false;
    });
  }
}

function whatsNewTriggers() {
  return [document.getElementById("app-version")].filter(Boolean);
}

function setWhatsNewOpen(open) {
  const panel = document.getElementById("whats-new");
  if (!panel) return;
  panel.hidden = !open;
  whatsNewTriggers().forEach(function (el) {
    el.setAttribute("aria-expanded", open ? "true" : "false");
  });
}

function setupWhatsNew() {
  const panel = document.getElementById("whats-new");
  const triggers = whatsNewTriggers();
  if (!panel || !triggers.length) return;
  triggers.forEach(function (el) {
    el.addEventListener("click", function () {
      setWhatsNewOpen(panel.hidden);
    });
  });
  document.addEventListener("pointerdown", function (ev) {
    if (panel.hidden) return;
    const t = ev.target;
    if (!t || !t.closest) return;
    if (t.closest("#whats-new") || t.closest("#map-credit")) return;
    setWhatsNewOpen(false);
  });
}

function areaCapOverride() {
  if (!devPage()) return undefined;
  let raw = "";
  try {
    raw = new URLSearchParams(location.search || "").get("areaCap");
  } catch (err) {
    return undefined;
  }
  if (raw == null || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  // Optional upper bound. Omitting it leaves the 4.9 MB byte budget and the 8000 sanity cap.
  if (n < 982 || n > 8000) return undefined;
  return n;
}

function terrainFloorsOverride() {
  if (!devPage()) return undefined;
  let raw = "";
  try {
    raw = new URLSearchParams(location.search || "").get("terrainFloors");
  } catch (err) {
    return undefined;
  }
  if (raw == null || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  if (n < 100 || n > 6000) return undefined;
  return n;
}

function jsonBudgetOverride() {
  if (!devPage()) return undefined;
  let raw = "";
  try {
    raw = new URLSearchParams(location.search || "").get("jsonBudget");
  } catch (err) {
    return undefined;
  }
  if (raw == null || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  if (n < 4900000 || n > 5242880) return undefined;
  return n;
}

function lidarQueryOn() {
  let raw = "";
  try {
    raw = new URLSearchParams(location.search || "").get("lidar");
  } catch (err) {
    return false;
  }
  return raw === "1";
}

function lidarEnabled() {
  if (!qualityPage()) return undefined;
  const input = document.getElementById("include-lidar");
  if (input && input.checked) return true;
  return lidarQueryOn() ? true : undefined;
}

function selectedImageryQuality() {
  const sel = document.getElementById("map-quality");
  const value = sel ? String(sel.value || "") : "";
  if (value === "low" || value === "standard" || value === "high" || value === "sharp" || value === "4k" || value === "8k") return value;
  return "auto";
}

function clutterChecked(id) {
  const input = document.getElementById(id);
  if (!input) return true;
  return !!input.checked;
}

function terrainExportEnabled() {
  const input = document.getElementById("include-terrain");
  if (!input) return true;
  return !!input.checked;
}

(function markDeployEnv() {
  const badge = document.getElementById("env-badge");
  if (badge && devPage()) badge.classList.add("on");
  syncDevPanel();
  restoreAdvanced();
  setupWhatsNew();
  const lidarBox = document.getElementById("include-lidar");
  if (lidarBox && qualityPage() && lidarQueryOn()) lidarBox.checked = true;
  const ver = document.getElementById("app-version");
  if (ver && window.OPENCLUTTER_VERSION) ver.textContent = "v" + window.OPENCLUTTER_VERSION;
})();

let bbox = null;
let terrainPasteGpsOnly = false;

// World Imagery's tile pyramid ends at level 23 (~0.02 m at the equator).
// Leaflet's default map zoom is 18, which is why a drawn site looked soft.
// On /dev the map follows that pyramid. A missing high level steps the
// native zoom down so the last good tiles scale up instead of breaking the map.
const ESRI_TILE_MAX_ZOOM = 23;
const mapZoom = qualityPage() ? ESRI_TILE_MAX_ZOOM : 18;
const map = L.map("map", { maxZoom: mapZoom }).setView([36.128, -115.16], 16);
// CARTO's keyless dark tiles now paint "API KEY REQUIRED" through the aerial.
// The draw sits on World Imagery. The page background shows where a tile misses.
const imageryTiles = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    opacity: 1,
    maxZoom: qualityPage() ? ESRI_TILE_MAX_ZOOM : 19,
    maxNativeZoom: qualityPage() ? ESRI_TILE_MAX_ZOOM : 19,
    attribution: "Tiles &copy; Esri",
  }
).addTo(map);
if (qualityPage()) {
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
let terrainPasteJson = "";
let exportCopyReady = false;
let drawHidesCopy = false;
let drawEpoch = 0;
let exportEpoch = 0;

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

function clearButtonHtml() {
  return ' <button type="button" class="area-clear" aria-label="Clear">x</button>';
}

function showAreaChip(bounds, label, withClear) {
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
  const body = line.html || text;
  areaChip.setLatLng(bounds.getCenter()).setContent(withClear ? body + clearButtonHtml() : body);
  if (!map.hasLayer(areaChip)) areaChip.addTo(map);
}

function exportHeadline(stats, warnings, foliageOn) {
  const bits = [];
  const buildings = stats && +stats.buildingsKept;
  const trees = stats && +stats.treesKept;
  if (Number.isFinite(buildings)) bits.push(buildings + (buildings === 1 ? " building" : " buildings"));
  if (foliageOn && Number.isFinite(trees)) bits.push(trees + (trees === 1 ? " tree" : " trees"));
  const mapLine = (warnings || []).find((w) => /^Map (image|stepped) /.test(String(w)));
  const stepped = mapLine && /stepped down to (\d+) px from (\d+) px/.exec(String(mapLine));
  const px = mapLine && String(mapLine).match(/(\d+) px/);
  if (stepped) bits.push(stepped[1] + " px, down from " + stepped[2]);
  else if (px) bits.push(px[1] + " px");
  const lidarLine = (warnings || []).find((w) => /^Lidar heights (used|not used)\./.test(String(w)));
  if (lidarLine) bits.push(String(lidarLine).replace(/\.$/, ""));
  if (!bits.length) return "OpenIntent file ready.";
  return "OpenIntent file ready. " + bits.join(", ") + ".";
}

function setCopyNote(msg, err) {
  const note = document.getElementById("copy-note");
  if (!note) return;
  const text = String(msg || "");
  note.textContent = text;
  note.hidden = !text;
  note.classList.toggle("err", !!err);
}

function clearCopyNote() {
  setCopyNote("");
}

function setStatus(msg, err) {
  hideExportProgress();
  clearCopyNote();
  const text = String(msg || "");
  const parts = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const lineEl = document.getElementById("status-line");
  const more = document.getElementById("status-more");
  const body = document.getElementById("status-body");
  statusEl.className = err ? "err" : "";
  const done = !err && /^Done in \d+:\d\d$/.test(parts[0] || "");
  if (lineEl) lineEl.classList.toggle("done", done);
  if (!err && !(done && exportStepsSeen)) hideExportSteps();
  const tip = document.getElementById("import-tip");
  if (tip) tip.hidden = !done;
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
  if (committedBounds) showAreaChip(committedBounds, committedLabel, true);
  else hideAreaChip();
  noteDrawCancelled();
}

function syncDrawMode() {
  const container = map.getContainer();
  map.dragging.disable();
  if (map.doubleClickZoom) map.doubleClickZoom.disable();
  if (map.touchZoom && !map.touchZoom.enabled()) map.touchZoom.enable();
  if (map.scrollWheelZoom && !map.scrollWheelZoom.enabled()) map.scrollWheelZoom.enable();
  container.style.touchAction = "none";
  if (panPointer != null) {
    container.style.cursor = "grabbing";
    return;
  }
  container.style.cursor = spacePan ? "grab" : "crosshair";
}

function typingTarget(el) {
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "SELECT") return true;
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
  if (
    el.closest &&
    (el.closest(".panel") ||
      el.closest("#map-credit") ||
      el.closest("#whats-new"))
  ) {
    el.blur();
  }
}

function panGesture(ev) {
  if (ev.button === 1 || ev.button === 2) return true;
  if (ev.button !== 0) return false;
  return spacePan || !!ev.ctrlKey;
}

function committedExportBlocked() {
  if (!bbox) return true;
  const w = L.latLng(bbox.south, bbox.west).distanceTo(L.latLng(bbox.south, bbox.east));
  const h = L.latLng(bbox.south, bbox.west).distanceTo(L.latLng(bbox.north, bbox.west));
  return w > 10000 || h > 10000 || w < 40 || h < 40;
}

function syncDrawHint() {
  const hint = document.getElementById("draw-hint");
  if (!hint) return;
  const open = (drawSession.phase === "polygon" && drawSession.vertices.length > 0) || !!drawSession.dragged;
  hint.hidden = !!(bbox || open);
}

function syncExportReady() {
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
  syncDrawHint();
  if (message) setStatus(message);
}

function resumeDrawMode() {
  if (drawSession.vertices.length || drawSession.down) return;
  if (!drawSession.armed) OpenClutterDraw.arm(drawSession);
  syncDrawMode();
  syncExportReady();
  syncDrawHint();
}

function applyExtent(bounds, label) {
  noteAreaReplaced();
  committedBounds = bounds;
  committedLabel = label == null ? null : label;
  bbox = chipBbox(bounds);
  showAreaChip(bounds, committedLabel, true);
  syncExportReady();
  syncDrawHint();
  if (exportBtn.disabled) setStatus("Area must be between 40 m and 10 km on a side.", true);
  else setStatus("Ready to export.");
}

function clearFinishedShape() {
  noteAreaReplaced();
  drawn.clearLayers();
  if (!map.hasLayer(drawn)) map.addLayer(drawn);
  committedBounds = null;
  committedLabel = null;
  bbox = null;
  sketchHidden = false;
  clearRubber();
  hideAreaChip();
  syncExportReady();
  syncDrawHint();
  if (!(drawSession.phase === "polygon" && drawSession.vertices.length)) setStatus("");
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
  noteDrawInProgress();
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
  noteDrawInProgress();
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
    syncDrawHint();
    return;
  }
  if (result.type === "vertex") {
    showVertexPreview(result.vertices);
    const n = result.vertices.length;
    syncExportReady();
    syncDrawHint();
    if (n < 3) setStatus("Corner " + n + ". Click the next corner. Esc cancels.");
    else setStatus("Corner " + n + ". Click the first corner to close. Double-click also finishes. Esc cancels.");
    return;
  }
  if (result.type === "short") {
    setStatus("Add another corner, then click the first corner to close. Esc cancels.");
    syncDrawHint();
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
    syncDrawHint();
    if (!result.discarded) return;
    if (!bbox) setStatus("");
    else if (exportBtn.disabled) setStatus("Area must be between 40 m and 10 km on a side.", true);
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
  syncDrawHint();
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
const touchIds = new Set();
let pinchGesture = false;
const ARROW_PAN = {
  ArrowLeft: [-80, 0],
  ArrowRight: [80, 0],
  ArrowUp: [0, -80],
  ArrowDown: [0, 80],
};

function noteTouch(ev) {
  if (ev.pointerType === "touch") touchIds.add(ev.pointerId);
}

function forgetTouch(ev) {
  if (ev.pointerType === "touch") touchIds.delete(ev.pointerId);
}

function focusMapForKeys() {
  const container = map.getContainer();
  if (!container || document.activeElement === container) return;
  try {
    container.focus({ preventScroll: true });
  } catch (e) {
    container.focus();
  }
}

function abortDrawForPinch() {
  if (activePointer != null) {
    try {
      mapEl.releasePointerCapture(activePointer);
    } catch (e) {
      /* already released */
    }
    OpenClutterDraw.abortPress(drawSession);
    activePointer = null;
  }
  if (drawSession.vertices.length) showVertexPreview(drawSession.vertices.map((v) => ({ lat: v.lat, lng: v.lng })));
  else restoreCommitted();
  syncDrawHint();
}

mapEl.addEventListener(
  "pointerdown",
  (ev) => {
    noteTouch(ev);
    if (ev.target.closest && ev.target.closest(".leaflet-control")) return;
    if (ev.target.closest && ev.target.closest(".area-clear")) return;
    if (ev.pointerType === "touch" && touchIds.size >= 2) {
      pinchGesture = true;
      abortDrawForPinch();
      if (panPointer != null) endPan();
      return;
    }
    if (pinchGesture) return;
    focusMapForKeys();
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
    if (pinchGesture) return;
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

function endPinchPointer(ev) {
  forgetTouch(ev);
  if (!pinchGesture) return false;
  if (ev.pointerId === panPointer) endPan();
  if (ev.pointerId === activePointer) {
    OpenClutterDraw.abortPress(drawSession);
    activePointer = null;
  }
  if (touchIds.size === 0) {
    pinchGesture = false;
    if (drawSession.vertices.length) showVertexPreview(drawSession.vertices.map((v) => ({ lat: v.lat, lng: v.lng })));
    else restoreCommitted();
    syncDrawHint();
  }
  return true;
}

mapEl.addEventListener("pointerup", (ev) => {
  if (endPinchPointer(ev)) return;
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
  if (endPinchPointer(ev)) return;
  if (ev.pointerId === panPointer) {
    endPan();
    return;
  }
  if (ev.pointerId !== activePointer) return;
  activePointer = null;
  OpenClutterDraw.abortPress(drawSession);
  if (drawSession.vertices.length) showVertexPreview(drawSession.vertices.map((v) => ({ lat: v.lat, lng: v.lng })));
  else restoreCommitted();
  syncDrawHint();
});

mapEl.addEventListener("click", (ev) => {
  const btn = ev.target.closest && ev.target.closest(".area-clear");
  if (!btn) return;
  ev.preventDefault();
  ev.stopPropagation();
  clearFinishedShape();
});


mapEl.addEventListener(
  "contextmenu",
  (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  },
  true
);

// Middle-click would otherwise start browser autoscroll or paste on the map.
mapEl.addEventListener(
  "mousedown",
  (ev) => {
    if (ev.button !== 1) return;
    ev.preventDefault();
    ev.stopPropagation();
  },
  true
);

mapEl.addEventListener(
  "auxclick",
  (ev) => {
    if (ev.button !== 1) return;
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
  const arrow = ARROW_PAN[ev.key];
  if (arrow && !typingTarget(ev.target) && !(ev.target && ev.target.closest && ev.target.closest("#map"))) {
    ev.preventDefault();
    map.panBy(L.point(arrow[0], arrow[1]), { animate: false });
  }
  if (ev.key !== "Escape") return;
  const howto = document.getElementById("howto");
  if (howto && howto.open && howto.contains(document.activeElement)) {
    howto.open = false;
    howto.querySelector("summary").focus();
    ev.preventDefault();
    return;
  }
  const whats = document.getElementById("whats-new");
  const triggers = whatsNewTriggers();
  const active = document.activeElement;
  if (
    whats &&
    !whats.hidden &&
    (whats.contains(active) || triggers.indexOf(active) >= 0)
  ) {
    setWhatsNewOpen(false);
    const ver = document.getElementById("app-version");
    if (ver) ver.focus();
    ev.preventDefault();
    return;
  }
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
    map.setView([+hit.lat, +hit.lon], 17);
    if (!bbox) setStatus("");
    else if (exportBtn.disabled) setStatus("Area must be between 40 m and 10 km on a side.", true);
    else setStatus("Ready to export.");
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

function copyTerrainLabelReady() {
  return !!(exportCopyReady && !drawHidesCopy && terrainPasteJson && !terrainPasteGpsOnly);
}

function syncIdleExportLabel() {
  if (exportLive) return;
  const label = document.getElementById("export-label");
  if (!label) return;
  label.textContent = OpenClutterExport.finishedExportButton(
    copyTerrainLabelReady() ? { json: terrainPasteJson, gpsOnly: false } : { json: "", gpsOnly: false }
  ).label;
}

function noteDrawInProgress() {
  if (drawHidesCopy) return;
  drawHidesCopy = true;
  syncIdleExportLabel();
  clearCopyNote();
}

function noteDrawCancelled() {
  if (!drawHidesCopy) return;
  drawHidesCopy = false;
  syncIdleExportLabel();
  if (exportCopyReady) setCopyNote("Paste terrain separately in Hamina.");
}

function noteAreaReplaced() {
  drawHidesCopy = false;
  if (drawEpoch === exportEpoch) drawEpoch += 1;
  exportCopyReady = false;
  terrainPasteJson = "";
  terrainPasteGpsOnly = false;
  syncIdleExportLabel();
  clearCopyNote();
}

function rememberTerrain(data, includeTerrain) {
  const choice = OpenClutterExport.chooseTerrainPaste(data, includeTerrain);
  terrainPasteJson = choice.json;
  terrainPasteGpsOnly = choice.gpsOnly;
  if (data && includeTerrain !== false && !choice.json) data.terrainStatus = choice.status;
  const button = OpenClutterExport.finishedExportButton(choice);
  exportCopyReady = !!(button.copyReady && drawEpoch === exportEpoch);
  return button;
}

async function copyFinishedTerrain() {
  if (!terrainPasteJson || terrainPasteGpsOnly) return;
  try {
    await navigator.clipboard.writeText(terrainPasteJson);
    setCopyNote("Copied. Paste terrain separately in Hamina.");
  } catch (e) {
    setCopyNote("Could not copy terrain. Allow clipboard access and try Copy terrain again.", true);
  }
}

function exportError(status, data) {
  // An empty 502 or 504 is tried once more in this same click. A sentence
  // from the function is shown as-is. The status does not stay blank.
  return OpenClutterExport.failureError(status, data);
}

async function fetchTerrainPaste() {
  const body = JSON.stringify({
    ...bbox,
    name: document.getElementById("q").value || "Site",
    includeTerrain: true,
    terrainResolution: "auto",
    terrainStyle: "sloped",
    terrainFloors: terrainFloorsOverride(),
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

function showExportResult(data, includeFoliage, includeTerrain, fallbackNote) {
  const terrainOff = includeTerrain === false;
  const button = rememberTerrain(data, includeTerrain);
  const summary = (data.stats && data.stats.summary) || "";
  const terrainNote = terrainOff ? button.omittedLine : data.terrainStatus || "";
  const pasteLine = terrainOff ? "" : OpenClutterExport.terrainPasteLine(data && data.terrainClipboard);
  let pastedNotes = 0;
  if (terrainPasteJson) {
    try {
      const pasted = JSON.parse(terrainPasteJson);
      pastedNotes = pasted && Array.isArray(pasted.mapNotes) ? pasted.mapNotes.length : 0;
    } catch (err) {
      pastedNotes = 0;
    }
  }
  const gpsNote = button.copyReady
    ? "Two GPS points, the southwest and northeast corners of the imported map, are on the paste." +
      (pastedNotes ? " Map notes are on that paste." : "")
    : "";
  const warnLines = (Array.isArray(data.warnings) ? data.warnings.filter(Boolean) : []).filter(
    (line) => !terrainOff || !/terrain/i.test(line)
  );
  const lines = [exportHeadline(data.stats, warnLines, includeFoliage)];
  const detail = OpenClutterExport.exportSummaryLines(data, {
    foliageOn: includeFoliage,
    terrainOn: !terrainOff,
  });
  for (let i = 0; i < detail.length; i++) lines.push(detail[i]);
  lines.push("Import this OpenIntent file in Hamina (Projects → Import → OpenIntent).");
  if (fallbackNote) lines.push(fallbackNote);
  const coveredTerrain = detail.some((line) => line.indexOf("Terrain") === 0 || line.indexOf("Minimum ") === 0);
  if (terrainNote && !coveredTerrain) lines.push(terrainNote);
  if (pasteLine && !detail.some((line) => line.indexOf("Terrain pieces ") === 0)) lines.push(pasteLine);
  if (gpsNote) lines.push(gpsNote);
  if (summary && !detail.length) lines.push(summary);
  const withOmitted = OpenClutterExport.appendTerrainOmitted(lines, button);
  lines.length = 0;
  for (let i = 0; i < withOmitted.length; i++) lines.push(withOmitted[i]);
  for (let i = 0; i < warnLines.length; i++) {
    if (/^Lidar heights (used|not used)\.$/.test(warnLines[i])) continue;
    if (/^Map (image|stepped) /.test(warnLines[i])) continue;
    lines.push(warnLines[i]);
  }
  const doneMs = exportClock ? exportClock.elapsedMs() : null;
  if (doneMs != null) {
    const withDone = OpenClutterExport.withExportDone(lines, doneMs);
    lines.length = 0;
    for (let i = 0; i < withDone.length; i++) lines.push(withDone[i]);
  }
  setStatus(lines.join("\n"));
  if (exportCopyReady && !drawHidesCopy) setCopyNote("Paste terrain separately in Hamina.");
}

const EXPORT_STEPS = [
  { id: "aerial", label: "Aerial image" },
  { id: "terrain", label: "Terrain", when: "terrain" },
  { id: "buildings", label: "Buildings" },
  { id: "trees", label: "Trees", when: "foliage" },
  { id: "vehicles", label: "Vehicles" },
  { id: "zip", label: "OpenIntent file" },
];
let exportStepOpts = { terrain: true, foliage: true };
let exportStepsSeen = false;

function zipSizeText(bytes) {
  const b = +bytes || 0;
  if (!(b > 0)) return "";
  return b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";
}

/** Checklist rows from the worker's finished steps. Pure, for tests too. */
function exportStepRows(steps, opts, finished, zipBytes) {
  const got = steps && typeof steps === "object" ? steps : {};
  const rows = [];
  let current = false;
  for (let i = 0; i < EXPORT_STEPS.length; i++) {
    const def = EXPORT_STEPS[i];
    if (def.when === "terrain" && !opts.terrain) continue;
    if (def.when === "foliage" && !opts.foliage) continue;
    let mark = got[def.id];
    if (!mark && def.id === "zip" && finished) mark = { done: true, detail: zipSizeText(zipBytes) };
    let state = "todo";
    if (mark && mark.skipped) state = "skip";
    else if (mark && mark.done) state = "ok";
    else if (finished) state = "skip";
    else if (!current) {
      state = "now";
      current = true;
    }
    rows.push({ id: def.id, label: def.label, state, detail: (mark && mark.detail) || "" });
  }
  return rows;
}

function paintExportSteps(job, finished) {
  const list = document.getElementById("export-steps");
  if (!list) return;
  const steps = job && job.steps;
  if (steps && typeof steps === "object" && Object.keys(steps).length) exportStepsSeen = true;
  const rows = exportStepRows(steps, exportStepOpts, !!finished, job && job.zipBytes);
  list.replaceChildren();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const li = document.createElement("li");
    li.className = r.state;
    const mk = document.createElement("span");
    mk.className = "mk";
    mk.textContent = r.state === "ok" ? "\u2713" : r.state === "skip" ? "\u2013" : r.state === "now" ? "\u2022" : "\u00b7";
    const name = document.createElement("span");
    name.textContent = r.label;
    li.append(mk, name);
    if (r.detail) {
      const dt = document.createElement("span");
      dt.className = "dt";
      dt.textContent = r.detail;
      li.appendChild(dt);
    }
    list.appendChild(li);
  }
  list.classList.toggle("compact", !!finished);
  list.hidden = false;
}

function hideExportSteps() {
  const list = document.getElementById("export-steps");
  if (list) {
    list.hidden = true;
    list.replaceChildren();
  }
}

let exportLive = false;
let exportPercentHeld = 0;
let exportTick = 0;
let exportShownStage = "";
let exportClock = null;

function paintExportElapsedLabel(label) {
  const elapsed = document.getElementById("export-elapsed");
  if (!elapsed) return;
  elapsed.hidden = false;
  elapsed.textContent = label;
  if (exportBtn && exportLive) {
    exportBtn.setAttribute("aria-valuetext", "Exporting " + exportPercentHeld + "%, " + label);
  }
}

function hideExportElapsed() {
  const elapsed = document.getElementById("export-elapsed");
  if (!elapsed) return;
  elapsed.hidden = true;
  elapsed.textContent = "";
}

function stopExportTick() {
  if (exportTick) {
    clearInterval(exportTick);
    exportTick = 0;
  }
}

function hideExportProgress() {
  if (exportLive) return;
  exportPercentHeld = 0;
  const fill = document.getElementById("export-fill");
  if (fill) fill.style.width = "0";
  syncIdleExportLabel();
  if (exportBtn) {
    exportBtn.classList.remove("exporting");
    exportBtn.removeAttribute("role");
    exportBtn.removeAttribute("aria-valuemin");
    exportBtn.removeAttribute("aria-valuemax");
    exportBtn.removeAttribute("aria-valuenow");
    exportBtn.removeAttribute("aria-valuetext");
  }
  hideExportElapsed();
}

function endExportProgress() {
  stopExportTick();
  if (exportClock) exportClock.stop();
  exportLive = false;
  exportShownStage = "";
  hideExportProgress();
}

function showExportProgress(job) {
  exportLive = true;
  const view = job ? Object.assign({}, job) : {};
  const stageName = String(view.stage || view.heartbeatStage || "");
  if (stageName) exportShownStage = stageName;
  if (/^Fetching (aerial|map)\b/i.test(stageName)) {
    const started = Number(view.aerialStartedAt || view.createdAt);
    let elapsed = started > 0 ? Math.max(0, Date.now() - started) : 0;
    if (+view.aerialElapsedMs > elapsed) elapsed = +view.aerialElapsedMs;
    if (elapsed > 0) view.aerialElapsedMs = elapsed;
  }
  let pct = OpenClutterProgress.exportPercent(view, exportPercentHeld);
  if (view.state === "done") pct = 100;
  else if (Number.isFinite(+view.percent) && +view.percent > pct) pct = Math.min(99, Math.floor(+view.percent));
  exportPercentHeld = pct;
  const fill = document.getElementById("export-fill");
  const label = document.getElementById("export-label");
  if (fill) fill.style.width = pct + "%";
  if (label) label.textContent = "Exporting " + pct + "%";
  if (exportBtn) {
    exportBtn.classList.add("exporting");
    exportBtn.setAttribute("role", "progressbar");
    exportBtn.setAttribute("aria-valuemin", "0");
    exportBtn.setAttribute("aria-valuemax", "100");
    exportBtn.setAttribute("aria-valuenow", String(pct));
    const elapsedEl = document.getElementById("export-elapsed");
    const time = elapsedEl && !elapsedEl.hidden && elapsedEl.textContent ? ", " + elapsedEl.textContent : "";
    exportBtn.setAttribute("aria-valuetext", "Exporting " + pct + "%" + time);
  }
  if (view.state !== "done") paintExportSteps(view, false);
  const line = document.getElementById("status-line");
  let stageText = (job && (job.stageLabel || job.stage)) || "Fetching aerial";
  if (/^Fetching map$/i.test(stageText)) stageText = "Fetching aerial";
  if (line) {
    line.textContent = stageText;
    line.classList.remove("done");
  }
  if (statusEl) statusEl.className = "";
  const more = document.getElementById("status-more");
  if (more) {
    more.hidden = true;
    more.open = false;
  }
}

function beginExportProgress(opts) {
  stopExportTick();
  exportStepOpts = Object.assign({ terrain: true, foliage: true }, opts || {});
  exportStepsSeen = false;
  if (exportClock) exportClock.stop();
  exportClock = OpenClutterExport.createExportClock({
    onTick: paintExportElapsedLabel,
  });
  exportPercentHeld = 0;
  exportShownStage = "Fetching aerial";
  const started = Date.now();
  showExportProgress({
    stage: "Fetching aerial",
    stageLabel: "Fetching aerial",
    state: "running",
    createdAt: started,
  });
  exportTick = setInterval(() => {
    if (!exportLive) return;
    if (!/^Fetching (aerial|map)\b/i.test(exportShownStage)) return;
    showExportProgress({
      stage: "Fetching aerial",
      stageLabel: "Fetching aerial",
      state: "running",
      createdAt: started,
    });
  }, 400);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function enqueueExport(trees, treesSource, canopyHits, includeFoliage, includeTerrain) {
  const foliage = includeFoliage === true;
  const terrain = includeTerrain !== false;
  const r = await fetch("/api/clutter", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...bbox,
      name: document.getElementById("q").value || "Site",
      includeFoliage: foliage,
      includeWater: clutterChecked("include-water"),
      includeParking: clutterChecked("include-parking"),
      includeWalls: clutterChecked("include-walls"),
      includePoles: clutterChecked("include-poles"),
      includeRvs: clutterChecked("include-rvs"),
      includeCars: clutterChecked("include-cars"),
      includeTerrain: terrain,
      deferTerrain: false,
      terrainResolution: terrain ? "auto" : undefined,
      terrainStyle: terrain ? "sloped" : undefined,
      imageryQuality: qualityPage() ? selectedImageryQuality() : undefined,
      areaCap: areaCapOverride(),
      jsonBudget: jsonBudgetOverride(),
      terrainFloors: terrainFloorsOverride(),
      lidar: lidarEnabled(),
      mapNotes: clutterChecked("include-map-notes"),
      trees: foliage ? trees : [],
      treesSource: foliage ? treesSource : "none",
      canopyHits: foliage && canopyHits && canopyHits.length ? canopyHits : undefined,
      format: "bundle",
      async: true,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw exportError(r.status, data);
  return data;
}

async function pollExport(jobId) {
  const started = Date.now();
  const ceiling = 15 * 60 * 1000;
  let misses = 0;
  while (Date.now() - started < ceiling) {
    let data = null;
    try {
      const r = await fetch("/api/export-status?job=" + encodeURIComponent(jobId), { cache: "no-store" });
      data = await r.json().catch(() => ({}));
      if (r.status === 404) throw new Error(data.error || "This export expired. Export again.");
      if (!r.ok) throw new Error(data.error || "Could not read export status.");
      misses = 0;
    } catch (err) {
      if (err && /expired|Export id/i.test(err.message || "")) throw err;
      misses += 1;
      if (misses >= 4) throw new Error("Could not read export status. Export again.");
      await sleep(1500);
      continue;
    }
    if (data.state === "error") {
      endExportProgress();
      throw new Error(data.error || "Export failed.");
    }
    showExportProgress(data);
    if (data.state === "done") return data;
    await sleep(1500);
  }
  throw new Error("Export timed out after 15 minutes. Draw a smaller area and try again.");
}

function downloadFailure(status, data) {
  const msg = data && (data.error || data.errorMessage);
  if (msg) return String(msg);
  if (status === 413) return "The OpenIntent file is too large to download. Export again.";
  if (status) return "The OpenIntent download failed (" + status + "). Export again.";
  return "The OpenIntent download failed. Export again.";
}

async function downloadJobZip(jobId, filename) {
  let lastStatus = 0;
  let lastData = {};
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch("/api/export-file?job=" + encodeURIComponent(jobId), { cache: "no-store" });
    if (r.ok) {
      const blob = await r.blob();
      const disp = r.headers.get("content-disposition") || "";
      const named = disp.match(/filename="([^"]+)"/);
      downloadBlob(blob, (named && named[1]) || filename || "openintent.zip");
      return;
    }
    lastStatus = r.status;
    lastData = await r.json().catch(() => ({}));
    const wait = r.status === 409 || r.status === 503;
    if (!wait || attempt === 3) break;
    await sleep(500);
  }
  throw new Error(downloadFailure(lastStatus, lastData));
}

async function exportOnce(trees, treesSource, canopyHits, includeFoliage, includeTerrain, terrainPaste) {
  const foliage = includeFoliage === true;
  const terrain = includeTerrain !== false;
  const liftSamples =
    terrain && qualityPage() && terrainPaste && Array.isArray(terrainPaste.liftSamples)
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
      includeWater: clutterChecked("include-water"),
      includeParking: clutterChecked("include-parking"),
      includeWalls: clutterChecked("include-walls"),
      includePoles: clutterChecked("include-poles"),
      includeRvs: clutterChecked("include-rvs"),
      includeCars: clutterChecked("include-cars"),
      includeTerrain: terrain,
      deferTerrain: terrain && qualityPage(),
      terrainResolution: terrain ? "auto" : undefined,
      terrainStyle: terrain ? "sloped" : undefined,
      liftSamples,
      liftKind: liftSamples && terrainPaste.liftKind ? terrainPaste.liftKind : undefined,
      imageryQuality: qualityPage() ? selectedImageryQuality() : undefined,
      areaCap: areaCapOverride(),
      jsonBudget: jsonBudgetOverride(),
      terrainFloors: terrainFloorsOverride(),
      lidar: lidarEnabled(),
      mapNotes: clutterChecked("include-map-notes"),
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
  if (copyTerrainLabelReady()) {
    await copyFinishedTerrain();
    return;
  }
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
  exportEpoch = drawEpoch;
  exportCopyReady = false;
  exportBtn.disabled = true;
  const includeFoliage = clutterChecked("include-foliage");
  const includeTerrain = terrainExportEnabled();
  try {
    beginExportProgress({ terrain: includeTerrain !== false, foliage: includeFoliage === true });
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
    let queued = null;
    try {
      queued = await enqueueExport(trees, treesSource, canopyHits, includeFoliage, includeTerrain);
    } catch (err) {
      if (err && err.noRetry) throw err;
      queued = {
        fallback: true,
        note: "Background export is unavailable. This export uses the short path.",
      };
    }
    if (queued && queued.jobId) {
      const data = await pollExport(queued.jobId);
      paintExportSteps(data, true);
      await downloadJobZip(queued.jobId, data.zipFilename);
      showExportResult(data, includeFoliage, includeTerrain, "");
      return;
    }
    const fallbackNote =
      queued && queued.fallback
        ? queued.note || "Background export is unavailable. This export uses the short path."
        : "";
    if (fallbackNote) setStatus(fallbackNote);
    const terrainPromise = includeTerrain && qualityPage() ? fetchTerrainPaste() : null;
    if (terrainPromise) terrainPromise.catch(() => {});
    const paste = terrainPromise ? await terrainPromise : null;
    const data = await OpenClutterExport.runExportAttempts((attempt) => {
      if (attempt > 1) {
        setStatus("The first export did not return an OpenIntent file. Export is still working.");
      }
      return exportOnce(trees, treesSource, canopyHits, includeFoliage, includeTerrain, paste);
    });
    downloadBlob(b64ToBlob(data.zipBase64, "application/zip"), data.zipFilename || "openintent.zip");
    if (paste && paste.terrainClipboard) {
      const keptNotes = data.terrainClipboard && data.terrainClipboard.mapNotes;
      data.terrainClipboard = paste.terrainClipboard;
      if (
        Array.isArray(keptNotes) &&
        keptNotes.length &&
        (!data.terrainClipboard.mapNotes || !data.terrainClipboard.mapNotes.length)
      ) {
        data.terrainClipboard.mapNotes = keptNotes;
      }
      data.terrainStatus = paste.terrainStatus || "";
      if (Array.isArray(data.warnings)) {
        data.warnings = data.warnings.filter((w) => !/terrain omitted|export budget spent/i.test(String(w)));
      }
    } else if (paste && !data.terrainClipboard) {
      data.terrainStatus = paste.terrainStatus || "Terrain did not return. Export again.";
    }
    showExportResult(data, includeFoliage, includeTerrain, fallbackNote);
  } catch (err) {
    setStatus(OpenClutterExport.idleStatus(err), true);
  } finally {
    endExportProgress();
    exportBtn.disabled = false;
  }
};

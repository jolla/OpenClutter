(function markDeployEnv() {
  const host = location.hostname || "";
  const path = location.pathname || "";
  const isDev =
    host.startsWith("dev--") ||
    host.startsWith("deploy-preview-") ||
    path === "/dev" ||
    path.startsWith("/dev/");
  const badge = document.getElementById("env-badge");
  if (badge && isDev) badge.classList.add("on");
})();

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

let bbox = null;
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

async function exportOnce(trees, treesSource, canopyHits, includeFoliage) {
  const foliage = includeFoliage === true;
  const r = await fetch("/api/clutter", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      // A polygon exports as this axis-aligned box. The API frame is west/south/east/north.
      ...bbox,
      name: document.getElementById("q").value || "Site",
      includeFoliage: foliage,
      trees: foliage ? trees : [],
      treesSource: foliage ? treesSource : "none",
      canopyHits: foliage && canopyHits && canopyHits.length ? canopyHits : undefined,
      format: "bundle",
    }),
  });
  const data = await r.json().catch(() => ({ error: r.status + " " + r.statusText }));
  if (!r.ok) throw new Error(data.error || "Export failed (" + r.status + ")");
  return data;
}

document.getElementById("export").onclick = async () => {
  if (!bbox) return;
  exportBtn.disabled = true;
  const includeFoliage = document.getElementById("include-foliage").checked;
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
      data = await exportOnce(trees, treesSource, canopyHits, includeFoliage);
    } catch (e) {
      data = await exportOnce(trees, treesSource, canopyHits, includeFoliage);
    }
    downloadBlob(b64ToBlob(data.zipBase64, "application/zip"), data.zipFilename || "openclutter.zip");
    rememberTerrain(data);
    const summary = (data.stats && data.stats.summary) || "";
    const terrainNote = data.terrainStatus || "";
    setStatus(
      "Import this zip in Hamina (Projects → Import → OpenIntent)." +
        (terrainNote ? "\n" + terrainNote : "") +
        (summary ? "\n" + summary : "")
    );
  } catch (err) {
    setStatus(String(err && err.message ? err.message : "Export failed. Retry."), true);
  } finally {
    exportBtn.disabled = false;
  }
};

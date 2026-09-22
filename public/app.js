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

const drawn = new L.FeatureGroup();
map.addLayer(drawn);
const drawControl = new L.Control.Draw({
  draw: {
    polygon: false,
    polyline: false,
    circle: false,
    circlemarker: false,
    marker: false,
    rectangle: {
      shapeOptions: { color: "#3fb950", weight: 2 },
      showArea: false,
    },
  },
  edit: { featureGroup: drawn },
});

let bbox = null;
let rectDrawer = null;
/** Finished rectangle; the chip returns here if a redraw is cancelled. */
let committedBounds = null;
let gestureCommitted = false;
let areaChip = null;
const statusEl = document.getElementById("status");
const exportBtn = document.getElementById("export");

function chipBbox(bounds) {
  return {
    west: bounds.getWest(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    north: bounds.getNorth(),
  };
}

function hideAreaChip() {
  if (areaChip && map.hasLayer(areaChip)) map.removeLayer(areaChip);
}

function showAreaChip(bounds) {
  const label = OpenClutterArea.formatBboxFeet(chipBbox(bounds));
  if (!label) {
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
  areaChip.setLatLng(bounds.getCenter()).setContent(label);
  if (!map.hasLayer(areaChip)) areaChip.addTo(map);
}

function onDrawPointerMove(e) {
  if (!rectDrawer || !rectDrawer._isDrawing || !rectDrawer._startLatLng || !e.latlng) return;
  const bounds = L.latLngBounds(rectDrawer._startLatLng, e.latlng);
  if (!OpenClutterArea.formatBboxFeet(chipBbox(bounds))) return;
  showAreaChip(bounds);
}

map.on("mousemove", onDrawPointerMove);
map.on("touchmove", onDrawPointerMove);
map.on(L.Draw.Event.DRAWSTART, () => {
  gestureCommitted = false;
});
map.on(L.Draw.Event.DRAWSTOP, () => {
  if (gestureCommitted) return;
  if (committedBounds) showAreaChip(committedBounds);
  else hideAreaChip();
});

function setStatus(msg, err) {
  statusEl.textContent = msg;
  statusEl.className = err ? "err" : "";
}

map.on(L.Draw.Event.CREATED, (e) => {
  gestureCommitted = true;
  drawn.clearLayers();
  drawn.addLayer(e.layer);
  const b = e.layer.getBounds();
  committedBounds = b;
  bbox = chipBbox(b);
  showAreaChip(b);
  const w = L.latLng(bbox.south, bbox.west).distanceTo(L.latLng(bbox.south, bbox.east));
  const h = L.latLng(bbox.south, bbox.west).distanceTo(L.latLng(bbox.north, bbox.west));
  exportBtn.disabled = w > 2500 || h > 2500 || w < 40 || h < 40;
  if (exportBtn.disabled) setStatus("Area must be between 40 m and 2.5 km on a side.", true);
  else setStatus("Ready to export.");
});

document.getElementById("draw").onclick = () => {
  if (rectDrawer && rectDrawer.enabled()) rectDrawer.disable();
  rectDrawer = new L.Draw.Rectangle(map, drawControl.options.draw.rectangle);
  rectDrawer.enable();
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

async function exportOnce(trees, treesSource, canopyHits) {
  const r = await fetch("/api/clutter", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...bbox,
      name: document.getElementById("q").value || "Site",
      trees,
      treesSource,
      canopyHits: canopyHits && canopyHits.length ? canopyHits : undefined,
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
  setStatus("Building map + clutter…");
  try {
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
    const trees = resolved.trees;
    const treesSource = resolved.source;
    const canopyHits =
      treesSource === "nlcd-canopy" && canopy && canopy.parsed && canopy.parsed.hits
        ? canopy.parsed.hits
        : null;
    let data;
    try {
      data = await exportOnce(trees, treesSource, canopyHits);
    } catch (e) {
      data = await exportOnce(trees, treesSource, canopyHits);
    }
    downloadBlob(b64ToBlob(data.zipBase64, "application/zip"), data.zipFilename || "openclutter.zip");
    const summary = (data.stats && data.stats.summary) || "";
    setStatus(
      "Import this zip in Hamina (Projects → Import → OpenIntent)." +
        (summary ? "\n" + summary : "")
    );
  } catch (err) {
    setStatus(String(err && err.message ? err.message : "Export failed. Retry."), true);
  } finally {
    exportBtn.disabled = false;
  }
};

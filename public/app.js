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
    rectangle: { shapeOptions: { color: "#3fb950", weight: 2 } },
  },
  edit: { featureGroup: drawn },
});

let bbox = null;
const statusEl = document.getElementById("status");
const exportBtn = document.getElementById("export");

function setStatus(msg, err) {
  statusEl.textContent = msg;
  statusEl.className = err ? "err" : "";
}

map.on(L.Draw.Event.CREATED, (e) => {
  drawn.clearLayers();
  drawn.addLayer(e.layer);
  const b = e.layer.getBounds();
  bbox = {
    west: b.getWest(),
    south: b.getSouth(),
    east: b.getEast(),
    north: b.getNorth(),
  };
  const w = L.latLng(bbox.south, bbox.west).distanceTo(L.latLng(bbox.south, bbox.east));
  const h = L.latLng(bbox.south, bbox.west).distanceTo(L.latLng(bbox.north, bbox.west));
  exportBtn.disabled = w > 2500 || h > 2500 || w < 40 || h < 40;
  if (exportBtn.disabled) setStatus("Area must be between 40 m and 2.5 km on a side.", true);
  else setStatus("Ready to export.");
});

document.getElementById("draw").onclick = () => {
  new L.Draw.Rectangle(map, drawControl.options.draw.rectangle).enable();
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
  const result = await T.fetchCanopyTrees(b, (url) => fetch(url, { signal: AbortSignal.timeout(8000) }), {
    maxTrees: T.maxTreesForBbox(b),
  });
  if (!result.source) return null;
  return result;
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

async function exportOnce(trees, treesSource) {
  const r = await fetch("/api/clutter", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...bbox,
      name: document.getElementById("q").value || "Site",
      trees,
      treesSource,
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
    let trees = [];
    let treesSource = "none";
    let woodsHits = 0;
    let nlcdCount = 0;
    try {
      const canopy = await detectCanopyTrees(bbox);
      if (canopy) {
        trees = canopy.trees || [];
        nlcdCount = trees.length;
        treesSource = "nlcd-canopy";
        const hits = (canopy.parsed && canopy.parsed.hits) || [];
        woodsHits = hits.filter((h) => (h.pct || 0) >= 40).length;
      }
    } catch (e) {
      treesSource = "none";
    }
    // Oak Creek: NLCD can be valid with 0 hits on parking lots / winter street
    // trees. Always RGB-fill when NLCD placed nothing; also supplement sparse TCC.
    const needRgb = trees.length === 0 || (treesSource === "nlcd-canopy" && trees.length < budget * 0.4 && woodsHits < 16);
    if (needRgb) {
      try {
        const rgb = await detectRgbTrees(bbox);
        if (rgb && rgb.length) {
          trees = T.mergeTreePoints(trees, rgb, bbox, { maxTrees: budget });
          if (nlcdCount === 0) treesSource = "imagery-rgb";
        }
      } catch (e) {
        /* keep NLCD points if any */
      }
    }
    let data;
    try {
      data = await exportOnce(trees, treesSource);
    } catch (e) {
      data = await exportOnce(trees, treesSource);
    }
    downloadBlob(b64ToBlob(data.zipBase64, "application/zip"), data.zipFilename || "openclutter.zip");
    const summary = (data.stats && data.stats.summary) || "";
    setStatus(
      "Import this zip in Hamina (Projects → Import → OpenIntent)." +
        (summary ? "\n" + summary : "")
    );
  } catch (err) {
    setStatus(err.message + " — try a smaller box.", true);
  } finally {
    exportBtn.disabled = false;
  }
};

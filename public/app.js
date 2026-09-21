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
  setStatus(`${Math.round(w)} × ${Math.round(h)} m — export uses this bbox for imagery, footprints, and clipboard meters.`);
  exportBtn.disabled = w > 2500 || h > 2500 || w < 40 || h < 40;
  if (exportBtn.disabled) setStatus("Area must be between 40 m and 2.5 km on a side.", true);
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
    setStatus(hit.display_name);
  } catch (err) {
    setStatus(err.message, true);
  }
};

function isVeg(r, g, b) {
  const s = r + g + b;
  if (s < 70 || s > 420) return false;
  if (b > 125 && b > g + 8) return false;
  if (r > 185 && g > 170) return false;
  const olive = g >= r - 18 && g > b + 4 && r > 38 && r < 160 && g > 42 && g < 145 && b < 110;
  const dusty = r >= g - 8 && r > b + 10 && r > 45 && r < 140 && g > 40 && g < 120 && b < 90 && g > r * 0.55;
  return olive || dusty;
}

async function detectTrees(b) {
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
  const step = 8;
  const hits = [];
  for (let y = step; y < h - step; y += step) {
    for (let x = step; x < w - step; x += step) {
      const i = (y * w + x) * 4;
      if (!isVeg(data[i], data[i + 1], data[i + 2])) continue;
      let ok = 0, n = 0;
      for (let dy = -4; dy <= 4; dy += 4) {
        for (let dx = -4; dx <= 4; dx += 4) {
          const j = ((y + dy) * w + (x + dx)) * 4;
          if (j < 0 || j >= data.length) continue;
          n++;
          if (isVeg(data[j], data[j + 1], data[j + 2])) ok++;
        }
      }
      if (n && ok / n >= 0.4) {
        hits.push({
          lon: b.west + (x / w) * (b.east - b.west),
          lat: b.north - (y / h) * (b.north - b.south),
        });
      }
    }
  }
  const cell = 0.00012;
  const seen = new Set();
  const out = [];
  for (const t of hits) {
    const k = Math.floor(t.lon / cell) + ":" + Math.floor(t.lat / cell);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= 180) break;
  }
  return out;
}

function parseControlPoints() {
  const raw = (document.getElementById("controlPoints").value || "").trim();
  if (!raw) return null;
  const pts = JSON.parse(raw);
  if (!Array.isArray(pts) || pts.length < 3) {
    throw new Error("Calibration needs 3+ control points {lon,lat,xM,yM}.");
  }
  return pts;
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

async function exportOnce(trees, controlPoints) {
  const r = await fetch("/api/clutter", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...bbox,
      name: document.getElementById("q").value || "Site",
      trees,
      osmTrees: document.getElementById("osmTrees").checked,
      format: "bundle",
      controlPoints: controlPoints || undefined,
    }),
  });
  const data = await r.json().catch(() => ({ error: r.status + " " + r.statusText }));
  if (!r.ok) throw new Error(data.error || "Export failed (" + r.status + ")");
  return data;
}

document.getElementById("export").onclick = async () => {
  if (!bbox) return;
  exportBtn.disabled = true;
  setStatus("Finding trees in the Esri aerial…");
  try {
    let controlPoints = null;
    try {
      controlPoints = parseControlPoints();
    } catch (e) {
      throw e;
    }
    let trees = [];
    try {
      trees = await detectTrees(bbox);
    } catch (e) {
      trees = [];
    }
    setStatus(`Found ${trees.length} vegetation points. Building zip + clipboard…`);
    let data;
    try {
      data = await exportOnce(trees, controlPoints);
    } catch (e) {
      setStatus("Retrying… " + e.message);
      data = await exportOnce(trees, controlPoints);
    }
    downloadBlob(b64ToBlob(data.zipBase64, "application/zip"), data.zipFilename || "openintent-clutter.zip");
    await new Promise((r) => setTimeout(r, 400));
    downloadBlob(
      new Blob([JSON.stringify(data.clipboard)], { type: "application/json" }),
      data.clipboardFilename || "hamina-clipboard.json"
    );
    const s = data.stats || {};
    const w = data.frame && Math.round(data.frame.widthM);
    const l = data.frame && Math.round(data.frame.lengthM);
    setStatus(
      `Downloaded map zip (${w} × ${l} m) and clipboard JSON.\n` +
        `${s.buildings || 0} buildings, ${s.trees || 0} trees` +
        (s.calibrated ? " (legacy calibration on)." : ".") +
        `\nImport the zip in Hamina first, then paste the JSON on the map.`
    );
  } catch (err) {
    setStatus(err.message + " — try a smaller box and export again.", true);
  } finally {
    exportBtn.disabled = false;
  }
};

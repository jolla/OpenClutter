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
  setStatus(`${Math.round(w)} × ${Math.round(h)} m`);
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

document.getElementById("export").onclick = async () => {
  if (!bbox) return;
  exportBtn.disabled = true;
  setStatus("Building OpenIntent zip…");
  try {
    const r = await fetch("/api/clutter", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...bbox, name: document.getElementById("q").value || "Site" }),
    });
    if (!r.ok) {
      const t = await r.json().catch(() => ({ error: r.statusText }));
      throw new Error(t.error || "Export failed");
    }
    const blob = await r.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "openintent-clutter.zip";
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus(`Downloaded ${Math.round(blob.size / 1024)} KB. Import the zip in Hamina.`);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    exportBtn.disabled = false;
  }
};

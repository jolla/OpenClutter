const UA = "openintent-clutter/0.2 (https://github.com/jolla/openintent-clutter)";
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }
function zipStore(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const crc = crc32(data);
    const local = Buffer.concat([
      Buffer.from("PK\x03\x04"), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data,
    ]);
    const central = Buffer.concat([
      Buffer.from("PK\x01\x02"), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), name,
    ]);
    locals.push(local); centrals.push(central); offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.concat([
    Buffer.from("PK\x05\x06"), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(central.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, central, end]);
}

function metersPerDeg(lat) {
  const rad = (lat * Math.PI) / 180;
  return { lon: 111320 * Math.cos(rad), lat: 110540 };
}
function xyz(x, y) {
  return { coordinate_xyz: { x: +x.toFixed(2), y: +y.toFixed(2), unit: "pixels" } };
}
function material(name, color, top, db, bottom) {
  const m = { name, display_color: color, top_height: top, rf_properties: { attenuation_per_m: db } };
  if (bottom != null) m.bottom_height = bottom;
  return m;
}
const MAT = {
  one: material("Building - One Floor", "#C4C4C4", 4.5, 5),
  five: material("Building - Five Floor", "#9A9A9A", 16, 5),
  ten: material("Building - Ten Floor", "#7A7A7A", 32, 5),
  tall: material("Building - Ten Floor", "#5A5A5A", 55, 2),
  fol: material("Foliage - Heavy", "#3F7D2A", 12, 2, 3.5),
  trunk: material("Tree Trunk", "#8B6B4F", 8, 10),
};
function llToPx(lon, lat, west, south, mpd, mpu) {
  return [((lon - west) * mpd.lon) / mpu, ((lat - south) * mpd.lat) / mpu];
}
function simplify(ring, minM, mpd) {
  if (ring.length < 5) return ring;
  const out = [ring[0]];
  let acc = 0;
  for (let i = 1; i < ring.length - 1; i++) {
    const a = out[out.length - 1], b = ring[i];
    acc += Math.hypot((b[0] - a[0]) * mpd.lon, (b[1] - a[1]) * mpd.lat);
    if (acc >= minM) { out.push(b); acc = 0; }
  }
  out.push(ring[ring.length - 1]);
  if (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1]) out.push(out[0]);
  return out.length >= 4 ? out : ring;
}
function ringAreaM2(ring, mpd) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const x0 = ring[i][0] * mpd.lon, y0 = ring[i][1] * mpd.lat;
    const x1 = ring[i + 1][0] * mpd.lon, y1 = ring[i + 1][1] * mpd.lat;
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}
function ringToArea(ring, west, south, mpd, mpu, imgW, imgH) {
  const coords = [];
  let on = 0;
  for (const [lon, lat] of ring) {
    let [x, y] = llToPx(lon, lat, west, south, mpd, mpu);
    if (x >= 0 && x <= imgW && y >= 0 && y <= imgH) on++;
    x = Math.max(-2, Math.min(imgW + 2, x));
    y = Math.max(-2, Math.min(imgH + 2, y));
    coords.push(xyz(x, y));
  }
  if (coords.length && (coords[0].coordinate_xyz.x !== coords[coords.length - 1].coordinate_xyz.x ||
      coords[0].coordinate_xyz.y !== coords[coords.length - 1].coordinate_xyz.y)) {
    coords.push(coords[0]);
  }
  return on >= 2 && coords.length >= 4 ? coords : null;
}
function pickBuildingMat(areaM2, heightM) {
  const h = heightM && heightM > 2 ? heightM : areaM2 >= 80000 ? 32 : areaM2 >= 25000 ? 16 : areaM2 >= 4000 ? 8 : 4.5;
  if (h >= 40) return { ...MAT.tall, top_height: Math.min(h, 80) };
  if (h >= 24) return { ...MAT.ten, top_height: h };
  if (h >= 10) return { ...MAT.five, top_height: h };
  return { ...MAT.one, top_height: Math.max(3.5, h) };
}
function circle(cx, cy, rPx, n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pts.push(xyz(cx + rPx * Math.cos(a), cy + rPx * Math.sin(a)));
  }
  pts.push(pts[0]);
  return pts;
}
async function overpassTrees(west, south, east, north) {
  const q = `[out:json][timeout:12];
(
  way["natural"="wood"](${south},${west},${north},${east});
  way["landuse"="forest"](${south},${west},${north},${east});
  way["leisure"="golf_course"](${south},${west},${north},${east});
  way["natural"="scrub"](${south},${west},${north},${east});
  node["natural"="tree"](${south},${west},${north},${east});
);
out geom qt;`;
  const r = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "user-agent": UA, "content-type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(q),
  });
  if (!r.ok) return { elements: [] };
  return r.json();
}
function json(status, cors, obj) {
  return { statusCode: status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors, body: "POST only" };
  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return json(400, cors, { error: "invalid json" }); }
  const west = +body.west, south = +body.south, east = +body.east, north = +body.north;
  if (![west, south, east, north].every(Number.isFinite)) return json(400, cors, { error: "west,south,east,north required" });
  if (east <= west || north <= south) return json(400, cors, { error: "bad bbox" });
  const mpd = metersPerDeg((south + north) / 2);
  const widthM = (east - west) * mpd.lon;
  const lengthM = (north - south) * mpd.lat;
  if (widthM > 2500 || lengthM > 2500) return json(400, cors, { error: "bbox too large (max 2.5 km)" });
  if (widthM < 40 || lengthM < 40) return json(400, cors, { error: "bbox too small" });
  let imgW = Math.round(widthM / 0.6);
  let imgH = Math.round(lengthM / 0.6);
  const maxSide = 3840;
  if (Math.max(imgW, imgH) > maxSide) {
    const k = maxSide / Math.max(imgW, imgH);
    imgW = Math.round(imgW * k);
    imgH = Math.round(imgH * k);
  }
  const mpu = widthM / imgW;
  const bbox = `${west},${south},${east},${north}`;
  const imgUrl = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export" +
    `?bbox=${bbox}&bboxSR=4326&imageSR=4326&size=${imgW},${imgH}&format=jpg&f=image`;
  const footprintsUrl = "https://services.arcgis.com/P3ePLMYs2RVChkJx/ArcGIS/rest/services/MSBFP2/FeatureServer/0/query" +
    "?f=geojson&returnGeometry=true&spatialRel=esriSpatialRelIntersects&geometryType=esriGeometryEnvelope" +
    "&inSR=4326&outSR=4326&outFields=*&resultRecordCount=2000" +
    `&geometry=${encodeURIComponent(JSON.stringify({ xmin: west, ymin: south, xmax: east, ymax: north, spatialReference: { wkid: 4326 } }))}`;
  let imgBuf, gj, osm;
  try {
    const [imgRes, fpRes, osmJ] = await Promise.all([
      fetch(imgUrl, { headers: { "user-agent": UA } }),
      fetch(footprintsUrl, { headers: { "user-agent": UA } }),
      overpassTrees(west, south, east, north),
    ]);
    if (!imgRes.ok) throw new Error("imagery " + imgRes.status);
    imgBuf = Buffer.from(await imgRes.arrayBuffer());
    if (!fpRes.ok) throw new Error("footprints " + fpRes.status);
    gj = await fpRes.json();
    osm = osmJ;
  } catch (e) {
    return json(502, cors, { error: String(e.message || e) });
  }
  const areas = [];
  for (const f of gj.features || []) {
    const g = f.geometry;
    if (!g) continue;
    const props = f.properties || {};
    const heightM = Number(props.height || props.Height || props.HEIGHT || props.building_height || 0);
    const polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
    for (const poly of polys) {
      const ring = simplify(poly[0] || [], 6, mpd);
      const coords = ringToArea(ring, west, south, mpd, mpu, imgW, imgH);
      if (!coords) continue;
      const am = ringAreaM2(ring, mpd);
      if (am < 40) continue;
      areas.push({ area: { coordinates: coords }, area_material: pickBuildingMat(am, heightM) });
    }
  }
  let treeN = 0;
  for (const el of osm.elements || []) {
    if (treeN > 180) break;
    if (el.type === "node" && el.lat) {
      const [x, y] = llToPx(el.lon, el.lat, west, south, mpd, mpu);
      if (x < 0 || y < 0 || x > imgW || y > imgH) continue;
      const r = 6 / mpu;
      areas.push({ area: { coordinates: circle(x, y, r * 1.1, 8) }, area_material: MAT.fol });
      areas.push({ area: { coordinates: circle(x, y, Math.max(1.2, r * 0.18), 6) }, area_material: MAT.trunk });
      treeN++;
    } else if (el.type === "way" && el.geometry && el.geometry.length >= 4) {
      const ring = el.geometry.map((p) => [p.lon, p.lat]);
      if (ring[0][0] !== ring[ring.length - 1][0]) ring.push(ring[0]);
      const coords = ringToArea(simplify(ring, 10, mpd), west, south, mpd, mpu, imgW, imgH);
      if (!coords) continue;
      areas.push({ area: { coordinates: coords }, area_material: MAT.fol });
      treeN++;
    }
  }
  const name = String(body.name || "Site").slice(0, 80);
  const slug = name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "Site";
  const imgName = `${slug}.jpg`;
  const oi = {
    openintent_version: "2.0.1",
    floorplans: [{
      name, project_name: name + " Clutter", rotation: 0, map_uri: "file://images/" + imgName,
      dimensions: [
        { width: imgW, length: imgH, height: 12, unit: "pixels" },
        { width: widthM, length: lengthM, height: 55, unit: "meters" },
        { width: widthM / 0.3048, length: lengthM / 0.3048, height: 55 / 0.3048, unit: "feet" },
      ],
      attenuation_areas: areas, wall_segments: [], coverage_areas: [], reference_markers: [], closets: [],
    }],
    area_materials: [MAT.one, MAT.five, MAT.ten, MAT.tall, MAT.fol, MAT.trunk],
    wall_materials: [], switches: [],
  };
  const zip = zipStore([
    { name: `openIntent_${slug}.json`, data: Buffer.from(JSON.stringify(oi)) },
    { name: "images/" + imgName, data: imgBuf },
    { name: "export-warnings.json", data: Buffer.from('{"errors":[],"warnings":[]}') },
  ]);
  return {
    statusCode: 200,
    headers: { ...cors, "content-type": "application/zip", "content-disposition": `attachment; filename="${slug}-openintent.zip"` },
    body: zip.toString("base64"),
    isBase64Encoded: true,
  };
};

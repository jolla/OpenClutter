const UA = "openintent-clutter/0.6.2 (https://github.com/jolla/openintent-clutter)";
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
function uuid() {
  const b = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) b[i] = (Math.random() * 256) | 0;
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function xyz(x, y) {
  return { coordinate_xyz: { x: +Math.max(0, x).toFixed(3), y: +Math.max(0, y).toFixed(3), unit: "pixels" } };
}
function material(name, color, top, db) {
  return { name, display_color: color, top_height: +top, rf_properties: { attenuation_per_m: db } };
}
const MAT = {
  one: material("Building - One Floor", "#C4C4C4", 4.5, 5),
  five: material("Building - Five Floor", "#9A9A9A", 16, 5),
  ten: material("Building - Ten Floor", "#7A7A7A", 32, 5),
};
function llToPx(lon, lat, west, south, mpd, mpu) {
  return [((lon - west) * mpd.lon) / mpu, ((lat - south) * mpd.lat) / mpu];
}
function ringCoords(pts, imgW, imgH) {
  if (!pts || pts.length < 3) return null;
  const step = Math.max(1, Math.ceil(pts.length / 20));
  const out = [];
  for (let i = 0; i < pts.length; i += step) {
    const x = Math.min(imgW, Math.max(0, pts[i][0]));
    const y = Math.min(imgH, Math.max(0, pts[i][1]));
    out.push(xyz(x, y));
  }
  const a = out[0].coordinate_xyz, b = out[out.length - 1].coordinate_xyz;
  if (a.x !== b.x || a.y !== b.y) out.push(out[0]);
  if (out.length < 4) return null;
  return out;
}
function pickMat(areaM2, heightM) {
  const h = heightM > 2 ? heightM : areaM2 >= 80000 ? 32 : areaM2 >= 25000 ? 16 : areaM2 >= 4000 ? 8 : 4.5;
  if (h >= 24) return { ...MAT.ten, top_height: Math.min(80, h) };
  if (h >= 10) return { ...MAT.five, top_height: h };
  return { ...MAT.one, top_height: Math.max(3.5, h) };
}
function json(status, cors, obj) {
  return { statusCode: status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(obj) };
}
async function fetchOk(url) {
  let last = "fetch failed";
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(6000) });
      if (r.ok) return r;
      last = "HTTP " + r.status;
    } catch (e) { last = String(e.message || e); }
  }
  throw new Error(last);
}

exports.handler = async (event) => {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors, body: "POST only" };
  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return json(400, cors, { error: "invalid json" }); }
  const west = +body.west, south = +body.south, east = +body.east, north = +body.north;
  if (![west, south, east, north].every(Number.isFinite)) return json(400, cors, { error: "bbox required" });
  if (east <= west || north <= south) return json(400, cors, { error: "bad bbox" });
  const mpd = metersPerDeg((south + north) / 2);
  const widthM = (east - west) * mpd.lon;
  const lengthM = (north - south) * mpd.lat;
  if (widthM > 2500 || lengthM > 2500) return json(400, cors, { error: "bbox too large (max 2.5 km)" });
  if (widthM < 40 || lengthM < 40) return json(400, cors, { error: "bbox too small" });
  let imgW = Math.round(widthM / 1.0);
  let imgH = Math.round(lengthM / 1.0);
  const maxSide = 1280;
  if (Math.max(imgW, imgH) > maxSide) {
    const k = maxSide / Math.max(imgW, imgH);
    imgW = Math.max(64, Math.round(imgW * k));
    imgH = Math.max(64, Math.round(imgH * k));
  }
  const mpu = widthM / imgW;
  const bbox = `${west},${south},${east},${north}`;
  const imgUrl = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export" +
    `?bbox=${bbox}&bboxSR=4326&imageSR=4326&size=${imgW},${imgH}&format=jpg&f=image`;
  const footprintsUrl = "https://services.arcgis.com/P3ePLMYs2RVChkJx/ArcGIS/rest/services/MSBFP2/FeatureServer/0/query" +
    "?f=geojson&returnGeometry=true&spatialRel=esriSpatialRelIntersects&geometryType=esriGeometryEnvelope" +
    "&inSR=4326&outSR=4326&outFields=*&resultRecordCount=300" +
    `&geometry=${encodeURIComponent(JSON.stringify({ xmin: west, ymin: south, xmax: east, ymax: north, spatialReference: { wkid: 4326 } }))}`;
  let imgBuf, gj;
  try {
    const [imgRes, fpRes] = await Promise.all([fetchOk(imgUrl), fetchOk(footprintsUrl)]);
    imgBuf = Buffer.from(await imgRes.arrayBuffer());
    if (imgBuf.length < 100 || imgBuf[0] !== 0xff || imgBuf[1] !== 0xd8) throw new Error("imagery not jpeg");
    gj = await fpRes.json();
  } catch (e) {
    return json(502, cors, { error: String(e.message || e) + " — Esri timed out, retry or draw a smaller box" });
  }
  const areas = [];
  for (const f of gj.features || []) {
    if (areas.length > 300) break;
    const g = f.geometry;
    if (!g) continue;
    const heightM = Number((f.properties || {}).height || (f.properties || {}).Height || 0) || 0;
    const polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
    for (const poly of polys) {
      const ring = poly[0] || [];
      const pts = [];
      for (const [lon, lat] of ring) {
        const [x, y] = llToPx(lon, lat, west, south, mpd, mpu);
        if (Number.isFinite(x) && Number.isFinite(y)) pts.push([x, y]);
      }
      if (pts.length < 3) continue;
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const am = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)) * mpu * mpu;
      if (am < 40) continue;
      const coords = ringCoords(pts, imgW, imgH);
      if (!coords) continue;
      areas.push({ area: { coordinates: coords }, area_material: pickMat(am, heightM) });
    }
  }
  const rawName = String(body.name || "Site").slice(0, 60);
  const name = rawName.replace(/[^\w \-]/g, "").trim() || "Site";
  const slug = name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "Site";
  const imgName = `${slug}.jpg`;
  const oi = {
    floorplans: [{
      name,
      project_name: name + " Clutter",
      floor_id: uuid(),
      rotation: 0,
      map_uri: "file://images/" + imgName,
      dimensions: [
        { width: imgW, length: imgH, height: 12, unit: "pixels" },
        { width: widthM, length: lengthM, height: 2.5, unit: "meters" },
        { width: widthM / 0.3048, length: lengthM / 0.3048, height: 8.202, unit: "feet" },
      ],
      attenuation_areas: areas,
      coverage_areas: [],
      reference_markers: [],
      closets: [],
    }],
    wall_materials: [],
    switches: [],
    openintent_version: "2.0.1",
  };
  const zip = zipStore([
    { name: `openIntent_${slug}.json`, data: Buffer.from(JSON.stringify(oi)) },
    { name: "images/" + imgName, data: imgBuf },
    { name: "export-warnings.json", data: Buffer.from('{"errors":[],"warnings":[]}') },
  ]);
  if (zip.length > 4500000) return json(413, cors, { error: "zip too large — draw a smaller box" });
  return {
    statusCode: 200,
    headers: {
      ...cors,
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${slug}-openintent.zip"`,
    },
    body: zip.toString("base64"),
    isBase64Encoded: true,
  };
};

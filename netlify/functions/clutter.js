const UA = "openintent-clutter/0.1 (https://github.com/jolla/openintent-clutter)";
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

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

function zipStore(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const crc = crc32(data);
    const local = Buffer.concat([
      Buffer.from("PK\x03\x04"),
      u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(name.length), u16(0), name, data,
    ]);
    const central = Buffer.concat([
      Buffer.from("PK\x01\x02"),
      u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.concat([
    Buffer.from("PK\x05\x06"), u16(0), u16(0),
    u16(files.length), u16(files.length), u32(central.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, central, end]);
}

function midLat(south, north) { return (south + north) / 2; }
function metersPerDeg(lat) {
  const rad = (lat * Math.PI) / 180;
  return { lon: 111320 * Math.cos(rad), lat: 110540 };
}
function xyz(x, y, unit) {
  return { coordinate_xyz: { x: +x.toFixed(3), y: +y.toFixed(3), unit } };
}
function box(x0, y0, x1, y1, unit) {
  return [xyz(x0, y0, unit), xyz(x1, y0, unit), xyz(x1, y1, unit), xyz(x0, y1, unit), xyz(x0, y0, unit)];
}
function material(name, color, top, db) {
  return { name, display_color: color, top_height: top, rf_properties: { attenuation_per_m: db } };
}
const MAT = {
  one: material("Building - One Floor", "#C4C4C4", 4.5, 5),
  five: material("Building - Five Floor", "#9A9A9A", 16, 5),
  hotel: material("Building - Ten Floor", "#7A7A7A", 32, 5),
};

exports.handler = async (event) => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors, body: "POST only" };
  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return json(400, cors, { error: "invalid json" }); }
  const { west, south, east, north } = body;
  if (![west, south, east, north].every((n) => Number.isFinite(+n))) {
    return json(400, cors, { error: "west,south,east,north required" });
  }
  if (east <= west || north <= south) return json(400, cors, { error: "bad bbox" });
  const lat0 = midLat(+south, +north);
  const mpd = metersPerDeg(lat0);
  const widthM = (+east - +west) * mpd.lon;
  const lengthM = (+north - +south) * mpd.lat;
  if (widthM > 2500 || lengthM > 2500) return json(400, cors, { error: "bbox too large (max 2.5 km)" });
  if (widthM < 40 || lengthM < 40) return json(400, cors, { error: "bbox too small" });
  const scale = 0.6;
  let imgW = Math.round(widthM / scale);
  let imgH = Math.round(lengthM / scale);
  const maxSide = 3840;
  if (imgW > maxSide || imgH > maxSide) {
    const k = maxSide / Math.max(imgW, imgH);
    imgW = Math.round(imgW * k);
    imgH = Math.round(imgH * k);
  }
  const mpu = widthM / imgW;
  const bbox = `${west},${south},${east},${north}`;
  const imgUrl =
    "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export" +
    `?bbox=${bbox}&bboxSR=4326&imageSR=4326&size=${imgW},${imgH}&format=jpg&f=image&transparent=false`;
  const footprintsUrl =
    "https://services.arcgis.com/P3ePLMYs2RVChkJx/ArcGIS/rest/services/MSBFP2/FeatureServer/0/query" +
    `?f=geojson&returnGeometry=true&spatialRel=esriSpatialRelIntersects&geometryType=esriGeometryEnvelope` +
    `&inSR=4326&outSR=4326&outFields=*&resultRecordCount=2000` +
    `&geometry=${encodeURIComponent(JSON.stringify({ xmin: +west, ymin: +south, xmax: +east, ymax: +north, spatialReference: { wkid: 4326 } }))}`;
  let imgBuf, gj;
  try {
    const [imgRes, fpRes] = await Promise.all([
      fetch(imgUrl, { headers: { "user-agent": UA } }),
      fetch(footprintsUrl, { headers: { "user-agent": UA } }),
    ]);
    if (!imgRes.ok) throw new Error("imagery " + imgRes.status);
    imgBuf = Buffer.from(await imgRes.arrayBuffer());
    if (!fpRes.ok) throw new Error("footprints " + fpRes.status);
    gj = await fpRes.json();
  } catch (e) {
    return json(502, cors, { error: String(e.message || e) });
  }
  const areas = [];
  for (const f of gj.features || []) {
    const g = f.geometry;
    if (!g) continue;
    const polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
    for (const poly of polys) {
      const ring = poly[0] || [];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [lon, lat] of ring) {
        const x = ((lon - west) * mpd.lon) / mpu;
        const y = ((lat - south) * mpd.lat) / mpu;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      if (maxX < 0 || minX > imgW || maxY < 0 || minY > imgH) continue;
      minX = Math.max(0, minX);
      minY = Math.max(0, minY);
      maxX = Math.min(imgW, maxX);
      maxY = Math.min(imgH, maxY);
      if (maxX - minX < 4 || maxY - minY < 4) continue;
      const am = (maxX - minX) * (maxY - minY) * mpu * mpu;
      const mat = am >= 80000 ? MAT.hotel : am >= 25000 ? MAT.five : MAT.one;
      areas.push({ area: { coordinates: box(minX, minY, maxX, maxY, "pixels") }, area_material: mat });
    }
  }
  const name = String(body.name || "Site").slice(0, 80);
  const slug = name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "Site";
  const imgName = `${slug}.jpg`;
  const oi = {
    openintent_version: "2.0.1",
    floorplans: [{
      name,
      project_name: name + " Clutter",
      rotation: 0,
      map_uri: "file://images/" + imgName,
      dimensions: [
        { width: imgW, length: imgH, height: 12, unit: "pixels" },
        { width: widthM, length: lengthM, height: 32, unit: "meters" },
        { width: widthM / 0.3048, length: lengthM / 0.3048, height: 32 / 0.3048, unit: "feet" },
      ],
      attenuation_areas: areas,
      wall_segments: [],
      coverage_areas: [],
      reference_markers: [],
      closets: [],
    }],
    area_materials: [MAT.one, MAT.five, MAT.hotel],
    wall_materials: [],
    switches: [],
  };
  const zip = zipStore([
    { name: `openIntent_${slug}.json`, data: Buffer.from(JSON.stringify(oi)) },
    { name: "images/" + imgName, data: imgBuf },
    { name: "export-warnings.json", data: Buffer.from('{"errors":[],"warnings":[]}') },
  ]);
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

function json(status, cors, obj) {
  return { statusCode: status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(obj) };
}

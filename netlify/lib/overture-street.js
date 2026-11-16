"use strict";

/**
 * Overture transportation and base themes as Overpass-shaped elements.
 *
 * Same free Azure GeoParquet path as buildings (release pinned in overture.js),
 * with a committed row-group bbox index. source_tags are copied when present.
 * A class is mapped only when it matches a tag OpenClutter already reads from
 * OSM. Unknown or unused classes are left out (precision over recall).
 */

const zlib = require("node:zlib");
const packed = require("./overture-street-rg-data");
const { RELEASE } = require("./overture");

const AZURE_ROOT = "https://overturemapswestus2.blob.core.windows.net/release/" + RELEASE + "/";
const GROUP_STRIDE = 26;
const STREET_DEADLINE_MS = 15000;
const THEME_CONCURRENCY = 5;
const GROUP_READ_CONCURRENCY = 4;

const THEMES = [
  { key: "infrastructure", theme: "base", type: "infrastructure", columns: ["id", "class", "subtype", "height", "level", "names", "source_tags", "bbox", "geometry"] },
  { key: "water", theme: "base", type: "water", columns: ["id", "class", "subtype", "names", "source_tags", "bbox", "geometry"] },
  { key: "land_use", theme: "base", type: "land_use", columns: ["id", "class", "subtype", "names", "source_tags", "bbox", "geometry"] },
  { key: "land", theme: "base", type: "land", columns: ["id", "class", "subtype", "names", "source_tags", "bbox", "geometry"] },
  { key: "segment", theme: "transportation", type: "segment", columns: ["id", "subtype", "class", "road_flags", "rail_flags", "level_rules", "names", "bbox", "geometry"] },
];

const BARRIER_CLASS = { fence: "fence", wall: "wall", retaining_wall: "retaining_wall", hedge: "hedge", city_wall: "city_wall" };
const ROAD_CLASS = {
  motorway: true,
  trunk: true,
  primary: true,
  secondary: true,
  tertiary: true,
  residential: true,
  living_street: true,
  service: true,
  track: true,
  unclassified: true,
  pedestrian: true,
};
const RAIL_CLASS = { monorail: true, light_rail: true, subway: true, rail: true, tram: true };
const WATER_CLASS = {
  lake: "lake",
  pond: "pond",
  reservoir: "reservoir",
  lagoon: "lagoon",
  basin: "basin",
  river: "river",
  stream: "stream",
  canal: "canal",
  oxbow: "oxbow",
  wastewater: "wastewater",
  moat: "moat",
  ditch: "ditch",
  spring: "spring",
  reef: "reef",
  ocean: "ocean",
  sea: "sea",
};

const cache = {};

function parsedThemeIndex(key) {
  if (cache[key]) return cache[key];
  const b64 = packed[key];
  if (!b64) throw new Error("no Overture street index for " + key);
  const buf = zlib.gunzipSync(Buffer.from(b64, "base64"));
  if (buf.toString("ascii", 0, 4) !== "OVR1") throw new Error("bad overture street index " + key);
  let o = 4;
  const version = buf.readUInt16LE(o);
  o += 2;
  if (version !== 1) throw new Error("overture street index version " + version);
  const fileCount = buf.readUInt16LE(o);
  o += 2;
  const groupCount = buf.readUInt32LE(o);
  o += 4;
  const relLen = buf.readUInt16LE(o);
  o += 2;
  const release = buf.toString("utf8", o, o + relLen);
  o += relLen;
  const files = new Array(fileCount);
  for (let i = 0; i < fileCount; i++) {
    const n = buf.readUInt16LE(o);
    o += 2;
    files[i] = buf.toString("utf8", o, o + n);
    o += n;
  }
  cache[key] = { buf, files, groupStart: o, groupCount, release };
  return cache[key];
}

function groupsForThemeBbox(key, bbox) {
  const idx = parsedThemeIndex(key);
  const w = +bbox.west;
  const s = +bbox.south;
  const e = +bbox.east;
  const n = +bbox.north;
  const hits = [];
  const { buf, files, groupStart, groupCount } = idx;
  for (let i = 0; i < groupCount; i++) {
    const p = groupStart + i * GROUP_STRIDE;
    const xmin = buf.readFloatLE(p + 10);
    const ymin = buf.readFloatLE(p + 14);
    const xmax = buf.readFloatLE(p + 18);
    const ymax = buf.readFloatLE(p + 22);
    if (xmax < w || xmin > e || ymax < s || ymin > n) continue;
    hits.push({
      file: files[buf.readUInt16LE(p)],
      rowStart: buf.readUInt32LE(p + 2),
      rowCount: buf.readUInt32LE(p + 6),
      xmin,
      ymin,
      xmax,
      ymax,
    });
  }
  return hits;
}

function sourceTagsOf(row) {
  const raw = row && row.source_tags;
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === "object") return raw;
  return {};
}

function copyNameAndHeight(tags, row) {
  const primary = row && row.names && (row.names.primary || (row.names.common && row.names.common.en));
  if (primary && !tags.name) tags.name = String(primary);
  const h = Number(row && row.height);
  if (h > 0 && !tags.height) tags.height = String(h);
}

function takeTag(src, key) {
  if (!src) return "";
  const v = src[key];
  if (v == null || v === "") return "";
  return String(v);
}

function tagsFromInfrastructure(row) {
  const src = sourceTagsOf(row);
  const tags = {};
  const barrier = takeTag(src, "barrier");
  if (BARRIER_CLASS[barrier] || barrier === "city_wall") tags.barrier = barrier;
  const cls = String(row && row.class || "");
  if (!tags.barrier && BARRIER_CLASS[cls]) tags.barrier = BARRIER_CLASS[cls];
  if (takeTag(src, "highway") === "street_lamp" || cls === "street_lamp") tags.highway = "street_lamp";
  const made = takeTag(src, "man_made");
  if (made === "lighting" || made === "pole" || made === "mast" || made === "bridge" || made === "pier") tags.man_made = made;
  if (!tags.man_made && cls === "lighting") tags.man_made = "lighting";
  if (!tags.man_made && (cls === "bridge" || cls === "viaduct")) {
    tags.man_made = "bridge";
    if (cls === "viaduct") tags.bridge = "viaduct";
  }
  if (!tags.man_made && cls === "pier") tags.man_made = "pier";
  if (takeTag(src, "amenity") === "parking" || takeTag(src, "building") === "parking" || cls === "parking") {
    if (takeTag(src, "amenity") === "parking") tags.amenity = "parking";
    else if (takeTag(src, "building") === "parking") tags.building = "parking";
    else tags.amenity = "parking";
    const parking = takeTag(src, "parking");
    if (parking) tags.parking = parking;
  }
  const tourism = takeTag(src, "tourism");
  if (tourism === "camp_site" || tourism === "caravan_site") tags.tourism = tourism;
  if (!tags.tourism && cls === "camp_site") tags.tourism = "camp_site";
  const height = takeTag(src, "height");
  if (height) tags.height = height;
  copyNameAndHeight(tags, row);
  if (row && row.level != null && Number(row.level) !== 0 && !tags.layer) tags.layer = String(row.level);
  if (tags.barrier || tags.highway === "street_lamp" || tags.man_made || tags.amenity === "parking" || tags.building === "parking" || tags.tourism) {
    return tags;
  }
  return null;
}

function tagsFromWater(row) {
  const src = sourceTagsOf(row);
  const tags = {};
  const natural = takeTag(src, "natural");
  if (natural === "water" || natural === "coastline") tags.natural = natural;
  const waterway = takeTag(src, "waterway");
  if (waterway) tags.waterway = waterway;
  const water = takeTag(src, "water");
  if (water) tags.water = water;
  const landuse = takeTag(src, "landuse");
  if (landuse === "reservoir") tags.landuse = "reservoir";
  const cls = String(row && row.class || "");
  if (!tags.natural && !tags.water && !tags.waterway && !tags.landuse) {
    if (cls === "stream") tags.waterway = "stream";
    else if (cls === "reservoir") tags.landuse = "reservoir";
    else if (WATER_CLASS[cls]) {
      tags.natural = "water";
      if (cls !== "ocean" && cls !== "sea" && cls !== "lake" && cls !== "pond") tags.water = WATER_CLASS[cls];
      else if (cls === "lake" || cls === "pond") tags.water = cls;
    }
  }
  copyNameAndHeight(tags, row);
  if (tags.natural === "water" || tags.natural === "coastline" || tags.waterway || tags.water || tags.landuse === "reservoir") return tags;
  return null;
}

function tagsFromLand(row) {
  const src = sourceTagsOf(row);
  const tags = {};
  const natural = takeTag(src, "natural");
  if (natural === "wood" || natural === "tree") tags.natural = natural;
  const landuse = takeTag(src, "landuse");
  if (landuse === "forest") tags.landuse = "forest";
  if (takeTag(src, "leaf_type")) tags.leaf_type = takeTag(src, "leaf_type");
  if (takeTag(src, "genus")) tags.genus = takeTag(src, "genus");
  if (takeTag(src, "species")) tags.species = takeTag(src, "species");
  if (takeTag(src, "taxon")) tags.taxon = takeTag(src, "taxon");
  const cls = String(row && row.class || "");
  // Only accept a class mapping when source_tags confirm the OSM feature.
  // A bare class=forest can be a generalized protected area, not a mapped wood.
  if (!tags.natural && !tags.landuse) {
    if (cls === "wood" && natural === "wood") tags.natural = "wood";
    if (cls === "tree" && natural === "tree") tags.natural = "tree";
  }
  copyNameAndHeight(tags, row);
  if (tags.natural === "wood" || tags.natural === "tree" || tags.landuse === "forest") return tags;
  return null;
}

function tagsFromLandUse(row) {
  const src = sourceTagsOf(row);
  const tags = {};
  const landuse = takeTag(src, "landuse");
  if (landuse === "forest" || landuse === "winter_sports" || landuse === "harbour") tags.landuse = landuse;
  if (takeTag(src, "natural") === "wood") tags.natural = "wood";
  if (takeTag(src, "piste:type") === "downhill") tags["piste:type"] = "downhill";
  const tourism = takeTag(src, "tourism");
  if (tourism === "camp_site" || tourism === "caravan_site") tags.tourism = tourism;
  const leisure = takeTag(src, "leisure");
  if (leisure === "marina") tags.leisure = "marina";
  const cls = String(row && row.class || "");
  if (!tags.landuse && !tags.natural && !tags["piste:type"] && !tags.tourism && !tags.leisure) {
    // Confirmed OSM tags only. class=forest without source_tags stays out.
    if (cls === "downhill" && takeTag(src, "piste:type")) tags["piste:type"] = "downhill";
    if (cls === "camp_site" && (tourism === "camp_site" || tourism === "caravan_site")) tags.tourism = tourism || "camp_site";
  }
  copyNameAndHeight(tags, row);
  if (tags.landuse === "forest" || tags.landuse === "winter_sports" || tags.landuse === "harbour" || tags.natural === "wood" || tags["piste:type"] === "downhill" || tags.tourism || tags.leisure === "marina") {
    return tags;
  }
  return null;
}

function flagValues(flags) {
  const out = [];
  const walk = (v) => {
    if (!v) return;
    if (typeof v === "string") {
      out.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) walk(v[i]);
      return;
    }
    if (typeof v === "object") {
      if (Array.isArray(v.values)) walk(v.values);
      if (v.value) walk(v.value);
      if (v.flag) walk(v.flag);
    }
  };
  walk(flags);
  return out;
}

function levelFromRules(rules) {
  if (rules == null) return null;
  const list = Array.isArray(rules) ? rules : [rules];
  let best = null;
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    const v = r && typeof r === "object" ? Number(r.value != null ? r.value : r.level) : Number(r);
    if (!Number.isFinite(v)) continue;
    if (best == null || Math.abs(v) > Math.abs(best)) best = v;
  }
  return best;
}

function tagsFromSegment(row) {
  const tags = {};
  const subtype = String(row && row.subtype || "");
  const cls = String(row && row.class || "");
  const flags = flagValues(row && row.road_flags);
  const railFlags = flagValues(row && row.rail_flags);
  const isLink = flags.indexOf("is_link") >= 0;
  const isBridge = flags.indexOf("is_bridge") >= 0;
  const isTunnel = flags.indexOf("is_tunnel") >= 0;
  if (subtype === "rail" || RAIL_CLASS[cls]) {
    const rail = RAIL_CLASS[cls] ? cls : "";
    if (!rail) return null;
    tags.railway = rail;
  } else {
    let hwy = ROAD_CLASS[cls] ? cls : "";
    if (!hwy && cls === "unknown" && subtype === "road") hwy = "unclassified";
    if (!hwy && (isBridge || Number(levelFromRules(row && row.level_rules)) >= 1) && subtype === "road") hwy = "unclassified";
    if (!hwy) return null;
    if (isLink && (hwy === "motorway" || hwy === "trunk" || hwy === "primary" || hwy === "secondary" || hwy === "tertiary")) {
      tags.highway = hwy + "_link";
    } else {
      tags.highway = hwy;
    }
  }
  if (isBridge) tags.bridge = "yes";
  if (isTunnel) tags.tunnel = "yes";
  const level = levelFromRules(row && row.level_rules);
  if (level != null && level !== 0) tags.layer = String(level);
  void railFlags;
  copyNameAndHeight(tags, row);
  return tags;
}

function tagsForTheme(key, row) {
  if (key === "infrastructure") return tagsFromInfrastructure(row);
  if (key === "water") return tagsFromWater(row);
  if (key === "land_use") return tagsFromLandUse(row);
  if (key === "land") return tagsFromLand(row);
  if (key === "segment") return tagsFromSegment(row);
  return null;
}

function asGeometry(value) {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return wkbToGeom(Buffer.from(value, "utf8")) || null;
    }
  }
  if (value.type && value.coordinates) return value;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return wkbToGeom(value);
  if (value.buffer && value.byteLength != null) return wkbToGeom(Buffer.from(value));
  if (value.wkb) return wkbToGeom(value.wkb);
  return null;
}

function wkbToGeom(input) {
  try {
    const b = Buffer.isBuffer(input) ? input : Buffer.from(input);
    let o = 0;
    const read = () => readGeom();
    function readGeom() {
      if (o + 5 > b.length) return null;
      const le = u8() === 1;
      let typ = u32(le);
      let hasZ = false;
      if (typ & 0x20000000) {
        typ &= ~0x20000000;
        o += 4;
      }
      if (typ & 0x80000000) {
        typ &= ~0x80000000;
        hasZ = true;
      }
      if (typ & 0x40000000) typ &= ~0x40000000;
      if (typ > 1000 && typ < 2000) {
        typ -= 1000;
        hasZ = true;
      }
      if (typ === 1) return { type: "Point", coordinates: point(hasZ) };
      if (typ === 2) return { type: "LineString", coordinates: line(hasZ) };
      if (typ === 3) return { type: "Polygon", coordinates: polygon(hasZ) };
      if (typ === 4) return { type: "MultiPoint", coordinates: multi(hasZ, () => point(hasZ)) };
      if (typ === 5) return { type: "MultiLineString", coordinates: multi(hasZ, () => line(hasZ)) };
      if (typ === 6) return { type: "MultiPolygon", coordinates: multi(hasZ, () => polygon(hasZ)) };
      if (typ === 7) {
        const n = u32(le);
        const geoms = [];
        for (let i = 0; i < n; i++) {
          const g = readGeom();
          if (g) geoms.push(g);
        }
        return { type: "GeometryCollection", geometries: geoms };
      }
      return null;
    }
    function u8() {
      return b[o++];
    }
    function u32(le) {
      const v = le ? b.readUInt32LE(o) : b.readUInt32BE(o);
      o += 4;
      return v;
    }
    function f64(le) {
      const v = le !== false ? b.readDoubleLE(o) : b.readDoubleBE(o);
      o += 8;
      return v;
    }
    function point(hasZ) {
      const x = f64(true);
      const y = f64(true);
      if (hasZ) o += 8;
      return [x, y];
    }
    function line(hasZ) {
      const n = u32(true);
      const pts = [];
      for (let i = 0; i < n; i++) pts.push(point(hasZ));
      return pts;
    }
    function polygon(hasZ) {
      const n = u32(true);
      const rings = [];
      for (let i = 0; i < n; i++) rings.push(line(hasZ));
      return rings;
    }
    function multi(hasZ, fn) {
      const n = u32(true);
      const out = [];
      for (let i = 0; i < n; i++) {
        // Each part is a full WKB geometry.
        const g = read();
        if (!g) continue;
        out.push(g.coordinates);
      }
      void hasZ;
      return out;
    }
    return readGeom();
  } catch {
    return null;
  }
}

function ptToGeom(pt) {
  return { lon: +pt[0], lat: +pt[1] };
}

function closeRing(ring) {
  if (!ring || ring.length < 3) return ring;
  const a = ring[0];
  const b = ring[ring.length - 1];
  if (a && b && a[0] === b[0] && a[1] === b[1]) return ring;
  return ring.concat([a]);
}

function bboxHitsCoords(coords, bbox) {
  if (!bbox || !coords || !coords.length) return !bbox;
  const w = +bbox.west;
  const s = +bbox.south;
  const e = +bbox.east;
  const n = +bbox.north;
  for (let i = 0; i < coords.length; i++) {
    const x = +coords[i][0];
    const y = +coords[i][1];
    if (x >= w && x <= e && y >= s && y <= n) return true;
  }
  for (let i = 1; i < coords.length; i++) {
    if (segmentHitsBox(coords[i - 1], coords[i], w, s, e, n)) return true;
  }
  if (coords.length >= 4) {
    const closed = coords[0][0] === coords[coords.length - 1][0] && coords[0][1] === coords[coords.length - 1][1];
    if (closed && pointInRing([(w + e) / 2, (s + n) / 2], coords)) return true;
  }
  return false;
}

function segmentHitsBox(a, b, w, s, e, n) {
  const ax = +a[0];
  const ay = +a[1];
  const bx = +b[0];
  const by = +b[1];
  if (Math.max(ax, bx) < w || Math.min(ax, bx) > e || Math.max(ay, by) < s || Math.min(ay, by) > n) return false;
  if (ax >= w && ax <= e && ay >= s && ay <= n) return true;
  if (bx >= w && bx <= e && by >= s && by <= n) return true;
  return (
    crosses(ax, ay, bx, by, w, s, w, n) ||
    crosses(ax, ay, bx, by, e, s, e, n) ||
    crosses(ax, ay, bx, by, w, s, e, s) ||
    crosses(ax, ay, bx, by, w, n, e, n)
  );
}

function crosses(ax, ay, bx, by, cx, cy, dx, dy) {
  const d = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  if (d === 0) return false;
  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / d;
  const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = +ring[i][0];
    const yi = +ring[i][1];
    const xj = +ring[j][0];
    const yj = +ring[j][1];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi || 1e-16) + xi) inside = !inside;
  }
  return inside;
}

function rowInBbox(row, bbox) {
  const b = row && row.bbox;
  if (!bbox || !b) return true;
  const xmin = b.xmin;
  const xmax = b.xmax;
  const ymin = b.ymin;
  const ymax = b.ymax;
  if ([xmin, xmax, ymin, ymax].some((v) => v == null)) return true;
  return xmax >= +bbox.west && xmin <= +bbox.east && ymax >= +bbox.south && ymin <= +bbox.north;
}

function elementsFromGeometry(idBase, tags, geom, bbox) {
  if (!geom || !tags) return [];
  const out = [];
  function emitWay(coords, suffix) {
    if (!coords || coords.length < 2) return;
    if (bbox && !bboxHitsCoords(coords, bbox)) return;
    out.push({
      type: "way",
      id: idBase + (suffix || ""),
      tags,
      geometry: coords.map(ptToGeom),
    });
  }
  function emitNode(pt, suffix) {
    if (!pt) return;
    const lon = +pt[0];
    const lat = +pt[1];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    if (bbox && (lon < +bbox.west || lon > +bbox.east || lat < +bbox.south || lat > +bbox.north)) return;
    out.push({ type: "node", id: idBase + (suffix || ""), lon, lat, tags });
  }
  function emitPolygon(rings, suffix) {
    if (!rings || !rings[0] || rings[0].length < 4) return;
    const outer = closeRing(rings[0]);
    if (bbox && !bboxHitsCoords(outer, bbox) && !bboxHitsCoords(closeRing(rings[0]), bbox)) {
      // Covered box: all vertices outside but the ring contains the draw.
      if (!pointInRing([(+bbox.west + +bbox.east) / 2, (+bbox.south + +bbox.north) / 2], outer)) return;
    }
    if (rings.length === 1) {
      emitWay(outer, suffix);
      return;
    }
    const members = [];
    members.push({ type: "way", role: "outer", geometry: outer.map(ptToGeom) });
    for (let i = 1; i < rings.length; i++) {
      if (rings[i] && rings[i].length >= 4) members.push({ type: "way", role: "inner", geometry: closeRing(rings[i]).map(ptToGeom) });
    }
    out.push({ type: "relation", id: idBase + (suffix || ""), tags, members });
  }
  const t = geom.type;
  const c = geom.coordinates;
  if (t === "Point") emitNode(c);
  else if (t === "MultiPoint") {
    for (let i = 0; i < (c || []).length; i++) emitNode(c[i], "-" + i);
  } else if (t === "LineString") emitWay(c);
  else if (t === "MultiLineString") {
    for (let i = 0; i < (c || []).length; i++) emitWay(c[i], "-" + i);
  } else if (t === "Polygon") emitPolygon(c);
  else if (t === "MultiPolygon") {
    for (let i = 0; i < (c || []).length; i++) emitPolygon(c[i], "-" + i);
  } else if (t === "GeometryCollection") {
    const geoms = geom.geometries || [];
    for (let i = 0; i < geoms.length; i++) {
      const more = elementsFromGeometry(idBase + "-g" + i, tags, geoms[i], bbox);
      for (let k = 0; k < more.length; k++) out.push(more[k]);
    }
  }
  return out;
}

function elementsFromRows(key, rows, bbox) {
  const out = [];
  const list = rows || [];
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    if (!rowInBbox(row, bbox)) continue;
    const tags = tagsForTheme(key, row);
    if (!tags) continue;
    const geom = asGeometry(row.geometry);
    if (!geom) continue;
    const id = String(row.id || "ovt-" + key + "-" + i);
    const els = elementsFromGeometry(id, tags, geom, bbox);
    for (let k = 0; k < els.length; k++) out.push(els[k]);
  }
  return out;
}

function isAbortError(err) {
  if (!err) return false;
  if (err.name === "AbortError") return true;
  return /abort|timeout/i.test(String(err.message || err));
}

function loadReader() {
  const hp = require("hyparquet");
  const comp = require("hyparquet-compressors");
  return {
    asyncBufferFromUrl: hp.asyncBufferFromUrl,
    parquetReadObjects: hp.parquetReadObjects,
    compressors: comp.compressors,
  };
}

function bboxRowFilter(bbox) {
  return {
    $and: [
      { "bbox.xmax": { $gte: +bbox.west } },
      { "bbox.xmin": { $lte: +bbox.east } },
      { "bbox.ymax": { $gte: +bbox.south } },
      { "bbox.ymin": { $lte: +bbox.north } },
    ],
  };
}

async function poolMap(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const n = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

async function readTheme(theme, bbox, reader, signal) {
  const groups = groupsForThemeBbox(theme.key, bbox);
  if (!groups.length) return [];
  const byFile = new Map();
  for (const g of groups) {
    if (!byFile.has(g.file)) byFile.set(g.file, []);
    byFile.get(g.file).push(g);
  }
  const rows = [];
  const filter = bboxRowFilter(bbox);
  const files = [...byFile.entries()];
  await poolMap(files, GROUP_READ_CONCURRENCY, async ([file, gs]) => {
    if (signal && signal.aborted) throw new Error("The operation was aborted due to timeout");
    const url = AZURE_ROOT + "theme=" + theme.theme + "/type=" + theme.type + "/" + file;
    const source = await reader.asyncBufferFromUrl({ url, requestInit: { signal } });
    for (const g of gs) {
      if (signal && signal.aborted) throw new Error("The operation was aborted due to timeout");
      const base = {
        file: source,
        compressors: reader.compressors,
        columns: theme.columns,
        rowStart: g.rowStart,
        rowEnd: g.rowStart + g.rowCount,
      };
      let got;
      try {
        got = await reader.parquetReadObjects({ ...base, filter, usePageIndex: true });
      } catch (e) {
        if (signal && signal.aborted || isAbortError(e)) throw e;
        got = await reader.parquetReadObjects(base);
      }
      for (let i = 0; i < (got || []).length; i++) rows.push(got[i]);
    }
  });
  return rows;
}

/**
 * @returns {Promise<{ok:boolean, elements:object[], notes:string[], themes:object}>}
 */
async function fetchOvertureStreet(bbox, opts) {
  const o = opts || {};
  const box = { west: +bbox.west, south: +bbox.south, east: +bbox.east, north: +bbox.north };
  const deadlineMs = o.deadlineMs > 0 ? o.deadlineMs : STREET_DEADLINE_MS;
  const parent = o.signal;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deadlineMs);
  const onParent = () => ctrl.abort();
  if (parent) {
    if (parent.aborted) ctrl.abort();
    else parent.addEventListener("abort", onParent, { once: true });
  }
  const reader = o.reader || loadReader();
  try {
    const results = await poolMap(THEMES, THEME_CONCURRENCY, async (theme) => {
      const rows = await readTheme(theme, box, reader, ctrl.signal);
      return { key: theme.key, rows, elements: elementsFromRows(theme.key, rows, box) };
    });
    const elements = [];
    const themes = {};
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      themes[r.key] = r.elements.length;
      for (let k = 0; k < r.elements.length; k++) elements.push(r.elements[k]);
    }
    return { ok: true, elements, notes: [], themes, release: packed.release || RELEASE };
  } catch (e) {
    return { ok: false, elements: [], notes: [], error: String(e && e.message ? e.message : e) };
  } finally {
    clearTimeout(timer);
    if (parent) parent.removeEventListener("abort", onParent);
  }
}

module.exports = {
  RELEASE,
  STREET_DEADLINE_MS,
  THEMES,
  groupsForThemeBbox,
  parsedThemeIndex,
  sourceTagsOf,
  tagsFromInfrastructure,
  tagsFromWater,
  tagsFromLand,
  tagsFromLandUse,
  tagsFromSegment,
  flagValues,
  levelFromRules,
  asGeometry,
  wkbToGeom,
  bboxHitsCoords,
  elementsFromGeometry,
  elementsFromRows,
  fetchOvertureStreet,
};

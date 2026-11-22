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
const { isTransientRangeError } = require("./parquet-cache");

const AZURE_ROOT = "https://overturemapswestus2.blob.core.windows.net/release/" + RELEASE + "/";
const GROUP_STRIDE = 26;
const STREET_DEADLINE_MS = 30000;
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

function parseBetween(raw) {
  if (raw == null) return null;
  const pair = Array.isArray(raw) ? raw : Array.isArray(raw.values) ? raw.values : null;
  if (!pair || pair.length < 2) return null;
  const a = Number(pair[0]);
  const b = Number(pair[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (hi - lo <= 0) return null;
  return [lo, hi];
}

function coversFull(between) {
  if (!between) return true;
  return between[0] <= 0.001 && between[1] >= 0.999;
}

function rangesOverlap(a, b) {
  if (!a || !b) return true;
  return a[0] < b[1] && b[0] < a[1];
}

function mergeRanges(list) {
  const raw = (list || []).filter((r) => r && r.length >= 2 && r[1] > r[0]);
  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1e-6) {
      last[1] = Math.max(last[1], r[1]);
    } else {
      out.push([r[0], r[1]]);
    }
  }
  return out;
}

function normalizeFlagRules(flags) {
  const out = [];
  const walk = (v, between) => {
    if (!v) return;
    if (typeof v === "string") {
      out.push({ values: [v], between: between || null });
      return;
    }
    if (Array.isArray(v)) {
      const allStr = v.every((x) => typeof x === "string");
      if (allStr) {
        if (v.length) out.push({ values: v.slice(), between: between || null });
        return;
      }
      for (let i = 0; i < v.length; i++) walk(v[i], between);
      return;
    }
    if (typeof v === "object") {
      const next = parseBetween(v.between) || between || null;
      if (Array.isArray(v.values) || v.value || v.flag) {
        const values = [];
        const take = (src) => {
          if (!src) return;
          if (typeof src === "string") values.push(src);
          else if (Array.isArray(src)) {
            for (let i = 0; i < src.length; i++) if (typeof src[i] === "string") values.push(src[i]);
          }
        };
        take(v.values);
        take(v.value);
        take(v.flag);
        if (values.length) out.push({ values, between: next });
        return;
      }
    }
  };
  walk(flags, null);
  return out;
}

function flagCoversFull(flags, name) {
  const rules = normalizeFlagRules(flags);
  for (let i = 0; i < rules.length; i++) {
    if (rules[i].values.indexOf(name) >= 0 && coversFull(rules[i].between)) return true;
  }
  return false;
}

function flagRanges(flags, name) {
  const out = [];
  const rules = normalizeFlagRules(flags);
  for (let i = 0; i < rules.length; i++) {
    if (rules[i].values.indexOf(name) < 0) continue;
    const b = rules[i].between;
    out.push(b ? [b[0], b[1]] : [0, 1]);
  }
  return mergeRanges(out);
}

function normalizeLevelRules(rules) {
  if (rules == null) return [];
  const list = Array.isArray(rules) ? rules : [rules];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    const v = r && typeof r === "object" ? Number(r.value != null ? r.value : r.level) : Number(r);
    if (!Number.isFinite(v)) continue;
    const between = r && typeof r === "object" ? parseBetween(r.between) : null;
    out.push({ value: v, between });
  }
  return out;
}

function levelCoversFull(rules) {
  const list = normalizeLevelRules(rules);
  let best = null;
  for (let i = 0; i < list.length; i++) {
    if (!coversFull(list[i].between)) continue;
    const v = list[i].value;
    if (best == null || Math.abs(v) > Math.abs(best)) best = v;
  }
  return best;
}

function levelRaisedRanges(rules) {
  const out = [];
  const list = normalizeLevelRules(rules);
  for (let i = 0; i < list.length; i++) {
    if (!(list[i].value >= 1)) continue;
    const b = list[i].between;
    out.push(b ? [b[0], b[1]] : [0, 1]);
  }
  return mergeRanges(out);
}

function levelOverlapping(rules, range) {
  const list = normalizeLevelRules(rules);
  let best = null;
  for (let i = 0; i < list.length; i++) {
    const b = list[i].between || [0, 1];
    if (!rangesOverlap(b, range)) continue;
    const v = list[i].value;
    if (best == null || Math.abs(v) > Math.abs(best)) best = v;
  }
  return best;
}

function segmentLengthM(coords) {
  let n = 0;
  for (let i = 1; i < coords.length; i++) {
    const lon0 = coords[i - 1][0];
    const lat0 = coords[i - 1][1];
    const lon1 = coords[i][0];
    const lat1 = coords[i][1];
    const dLat = (lat1 - lat0) * 111000;
    const dLon = (lon1 - lon0) * 111000 * Math.cos(((lat0 + lat1) * Math.PI) / 360);
    n += Math.hypot(dLat, dLon);
  }
  return n;
}

function interpolateLonLat(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Clip a LineString to a normalized [start, end] range along its length. */
function clipLineByRange(coords, start, end) {
  if (!coords || coords.length < 2) return null;
  const lo = Math.max(0, Math.min(1, Number(start)));
  const hi = Math.max(0, Math.min(1, Number(end)));
  if (!(hi - lo > 1e-6)) return null;
  if (lo <= 0 && hi >= 1) return coords.slice();
  const total = segmentLengthM(coords);
  if (!(total > 0)) return null;
  const a = lo * total;
  const b = hi * total;
  const out = [];
  let dist = 0;
  for (let i = 1; i < coords.length; i++) {
    const p0 = coords[i - 1];
    const p1 = coords[i];
    const dLat = (p1[1] - p0[1]) * 111000;
    const dLon = (p1[0] - p0[0]) * 111000 * Math.cos(((p0[1] + p1[1]) * Math.PI) / 360);
    const seg = Math.hypot(dLat, dLon);
    const d1 = dist + seg;
    if (d1 < a - 1e-9) {
      dist = d1;
      continue;
    }
    if (dist <= a && a <= d1) {
      const t = seg > 0 ? (a - dist) / seg : 0;
      out.push(interpolateLonLat(p0, p1, t));
    } else if (dist >= a && dist <= b && (!out.length || out[out.length - 1][0] !== p0[0] || out[out.length - 1][1] !== p0[1])) {
      out.push(p0);
    }
    if (dist <= b && b <= d1) {
      const t = seg > 0 ? (b - dist) / seg : 1;
      const pt = interpolateLonLat(p0, p1, t);
      const last = out[out.length - 1];
      if (!last || last[0] !== pt[0] || last[1] !== pt[1]) out.push(pt);
      break;
    }
    if (d1 <= b && d1 >= a) {
      const last = out[out.length - 1];
      if (!last || last[0] !== p1[0] || last[1] !== p1[1]) out.push(p1);
    }
    dist = d1;
  }
  return out.length >= 2 ? out : null;
}

function clipGeometryByRange(geom, start, end) {
  if (!geom) return null;
  const t = geom.type;
  const c = geom.coordinates;
  if (t === "LineString") {
    const line = clipLineByRange(c, start, end);
    return line ? { type: "LineString", coordinates: line } : null;
  }
  if (t === "MultiLineString") {
    const parts = [];
    for (let i = 0; i < (c || []).length; i++) {
      const line = clipLineByRange(c[i], start, end);
      if (line) parts.push(line);
    }
    if (!parts.length) return null;
    return parts.length === 1 ? { type: "LineString", coordinates: parts[0] } : { type: "MultiLineString", coordinates: parts };
  }
  return null;
}

function scopedSegmentElements(id, baseTags, geom, row, bbox) {
  const out = [];
  const flags = row && row.road_flags;
  const raised = mergeRanges(flagRanges(flags, "is_bridge").concat(levelRaisedRanges(row && row.level_rules)));
  const tunnels = mergeRanges(flagRanges(flags, "is_tunnel"));
  let n = 0;
  function emit(range, extra, suffix) {
    if (coversFull(range)) return;
    const clipped = clipGeometryByRange(geom, range[0], range[1]);
    if (!clipped) return;
    const tags = Object.assign({}, baseTags, extra);
    const els = elementsFromGeometry(id + suffix, tags, clipped, bbox);
    for (let k = 0; k < els.length; k++) out.push(els[k]);
  }
  for (let i = 0; i < raised.length; i++) {
    const r = raised[i];
    const extra = {};
    const bridgeHits = flagRanges(flags, "is_bridge").some((b) => rangesOverlap(b, r));
    if (bridgeHits) extra.bridge = "yes";
    const lv = levelOverlapping(row && row.level_rules, r);
    if (lv != null && lv !== 0) extra.layer = String(lv);
    if (!extra.bridge && !(Number(extra.layer) >= 1)) continue;
    emit(r, extra, "-br" + n++);
  }
  for (let i = 0; i < tunnels.length; i++) {
    emit(tunnels[i], { tunnel: "yes" }, "-tun" + n++);
  }
  return out;
}

function tagsFromSegment(row) {
  const tags = {};
  const subtype = String(row && row.subtype || "");
  const cls = String(row && row.class || "");
  const flags = flagValues(row && row.road_flags);
  const railFlags = flagValues(row && row.rail_flags);
  const isLink = flags.indexOf("is_link") >= 0;
  const anyBridge = flags.indexOf("is_bridge") >= 0;
  const isBridge = flagCoversFull(row && row.road_flags, "is_bridge");
  const isTunnel = flagCoversFull(row && row.road_flags, "is_tunnel");
  if (subtype === "rail" || RAIL_CLASS[cls]) {
    const rail = RAIL_CLASS[cls] ? cls : "";
    if (!rail) return null;
    tags.railway = rail;
  } else {
    let hwy = ROAD_CLASS[cls] ? cls : "";
    if (!hwy && cls === "unknown" && subtype === "road") hwy = "unclassified";
    if (!hwy && (anyBridge || Number(levelFromRules(row && row.level_rules)) >= 1) && subtype === "road") hwy = "unclassified";
    if (!hwy) return null;
    if (isLink && (hwy === "motorway" || hwy === "trunk" || hwy === "primary" || hwy === "secondary" || hwy === "tertiary")) {
      tags.highway = hwy + "_link";
    } else {
      tags.highway = hwy;
    }
  }
  if (isBridge) tags.bridge = "yes";
  if (isTunnel) tags.tunnel = "yes";
  const level = levelCoversFull(row && row.level_rules);
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

function ringHitsBbox(ring, bbox) {
  if (!bbox) return true;
  if (bboxHitsCoords(ring, bbox)) return true;
  if (!ring || ring.length < 4) return false;
  const w = +bbox.west;
  const s = +bbox.south;
  const e = +bbox.east;
  const n = +bbox.north;
  const pts = [
    [w, s],
    [w, n],
    [e, s],
    [e, n],
    [(w + e) / 2, (s + n) / 2],
  ];
  for (let i = 0; i < pts.length; i++) {
    if (pointInRing(pts[i], ring)) return true;
  }
  return false;
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
    if (bbox && !ringHitsBbox(outer, bbox)) return;
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
    if (key === "segment") {
      const extras = scopedSegmentElements(id, tags, geom, row, bbox);
      for (let k = 0; k < extras.length; k++) out.push(extras[k]);
    }
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
    parquetMetadataAsync: hp.parquetMetadataAsync,
    compressors: comp.compressors,
    // Real reads go through the process-level range and footer cache.
    processCache: true,
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
  const byFileRows = new Map();
  await poolMap(files, GROUP_READ_CONCURRENCY, async ([file, gs]) => {
    if (signal && signal.aborted) throw new Error("The operation was aborted due to timeout");
    const url = AZURE_ROOT + "theme=" + theme.theme + "/type=" + theme.type + "/" + file;
    const pc = reader.processCache ? require("./parquet-cache") : null;
    const source = pc
      ? await pc.cachedSource(reader, url, signal)
      : await reader.asyncBufferFromUrl({ url, requestInit: { signal } });
    // One footer per file, shared by its row groups (and later exports).
    let metadata = null;
    if (pc) {
      try {
        metadata = await pc.cachedMetadata(reader, url, source);
      } catch (e) {
        if (signal && signal.aborted || isAbortError(e)) throw e;
        metadata = null;
      }
    }
    const readGroup = async (g) => {
      if (signal && signal.aborted) throw new Error("The operation was aborted due to timeout");
      const base = {
        file: source,
        compressors: reader.compressors,
        columns: theme.columns,
        rowStart: g.rowStart,
        rowEnd: g.rowStart + g.rowCount,
      };
      if (metadata) base.metadata = metadata;
      try {
        return await reader.parquetReadObjects({ ...base, filter, usePageIndex: true });
      } catch (e) {
        if (signal && signal.aborted || isAbortError(e)) throw e;
        // A dropped Azure range is transient. Retry the same filtered
        // page-index read; do not fall through to an unfiltered group
        // (a much larger request) just because one range was reset.
        if (isTransientRangeError(e)) {
          return await reader.parquetReadObjects({ ...base, filter, usePageIndex: true });
        }
        return reader.parquetReadObjects(base);
      }
    };
    // Groups of one file in parallel once the footer is known; rows keep
    // the file's group order.
    const perGroup = metadata ? await poolMap(gs, GROUP_READ_CONCURRENCY, readGroup) : [];
    if (!metadata) for (const g of gs) perGroup.push(await readGroup(g));
    byFileRows.set(file, perGroup);
  });
  for (const [file] of files) {
    const perGroup = byFileRows.get(file) || [];
    for (const got of perGroup) for (let i = 0; i < (got || []).length; i++) rows.push(got[i]);
  }
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
    const error = isAbortError(e) ? "timed out after " + deadlineMs + "ms" : String(e && e.message ? e.message : e);
    return { ok: false, elements: [], notes: [], error };
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
  flagCoversFull,
  clipLineByRange,
  asGeometry,
  wkbToGeom,
  bboxHitsCoords,
  ringHitsBbox,
  elementsFromGeometry,
  elementsFromRows,
  fetchOvertureStreet,
};

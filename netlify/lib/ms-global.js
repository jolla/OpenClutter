"use strict";

/**
 * Microsoft Global ML Building Footprints (quadkey gzip geojsonl).
 *
 * Esri MSBFP2 was last edited 2022-04-13 and only returns a handful of
 * footprints for Oak Creek's commercial block — the large white roofs are
 * absent from that layer, not dropped by pagination or the area filters.
 * The global release is one ~40 MB gzip per zoom-9 quadkey. We needle-filter
 * lines to the site bbox and keep polygons that actually intersect it.
 * MSBFP2 is still merged in underneath so a missing quadkey cannot erase
 * footprints the ArcGIS layer does have. OSM building ways are not read.
 */

const zlib = require("zlib");

const INDEX = require("./ms-buildings-index.json");
const QUADKEY_ZOOM = 9;

function lonLatToTile(lon, lat, zoom) {
  const n = 2 ** zoom;
  const x = Math.floor(((+lon + 180) / 360) * n);
  const latRad = (+lat * Math.PI) / 180;
  const y = Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n);
  return [x, y];
}

function tileToQuadkey(x, y, zoom) {
  let q = "";
  for (let i = zoom; i > 0; i--) {
    let b = 0;
    const mask = 1 << (i - 1);
    if (x & mask) b += 1;
    if (y & mask) b += 2;
    q += String(b);
  }
  return q;
}

function quadkeysForBbox(west, south, east, north, zoom) {
  const z = zoom || QUADKEY_ZOOM;
  const [xW, yS] = lonLatToTile(west, south, z);
  const [xE, yN] = lonLatToTile(east, north, z);
  const keys = [];
  for (let x = Math.min(xW, xE); x <= Math.max(xW, xE); x++) {
    for (let y = Math.min(yN, yS); y <= Math.max(yN, yS); y++) {
      keys.push(tileToQuadkey(x, y, z));
    }
  }
  return keys;
}

function urlsForBbox(west, south, east, north) {
  const keys = quadkeysForBbox(west, south, east, north);
  const urls = [];
  for (const key of keys) {
    const url = INDEX[key];
    if (url) urls.push({ quadkey: key, url });
  }
  return { keys, urls };
}

/** Decimal prefixes that appear in coordinates inside [min, max] ± pad. */
function spanNeedles(min, max, pad) {
  const a = Math.floor((min - pad) * 100) / 100;
  const b = Math.ceil((max + pad) * 100) / 100;
  const out = [];
  for (let x = a; x <= b + 1e-9; x += 0.01) {
    const s = (Math.round(x * 100) / 100).toFixed(2);
    out.push(Buffer.from(s));
  }
  return out;
}

function hasAny(line, needles) {
  for (let i = 0; i < needles.length; i++) {
    if (line.includes(needles[i])) return true;
  }
  return false;
}

function usableHeight(props) {
  const h = Number(
    props && (props.height != null ? props.height : props.Height != null ? props.Height : props.HEIGHT)
  );
  return h > 2 && h < 400 ? h : 0;
}

function featureHeight(feature) {
  return usableHeight(feature && feature.properties);
}

function setFeatureHeight(feature, height) {
  if (!feature.properties) feature.properties = {};
  feature.properties.height = height;
}

function exteriorRings(geometry) {
  if (!geometry || !geometry.coordinates) return [];
  if (geometry.type === "Polygon") {
    const ring = geometry.coordinates[0];
    return ring && ring.length >= 4 ? [ring] : [];
  }
  if (geometry.type === "MultiPolygon") {
    const out = [];
    for (const poly of geometry.coordinates) {
      if (poly && poly[0] && poly[0].length >= 4) out.push(poly[0]);
    }
    return out;
  }
  return [];
}

function ringBBoxHits(ring, bbox) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const x = +ring[i][0];
    const y = +ring[i][1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return !(maxX < bbox.west || minX > bbox.east || maxY < bbox.south || minY > bbox.north);
}

function geometryHitsBbox(geometry, bbox) {
  const rings = exteriorRings(geometry);
  for (let i = 0; i < rings.length; i++) {
    if (ringBBoxHits(rings[i], bbox)) return true;
  }
  return false;
}

function normalizeFeature(obj) {
  if (!obj || !obj.geometry) return null;
  const height = usableHeight(obj.properties);
  const properties = { geomSource: "ms-global" };
  if (height) {
    properties.height = height;
    properties.heightSource = "ms-global";
  }
  return {
    type: "Feature",
    properties,
    geometry: obj.geometry,
  };
}

/**
 * @param {Buffer} gz gzip of newline-delimited GeoJSON
 * @param {{west:number,south:number,east:number,north:number}} bbox
 */
function featuresFromGzip(gz, bbox) {
  const text = zlib.gunzipSync(gz);
  const lonNeedles = spanNeedles(+bbox.west, +bbox.east, 0.03);
  const latNeedles = spanNeedles(+bbox.south, +bbox.north, 0.03);
  const features = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i !== text.length && text[i] !== 10) continue;
    const line = text.subarray(start, i);
    start = i + 1;
    if (line.length < 40) continue;
    if (!hasAny(line, lonNeedles) || !hasAny(line, latNeedles)) continue;
    let obj;
    try {
      obj = JSON.parse(line.toString("utf8"));
    } catch {
      continue;
    }
    if (!geometryHitsBbox(obj.geometry, bbox)) continue;
    const feature = normalizeFeature(obj);
    if (feature) features.push(feature);
  }
  return features;
}

function centroid(ring) {
  const closed =
    ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const n = closed ? ring.length - 1 : ring.length;
  if (n < 3) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += +ring[i][0];
    sy += +ring[i][1];
  }
  return [sx / n, sy / n];
}

function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = +ring[i][0];
    const yi = +ring[i][1];
    const xj = +ring[j][0];
    const yj = +ring[j][1];
    const intersect = yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi || 1e-20) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Keep every primary footprint, then add secondary footprints whose centroid
 * is not already inside one. When a secondary ring is already covered, copy
 * its measured height onto the primary feature that contains the centroid
 * (FEMA USA Structures HEIGHT is otherwise thrown away by the dedupe).
 */
function mergeFootprintFeatures(primary, secondary) {
  const base = Array.isArray(primary) ? primary.slice() : [];
  const extraSrc = Array.isArray(secondary) ? secondary : [];
  const owners = [];
  for (const f of base) {
    const ex = exteriorRings(f && f.geometry);
    for (const r of ex) owners.push({ ring: r, feature: f });
  }
  let added = 0;
  let heightsTransferred = 0;
  for (const f of extraSrc) {
    const ex = exteriorRings(f && f.geometry);
    if (!ex.length) continue;
    const h = featureHeight(f);
    let covered = true;
    for (const ring of ex) {
      const c = centroid(ring);
      const owner = c && owners.find((o) => pointInRing(c, o.ring));
      if (!owner) {
        covered = false;
        continue;
      }
      if (h && !featureHeight(owner.feature)) {
        setFeatureHeight(owner.feature, h);
        heightsTransferred++;
      }
    }
    if (covered) continue;
    base.push(f);
    for (const r of ex) owners.push({ ring: r, feature: f });
    added++;
  }
  return { features: base, added, heightsTransferred };
}

async function fetchMsGlobalFootprints(frame, fetchFn) {
  const { keys, urls } = urlsForBbox(frame.west, frame.south, frame.east, frame.north);
  const bbox = {
    west: +frame.west,
    south: +frame.south,
    east: +frame.east,
    north: +frame.north,
  };
  const features = [];
  for (const item of urls) {
    const res = await fetchFn(item.url);
    if (!res || res.ok === false) {
      throw new Error("global footprints HTTP " + (res && res.status));
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const chunk = featuresFromGzip(buf, bbox);
    for (const f of chunk) features.push(f);
  }
  return { features, quadkeys: keys, files: urls.length };
}

module.exports = {
  QUADKEY_ZOOM,
  lonLatToTile,
  tileToQuadkey,
  quadkeysForBbox,
  urlsForBbox,
  spanNeedles,
  featuresFromGzip,
  mergeFootprintFeatures,
  fetchMsGlobalFootprints,
  exteriorRings,
  pointInRing,
  centroid,
  featureHeight,
  setFeatureHeight,
};

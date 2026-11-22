"use strict";

/**
 * Microsoft Global ML cleanup that uses street-map context the export
 * already fetched (parking, railway, parks) plus a thin-strip test.
 * A lidar or roof-shadow reading that supports a structure wins.
 */

const polygonClipping = require("polygon-clipping");
const { exteriorRings, centroid, featureHeight } = require("./ms-global");

const CONTEXT_COVER = 0.6;
const THIN_ASPECT = 8;
const THIN_WIDTH_M = 8;
const THIN_ASPECT_NARROW = 6;
const THIN_WIDTH_NARROW_M = 6;
const RAIL_BUFFER_M = 10;
const LIDAR_SUPPORT_M = 4;

/** Overpass clauses for land context, appended to an existing extract. */
function landContextQuery(box) {
  return (
    'way["landuse"="railway"](' + box + ");" +
    'relation["landuse"="railway"](' + box + ");" +
    'way["railway"="platform"](' + box + ");" +
    'relation["railway"="platform"](' + box + ");" +
    'way["leisure"~"^(park|garden|playground|pitch|common)$"](' + box + ");" +
    'relation["leisure"~"^(park|garden|playground|pitch|common)$"](' + box + ");" +
    'way["landuse"~"^(recreation_ground|village_green)$"](' + box + ");" +
    'relation["landuse"~"^(recreation_ground|village_green)$"](' + box + ");" +
    'way["place"="square"](' + box + ");" +
    'relation["place"="square"](' + box + ");" +
    'way["highway"="pedestrian"]["area"="yes"](' + box + ");"
  );
}

function parkingSurfaceQuery(box) {
  return 'way["amenity"="parking"](' + box + ");" + 'relation["amenity"="parking"](' + box + ");";
}

function isParkingStructure(tags) {
  if (!tags) return false;
  if (tags.parking === "underground" || tags.location === "underground") return true;
  return tags.parking === "multi-storey" || tags.building === "parking";
}

function classifyLandTags(tags) {
  if (!tags) return null;
  const railway = String(tags.railway || "");
  const leisure = String(tags.leisure || "");
  const landuse = String(tags.landuse || "");
  const place = String(tags.place || "");
  if (isParkingStructure(tags)) return null;
  if (tags.amenity === "parking") return "parking";
  if (landuse === "railway") return "railway_land";
  if (railway === "platform") return "platform";
  if (/^(monorail|light_rail|subway|rail|tram)$/.test(railway)) return "railway_line";
  if (/^(park|garden|playground|pitch|common)$/.test(leisure)) return "park";
  if (landuse === "recreation_ground" || landuse === "village_green") return "park";
  if (place === "square") return "plaza";
  if (tags.highway === "pedestrian" && (tags.area === "yes" || tags.area === "true")) return "plaza";
  return null;
}

function wayCoords(el) {
  if (!el) return null;
  if (Array.isArray(el.geometry) && el.geometry.length >= 2) {
    return el.geometry.map((p) => [+p.lon, +p.lat]);
  }
  if (Array.isArray(el.coordinates) && el.coordinates.length >= 2) {
    return el.coordinates.map((p) => (Array.isArray(p) ? [+p[0], +p[1]] : [+p.lon, +p.lat]));
  }
  return null;
}

function isClosed(coords) {
  if (!coords || coords.length < 4) return false;
  const a = coords[0];
  const b = coords[coords.length - 1];
  return a[0] === b[0] && a[1] === b[1];
}

function closeRing(coords) {
  if (!coords || coords.length < 3) return null;
  if (isClosed(coords)) return coords;
  return coords.concat([coords[0]]);
}

function memberRings(el, role) {
  const out = [];
  const members = (el && el.members) || [];
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    if (!m || (role && m.role !== role)) continue;
    const coords = wayCoords(m);
    const ring = closeRing(coords);
    if (ring) out.push(ring);
  }
  return out;
}

function emptyContext() {
  return { parking: [], railwayLand: [], platforms: [], parks: [], plazas: [], railwayLines: [] };
}

function pushKind(ctx, kind, ringOrLine) {
  if (!ringOrLine || !kind) return;
  if (kind === "parking") ctx.parking.push(ringOrLine);
  else if (kind === "railway_land") ctx.railwayLand.push(ringOrLine);
  else if (kind === "platform") ctx.platforms.push(ringOrLine);
  else if (kind === "park") ctx.parks.push(ringOrLine);
  else if (kind === "plaza") ctx.plazas.push(ringOrLine);
  else if (kind === "railway_line") ctx.railwayLines.push(ringOrLine);
}

function extractLandContext(elements) {
  const ctx = emptyContext();
  const list = Array.isArray(elements) ? elements : [];
  for (let i = 0; i < list.length; i++) {
    const el = list[i];
    if (!el) continue;
    const kind = classifyLandTags(el.tags || {});
    if (!kind) continue;
    if (el.type === "way" || !el.type) {
      const coords = wayCoords(el);
      if (!coords) continue;
      if (kind === "railway_line") {
        if (coords.length >= 2) ctx.railwayLines.push(coords);
        continue;
      }
      const ring = closeRing(coords);
      if (ring) pushKind(ctx, kind, ring);
      continue;
    }
    if (el.type !== "relation") continue;
    if (kind === "railway_line") continue;
    const outers = memberRings(el, "outer");
    for (let o = 0; o < outers.length; o++) pushKind(ctx, kind, outers[o]);
  }
  return ctx;
}

function mergeLandContext(packs) {
  const ctx = emptyContext();
  const lists = Array.isArray(packs) ? packs : [packs];
  const seen = new Set();
  function add(kind, ring) {
    if (!ring || !ring.length) return;
    const key = kind + ":" + ring[0][0] + "," + ring[0][1] + ":" + ring.length;
    if (seen.has(key)) return;
    seen.add(key);
    pushKind(ctx, kind, ring);
  }
  for (let p = 0; p < lists.length; p++) {
    const src = lists[p] || {};
    const land = src.landContext || src;
    const pairs = [
      ["parking", land.parking],
      ["railway_land", land.railwayLand],
      ["platform", land.platforms],
      ["park", land.parks],
      ["plaza", land.plazas],
      ["railway_line", land.railwayLines],
    ];
    for (let i = 0; i < pairs.length; i++) {
      const kind = pairs[i][0];
      const rings = pairs[i][1] || [];
      for (let r = 0; r < rings.length; r++) add(kind, rings[r]);
    }
  }
  return ctx;
}

function addGuidewaysToContext(ctx, guideways) {
  const out = ctx || emptyContext();
  const list = Array.isArray(guideways) ? guideways : [];
  for (let i = 0; i < list.length; i++) {
    const g = list[i];
    const coords = g && (g.coords || g.geometry);
    if (!coords || coords.length < 2) continue;
    const line = Array.isArray(coords[0]) && typeof coords[0][0] === "number" ? coords : wayCoords(g);
    if (line && line.length >= 2) out.railwayLines.push(line);
  }
  return out;
}

function isMicrosoftGeom(feature) {
  const src = feature && feature.properties && feature.properties.geomSource;
  return src === "ms-global";
}

function ringAreaM2(ring) {
  if (!ring || ring.length < 4) return 0;
  const closed = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const n = closed ? ring.length - 1 : ring.length;
  if (n < 3) return 0;
  let lat = 0;
  for (let i = 0; i < n; i++) lat += +ring[i][1];
  const cos = Math.cos(((lat / n) * Math.PI) / 180);
  const mx = 111320 * Math.max(0.2, cos);
  const my = 110540;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += +ring[i][0] * mx * +ring[j][1] * my - +ring[j][0] * mx * +ring[i][1] * my;
  }
  return Math.abs(a) / 2;
}

function featureAreaM2(feature) {
  const rings = exteriorRings(feature && feature.geometry);
  let a = 0;
  for (const r of rings) a += ringAreaM2(r);
  return a;
}

function intersectionAreaM2(ringA, ringB) {
  if (!ringA || !ringB || ringA.length < 4 || ringB.length < 4) return 0;
  try {
    const inter = polygonClipping.intersection([[ringA]], [[ringB]]);
    let area = 0;
    for (const poly of inter || []) {
      if (!poly[0]) continue;
      area += ringAreaM2(poly[0]);
    }
    return area > 0 ? area : 0;
  } catch {
    return 0;
  }
}

function overlapFraction(feature, rings) {
  const exteriors = exteriorRings(feature && feature.geometry);
  if (!exteriors.length || !rings || !rings.length) return 0;
  let total = 0;
  let hit = 0;
  for (let i = 0; i < exteriors.length; i++) {
    const a = ringAreaM2(exteriors[i]);
    if (!(a > 0)) continue;
    total += a;
    for (let r = 0; r < rings.length; r++) {
      hit += intersectionAreaM2(exteriors[i], rings[r]);
    }
  }
  if (!(total > 0)) return 0;
  return Math.min(1, hit / total);
}

function ringWidthAndAspect(ring) {
  if (!ring || ring.length < 4) return { widthM: 0, aspect: 0, lengthM: 0 };
  const area = ringAreaM2(ring);
  let per = 0;
  const n = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.length - 1 : ring.length;
  let lat = 0;
  for (let i = 0; i < n; i++) lat += +ring[i][1];
  const cos = Math.cos(((lat / n) * Math.PI) / 180);
  const mx = 111320 * Math.max(0.2, cos);
  const my = 110540;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = (ring[j][0] - ring[i][0]) * mx;
    const dy = (ring[j][1] - ring[i][1]) * my;
    per += Math.hypot(dx, dy);
    const x = ring[i][0] * mx;
    const y = ring[i][1] * my;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const widthM = per > 0 ? (2 * area) / per : 0;
  const bw = Math.max(1e-6, maxX - minX);
  const bh = Math.max(1e-6, maxY - minY);
  const aspect = Math.max(bw, bh) / Math.min(bw, bh);
  return { widthM, aspect, lengthM: Math.max(bw, bh) };
}

function isThinStrip(feature) {
  const rings = exteriorRings(feature && feature.geometry);
  if (!rings.length) return false;
  let worst = false;
  for (let i = 0; i < rings.length; i++) {
    const s = ringWidthAndAspect(rings[i]);
    if ((s.aspect >= THIN_ASPECT && s.widthM < THIN_WIDTH_M) || (s.aspect >= THIN_ASPECT_NARROW && s.widthM < THIN_WIDTH_NARROW_M)) {
      worst = true;
    }
  }
  return worst;
}

function pointToSegDistM(lon, lat, a, b, mx, my) {
  const x = lon * mx;
  const y = lat * my;
  const ax = a[0] * mx;
  const ay = a[1] * my;
  const bx = b[0] * mx;
  const by = b[1] * my;
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  let t = 0;
  if (len2 > 0) t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / len2));
  return Math.hypot(x - (ax + t * vx), y - (ay + t * vy));
}

function fractionNearRailway(feature, lines) {
  if (!lines || !lines.length) return 0;
  const rings = exteriorRings(feature && feature.geometry);
  if (!rings.length) return 0;
  const pts = [];
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    const n = ring.length;
    const step = Math.max(1, Math.floor(n / 16));
    for (let i = 0; i < n; i += step) pts.push(ring[i]);
    const c = centroid(ring);
    if (c) pts.push(c);
  }
  if (!pts.length) return 0;
  let lat = 0;
  for (let i = 0; i < pts.length; i++) lat += pts[i][1];
  const mx = 111320 * Math.max(0.2, Math.cos(((lat / pts.length) * Math.PI) / 180));
  const my = 110540;
  let near = 0;
  for (let p = 0; p < pts.length; p++) {
    let dmin = Infinity;
    for (let L = 0; L < lines.length; L++) {
      const line = lines[L];
      for (let i = 1; i < line.length; i++) {
        const d = pointToSegDistM(pts[p][0], pts[p][1], line[i - 1], line[i], mx, my);
        if (d < dmin) dmin = d;
      }
    }
    if (dmin <= RAIL_BUFFER_M) near++;
  }
  return near / pts.length;
}

function supportedStructure(feature, opts) {
  const src = (feature && feature.properties && feature.properties.heightSource) || "";
  const h = featureHeight(feature);
  if ((src === "lidar" || src === "nls-laser") && h >= LIDAR_SUPPORT_M) return true;
  if (opts && typeof opts.lidarHeight === "function") {
    const lh = Number(opts.lidarHeight(feature)) || 0;
    if (lh >= LIDAR_SUPPORT_M) return true;
  }
  if (opts && typeof opts.hasShadow === "function" && opts.hasShadow(feature)) return true;
  if (opts && typeof opts.supported === "function" && opts.supported(feature)) return true;
  return false;
}

function contextHit(feature, ctx) {
  if (!ctx) return null;
  const parking = overlapFraction(feature, ctx.parking || []);
  if (parking >= CONTEXT_COVER) return "parking";
  const railLand = overlapFraction(feature, (ctx.railwayLand || []).concat(ctx.platforms || []));
  if (railLand >= CONTEXT_COVER) return "railway";
  const park = overlapFraction(feature, (ctx.parks || []).concat(ctx.plazas || []));
  if (park >= CONTEXT_COVER) return "park";
  const railLine = fractionNearRailway(feature, ctx.railwayLines || []);
  if (railLine >= CONTEXT_COVER) return "railway";
  return null;
}

/**
 * Drop Microsoft footprints that sit mostly on parking, railway, platform,
 * or park/plaza, or that are very elongated thin strips, unless lidar or a
 * roof shadow supports a structure.
 */
function rejectMicrosoftFalsePositives(features, context, opts) {
  const list = Array.isArray(features) ? features : [];
  const kept = [];
  const dropped = [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (!f) continue;
    if (!isMicrosoftGeom(f) || supportedStructure(f, opts)) {
      kept.push(f);
      continue;
    }
    const hit = contextHit(f, context);
    const thin = isThinStrip(f);
    if (hit || thin) {
      dropped.push({ feature: f, reason: hit || "thin" });
      continue;
    }
    kept.push(f);
  }
  return { features: kept, dropped: dropped.length, reasons: dropped };
}

module.exports = {
  CONTEXT_COVER,
  THIN_ASPECT,
  THIN_WIDTH_M,
  RAIL_BUFFER_M,
  landContextQuery,
  parkingSurfaceQuery,
  classifyLandTags,
  extractLandContext,
  mergeLandContext,
  addGuidewaysToContext,
  isMicrosoftGeom,
  isThinStrip,
  overlapFraction,
  fractionNearRailway,
  rejectMicrosoftFalsePositives,
  emptyContext,
  featureAreaM2,
  ringAreaM2,
};

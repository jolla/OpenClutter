"use strict";

/**
 * A measured roof that changes with height is more than one attenuating
 * object. A dome (or onion) is stacked rings of the same footprint, shrunk
 * toward the measured apex. A shed, skillion, or lean-to that records a rise
 * and the direction it falls — or a feature that already carries a low height
 * and that direction — is side-by-side strips whose tops run from the low
 * side to the high side.
 *
 * A second height is never invented. A plain box, a round plan with no dome
 * roof, and a tower that only has one measured height stay one object.
 * min_height is the bottom of a floating volume, not a roof eave, and is not
 * read here. roof_shape "round" is a barrel roof, not a sphere.
 */

const polygonClipping = require("polygon-clipping");

const DOME_BANDS = 6;
const SLOPE_BANDS = 4;
const SLOPE_MIN_DELTA_M = 8;
const MIN_BAND_M = 2.05;
const MIN_PIECE_M2 = 25;
const M_PER_DEG_LAT = 110540;

const DOME_SHAPES = new Set(["dome", "onion"]);
const SLOPE_SHAPES = new Set(["shed", "skillion", "lean_to"]);

function roofShapeOf(props) {
  return String((props && props.roofShape) || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function ownHeight(props) {
  const h = Number(props && props.height);
  if (!(h > 2 && h < 400)) return 0;
  if (!props || props.heightSource === "nearby") return 0;
  return h;
}

function spanOf(props) {
  const top = ownHeight(props);
  if (!top) return null;
  const base = Number(props.levelBaseM) > 0 ? Number(props.levelBaseM) : 0;
  const span = base > 0 ? top - base : top;
  if (!(span > 2)) return null;
  return { top, base, span };
}

function directionDeg(props) {
  if (!props || props.roofDirection === undefined || props.roofDirection === null || props.roofDirection === "") {
    return null;
  }
  const n = Number(props.roofDirection);
  if (!Number.isFinite(n)) return null;
  return ((n % 360) + 360) % 360;
}

function explicitLow(props, high) {
  if (!props || props.lowHeight === undefined || props.lowHeight === null || props.lowHeight === "") return 0;
  const low = Number(props.lowHeight);
  if (!(low > 2 && low < high)) return 0;
  return low;
}

function riseLow(props, high) {
  if (!SLOPE_SHAPES.has(roofShapeOf(props))) return 0;
  const rise = Number(props && props.roofHeight);
  if (!(rise > 0 && rise < high)) return 0;
  return high - rise;
}

function slopeEnds(props) {
  const span = spanOf(props);
  if (!span) return null;
  const dir = directionDeg(props);
  if (dir === null) return null;
  const low = explicitLow(props, span.top) || riseLow(props, span.top);
  if (!(low > span.base + 2)) return null;
  if (!(span.top - low >= SLOPE_MIN_DELTA_M)) return null;
  return { high: span.top, low, base: span.base, direction: dir };
}

function openCount(ring) {
  if (!ring || ring.length < 4) return 0;
  const n = ring.length;
  const closed = ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1];
  return closed ? n - 1 : n;
}

function centroid(ring) {
  const n = openCount(ring);
  if (!n) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += ring[i][0];
    sy += ring[i][1];
  }
  return [sx / n, sy / n];
}

function closeRing(ring) {
  if (!ring || ring.length < 3) return null;
  const out = ring.map((p) => [p[0], p[1]]);
  const a = out[0];
  const b = out[out.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) out.push([a[0], a[1]]);
  return out.length >= 4 ? out : null;
}

function scaleRing(ring, scale, c) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    out.push([c[0] + (ring[i][0] - c[0]) * scale, c[1] + (ring[i][1] - c[1]) * scale]);
  }
  return out;
}

function scaleGeometry(geometry, scale) {
  if (!geometry || !(scale > 0)) return null;
  if (scale >= 0.9995) return geometry;
  if (geometry.type === "Polygon") {
    const c = centroid(geometry.coordinates[0]);
    if (!c) return null;
    return {
      type: "Polygon",
      coordinates: geometry.coordinates.map((ring) => scaleRing(ring, scale, c)),
    };
  }
  if (geometry.type === "MultiPolygon") {
    const coordinates = [];
    for (const poly of geometry.coordinates) {
      const c = centroid(poly && poly[0]);
      if (!c) continue;
      coordinates.push(poly.map((ring) => scaleRing(ring, scale, c)));
    }
    if (!coordinates.length) return null;
    return { type: "MultiPolygon", coordinates };
  }
  return null;
}

function mPerDegLon(lat) {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}

function ringAreaM2(ring) {
  const c = centroid(ring);
  if (!c) return 0;
  const mLon = mPerDegLon(c[1]);
  const n = openCount(ring);
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = (ring[i][0] - c[0]) * mLon;
    const y0 = (ring[i][1] - c[1]) * M_PER_DEG_LAT;
    const x1 = (ring[j][0] - c[0]) * mLon;
    const y1 = (ring[j][1] - c[1]) * M_PER_DEG_LAT;
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

function largestExterior(geometry) {
  if (!geometry) return null;
  const polys = geometry.type === "MultiPolygon" ? geometry.coordinates : geometry.type === "Polygon" ? [geometry.coordinates] : [];
  let best = null;
  let bestA = 0;
  for (const poly of polys) {
    const ring = poly && poly[0];
    const area = ringAreaM2(ring);
    if (area > bestA) {
      bestA = area;
      best = ring;
    }
  }
  return best;
}

/** Hemisphere on the footprint: r/R = sqrt(1 - (z/H)^2). Never wider than the ground ring. */
function domeScale(zOverH) {
  const t = Math.min(0.999, Math.max(0, zOverH));
  return Math.min(1, Math.sqrt(Math.max(0, 1 - t * t)));
}

function bandCount(span, maxBands) {
  const n = Math.min(maxBands, Math.floor(span / MIN_BAND_M));
  return n >= 2 ? n : 0;
}

function pieceFeature(feature, geometry, height, levelBase) {
  const props = Object.assign({}, feature.properties, {
    height,
    shapePart: true,
  });
  if (levelBase > 0) props.levelBaseM = levelBase;
  else delete props.levelBaseM;
  return { type: "Feature", properties: props, geometry };
}

function domePieces(feature) {
  const props = (feature && feature.properties) || {};
  if (!DOME_SHAPES.has(roofShapeOf(props))) return null;
  const span = spanOf(props);
  if (!span || !feature.geometry) return null;
  const n = bandCount(span.span, DOME_BANDS);
  if (!n) return null;
  const ground = ringAreaM2(largestExterior(feature.geometry));
  if (!(ground >= MIN_PIECE_M2)) return null;
  const pieces = [];
  for (let i = 0; i < n; i++) {
    const z = i >= n - 1 ? (n - 0.5) / n : i / n;
    const scale = domeScale(z);
    if (ground * scale * scale < MIN_PIECE_M2) break;
    const geometry = scaleGeometry(feature.geometry, scale);
    if (!geometry) break;
    const bottom = span.base + (span.span * i) / n;
    const top = i === n - 1 ? span.top : span.base + (span.span * (i + 1)) / n;
    pieces.push(pieceFeature(feature, geometry, top, bottom));
  }
  return pieces.length >= 2 ? pieces : null;
}

function toLocal(ring, origin) {
  const mLon = mPerDegLon(origin[1]);
  const local = [];
  for (let i = 0; i < ring.length; i++) {
    local.push([(ring[i][0] - origin[0]) * mLon, (ring[i][1] - origin[1]) * M_PER_DEG_LAT]);
  }
  return { local, mLon };
}

function fromLocal(local, origin, mLon) {
  const ring = [];
  for (let i = 0; i < local.length; i++) {
    ring.push([origin[0] + local[i][0] / mLon, origin[1] + local[i][1] / M_PER_DEG_LAT]);
  }
  return closeRing(ring);
}

function slopePieces(feature) {
  const props = (feature && feature.properties) || {};
  const ends = slopeEnds(props);
  if (!ends || !feature.geometry) return null;
  const ring = closeRing(largestExterior(feature.geometry));
  if (!ring) return null;
  const origin = centroid(ring);
  if (!origin) return null;
  const { local, mLon } = toLocal(ring, origin);
  const closed = closeRing(local);
  if (!closed) return null;
  const rad = (ends.direction * Math.PI) / 180;
  const down = [Math.sin(rad), Math.cos(rad)];
  const up = [-down[0], -down[1]];
  const side = [-up[1], up[0]];
  let uMin = Infinity;
  let uMax = -Infinity;
  for (let i = 0; i < closed.length; i++) {
    const u = closed[i][0] * up[0] + closed[i][1] * up[1];
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
  }
  const spanU = uMax - uMin;
  if (!(spanU >= 1)) return null;
  const n = SLOPE_BANDS;
  const pad = spanU + 50;
  const pieces = [];
  for (let i = 0; i < n; i++) {
    const u0 = uMin + (spanU * i) / n;
    const u1 = i === n - 1 ? uMax : uMin + (spanU * (i + 1)) / n;
    const band = [
      [u0, -pad],
      [u1, -pad],
      [u1, pad],
      [u0, pad],
    ].map(([u, s]) => [up[0] * u + side[0] * s, up[1] * u + side[1] * s]);
    band.push(band[0]);
    let inter;
    try {
      inter = polygonClipping.intersection([[closed]], [[band]]);
    } catch {
      continue;
    }
    const roof = i === n - 1 ? ends.high : ends.low + ((ends.high - ends.low) * i) / (n - 1);
    for (const poly of inter || []) {
      const part = poly && poly[0];
      if (!part || part.length < 4) continue;
      const ll = fromLocal(part, origin, mLon);
      if (!ll || ringAreaM2(ll) < MIN_PIECE_M2) continue;
      pieces.push(pieceFeature(feature, { type: "Polygon", coordinates: [ll] }, roof, ends.base));
      if (pieces.length >= n * 2) return pieces.length >= 2 ? pieces : null;
    }
  }
  return pieces.length >= 2 ? pieces : null;
}

/** One feature, or several shape pieces. The original is unchanged. */
function piecesForFeature(feature) {
  const dome = domePieces(feature);
  if (dome) return dome;
  const slope = slopePieces(feature);
  if (slope) return slope;
  return [feature];
}

module.exports = {
  DOME_BANDS,
  SLOPE_BANDS,
  SLOPE_MIN_DELTA_M,
  piecesForFeature,
  domePieces,
  slopePieces,
};

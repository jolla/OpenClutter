"use strict";

/**
 * Building outlines left on empty RV pads.
 *
 * OSM and Overture keep the outline of a park model, cabin or shed long
 * after it is hauled away, and inside an RV park the export then draws an
 * RV (or a building) on a bare pad. A small outline inside an RV park,
 * campground or mobile-home park is left out only when every check agrees:
 *
 * - the photo shows ground inside it: no light roof pixels, and the colours
 *   inside match the pad, gravel or lawn just outside the outline;
 * - no roof sits just beside it (an outline a metre or two off its roof);
 * - nothing tall casts a shadow beside it;
 * - and the height data says there is nothing there: the lidar under the
 *   outline is clear, or, where the lidar is missing or unsure, the photo
 *   has clear sun and the outline casts no shadow where the sun puts one.
 *
 * Any doubt keeps the outline. Missing an empty pad is better than losing
 * a real building.
 */

const { llToImagePx } = require("./geo-frame");
const { mercator, groundAt } = require("./usgs-lidar");
const { photoSun, shiftedDarkShare } = require("./sun-shadow");

const P = {
  minM2: 10,
  maxM2: 120,
  // Inside the outline: light roof share at most, ground-like share at least.
  roofMax: 0.03,
  groundMin: 0.55,
  // Ground colours: the two commonest colours 1 to 4 m outside the outline.
  ringInM: 1,
  ringOutM: 4,
  refShare: 0.12,
  groundDist: 50,
  // A roof beside it: light roof share of the outline moved 1 or 2 m.
  besideM: [1, 2],
  besideMax: 0.25,
  // Shadow beside it: dark share of the outline moved 1, 2 and 3 m.
  shadeM: [1, 2, 3],
  shadeAnyMax: 0.3,
  shadeSunMax: 0.15,
  // Lidar under the outline: covered share, and the share of cells 1.5 m
  // or more over the ground.
  lidarCover: 0.6,
  lidarMinCells: 4,
  tallM: 1.5,
  lidarClear: 0.25,
  lidarTall: 0.5,
};

function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function ringGap(p, ring) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = ring[j][0];
    const ay = ring[j][1];
    const dx = ring[i][0] - ax;
    const dy = ring[i][1] - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy);
    if (d < best) best = d;
  }
  return best;
}

function areaM2(ring) {
  let lat = 0;
  for (let i = 0; i < ring.length; i++) lat += ring[i][1];
  lat /= ring.length;
  const mx = 111320 * Math.cos((lat * Math.PI) / 180);
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * mx * ring[i][1] * 110540 - ring[i][0] * mx * ring[j][1] * 110540;
  return Math.abs(a) / 2;
}

function exteriorRings(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return geometry.coordinates && geometry.coordinates[0] ? [geometry.coordinates[0]] : [];
  if (geometry.type === "MultiPolygon") return (geometry.coordinates || []).map((p) => p && p[0]).filter(Boolean);
  return [];
}

/** Colour distance used for pad ground (hue-weighted, as in vehicle-track). */
function groundDistance(r, g, b, q) {
  return 1.5 * (Math.abs(r - g - (q[0] - q[1])) + Math.abs(b - g - (q[2] - q[1]))) + 0.8 * Math.abs(luma(r - q[0], g - q[1], b - q[2]));
}

function plateStats(plate) {
  const d = plate.data;
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < d.length; i += 4 * 7) {
    hist[Math.round(luma(d[i], d[i + 1], d[i + 2]))]++;
    n++;
  }
  let med = 0;
  for (let acc = 0; med < 255; med++) {
    acc += hist[med];
    if (acc >= n / 2) break;
  }
  let top = 255;
  for (let acc = 0; top > 0; top--) {
    acc += hist[top];
    if (acc >= n * 0.005) break;
  }
  return { whiteMin: Math.max(170, Math.min(200, top - 25)), dark: 0.55 * med };
}

function isRoofPx(plate, x, y, st) {
  const i = (y * plate.width + x) * 4;
  const r = plate.data[i];
  const g = plate.data[i + 1];
  const b = plate.data[i + 2];
  return luma(r, g, b) >= st.whiteMin && Math.max(r, g, b) - Math.min(r, g, b) <= 30 && r <= b + 18;
}

/** Photo evidence for one outline in image pixels. */
function photoEvidence(plate, ringPx, mpu, st, sun) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ringPx) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  const m = P.ringOutM / mpu;
  const x0 = Math.max(0, Math.floor(minX - m));
  const y0 = Math.max(0, Math.floor(minY - m));
  const x1 = Math.min(plate.width - 1, Math.ceil(maxX + m));
  const y1 = Math.min(plate.height - 1, Math.ceil(maxY + m));
  if (x1 - x0 < 3 || y1 - y0 < 3) return null;
  const inside = [];
  const bins = new Map();
  let ringN = 0;
  const inPx = P.ringInM / mpu;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const c = [x + 0.5, y + 0.5];
      if (pointInRing(c, ringPx)) {
        inside.push([x, y]);
        continue;
      }
      if (ringGap(c, ringPx) < inPx) continue;
      const i = (y * plate.width + x) * 4;
      const key = ((plate.data[i] >> 4) << 8) | ((plate.data[i + 1] >> 4) << 4) | (plate.data[i + 2] >> 4);
      let b = bins.get(key);
      if (!b) bins.set(key, (b = [0, 0, 0, 0]));
      b[0]++;
      b[1] += plate.data[i];
      b[2] += plate.data[i + 1];
      b[3] += plate.data[i + 2];
      ringN++;
    }
  }
  if (inside.length < 20 || ringN < 20) return null;
  const refs = [];
  const sorted = [...bins.values()].sort((p, q) => q[0] - p[0]);
  for (const b of sorted) {
    if (refs.length >= 2 || (refs.length && b[0] < P.refShare * ringN)) break;
    const c = [b[1] / b[0], b[2] / b[0], b[3] / b[0]];
    if (refs.some((q) => groundDistance(c[0], c[1], c[2], q) < P.groundDist)) continue;
    refs.push(c);
  }
  let roof = 0;
  let ground = 0;
  for (const [x, y] of inside) {
    if (isRoofPx(plate, x, y, st)) roof++;
    const i = (y * plate.width + x) * 4;
    if (refs.some((q) => groundDistance(plate.data[i], plate.data[i + 1], plate.data[i + 2], q) < P.groundDist)) ground++;
  }
  // A roof beside the outline: the outline moved 1 or 2 m in 8 directions.
  let beside = 0;
  for (const s of P.besideM) {
    for (let d = 0; d < 8; d++) {
      const a = (Math.PI * d) / 4;
      const ox = Math.round((Math.cos(a) * s) / mpu);
      const oy = Math.round((Math.sin(a) * s) / mpu);
      let n = 0;
      let w = 0;
      for (const [x, y] of inside) {
        const nx = x + ox;
        const ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= plate.width || ny >= plate.height) continue;
        n++;
        if (isRoofPx(plate, nx, ny, st)) w++;
      }
      if (n) beside = Math.max(beside, w / n);
    }
  }
  // Shadow beside it, in any of 8 directions, and along the sun.
  let shadeAny = 0;
  for (let d = 0; d < 8; d++) {
    const a = (Math.PI * d) / 4;
    const v = shiftedDarkShare(plate, inside, Math.cos(a), Math.sin(a), P.shadeM, mpu, st.dark);
    if (v != null && v > shadeAny) shadeAny = v;
  }
  const shadeSun = sun && sun.ok ? shiftedDarkShare(plate, inside, sun.dx, sun.dy, P.shadeM, mpu, st.dark) : null;
  return { roof: roof / inside.length, ground: ground / inside.length, beside, shadeAny, shadeSun };
}

/** Lidar cells under a lon/lat ring: count, covered, and the tall share. */
function lidarEvidence(grid, ring) {
  if (!grid || !grid.cells) return null;
  const merc = ring.map((p) => mercator(p[0], p[1]));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of merc) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  const ix0 = Math.floor((minX - grid.originX) / grid.cell);
  const iy0 = Math.floor((minY - grid.originY) / grid.cell);
  const ix1 = Math.floor((maxX - grid.originX) / grid.cell);
  const iy1 = Math.floor((maxY - grid.originY) / grid.cell);
  let cells = 0;
  let hit = 0;
  let tall = 0;
  for (let iy = iy0; iy <= iy1; iy++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const c = [grid.originX + (ix + 0.5) * grid.cell, grid.originY + (iy + 0.5) * grid.cell];
      if (!pointInRing(c, merc)) continue;
      cells++;
      const rec = grid.cells.get(ix + "," + iy);
      if (!rec || !rec.n) continue;
      hit++;
      let top = null;
      for (const arr of [rec.b, rec.u, rec.v]) for (const z of arr || []) if (top == null || z > top) top = z;
      for (const z of [rec.fMax, rec.tMax, rec.uMax, rec.vegMax]) if (z != null && (top == null || z > top)) top = z;
      const g = groundAt(grid, ix, iy);
      if (top != null && g != null && top - g >= P.tallM) tall++;
    }
  }
  return { cells, hit, tall: hit ? tall / hit : 0 };
}

/**
 * @param {object} o
 * @param {object[]} o.features GeoJSON building features
 * @param {Array<Array<number[]>>} o.zones lon/lat rings of RV parks, campgrounds (not tent-only) and mobile-home parks
 * @param {{width:number,height:number,data:Uint8Array}} o.plate decoded photo matching o.frame
 * @param {object} o.frame image frame
 * @param {object} [o.lidar] lidar grid
 * @returns {{features: object[], dropped: object[]}}
 */
function dropStaleCampFootprints({ features, zones, plate, frame, lidar }) {
  const list = features || [];
  if (!zones || !zones.length || !plate || !plate.data || !frame || !(frame.mpuX > 0)) return { features: list, dropped: [] };
  if (plate.width !== frame.imgW || plate.height !== frame.imgH) return { features: list, dropped: [] };
  const mpu = Math.min(frame.mpuX, frame.mpuY > 0 ? frame.mpuY : frame.mpuX);
  const st = plateStats(plate);
  const sun = photoSun(plate, mpu);
  st.dark = sun.dark || st.dark;
  const kept = [];
  const dropped = [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    const verdict = f ? staleVerdict(f, zones, plate, frame, mpu, st, sun, lidar) : null;
    if (verdict) dropped.push(Object.assign({ index: i }, verdict));
    else kept.push(f);
  }
  return { features: dropped.length ? kept : list, dropped, sun };
}

function staleVerdict(f, zones, plate, frame, mpu, st, sun, lidar) {
  const props = f.properties || {};
  if (props.source === "imagery-roof") return null;
  const rings = exteriorRings(f.geometry);
  if (rings.length !== 1) return null;
  const ring = rings[0];
  if (ring.length < 4) return null;
  const a = areaM2(ring);
  if (a < P.minM2 || a > P.maxM2) return null;
  let cx = 0;
  let cy = 0;
  for (const p of ring) {
    cx += p[0];
    cy += p[1];
  }
  const c = [cx / ring.length, cy / ring.length];
  if (!zones.some((z) => z && z.length >= 3 && pointInRing(c, z))) return null;
  const ringPx = ring.map((p) => llToImagePx(p[0], p[1], frame));
  const e = photoEvidence(plate, ringPx, mpu, st, sun);
  if (!e) return null;
  if (e.roof >= P.roofMax || e.ground < P.groundMin) return null;
  if (e.beside >= P.besideMax) return null;
  if (e.shadeAny >= P.shadeAnyMax) return null;
  const l = lidarEvidence(lidar, ring);
  const covered = l && l.cells >= P.lidarMinCells && l.hit >= P.lidarCover * l.cells;
  if (covered && l.tall >= P.lidarTall) return null;
  const lidarClear = covered && l.tall < P.lidarClear;
  const sunClear = e.shadeSun != null && e.shadeSun < P.shadeSunMax;
  if (!lidarClear && !sunClear) return null;
  return {
    ring,
    areaM2: Math.round(a),
    by: lidarClear ? "lidar" : "shadow",
    roof: +e.roof.toFixed(2),
    ground: +e.ground.toFixed(2),
    tall: covered ? +l.tall.toFixed(2) : null,
    shade: e.shadeSun != null ? +e.shadeSun.toFixed(2) : null,
    c,
  };
}

module.exports = { dropStaleCampFootprints, lidarEvidence, PARAMS: P };

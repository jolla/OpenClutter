"use strict";

const { llToPx, pxToLl, pxToClipboard, applyAffine } = require("./geo-frame");
const { clipZone } = require("./hamina-clipboard");
const { measuredFoliageMaterial, materialForVegetation, liftFoliagePair, individualTreeParts } = require("./materials");

const { MAX_TREES, maxTreesForBbox, canopyHeightM } = require("./tree-source");
const { crownsForExport } = require("./canopy-height");
const { BUILDING_BUFFER_M, createClipSet, clipFoliageRing, dissolveFoliageRings, pointInRing, intersectionAreaPx } = require("./poly-clip");
const polygonClipping = require("polygon-clipping");

function pointInAabb(x, y, boxes, pad) {
  for (const b of boxes) {
    if (x >= b.minX - pad && x <= b.maxX + pad && y >= b.minY - pad && y <= b.maxY + pad) {
      return true;
    }
  }
  return false;
}

/** True when a lon/lat sits on a kept building (plus a ~2 px halo). */
function treeHitsBuilding(lon, lat, frame, buildingAabbs) {
  if (!buildingAabbs || !buildingAabbs.length || !frame) return false;
  const [x, y] = llToPx(lon, lat, frame);
  const pad = 2 / Math.max(frame.mpuX, 0.01);
  return pointInAabb(x, y, buildingAabbs, pad);
}

function normalizeTreePoints(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const t of raw) {
    if (!t) continue;
    if (Array.isArray(t) && t.length >= 2) {
      const lon = +t[0];
      const lat = +t[1];
      if (Number.isFinite(lon) && Number.isFinite(lat)) out.push({ lon, lat });
      continue;
    }
    const lon = +(t.lon ?? t.lng ?? t.longitude);
    const lat = +(t.lat ?? t.latitude);
    if (Number.isFinite(lon) && Number.isFinite(lat)) {
      const pct = t.pct != null ? +t.pct : null;
      const score = t.score != null ? +t.score : null;
      const row = { lon, lat, pct, score };
      if (t.heightM != null && Number.isFinite(+t.heightM)) row.heightM = +t.heightM;
      if (t.median) row.median = true;
      out.push(row);
    }
  }
  return out;
}

function toClipRing(ringPx, frame, affine, lonLatHint) {
  if (affine && lonLatHint) {
    const [cx, cy] = llToPx(lonLatHint.lon, lonLatHint.lat, frame);
    const [x0, y0] = applyAffine(lonLatHint.lon, lonLatHint.lat, affine);
    return ringPx.map(([x, y]) => [
      x0 + (x - cx) * frame.mpuX,
      y0 + (y - cy) * frame.mpuY,
    ]);
  }
  return ringPx.map(([x, y]) => {
    const cx = Math.min(frame.imgW, Math.max(0, x));
    const cy = Math.min(frame.imgH, Math.max(0, y));
    const m = pxToClipboard(cx, cy, frame);
    return [
      Math.min(0, Math.max(-frame.widthM, m[0])),
      Math.min(0, Math.max(-frame.lengthM, m[1])),
    ];
  });
}

function medianNumber(values) {
  const s = (values || []).filter((n) => n > 2 && n < 80).sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function medianGap(sorted) {
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i] - sorted[i - 1];
    if (d > 1e-8) gaps.push(d);
  }
  if (!gaps.length) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[(gaps.length / 2) | 0];
}

function uniqueSorted(nums) {
  const s = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const out = [];
  for (const n of s) {
    if (!out.length || Math.abs(n - out[out.length - 1]) > 1e-8) out.push(n);
  }
  return out;
}

/** NLCD getSamples spacing. Null when the points are not a canopy raster. */
function inferCanopyCell(hits, frame) {
  if (!hits || hits.length < 4 || !frame) return null;
  const dx = medianGap(uniqueSorted(hits.map((h) => h.lon)));
  const dy = medianGap(uniqueSorted(hits.map((h) => h.lat)));
  if (!(dx > 1e-6) || !(dy > 1e-6)) return null;
  const lat = (frame.south + frame.north) / 2;
  const mLon = dx * 111320 * Math.cos((lat * Math.PI) / 180);
  const mLat = dy * 110540;
  if (mLon < 8 || mLon > 80 || mLat < 8 || mLat > 80) return null;
  return { lon: dx, lat: dy };
}

function ringAbsArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(a / 2);
}

function dropCollinear(ring) {
  if (!ring || ring.length < 4) return ring;
  const open = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring.slice();
  const out = [];
  for (let i = 0; i < open.length; i++) {
    const prev = open[(i + open.length - 1) % open.length];
    const cur = open[i];
    const next = open[(i + 1) % open.length];
    const cross = (cur[0] - prev[0]) * (next[1] - cur[1]) - (cur[1] - prev[1]) * (next[0] - cur[0]);
    if (Math.abs(cross) > 1e-12) out.push(cur);
  }
  if (out.length < 3) return ring;
  out.push(out[0]);
  return out;
}

function chainBoundary(edges) {
  const key = (x, y) => x + "," + y;
  const from = new Map();
  for (const e of edges) {
    const k = key(e[0], e[1]);
    if (!from.has(k)) from.set(k, []);
    from.get(k).push(e);
  }
  const used = new Set();
  const rings = [];
  for (const e of edges) {
    const id = e.join(",");
    if (used.has(id)) continue;
    const ring = [[e[0], e[1]]];
    let cur = e;
    used.add(id);
    for (let guard = 0; guard < edges.length + 2; guard++) {
      if (cur[2] === ring[0][0] && cur[3] === ring[0][1]) break;
      const opts = from.get(key(cur[2], cur[3])) || [];
      let next = null;
      for (const cand of opts) {
        const cid = cand.join(",");
        if (!used.has(cid)) {
          next = cand;
          break;
        }
      }
      if (!next) break;
      used.add(next.join(","));
      ring.push([next[0], next[1]]);
      cur = next;
    }
    if (ring.length >= 4 && cur[2] === ring[0][0] && cur[3] === ring[0][1]) {
      ring.push(ring[0]);
      rings.push(ring);
    }
  }
  return rings;
}

/**
 * Connected NLCD cells above the canopy threshold become one outline per
 * height band. A single cell is not emitted as its own crown circle.
 */
function canopyPolygonsFromHits(hits, frame, buildingAabbs, heightSample, requireMeasured) {
  const cell = inferCanopyCell(hits, frame);
  if (!cell) return [];
  const originLon = frame.west;
  const originLat = frame.south;
  const pad = 2 / Math.max(frame.mpuX, 0.01);
  const grid = new Map();
  for (const h of hits) {
    const pct = h.pct != null ? +h.pct : (h.score || 0) * 100;
    if (!(pct >= 18)) continue;
    const [x, y] = llToPx(h.lon, h.lat, frame);
    if (x < 0 || y < 0 || x > frame.imgW || y > frame.imgH) continue;
    if (buildingAabbs && pointInAabb(x, y, buildingAabbs, pad)) continue;
    const ix = Math.round((h.lon - originLon) / cell.lon);
    const iy = Math.round((h.lat - originLat) / cell.lat);
    const key = ix + ":" + iy;
    const prev = grid.get(key);
    if (!prev || pct > prev.pct) {
      let heightM = 0;
      let measured = false;
      if (heightSample) {
        const sampled = +heightSample(h.lon, h.lat);
        if (sampled > 2 && sampled < 80) {
          heightM = sampled;
          measured = true;
        }
      }
      if (!(heightM > 2)) {
        // A real canopy-height grid must not be replaced by a percent bucket.
        if (requireMeasured) continue;
        heightM = canopyHeightM(pct, h.lon, h.lat);
      }
      grid.set(key, { ix, iy, lon: h.lon, lat: h.lat, pct, heightM, measured });
    }
  }
  const seen = new Set();
  const comps = [];
  for (const cell0 of grid.values()) {
    const startKey = cell0.ix + ":" + cell0.iy;
    if (seen.has(startKey)) continue;
    const stack = [cell0];
    seen.add(startKey);
    const comp = [];
    while (stack.length) {
      const cur = stack.pop();
      comp.push(cur);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const n = grid.get(cur.ix + dx + ":" + (cur.iy + dy));
          if (!n) continue;
          const nk = n.ix + ":" + n.iy;
          if (seen.has(nk)) continue;
          if (Math.abs(n.heightM - cur.heightM) > 3) continue;
          seen.add(nk);
          stack.push(n);
        }
      }
    }
    if (comp.length >= 2) comps.push(comp);
  }
  const polygons = [];
  for (const comp of comps) {
    const edges = [];
    const addEdge = (x0, y0, x1, y1) => {
      const rev = [x1, y1, x0, y0].join(",");
      const idx = edges.findIndex((e) => e.join(",") === rev);
      if (idx >= 0) edges.splice(idx, 1);
      else edges.push([x0, y0, x1, y1]);
    };
    for (const c of comp) {
      addEdge(c.ix, c.iy, c.ix + 1, c.iy);
      addEdge(c.ix + 1, c.iy, c.ix + 1, c.iy + 1);
      addEdge(c.ix + 1, c.iy + 1, c.ix, c.iy + 1);
      addEdge(c.ix, c.iy + 1, c.ix, c.iy);
    }
    const rings = chainBoundary(edges);
    if (!rings.length) continue;
    rings.sort((a, b) => ringAbsArea(b) - ringAbsArea(a));
    const gridRing = dropCollinear(rings[0]);
    const lonLat = gridRing.map(([ix, iy]) => [
      originLon + (ix - 0.5) * cell.lon,
      originLat + (iy - 0.5) * cell.lat,
    ]);
    const ringPx = lonLat.map(([lon, lat]) => llToPx(lon, lat, frame));
    const measuredVals = comp.filter((c) => c.measured).map((c) => c.heightM);
    const heightM = measuredVals.length ? medianNumber(measuredVals) : 0;
    const pct = medianNumber(comp.map((c) => c.pct));
    const tier = heightM > 2 ? (heightM >= 12 ? "heavy" : "light") : pct >= 50 ? "heavy" : "light";
    const material = materialForVegetation(heightM, tier);
    if (!material || ringPx.length < 4) continue;
    polygons.push({ ringPx, ringLonLat: lonLat, material, kind: "canopy", shape: "polygon" });
  }
  return polygons;
}

/**
 * CHM canopy as foliage polygons. One ring per connected outline, measured
 * height, no circles and no grid squares. Empty when the grid does not resolve canopy.
 */
function ringBoxes(rings) {
  const out = [];
  for (const ring of rings || []) {
    if (!ring || ring.length < 3) continue;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < ring.length; i++) {
      const x = ring[i][0];
      const y = ring[i][1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    if (maxX > minX && maxY > minY) out.push({ ring, minX, minY, maxX, maxY });
  }
  return out;
}

/** Point-in-ring test for footprints, pavement, and water. Boxes are built once. */
function blockerFromRings(frame, buildingRings, maskRings, maskPolygons) {
  const rings = ringBoxes(buildingRings).concat(ringBoxes(maskRings));
  for (const poly of maskPolygons || []) {
    if (poly && poly[0]) rings.push.apply(rings, ringBoxes([poly[0]]));
  }
  if (!frame || !rings.length) return null;
  return (lon, lat) => {
    const p = llToPx(lon, lat, frame);
    for (let i = 0; i < rings.length; i++) {
      const b = rings[i];
      if (p[0] < b.minX || p[0] > b.maxX || p[1] < b.minY || p[1] > b.maxY) continue;
      if (pointInRing(p, b.ring)) return true;
    }
    return false;
  };
}

function chmCrownPolygons(grid, frame, buildingAabbs, hits, opts) {
  const ringBlock = blockerFromRings(
    frame,
    opts && opts.buildingRings,
    opts && opts.maskRings,
    opts && opts.maskPolygons
  );
  // Footprint rings only. A building bounding box also covers the courtyard
  // and the trees beside an L-shaped roof, which is how fairway canopy disappeared.
  // A measured crown is not dropped for sitting far from an NLCD cell. Percent
  // can only raise a cell that already has a height. Empty CHM stays empty.
  const blocked = (lon, lat) => (ringBlock ? ringBlock(lon, lat) : false);
  void buildingAabbs;
  const packed = crownsForExport(grid, {
    blocked,
    hits,
    maxPolygons: opts && opts.maxPolygons,
  });
  const crowns = packed.crowns;
  const coarsened = packed.coarsened;
  const polygons = [];
  for (let i = 0; i < crowns.length; i++) {
    const c = crowns[i];
    const ringPx = c.ringLonLat.map(([lon, lat]) => llToPx(lon, lat, frame));
    if (ringPx.length < 4) continue;
    const tier = c.heightM >= 12 ? "heavy" : "light";
    const material = materialForVegetation(c.heightM, tier);
    if (!material) continue;
    polygons.push({
      ringPx,
      ringLonLat: c.ringLonLat,
      material,
      kind: "canopy",
      shape: "polygon",
    });
  }
  polygons.coarsened = !!coarsened;
  return polygons;
}

/** Clipboard type for a canopy polygon. Stock picker ids, or a measured foliage-m-* type. No trunks. */
function clipboardForCanopy(material) {
  if (!material || !material.name) return null;
  if (material.name === "Foliage - Heavy") return { typeId: "foliage-heavy" };
  if (material.name === "Foliage - Light") return { typeId: "foliage-light" };
  const measured = measuredFoliageMaterial(material.top_height);
  if (!measured || !measured.clipType) return null;
  return {
    typeId: measured.typeId,
    clipType: Object.assign({}, measured.clipType, {
      name: material.name,
      color: material.display_color,
      attenuationDbPerMeter: material.rf_properties.attenuation_per_m,
      transparencyEnabled: true,
    }),
  };
}

/**
 * Foliage rings for OpenIntent.
 * When a CHM grid is present, each connected canopy is one polygon: the
 * ring follows the traced CHM edge and the material height is the measured top.
 * Cells on a building footprint or a pavement/road polygon are cleared first.
 * NLCD percent can only extend a cell that already has a measured height.
 * A canopy-height timeout sets omitFoliage and emits nothing.
 * An export that asked for measured crowns (chmRequired) does not draw
 * NLCD cell outlines when the height grid is missing. Those outlines are
 * axis-aligned squares. Multi-cell NLCD patches are only the geometry when
 * the caller did not ask for a canopy-height grid. Tree points,
 * median dots, and crown circles are not emitted and do not become trees.
 * A compact measured crown is one tree: a round stem under that crown, the
 * crown bottom above the ground, and the crown top at the measured height.
 * The crown is three or four stacked footprints. The widest band sits in the
 * lower middle, the bottom band is narrower, and the top is about a third of
 * the traced area, so the side view is a dome. A merged canopy keeps the
 * traced outline on the ground and insets each upper layer from the edge.
 * A notched woods whose vertex average sits outside the ring is scaled toward
 * an interior point and clipped back to that outline, so the perimeter still
 * rolls off instead of standing up as a wall. A crowd keeps
 * that shape; extra trees are left out before a crown is flattened to one layer.
 * The stem is about 1 m across and stays well inside the crown. A wide or
 * long canopy has no invented stem.
 * `treePoints` is accepted so callers can keep passing placed points; they
 * do not become attenuation areas.
 */

/** A crown this wide, or wider, reads as canopy rather than one stem. */
const TREE_MAX_SIDE_M = 22;
const TREE_MIN_SIDE_M = 6;
const TREE_MAX_AREA_M2 = 320;
const TREE_MIN_AREA_M2 = 20;
const TREE_MAX_ASPECT = 1.8;
/** Hard max. A real stem is about 0.3–1 m; wider than this rivals the crown. */
const TRUNK_MAX_M = 1;
/** Also scale with the crown, so a small traced crown cannot grow a 1 m stem. */
const TRUNK_OF_CROWN = 0.18;
const TRUNK_SIDES = 12;
/**
 * Foliage areas, including stems. Above this, the smallest crowns lose a
 * layer. They are not flattened to one slab, and the attenuation cap still
 * drops whole trees once the Hamina area budget is full.
 */
const CROWN_LAYER_BUDGET = 720;
/** Each band stays thicker than 2 m, which is the custom-height floor. */
const MIN_CROWN_BAND_M = 2.1;

function ringPxArea(ring) {
  if (!ring || ring.length < 3) return 0;
  let a = 0;
  const n = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.length - 1 : ring.length;
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a / 2);
}

function ringCentroidPx(ring) {
  const n = ring && ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
    ? ring.length - 1
    : (ring && ring.length) || 0;
  if (n < 3) return null;
  let x = 0;
  let y = 0;
  for (let i = 0; i < n; i++) {
    x += ring[i][0];
    y += ring[i][1];
  }
  return [x / n, y / n];
}

/**
 * True when an existing canopy ring is one discrete tree. A woods, a tree
 * line, and a 30 m canopy cell are not. This does not create a ring.
 */
function looksLikeIndividualTree(ringPx, frame, heightM) {
  const h = Number(heightM);
  if (!(h >= 5 && h < 50) || !ringPx || ringPx.length < 4 || !frame) return false;
  const mpuX = frame.mpuX || frame.mpu || 1;
  const mpuY = frame.mpuY || mpuX;
  if (!(mpuX > 0) || !(mpuY > 0)) return false;
  const area = ringPxArea(ringPx) * mpuX * mpuY;
  if (!(area >= TREE_MIN_AREA_M2 && area <= TREE_MAX_AREA_M2)) return false;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < ringPx.length; i++) {
    const x = ringPx[i][0];
    const y = ringPx[i][1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const w = (maxX - minX) * mpuX;
  const ht = (maxY - minY) * mpuY;
  const side = Math.max(w, ht);
  const short = Math.min(w, ht);
  if (!(short >= TREE_MIN_SIDE_M) || side > TREE_MAX_SIDE_M) return false;
  if (side / short > TREE_MAX_ASPECT) return false;
  if (area / (w * ht) < 0.45) return false;
  const c = ringCentroidPx(ringPx);
  if (!c || !pointInRing(c, ringPx)) return false;
  return true;
}

function crownShortM(ringPx, frame) {
  const mpuX = frame.mpuX || frame.mpu || 1;
  const mpuY = frame.mpuY || mpuX;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < ringPx.length; i++) {
    const x = ringPx[i][0];
    const y = ringPx[i][1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return Math.min((maxX - minX) * mpuX, (maxY - minY) * mpuY);
}

/** Closed regular polygon. Ground diameter is `diameterM` on both axes. */
function circleRingPx(c, diameterM, mpuX, mpuY, sides) {
  const rx = diameterM / 2 / mpuX;
  const ry = diameterM / 2 / mpuY;
  const ring = [];
  for (let i = 0; i < sides; i++) {
    const a = (2 * Math.PI * i) / sides - Math.PI / sides;
    ring.push([c[0] + rx * Math.cos(a), c[1] + ry * Math.sin(a)]);
  }
  ring.push(ring[0]);
  return ring;
}

function circleFits(ring, crown) {
  const n = ring.length - 1;
  for (let i = 0; i < n; i++) {
    if (!pointInRing(ring[i], crown)) return false;
  }
  return true;
}

/**
 * Stem under one discrete crown. About 1 m across, and never more than a
 * fraction of the crown, so the stem stays clearly thinner. The footprint is
 * a 12-gon, not a square. Vertices stay inside the crown; a tight crown
 * shrinks the stem instead of dropping it or poking out.
 */
function trunkRingPx(ringPx, frame) {
  const c = ringCentroidPx(ringPx);
  if (!c || !frame || !ringPx) return null;
  const mpuX = frame.mpuX || frame.mpu || 1;
  const mpuY = frame.mpuY || mpuX;
  if (!(mpuX > 0) || !(mpuY > 0)) return null;
  const shortM = crownShortM(ringPx, frame);
  if (!(shortM > 0)) return null;
  let diameterM = Math.min(TRUNK_MAX_M, shortM * TRUNK_OF_CROWN);
  for (let attempt = 0; attempt < 8; attempt++) {
    if (!(diameterM >= 0.25)) return null;
    const ring = circleRingPx(c, diameterM, mpuX, mpuY, TRUNK_SIDES);
    if (circleFits(ring, ringPx)) return ring;
    diameterM = Math.round(diameterM * 0.75 * 100) / 100;
  }
  return null;
}

function roundTenths(n) {
  return Math.round(Number(n) * 10) / 10;
}

function crownThicknessM(material) {
  if (!material) return 0;
  const top = Number(material.top_height);
  const bottom = Number(material.bottom_height) >= 1 ? Number(material.bottom_height) : 0;
  if (!(top > bottom)) return 0;
  return roundTenths(top - bottom);
}

/**
 * Discrete trees get 3 bands whenever the crown is thick enough, and 4 on a
 * short stand of tall crowns. A merged canopy gets 3, then 2. A crown that
 * cannot hold two bands thicker than 2 m stays one footprint.
 */
function wantedCrownLayers(discrete, thickness, treeCount) {
  const fit = Math.floor((Number(thickness) + 1e-6) / MIN_CROWN_BAND_M);
  if (fit < 2) return 1;
  if (!discrete) return fit >= 3 ? 3 : 2;
  // A crowd of palms is many stems. Two bands each, not three or four,
  // so the area cap keeps the trees instead of the extra layers.
  if (treeCount > 80) return 2;
  if (fit >= 4 && treeCount <= 60) return 4;
  if (fit >= 3) return 3;
  return 2;
}

/**
 * Area of each band relative to the traced crown, lowest first.
 * A tree is narrow, widest, then a top near a third. A woods stays full
 * at the ground and steps in.
 */
function domeAreaFractions(n, discrete) {
  if (!(n >= 2)) return [1];
  if (!discrete) {
    if (n === 2) return [1, 0.36];
    return [1, 0.68, 0.34];
  }
  if (n === 2) return [1, 0.36];
  if (n === 3) return [0.66, 1, 0.36];
  return [0.62, 1, 0.64, 0.38];
}

function scaleRingAbout(ring, scale) {
  if (!ring || ring.length < 4) return null;
  if (!(scale > 0)) return null;
  if (scale >= 0.999) return ring;
  const c = ringCentroidPx(ring);
  if (!c) return null;
  const closed =
    ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const last = closed ? ring.length - 1 : ring.length;
  const out = [];
  for (let i = 0; i < last; i++) {
    out.push([c[0] + (ring[i][0] - c[0]) * scale, c[1] + (ring[i][1] - c[1]) * scale]);
  }
  if (out.length < 3) return null;
  out.push([out[0][0], out[0][1]]);
  return out;
}

function ringSpanPx(ring) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const n =
    ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.length - 1
      : ring.length;
  for (let i = 0; i < n; i++) {
    const x = ring[i][0];
    const y = ring[i][1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { w: maxX - minX, h: maxY - minY };
}

/** Same 3 m / 4 px floor the OpenIntent emitter uses. An inset under it is skipped. */
function crownSpanFloorPx(frame) {
  const mpuX = (frame && (frame.mpuX || frame.mpu)) || 1;
  return Math.max(4, 3 / Math.max(mpuX, 0.01));
}

function ringClearsSpan(ring, floorPx) {
  const b = ringSpanPx(ring);
  return b.w >= floorPx && b.h >= floorPx;
}

/** An inset that leaves the traced ring would cover a roof or pond the clip removed. */
function insetStaysIn(inner, outer) {
  if (!inner || !outer) return false;
  const closed =
    inner.length > 1 && inner[0][0] === inner[inner.length - 1][0] && inner[0][1] === inner[inner.length - 1][1];
  const n = closed ? inner.length - 1 : inner.length;
  for (let i = 0; i < n; i++) {
    if (!pointInRing(inner[i], outer)) return false;
  }
  const area = ringPxArea(inner);
  if (!(area > 1)) return false;
  return intersectionAreaPx(inner, outer) >= area * 0.9;
}

/** A thickness near the stock 6 m picker is nudged so the band stays custom. */
function pickBandMaterial(target, tier) {
  let h = roundTenths(target);
  if (!(h > 2)) return null;
  let base = materialForVegetation(h, tier);
  if (!base) return null;
  if (Math.abs(Number(base.top_height) - h) > 0.05) {
    const snapped = Number(base.top_height);
    h = roundTenths(h >= snapped ? snapped + 0.4 : Math.max(2.1, snapped - 0.4));
    base = materialForVegetation(h, tier);
    if (!base || Math.abs(Number(base.top_height) - h) > 0.05) return null;
  }
  return { h, base };
}

/**
 * Split one canopy into bands that share the class dB/m. A stock snap that
 * opens a gap, or a band that no longer ends on the measured top, returns
 * null so the caller keeps the single footprint.
 */
function buildCrownBands(material, n) {
  if (!material || !(n >= 2)) return null;
  const lifted = Number(material.bottom_height) >= 1;
  const bottom0 = lifted ? roundTenths(material.bottom_height) : 0;
  const top0 = Number(material.top_height);
  if (!(top0 > bottom0)) return null;
  const thickness = roundTenths(top0 - bottom0);
  if (!(thickness > 2 * n)) return null;
  const tier = String(material.name || "").indexOf("Light") >= 0 ? "light" : "heavy";
  const bands = [];
  let bottom = bottom0;
  let remain = thickness;
  for (let i = 0; i < n; i++) {
    const left = n - i;
    let target = left === 1 ? remain : roundTenths(remain / left);
    if (left > 1) {
      const minRest = (left - 1) * 2.1;
      if (target > remain - minRest) target = roundTenths(remain - minRest);
      if (!(target > 2)) target = 2.1;
    }
    const picked = pickBandMaterial(target, tier);
    if (!picked) return null;
    if (left === 1 && Math.abs(picked.h - remain) > 0.15) return null;
    const b = roundTenths(bottom);
    const base = picked.base;
    let mat = base;
    let clip = clipboardForCanopy(base);
    if (b >= 1) {
      const pair = liftFoliagePair(base, b);
      if (!pair || !pair.material) return null;
      mat = pair.material;
      clip = { typeId: pair.typeId, clipType: pair.clipType };
    }
    const actualBottom = mat.bottom_height != null ? Number(mat.bottom_height) : 0;
    const actualTop = Number(mat.top_height);
    if (Math.abs(actualBottom - b) > 0.15) return null;
    if (bands.length && Math.abs(actualBottom - Number(bands[bands.length - 1].material.top_height)) > 0.15) {
      return null;
    }
    if (i === n - 1 && Math.abs(actualTop - top0) > 0.15) return null;
    bands.push({ material: mat, clip });
    bottom = roundTenths(b + picked.h);
    remain = roundTenths(top0 - bottom);
  }
  return bands.length === n ? bands : null;
}

function layerCounts(pending) {
  let treeCount = 0;
  for (let i = 0; i < pending.length; i++) if (pending[i].trunk) treeCount++;
  const plans = pending.map((row) => {
    const discrete = !!row.trunk;
    const thickness = crownThicknessM(row.area && row.area.material);
    return {
      n: wantedCrownLayers(discrete, thickness, treeCount),
      discrete,
      area: ringPxArea(row.area && row.area.ringPx),
    };
  });
  const cost = () => {
    let n = 0;
    for (let i = 0; i < plans.length; i++) n += plans[i].n + (plans[i].discrete ? 1 : 0);
    return n;
  };
  const shrink = (pred, next) => {
    while (cost() > CROWN_LAYER_BUDGET) {
      let best = -1;
      for (let i = 0; i < plans.length; i++) {
        if (!pred(plans[i])) continue;
        if (best < 0 || plans[i].area < plans[best].area) best = i;
      }
      if (best < 0) return;
      plans[best].n = next(plans[best].n);
    }
  };
  shrink((p) => p.discrete && p.n >= 4, () => 3);
  shrink((p) => !p.discrete && p.n >= 3, () => 2);
  shrink((p) => p.discrete && p.n >= 3, () => 2);
  return plans.map((p) => p.n);
}

function openCrownRing(ring) {
  if (!ring || ring.length < 4) return null;
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev[0] - p[0]) < 1e-6 && Math.abs(prev[1] - p[1]) < 1e-6) continue;
    out.push([p[0], p[1]]);
  }
  if (out.length >= 2) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) out.pop();
  }
  return out.length >= 3 ? out : null;
}

/** Move each edge inward by `insetM`. A flipped or spiked ring is rejected. */
function insetRingPx(ring, insetM, frame) {
  const open = openCrownRing(ring);
  const c = ringCentroidPx(ring);
  const mpuX = (frame && (frame.mpuX || frame.mpu)) || 1;
  const mpuY = (frame && (frame.mpuY || mpuX)) || 1;
  if (!open || !c || !(insetM > 0) || !(mpuX > 0) || !(mpuY > 0)) return null;
  const meters = open.map((p) => [(p[0] - c[0]) * mpuX, (p[1] - c[1]) * mpuY]);
  const n = meters.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const p = meters[i];
    const q = meters[(i + 1) % n];
    area += p[0] * q[1] - q[0] * p[1];
  }
  if (Math.abs(area) < 1e-4) return null;
  const ccw = area > 0;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const p = meters[i];
    const q = meters[(i + 1) % n];
    let dx = q[0] - p[0];
    let dy = q[1] - p[1];
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-4)) continue;
    dx /= len;
    dy /= len;
    const nx = ccw ? -dy : dy;
    const ny = ccw ? dx : -dx;
    lines.push({ x: p[0] + nx * insetM, y: p[1] + ny * insetM, dx, dy });
  }
  if (lines.length < 3) return null;
  const m = lines.length;
  const shifted = [];
  for (let i = 0; i < m; i++) {
    const A = lines[(i + m - 1) % m];
    const B = lines[i];
    const det = A.dx * B.dy - A.dy * B.dx;
    let pt;
    if (Math.abs(det) < 1e-8) pt = [B.x, B.y];
    else {
      const t = ((B.x - A.x) * B.dy - (B.y - A.y) * B.dx) / det;
      pt = [A.x + A.dx * t, A.y + A.dy * t];
      if (Math.hypot(pt[0] - B.x, pt[1] - B.y) > insetM * 2.5) pt = [B.x, B.y];
    }
    if (!Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) return null;
    const prev = shifted[shifted.length - 1];
    if (!prev || Math.hypot(prev[0] - pt[0], prev[1] - pt[1]) > 0.15) shifted.push(pt);
  }
  if (shifted.length < 3) return null;
  let area2 = 0;
  for (let i = 0; i < shifted.length; i++) {
    const p = shifted[i];
    const q = shifted[(i + 1) % shifted.length];
    area2 += p[0] * q[1] - q[0] * p[1];
  }
  if (ccw ? area2 <= 0 : area2 >= 0) return null;
  if (Math.abs(area2) >= Math.abs(area) * 0.97) return null;
  const keep = Math.min(24, shifted.length);
  const simple = [];
  for (let i = 0; i < keep; i++) {
    const idx = Math.round((i * (shifted.length - 1)) / Math.max(1, keep - 1));
    simple.push(shifted[idx]);
  }
  const px = simple.map((p) => [c[0] + p[0] / mpuX, c[1] + p[1] / mpuY]);
  px.push([px[0][0], px[0][1]]);
  return px;
}

function distToSeg(p, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  if (!(len2 > 1e-8)) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(p[0] - (a[0] + vx * t), p[1] - (a[1] + vy * t));
}

/** A point inside the crown. The vertex average of a notched woods often is not. */
function interiorAnchor(ring) {
  const c = ringCentroidPx(ring);
  if (c && pointInRing(c, ring)) return c;
  const open = openCrownRing(ring);
  if (!open) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < open.length; i++) {
    const p = open[i];
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  const steps = 8;
  let best = null;
  let bestD = 0;
  for (let iy = 0; iy < steps; iy++) {
    for (let ix = 0; ix < steps; ix++) {
      const q = [
        minX + ((ix + 0.5) / steps) * (maxX - minX),
        minY + ((iy + 0.5) / steps) * (maxY - minY),
      ];
      if (!pointInRing(q, ring)) continue;
      let d = Infinity;
      for (let i = 0; i < open.length; i++) {
        const sep = distToSeg(q, open[i], open[(i + 1) % open.length]);
        if (sep < d) d = sep;
      }
      if (d > bestD) {
        bestD = d;
        best = q;
      }
    }
  }
  return best;
}

function closeCrownRing(pts) {
  if (!pts || pts.length < 3) return null;
  const out = [];
  for (let i = 0; i < pts.length; i++) out.push([pts[i][0], pts[i][1]]);
  const a = out[0];
  const b = out[out.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) out.push([a[0], a[1]]);
  return out.length >= 4 ? out : null;
}

function largestExterior(multi) {
  let best = null;
  let bestA = 0;
  for (const poly of multi || []) {
    const r = poly && poly[0];
    if (!r || r.length < 4) continue;
    const aa = ringPxArea(r);
    if (aa > bestA) {
      bestA = aa;
      best = r;
    }
  }
  return best;
}

function subsampleCrown(ring, maxVerts) {
  const open = openCrownRing(ring);
  if (!open) return null;
  if (open.length <= maxVerts) return closeCrownRing(open);
  const simple = [];
  for (let i = 0; i < maxVerts; i++) simple.push(open[Math.floor((i * open.length) / maxVerts)]);
  return closeCrownRing(simple);
}

/** Scale toward an interior point, then keep only the part that stays on the traced crown. */
function clipScaledRing(ring, scale) {
  const origin = interiorAnchor(ring);
  const open = openCrownRing(ring);
  if (!origin || !open || !(scale > 0) || scale >= 0.999) return null;
  const scaled = [];
  for (let i = 0; i < open.length; i++) {
    const p = open[i];
    scaled.push([origin[0] + (p[0] - origin[0]) * scale, origin[1] + (p[1] - origin[1]) * scale]);
  }
  const pulled = pullRingInside(closeCrownRing(scaled), ring) || closeCrownRing(scaled);
  const pulledOpen = openCrownRing(pulled);
  if (!pulledOpen) return null;
  let inter;
  try {
    inter = polygonClipping.intersection([closeCrownRing(open)], [closeCrownRing(pulledOpen)]);
  } catch {
    return null;
  }
  const best = largestExterior(inter);
  if (!best) return null;
  let shaped = subsampleCrown(best, 24);
  if (shaped && openCrownRing(shaped).length < openCrownRing(best).length) {
    try {
      const again = polygonClipping.intersection([closeCrownRing(open)], [shaped]);
      const clipped = largestExterior(again);
      if (clipped && openCrownRing(clipped).length <= 36) shaped = closeCrownRing(openCrownRing(clipped));
    } catch {
      shaped = openCrownRing(best).length <= 36 ? closeCrownRing(openCrownRing(best)) : shaped;
    }
  }
  const n = shaped && openCrownRing(shaped);
  if (!n || n.length > 36) return null;
  return shaped;
}

/**
 * A notched woods has no clean parallel inset: the offset self-intersects and
 * the vertex average sits in the notch. Search a scale whose clipped footprint
 * is near the target fraction of the traced area.
 */
function clippedFraction(ring, frame, fraction) {
  const floor = crownSpanFloorPx(frame);
  const base = ringPxArea(ring);
  if (!(base > 1)) return null;
  const short = crownShortM(ring, frame);
  const mpuX = (frame && (frame.mpuX || frame.mpu)) || 1;
  const mpuY = (frame && (frame.mpuY || mpuX)) || 1;
  const floorM = Math.max(3.2, floor * Math.min(mpuX, mpuY));
  const minScale = short > floorM ? floorM / short : 1;
  if (!(minScale < 0.98)) return null;
  const target = Math.sqrt(Math.max(fraction, 0.22));
  let lo = Math.max(minScale, target * 0.72);
  let hi = Math.min(0.94, Math.max(target * 1.55, lo + 0.04));
  if (!(hi > lo)) return null;
  let best = null;
  let bestErr = Infinity;
  for (let k = 0; k < 5; k++) {
    const mid = (lo + hi) / 2;
    const shaped = clipScaledRing(ring, mid);
    if (!shaped || !ringClearsSpan(shaped, floor)) {
      hi = mid;
      continue;
    }
    const ratio = ringPxArea(shaped) / base;
    if (!(ratio > 0.12) || !(ratio < 0.92)) {
      if (ratio >= 0.92) hi = mid;
      else lo = mid;
      continue;
    }
    const err = Math.abs(ratio - fraction);
    if (err < bestErr) {
      bestErr = err;
      best = shaped;
    }
    if (err < 0.05) return shaped;
    if (ratio > fraction) hi = mid;
    else lo = mid;
  }
  if (!best) return null;
  const ratio = ringPxArea(best) / base;
  if (!(ratio < 0.85) || !(ratio > 0.12)) return null;
  return best;
}

/** Pull vertices that left the traced crown back to its boundary. */
function pullRingInside(ring, outer) {
  const open = openCrownRing(ring);
  const c = interiorAnchor(outer);
  if (!open || !c) return null;
  const out = [];
  for (let i = 0; i < open.length; i++) {
    const p = open[i];
    if (pointInRing(p, outer)) {
      out.push(p);
      continue;
    }
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 14; k++) {
      const mid = (lo + hi) / 2;
      const q = [c[0] + (p[0] - c[0]) * mid, c[1] + (p[1] - c[1]) * mid];
      if (pointInRing(q, outer)) lo = mid;
      else hi = mid;
    }
    out.push([c[0] + (p[0] - c[0]) * lo * 0.98, c[1] + (p[1] - c[1]) * lo * 0.98]);
  }
  if (out.length < 3) return null;
  out.push([out[0][0], out[0][1]]);
  return out;
}

/** Inset from the traced edge. A concave woods is scaled, then pulled back inside. */
function ringForFraction(ring, frame, fraction) {
  if (!(fraction > 0)) return null;
  if (fraction >= 0.98) return ring;
  const mpuX = (frame && (frame.mpuX || frame.mpu)) || 1;
  const mpuY = (frame && (frame.mpuY || mpuX)) || 1;
  const areaM = ringPxArea(ring) * mpuX * mpuY;
  const short = crownShortM(ring, frame);
  const floor = crownSpanFloorPx(frame);
  const floorM = Math.max(3.2, floor * Math.min(mpuX, mpuY));
  const limit = (short - floorM) / 2;
  const radius = Math.sqrt(Math.max(areaM, 1) / Math.PI);
  let inset = radius * (1 - Math.sqrt(Math.max(fraction, 0.22))) * 0.86;
  if (limit > 0.35 && inset > limit) inset = limit * 0.96;
  if (inset > 0.35) {
    const next = insetRingPx(ring, inset, frame);
    if (
      next &&
      ringClearsSpan(next, floor) &&
      insetStaysIn(next, ring) &&
      ringPxArea(next) < ringPxArea(ring) * 0.94
    ) {
      return next;
    }
  }
  const centroid = ringCentroidPx(ring);
  if (centroid && pointInRing(centroid, ring)) {
    const scaled = scaleRingAbout(ring, Math.sqrt(Math.max(fraction, 0.22)));
    const pulled = scaled && (insetStaysIn(scaled, ring) ? scaled : pullRingInside(scaled, ring));
    if (
      pulled &&
      ringClearsSpan(pulled, floor) &&
      insetStaysIn(pulled, ring) &&
      ringPxArea(pulled) < ringPxArea(ring) * 0.96
    ) {
      return pulled;
    }
  }
  return clippedFraction(ring, frame, fraction);
}

/**
 * Bands that cannot clear the span floor are dropped by asking for fewer
 * layers. The traced ring is always one of the bands that remain.
 */
function crownStack(row, frame, want) {
  const ring = row.area && row.area.ringPx;
  if (!ring || !(want >= 2)) return null;
  const discrete = !!row.trunk;
  for (let n = Math.min(want, 4); n >= 2; n--) {
    const fractions = domeAreaFractions(n, discrete);
    if (fractions.length !== n) continue;
    const bands = buildCrownBands(row.area.material, n);
    if (!bands || bands.length !== n) continue;
    const parts = [];
    let ok = true;
    for (let i = 0; i < n; i++) {
      const shaped = ringForFraction(ring, frame, fractions[i]);
      if (!shaped) {
        ok = false;
        break;
      }
      parts.push({
        ringPx: shaped,
        material: bands[i].material,
        clip: bands[i].clip,
        scale: fractions[i],
      });
    }
    if (ok) return parts;
  }
  return null;
}

function pushFoliageClip(clip, ringPx, frame, affine, seenClip, clipTypes, clipZones) {
  if (!clip) return;
  if (clip.clipType && !seenClip.has(clip.clipType.id)) {
    seenClip.add(clip.clipType.id);
    clipTypes.push(clip.clipType);
  }
  if (!clip.typeId) return;
  const zone = clipZone(clip.typeId, toClipRing(ringPx, frame, affine, null));
  if (zone) clipZones.push(zone);
}

function treePairsFromPoints(treePoints, frame, buildingAabbs, affine, opts) {
  void treePoints;
  const oiAreas = [];
  const clipZones = [];
  const clipTypes = [];
  const materials = [];
  const overlayRings = [];
  const seenClip = new Set();
  let foliageGeometry = "none";
  let polygons = [];
  let coarsened = false;
  if (opts && opts.omitFoliage) {
    foliageGeometry = "omitted";
  } else if (opts && opts.chmGrid) {
    polygons = chmCrownPolygons(opts.chmGrid, frame, buildingAabbs, opts && opts.canopyHits, opts);
    coarsened = !!polygons.coarsened;
    if (polygons.length) foliageGeometry = "chm-contour";
  }
  if (
    !polygons.length &&
    !(opts && opts.omitFoliage) &&
    !(opts && opts.chmGrid) &&
    !(opts && opts.chmRequired)
  ) {
    polygons = canopyPolygonsFromHits(
      opts && opts.canopyHits,
      frame,
      buildingAabbs,
      opts && opts.heightSample,
      false
    );
    if (polygons.length) foliageGeometry = "nlcd-polygon";
  }
  const bufferM = opts && opts.buildingBufferM > 0 ? opts.buildingBufferM : BUILDING_BUFFER_M;
  const clipSet = createClipSet(
    opts && opts.buildingRings,
    opts && opts.maskRings,
    opts && opts.maskPolygons,
    bufferM / Math.max(frame.mpuX || 1, 0.05)
  );
  const pushCanopy = (ringPx, material, shape) => {
    const pieces = clipFoliageRing(ringPx, clipSet);
    for (const piece of pieces) {
      oiAreas.push({
        ringPx: piece,
        material,
        kind: "canopy",
        shape: piece.length === ringPx.length ? shape : "polygon",
      });
      overlayRings.push(piece);
      if (material) materials.push(material);
    }
  };
  for (const poly of polygons) pushCanopy(poly.ringPx, poly.material, "polygon");
  // Clip against roofs and water, then dissolve so two patches do not paint
  // green on green. Clipboard follows the dissolved rings, not tree points.
  const dissolved = dissolveFoliageRings(oiAreas, clipSet);
  oiAreas.length = 0;
  overlayRings.length = 0;
  const slopeTop = opts && typeof opts.slopeTop === "function" ? opts.slopeTop : null;
  let foliageLifted = 0;
  const pending = [];
  for (const area of dissolved) {
    let clip = null;
    let trunk = null;
    let ground = 0;
    if (slopeTop && area.ringPx && area.ringPx.length >= 3) {
      const ll = area.ringPx.map((p) => pxToLl(p[0], p[1], frame));
      ground = Number(slopeTop(ll)) || 0;
    }
    const height = area.material && Number(area.material.top_height);
    if (looksLikeIndividualTree(area.ringPx, frame, height)) {
      const parts = individualTreeParts(area.material, ground);
      const stem = parts && trunkRingPx(area.ringPx, frame);
      if (parts && stem) {
        area.material = parts.crownMat;
        clip = parts.crownClip;
        trunk = {
          ringPx: stem,
          material: parts.trunkMat,
          kind: "trunk",
          shape: "polygon",
          clip: parts.trunkClip,
        };
        if (ground >= 1) foliageLifted++;
      }
    }
    if (!clip && ground >= 1 && area.material) {
      const lifted = liftFoliagePair(area.material, ground);
      if (lifted) {
        area.material = lifted.material;
        clip = { typeId: lifted.typeId, clipType: lifted.clipType };
        foliageLifted++;
      }
    }
    pending.push({ area, clip, trunk });
  }
  let canopyCount = 0;
  const counts = layerCounts(pending);
  for (let r = 0; r < pending.length; r++) {
    const row = pending[r];
    const area = row.area;
    const stack = crownStack(row, frame, counts[r]);
    const parts = stack || [
      {
        ringPx: area.ringPx,
        material: area.material,
        clip: row.clip || clipboardForCanopy(area.material),
        scale: 1,
      },
    ];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      oiAreas.push({
        ringPx: part.ringPx,
        material: part.material,
        kind: i === 0 ? "canopy" : "layer",
        shape: area.shape || "polygon",
      });
      if (part.ringPx && !(part.scale < 0.999)) overlayRings.push(part.ringPx);
      if (part.material) materials.push(part.material);
      pushFoliageClip(part.clip, part.ringPx, frame, affine, seenClip, clipTypes, clipZones);
    }
    canopyCount++;
    const trunk = row.trunk;
    if (!trunk) continue;
    oiAreas.push(trunk);
    if (trunk.ringPx) overlayRings.push(trunk.ringPx);
    pushFoliageClip(trunk.clip, trunk.ringPx, frame, affine, seenClip, clipTypes, clipZones);
  }
  return {
    oiAreas,
    clipZones,
    clipTypes,
    materials,
    count: canopyCount,
    foliageLifted,
    foliageGeometry,
    foliageCoarsened: coarsened,
    polygons: polygons.length,
    overlayPoints: [],
    overlayRings,
  };
}

module.exports = {
  MAX_TREES,
  maxTreesForBbox,
  pointInAabb,
  treeHitsBuilding,
  normalizeTreePoints,
  treePairsFromPoints,
  canopyPolygonsFromHits,
};

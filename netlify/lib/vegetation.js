"use strict";

const { llToPx, pxToLl, pxToClipboard, applyAffine } = require("./geo-frame");
const { clipZone } = require("./hamina-clipboard");
const {
  measuredFoliageMaterial,
  materialForVegetation,
  liftFoliagePair,
  individualTreeParts,
  standUnderstoryM,
  understoryClipPair,
  isUnderstoryOiName,
} = require("./materials");

const { MAX_TREES, maxTreesForBbox, canopyHeightM } = require("./tree-source");
const { crownsForExport, tracePixels } = require("./canopy-height");
const { BUILDING_BUFFER_M, createClipSet, clipFoliageRing, dissolveFoliageRings, pointInRing, intersectionAreaPx } = require("./poly-clip");
const polygonClipping = require("polygon-clipping");
const profile = require("./profile-log");

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
    segment: !!(opts && opts.segmentTrees),
  });
  const polygons = polygonsFromCrowns(packed.crowns, frame);
  polygons.coarsened = !!packed.coarsened;
  polygons.dropped = packed.dropped | 0;
  return polygons;
}

function polygonsFromCrowns(crowns, frame) {
  const polygons = [];
  const list = crowns || [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (!c || !c.ringLonLat) continue;
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
      segTree: c.segTree === true,
    });
  }
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
/** A woods this large gets an understory plus a raised crown. A smaller clump stays one mass. */
const STAND_LAYER_M2 = 800;
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
/** A segmented tree is one crown: up to 22 m across and 400 m², 4 m tall. */
const SEG_TREE_MAX_M2 = 400;
const SEG_TREE_MAX_SIDE_M = 24;
function segTreeFits(ringPx, frame, heightM) {
  const h = Number(heightM);
  if (!(h >= 4 && h < 60) || !ringPx || ringPx.length < 4 || !frame) return false;
  const area = canopyAreaM2(ringPx, frame);
  if (!(area >= 6 && area <= SEG_TREE_MAX_M2)) return false;
  const mpuX = frame.mpuX || frame.mpu || 1;
  const mpuY = frame.mpuY || mpuX;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of ringPx) {
    if (p[0] < x0) x0 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0];
    if (p[1] > y1) y1 = p[1];
  }
  return Math.max((x1 - x0) * mpuX, (y1 - y0) * mpuY) <= SEG_TREE_MAX_SIDE_M;
}

/**
 * Crown form from the measured heights: a conifer's top falls away fast
 * from its peak, a broadleaf crown stays near its top across most of its
 * width. "conifer", "column" (a cypress: tall and under 4 m across), or
 * "broadleaf".
 */
function crownForm(ringPx, frame, heightM, heightSample) {
  const area = canopyAreaM2(ringPx, frame);
  const width = 2 * Math.sqrt(Math.max(area, 0) / Math.PI);
  if (heightM >= 8 && width <= 4 && heightM / Math.max(width, 0.5) >= 3) return "column";
  if (typeof heightSample !== "function") return "broadleaf";
  const c = ringCentroidPx(ringPx);
  if (!c) return "broadleaf";
  const mpu = frame.mpuX || frame.mpu || 1;
  const r = (0.6 * width) / 2 / mpu;
  const ring = [];
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    const ll = pxToLl(c[0] + r * Math.cos(a), c[1] + r * Math.sin(a), frame);
    const v = Number(heightSample(ll[0], ll[1]));
    if (v >= 1) ring.push(v);
  }
  if (ring.length < 5) return "broadleaf";
  ring.sort((x, y) => x - y);
  const mid = ring[ring.length >> 1];
  return mid / Math.max(heightM, 1) < 0.62 ? "conifer" : "broadleaf";
}

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


/**
 * Palms. A palm is a bare stem with a small crown at the top. Drawn as one
 * full-height prism it reads as a solid green column in Hamina.
 *
 * A crown is a palm when:
 * - an OSM natural=tree node inside it is tagged as a palm (leaf_type=palm,
 *   genus Phoenix / Washingtonia / Syagrus / Roystonea / Sabal / Cocos, or a
 *   species or taxon naming one), or
 * - the measured outline is a tall, narrow column: at least 7 m tall, no more
 *   than 6.5 m across, and at least twice as tall as it is wide. A broadleaf
 *   tree that tall spreads wider than that.
 * A narrow row of palm crowns that merged on the canopy grid is split at its
 * measured height peaks, never at guessed spacing.
 */
const PALM_MIN_H = 7;
/** Slope pieces smaller than this join a neighbour instead of shipping alone. */
const SLIVER_M2 = 25;
const SPIRE_MIN_H = 40;
/** A hillside piece this tall and wide gets a rounded top band. */
const SLOPE_LAYER_MIN_H = 8;
const SLOPE_LAYER_MIN_M2 = 150;
const SPIRE_MAX_M2 = 25;
const PALM_MAX_H = 35;
const PALM_MAX_DIAM_M = 6.5;
// A broadleaf crown's height cap per metre of crown width, and its floor.
const BROADLEAF_H_PER_DIAM = 2;
const CROWN_CAP_MIN_H = 4;
// A palm's fronds spread at the top: its crown near the tip is still at
// least this share of its crown lower down. A cypress narrows to a point.
const PALM_TOP_SHARE = 0.35;
const PALM_MIN_RATIO = 2;
const PALM_CROWN_MIN_M = 4;
const PALM_CROWN_MAX_M = 6;
const PALM_TRUNK_M = 0.6;
const PALM_ROW_MAX_M = 90;
const PALM_PEAK_GAP_M = 4.5;
// Widest head (the top 15% of a palm) that still reads as a palm crown.
const PALM_HEAD_MAX_M = 4.5;
const PALM_ROW_MIN_H = 12;
const PALM_ROW_MAX_W_M = 9;
const PALM_ROW_ELONG = 3;
const PALM_GROVE_MIN_H = 15;
const PALM_SKIRT_R_M = 5;
const PALM_SKIRT_MAX = 0.35;
const PALM_GENUS = /\b(phoenix|washingtonia|syagrus|roystonea|sabal|cocos|trachycarpus|butia|livistona|chamaerops|brahea|archontophoenix|dypsis|bismarckia|areca|arecaceae|palmae)\b/i;

function isPalmTags(tags) {
  if (!tags || typeof tags !== "object") return false;
  if (String(tags.leaf_type || "").toLowerCase() === "palm") return true;
  const keys = ["genus", "species", "taxon", "species:en", "taxon:en", "genus:en", "family", "species:wikidata_label"];
  for (let i = 0; i < keys.length; i++) {
    const v = tags[keys[i]];
    if (v && (PALM_GENUS.test(String(v)) || /\bpalm\b/i.test(String(v)))) return true;
  }
  return false;
}

function ringMeters(frame) {
  const mpuX = (frame && (frame.mpuX || frame.mpu)) || 1;
  const mpuY = (frame && (frame.mpuY || mpuX)) || mpuX;
  return { mpuX, mpuY };
}

/** Major axis of a ring in px, from its second moments. */
function ringAxis(ring, frame) {
  const { mpuX, mpuY } = ringMeters(frame);
  const c = ringCentroidPx(ring);
  if (!c) return null;
  const n = ring.length - 1;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (ring[i][0] - c[0]) * mpuX;
    const dy = (ring[i][1] - c[1]) * mpuY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const a = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  let lo = Infinity;
  let hi = -Infinity;
  let wlo = Infinity;
  let whi = -Infinity;
  for (let i = 0; i < n; i++) {
    const dx = (ring[i][0] - c[0]) * mpuX;
    const dy = (ring[i][1] - c[1]) * mpuY;
    const t = dx * ux + dy * uy;
    const w = -dx * uy + dy * ux;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
    if (w < wlo) wlo = w;
    if (w > whi) whi = w;
  }
  return { c, ux, uy, lo, hi, length: hi - lo, width: whi - wlo };
}

/**
 * Measured shape of an untagged palm. The whole footprint is crown near the
 * top (a palm head is flat-ish, a conifer is a cone whose edge cells read
 * low), and the ground around it is open (a palm stands alone or in a row,
 * a conifer in a stand has more canopy beside it). Without a height model
 * the shape cannot be checked, so it is not a palm.
 */
function palmProfile(ringPx, frame, h, heightSample) {
  if (typeof heightSample !== "function") return false;
  const { mpuX, mpuY } = ringMeters(frame);
  const c = ringCentroidPx(ringPx);
  if (!c) return false;
  let inSum = 0;
  let inN = 0;
  let openN = 0;
  let ringN = 0;
  for (let dy = -9; dy <= 9; dy += 1) {
    for (let dx = -9; dx <= 9; dx += 1) {
      const p = [c[0] + dx / mpuX, c[1] + dy / mpuY];
      const ll = pxToLl(p[0], p[1], frame);
      const v = Number(heightSample(ll[0], ll[1])) || 0;
      if (pointInRing(p, ringPx)) {
        inSum += v;
        inN++;
      } else {
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r < 5 || r > 9) continue;
        ringN++;
        if (v < 3) openN++;
      }
    }
  }
  if (inN < 3 || ringN < 8) return false;
  return inSum / inN >= 0.55 * h && openN / ringN >= 0.5;
}

function palmTagIn(ringPx, palmPx) {
  if (!palmPx || !palmPx.length) return false;
  for (let i = 0; i < palmPx.length; i++) if (pointInRing(palmPx[i], ringPx)) return true;
  return false;
}

/**
 * Palm crown centres in px for one traced canopy, or null when it is not
 * palms. Each centre carries its own measured height.
 */
function palmCentres(ringPx, frame, heightM, palmPx, heightSample) {
  const h = Number(heightM);
  if (!(h >= 6 && h < PALM_MAX_H) || !ringPx || ringPx.length < 4) return null;
  const { mpuX, mpuY } = ringMeters(frame);
  const areaM = ringPxArea(ringPx) * mpuX * mpuY;
  const diam = 2 * Math.sqrt(areaM / Math.PI);
  const tagged = palmTagIn(ringPx, palmPx);
  const c = ringCentroidPx(ringPx);
  if (!c || !pointInRing(c, ringPx)) return null;
  if (diam <= PALM_MAX_DIAM_M && (tagged || (h >= PALM_MIN_H && h / diam >= PALM_MIN_RATIO && palmProfile(ringPx, frame, h, heightSample)))) {
    return [{ c, h, diam }];
  }
  // Several palms whose crowns merged on the canopy grid: a row along a
  // street, a grove, a cluster by a pool. Split at the measured height peaks.
  return palmCluster(ringPx, frame, h, heightSample, tagged);
}

const PALM_CLUSTER_MAX_M2 = 6000;

/**
 * Local-maximum tree segmentation on the height model inside one traced
 * canopy. Each peak at least 4.5 m from a taller one is a tree top. Its crown
 * radius is where the height first drops below 60% of the peak in 8
 * directions. The canopy is palms only when most tops are narrow tall heads
 * and the tops explain the canopy area, so a broad tree with a bumpy top is
 * not cut into fake palms.
 */
function palmCluster(ringPx, frame, h, heightSample, tagged) {
  if (typeof heightSample !== "function") return null;
  let arid = false;
  try {
    arid = require("./lidar-canopy").aridClimate((frame.south + frame.north) / 2, (frame.west + frame.east) / 2);
  } catch {
    arid = false;
  }
  const { mpuX, mpuY } = ringMeters(frame);
  const areaM = ringPxArea(ringPx) * mpuX * mpuY;
  if (!(areaM <= PALM_CLUSTER_MAX_M2) || !(h >= PALM_MIN_H)) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < ringPx.length; i++) {
    if (ringPx[i][0] < minX) minX = ringPx[i][0];
    if (ringPx[i][1] < minY) minY = ringPx[i][1];
    if (ringPx[i][0] > maxX) maxX = ringPx[i][0];
    if (ringPx[i][1] > maxY) maxY = ringPx[i][1];
  }
  const step = 1;
  const nx = Math.max(2, Math.ceil(((maxX - minX) * mpuX) / step) + 1);
  const ny = Math.max(2, Math.ceil(((maxY - minY) * mpuY) / step) + 1);
  if (nx * ny > 40000) return null;
  const val = new Float32Array(nx * ny);
  const inside = new Uint8Array(nx * ny);
  const pxAt = (x, y) => [minX + (x * step) / mpuX, minY + (y * step) / mpuY];
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const p = pxAt(x, y);
      const ll = pxToLl(p[0], p[1], frame);
      val[y * nx + x] = Number(heightSample(ll[0], ll[1])) || 0;
      if (pointInRing(p, ringPx)) inside[y * nx + x] = 1;
    }
  }
  const at = (x, y) => (x < 0 || y < 0 || x >= nx || y >= ny ? 0 : val[y * nx + x]);
  const peaks = [];
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const k = y * nx + x;
      const v = val[k];
      if (!inside[k] || !(v >= PALM_MIN_H - 1) || v < 0.6 * h) continue;
      let top = true;
      for (let dy = -2; dy <= 2 && top; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (!dx && !dy) continue;
          const u = at(x + dx, y + dy);
          if (u > v || (u === v && (dy < 0 || (dy === 0 && dx < 0)))) {
            top = false;
            break;
          }
        }
      }
      if (top) peaks.push({ x, y, v });
    }
  }
  peaks.sort((p, q) => q.v - p.v);
  const tops = [];
  for (let i = 0; i < peaks.length; i++) {
    const p = peaks[i];
    if (tops.every((q) => Math.hypot(q.x - p.x, q.y - p.y) * step >= PALM_PEAK_GAP_M)) tops.push(p);
  }
  if (tops.length < 2) {
      return null;
  }
  // Each top owns the connected cells within 6 m that stay above 60% of its
  // height and are closer to it than to any other top.
  const owner = new Int32Array(nx * ny).fill(-1);
  let palmish = 0;
  let crownArea = 0;
  const out = [];
  for (let i = 0; i < tops.length; i++) {
    const t = tops[i];
    const floor = 0.6 * t.v;
    const stack = [t.y * nx + t.x];
    owner[stack[0]] = i;
    let n = 0;
    let head = 0;
    let sx = 0;
    let sy = 0;
    while (stack.length) {
      const k = stack.pop();
      const x = k % nx;
      const y = (k / nx) | 0;
      n++;
      sx += x;
      sy += y;
      const nb = [x > 0 ? k - 1 : -1, x < nx - 1 ? k + 1 : -1, y > 0 ? k - nx : -1, y < ny - 1 ? k + nx : -1];
      for (let j = 0; j < 4; j++) {
        const q = nb[j];
        if (q < 0 || owner[q] >= 0 || val[q] < floor) continue;
        const qx = q % nx;
        const qy = (q / nx) | 0;
        const d = Math.hypot(qx - t.x, qy - t.y) * step;
        if (d > 6) continue;
        let nearest = true;
        for (let m = 0; m < tops.length && nearest; m++) {
          if (m !== i && Math.hypot(qx - tops[m].x, qy - tops[m].y) * step < d) nearest = false;
        }
        if (!nearest) continue;
        owner[q] = i;
        stack.push(q);
        if (val[q] >= 0.85 * t.v) head++;
      }
    }
    const areaT = n * step * step;
    const diam = 2 * Math.sqrt(areaT / Math.PI);
    const headDiam = 2 * Math.sqrt(((head + 1) * step * step) / Math.PI);
    crownArea += areaT;
    if (diam <= PALM_MAX_DIAM_M && t.v / Math.max(diam, 1) >= PALM_MIN_RATIO) palmish++;
    // Desert palms: a merged row reads wide at 60% of the height, but the
    // head of each top is a few metres across, far narrower than a broadleaf.
    else if (arid && t.v >= PALM_MIN_H && headDiam <= PALM_HEAD_MAX_M && t.v / headDiam >= 2 * PALM_MIN_RATIO) palmish++;
    out.push({ c: pxAt(sx / n, sy / n), h: Math.round(t.v * 10) / 10, diam: Math.min(diam, PALM_CROWN_MAX_M) });
  }
  const need = tagged ? 0.5 : 0.75;
  // A desert median or frontage row: a strip a few metres wide and many
  // times longer, tall as a palm. Its crowns merge on the height grid, but
  // its measured tops are the palms, one stem each.
  const shortM = crownShortM(ringPx, frame);
  const row = arid && h >= PALM_ROW_MIN_H  && shortM > 0 && shortM <= PALM_ROW_MAX_W_M && areaM / shortM >= PALM_ROW_ELONG * shortM;
  // A desert stand whose separate tops all stand palm-tall: irrigated desert
  // broadleaf rarely clears 15 m, so three or more such tops are palms.
  // Guard against irrigated pines and other conifers: their crown skirts
  // down the stem, so the disc around a top is full of mid heights. A palm
  // is a bare stem under its head, so around it the grid is head or ground.
  const skirted = (t) => {
    let disc = 0;
    let mid = 0;
    const r = Math.round(PALM_SKIRT_R_M / step);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const v = at(t.x + dx, t.y + dy);
        disc++;
        if (v > 0.25 * t.v && v < 0.6 * t.v) mid++;
      }
    }
    return disc > 0 && mid / disc > PALM_SKIRT_MAX;
  };
  const grove = arid && tops.length >= 3 && tops.every((t) => t.v >= PALM_GROVE_MIN_H) && tops.filter(skirted).length <= tops.length * 0.25;
  const rowOk = row && tops.filter(skirted).length <= tops.length * 0.25;
  if (!rowOk && !grove && palmish / tops.length < need) return null;
  // Tall narrow tops that leave most of the canopy unexplained are a broad
  // crown with bumps, not palms.
  if (crownArea < areaM * 0.2) return null;
  return out;
}

/** Round palm crown: 4 to 6 m, kept off roofs and water by the same clip. */
function palmCrownRing(centre, frame, clipSet, neighbours) {
  const { mpuX, mpuY } = ringMeters(frame);
  let d = Math.max(PALM_CROWN_MIN_M, Math.min(PALM_CROWN_MAX_M, centre.diam * 1.1));
  if (neighbours && neighbours > 0) d = Math.min(d, Math.max(PALM_CROWN_MIN_M, neighbours * 0.95));
  const circle = circleRingPx(centre.c, d, mpuX, mpuY, 12);
  const full = ringPxArea(circle);
  const pieces = clipFoliageRing(circle, clipSet) || [];
  let best = null;
  for (let i = 0; i < pieces.length; i++) if (!best || ringPxArea(pieces[i]) > ringPxArea(best)) best = pieces[i];
  if (!best || ringPxArea(best) < full * 0.5) return null;
  if (!pointInRing(centre.c, best)) return null;
  return best;
}

/**
 * Layer outline from the measured canopy height: the part of `ring` where
 * the height model reaches `minH` above ground. Null when the height model
 * cannot say, so the caller keeps its geometric inset.
 */
function heightContourRing(ring, frame, heightSample, minH) {
  if (typeof heightSample !== "function" || !ring || ring.length < 4) return null;
  const { mpuX, mpuY } = ringMeters(frame);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    if (ring[i][0] < minX) minX = ring[i][0];
    if (ring[i][1] < minY) minY = ring[i][1];
    if (ring[i][0] > maxX) maxX = ring[i][0];
    if (ring[i][1] > maxY) maxY = ring[i][1];
  }
  const wM = (maxX - minX) * mpuX;
  const hM = (maxY - minY) * mpuY;
  const cellM = Math.max(1.2, Math.sqrt((wM * hM) / 3600));
  const nx = Math.max(2, Math.ceil(wM / cellM));
  const ny = Math.max(2, Math.ceil(hM / cellM));
  const sx = (maxX - minX) / nx;
  const sy = (maxY - minY) / ny;
  const on = new Uint8Array(nx * ny);
  let count = 0;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const p = [minX + (x + 0.5) * sx, minY + (y + 0.5) * sy];
      if (!pointInRing(p, ring)) continue;
      const ll = pxToLl(p[0], p[1], frame);
      const v = Number(heightSample(ll[0], ll[1])) || 0;
      if (v >= minH) {
        on[y * nx + x] = 1;
        count++;
      }
    }
  }
  if (count < 3) return null;
  // Largest 4-connected patch.
  const seen = new Uint8Array(nx * ny);
  let best = null;
  for (let i = 0; i < on.length; i++) {
    if (!on[i] || seen[i]) continue;
    const stack = [i];
    seen[i] = 1;
    const cells = [];
    while (stack.length) {
      const k = stack.pop();
      const x = k % nx;
      const y = (k / nx) | 0;
      cells.push([x, y]);
      const nb = [x > 0 ? k - 1 : -1, x < nx - 1 ? k + 1 : -1, y > 0 ? k - nx : -1, y < ny - 1 ? k + nx : -1];
      for (let j = 0; j < 4; j++) {
        const q = nb[j];
        if (q >= 0 && on[q] && !seen[q]) {
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    if (!best || cells.length > best.length) best = cells;
  }
  if (!best || best.length < 3) return null;
  const traced = tracePixels(best);
  if (!traced) return null;
  let px = traced.map(([x, y]) => [minX + x * sx, minY + y * sy]);
  if (px.length > 25) px = decimateClosed(px, 24) || px;
  try {
    const inter = polygonClipping.intersection([closeCrownRing(openCrownRing(ring))], [closeCrownRing(openCrownRing(px))]);
    return largestExterior(inter);
  } catch {
    return null;
  }
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
function domeAreaFractions(n, discrete, form) {
  if (!(n >= 2)) return [1];
  // A conifer narrows all the way up; a cypress is one narrow column.
  if (discrete && form === "conifer") {
    if (n === 2) return [1, 0.4];
    if (n === 3) return [1, 0.55, 0.22];
    return [1, 0.7, 0.42, 0.18];
  }
  if (!discrete) {
    // The full outline is only the skirt. The inset bands are the crown,
    // so a woods reads as a rounded top instead of a flat slab.
    if (n === 2) return [1, 0.42];
    if (n === 3) return [1, 0.58, 0.28];
    return [1, 0.72, 0.46, 0.24];
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
function buildCrownBands(material, n, skirt) {
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
    // A merged woods keeps a short full-height skirt, then puts the measured
    // top on the smaller bands so the edge rounds instead of a plateau.
    if (skirt && i === 0 && left > 1) {
      const minRest = (left - 1) * 2.2;
      const skirtH = roundTenths(Math.min(2.6, Math.max(2.2, remain - minRest)));
      if (skirtH > 2 && remain - skirtH >= minRest) target = skirtH;
    }
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

function bareCanopy(material, thickness) {
  let name = String((material && material.name) || "");
  const at = name.indexOf(" @ ");
  if (at > 0) name = name.slice(0, at);
  return {
    name,
    rf_properties: material && material.rf_properties,
    top_height: roundTenths(thickness),
    display_color: material && material.display_color,
    transparencyEnabled: true,
  };
}

/**
 * Understory from local ground, then the foliage crown up to the measured top.
 * Both use the traced outline. Null when the height cannot hold both layers.
 */
function standLayerParts(material) {
  if (!material || isUnderstoryOiName(material.name) || !isVegetationName(material.name)) return null;
  const lifted = Number(material.bottom_height) >= 1;
  const seat = lifted ? roundTenths(material.bottom_height) : 0;
  const top = Number(material.top_height);
  const thickness = roundTenths(top - seat);
  const tier = String(material.name).indexOf("Light") >= 0 ? "light" : "heavy";
  const base = standUnderstoryM(thickness, tier);
  if (!(base >= 2.5)) return null;
  const crownH = roundTenths(thickness - base);
  if (!(crownH >= 2.5)) return null;
  const underPair = understoryClipPair(base, seat);
  if (!underPair) return null;
  let crownBase = materialForVegetation(crownH, tier);
  if (!crownBase || Math.abs(Number(crownBase.top_height) - crownH) > 0.15) return null;
  const crownBottom = roundTenths(seat + base);
  let crownMat = crownBase;
  let crownClip = clipboardForCanopy(crownBase);
  if (crownBottom >= 1) {
    const pair = liftFoliagePair(crownBase, crownBottom);
    if (!pair || !pair.material) return null;
    crownMat = pair.material;
    crownClip = { typeId: pair.typeId, clipType: pair.clipType };
  }
  if (!crownClip) return null;
  if (Math.abs(Number(crownMat.top_height) - top) > 0.15) return null;
  const underTop = Number(underPair.material.top_height);
  const crownBot = crownMat.bottom_height != null ? Number(crownMat.bottom_height) : 0;
  if (Math.abs(underTop - (seat + base)) > 0.15) return null;
  if (Math.abs(crownBot - crownBottom) > 0.15 && crownBottom >= 1) return null;
  return [
    {
      material: underPair.material,
      clip: { typeId: underPair.typeId, clipType: underPair.clipType },
    },
    { material: crownMat, clip: crownClip },
  ];
}

function isVegetationName(name) {
  const n = String(name || "");
  if (n.indexOf("Foliage - Heavy") === 0 || n.indexOf("Foliage - Light") === 0) return true;
  return false;
}

function reseatPart(part, newBottom) {
  const mat = part.material;
  if (!mat) return null;
  const oldBottom = Number(mat.bottom_height) >= 1 ? Number(mat.bottom_height) : 0;
  const thickness = roundTenths(Number(mat.top_height) - oldBottom);
  if (!(thickness > 0.5)) return null;
  if (isUnderstoryOiName(mat.name)) {
    const pair = understoryClipPair(thickness, newBottom);
    if (!pair) return null;
    return {
      material: pair.material,
      clip: { typeId: pair.typeId, clipType: pair.clipType },
    };
  }
  if (!(newBottom >= 1)) {
    const bare = bareCanopy(mat, thickness);
    return { material: bare, clip: clipboardForCanopy(bare) };
  }
  const lifted = liftFoliagePair(bareCanopy(mat, thickness), newBottom);
  if (!lifted) return null;
  return { material: lifted.material, clip: { typeId: lifted.typeId, clipType: lifted.clipType } };
}

/**
 * An inset band used to keep the seat of the larger ring, so the piece hung
 * above the hill under its own outline. Drop the whole stack onto the
 * downhill ground of the lowest ring when that gap is more than 3 m.
 */
function dropStack(parts, slopeTop, frame) {
  if (!slopeTop || typeof slopeTop.seat !== "function" || !parts || !parts.length) return parts;
  const ring = parts[0] && parts[0].ringPx;
  if (!ring || ring.length < 4) return parts;
  const ll = [];
  for (let i = 0; i < ring.length; i++) {
    const q = pxToLl(ring[i][0], ring[i][1], frame);
    if (!q || !Number.isFinite(q[0]) || !Number.isFinite(q[1])) continue;
    ll.push(q);
  }
  if (ll.length < 3) return parts;
  const down = Number(slopeTop.seat(ll)) || 0;
  const mat0 = parts[0].material;
  const bottom = mat0 && Number(mat0.bottom_height) >= 1 ? Number(mat0.bottom_height) : 0;
  if (!(down >= 1) || !(bottom > down + 3)) return parts;
  const drop = bottom - down;
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const mat = part.material;
    if (!mat) {
      out.push(part);
      continue;
    }
    const oldBottom = Number(mat.bottom_height) >= 1 ? Number(mat.bottom_height) : 0;
    const newBottom = roundTenths(oldBottom - drop);
    const seated = reseatPart(part, newBottom);
    if (!seated) {
      out.push(part);
      continue;
    }
    out.push(Object.assign({}, part, seated));
  }
  return out;
}

/** Keep at most `maxPts` corners. A sawtooth edge makes the slope cut drop area and seat the whole stand on one sample. */
function decimateClosed(ring, maxPts) {
  if (!ring || ring.length < 4 || !(maxPts >= 4)) return ring;
  const closed =
    ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const open = closed ? ring.slice(0, -1) : ring.slice();
  if (open.length <= maxPts) return ring;
  const step = Math.ceil(open.length / maxPts);
  const out = [];
  for (let i = 0; i < open.length; i += step) out.push(open[i]);
  if (out.length < 3) return ring;
  out.push([out[0][0], out[0][1]]);
  return out;
}

function canopyAreaM2(ringPx, frame) {
  const mpuX = (frame && (frame.mpuX || frame.mpu)) || 1;
  const mpuY = (frame && (frame.mpuY || mpuX)) || mpuX;
  return ringPxArea(ringPx) * mpuX * mpuY;
}

function layerCounts(pending, frame) {
  let treeCount = 0;
  for (let i = 0; i < pending.length; i++) if (pending[i].trunk) treeCount++;
  const plans = pending.map((row) => {
    const discrete = !!row.trunk;
    const thickness = crownThicknessM(row.area && row.area.material);
    const areaM = canopyAreaM2(row.area && row.area.ringPx, frame);
    const tier = String((row.area && row.area.material && row.area.material.name) || "").indexOf("Light") >= 0 ? "light" : "heavy";
    const stand = !discrete && areaM >= STAND_LAYER_M2 && standUnderstoryM(thickness, tier) >= 2.5;
    const wide = row.slopePiece && areaM >= 4000;
    return {
      n: row.palm || row.form === "column" ? 1 : stand ? (thickness >= 12 ? 4 : thickness >= 9 ? 3 : 2) : row.slopePiece && !wide ? (thickness >= SLOPE_LAYER_MIN_H && areaM >= SLOPE_LAYER_MIN_M2 ? 2 : 1) : wantedCrownLayers(discrete, thickness, treeCount),
      stand,
      discrete,
      slope: !!row.slopePiece && !wide,
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
  // Rounded hillside tops go first when the budget is short; the stand stays.
  shrink((p) => p.slope && p.n >= 2, () => 1);
  shrink((p) => p.stand && p.n >= 3, (n) => n - 1);
  shrink((p) => p.stand && p.n >= 3, (n) => n - 1);
  shrink((p) => p.discrete && p.n >= 4, () => 3);
  shrink((p) => !p.discrete && !p.stand && p.n >= 3, () => 2);
  shrink((p) => p.discrete && p.n >= 3, () => 2);
  return plans;
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
  const clipped = clippedFraction(ring, frame, fraction);
  if (!clipped) return null;
  if (insetStaysIn(clipped, ring)) return clipped;
  // A shorter outline can chord across the outside of a notch and land in
  // the next stand. Keep only the part that is still on this crown.
  let brought = null;
  try {
    const inter = polygonClipping.intersection(
      [closeCrownRing(openCrownRing(ring))],
      [closeCrownRing(openCrownRing(clipped))]
    );
    brought = largestExterior(inter);
  } catch {
    brought = null;
  }
  if (
    brought &&
    ringClearsSpan(brought, floor) &&
    insetStaysIn(brought, ring) &&
    ringPxArea(brought) < ringPxArea(ring) * 0.96 &&
    ringPxArea(brought) > ringPxArea(ring) * 0.12
  ) {
    return brought;
  }
  return null;
}

/**
 * Bands that cannot clear the span floor are dropped by asking for fewer
 * layers. The traced ring is always one of the bands that remain.
 */
function crownStack(row, frame, want, heightSample, onUnderstory) {
  const ring = row.area && row.area.ringPx;
  if (!ring || !(want >= 2)) return null;
  const discrete = !!row.trunk;
  for (let n = Math.min(want, 4); n >= 2; n--) {
    const fractions = domeAreaFractions(n, discrete, row.form);
    if (fractions.length !== n) continue;
    const bands = buildCrownBands(row.area.material, n, !discrete && row.skirt !== false);
    if (!bands || bands.length !== n) continue;
    const parts = [];
    let ok = true;
    const groundM = Number(row.ground) >= 1 ? roundTenths(row.ground) : 0;
    let prev = null;
    let measured = 0;
    for (let i = 0; i < n; i++) {
      let shaped = null;
      // A band above the skirt follows where the height model really reaches
      // into it, so a mound tapers where its crowns do instead of stepping
      // in by a fixed fraction.
      if (heightSample && !discrete && i > 0 && prev) {
        const bottom = Number(bands[i].material.bottom_height) || 0;
        const top = Number(bands[i].material.top_height) || 0;
        const reach = bottom - groundM + Math.min(1, (top - bottom) * 0.35);
        // Clip to a slightly inset band below so the contour never shares its edge.
        const host = reach > 0 ? insetRingPx(prev, 0.3, frame) : null;
        const c = host && host.length >= 4 ? heightContourRing(host, frame, heightSample, reach) : null;
        if (
          c &&
          ringClearsSpan(c, crownSpanFloorPx(frame)) &&
          insetStaysIn(c, prev) &&
          ringPxArea(c) <= ringPxArea(prev) * 0.97 &&
          ringPxArea(c) >= ringPxArea(ring) * 0.06
        ) {
          shaped = c;
          // A band that barely steps in reads as a box. Where the height
          // model is flat across the band, it still tapers toward a dome:
          // no band keeps more than 1.6x the dome's share of the one below.
          const want = Math.min(0.9, (fractions[i] / Math.max(fractions[i - 1], 0.01)) * 1.6);
          const share = ringPxArea(c) / Math.max(ringPxArea(prev), 1e-9);
          if (share > want) {
            const tight = ringForFraction(c, frame, want / share);
            if (tight && insetStaysIn(tight, prev) && ringClearsSpan(tight, crownSpanFloorPx(frame))) shaped = tight;
          }
        }
      }
      if (shaped) measured++;
      if (!shaped) shaped = ringForFraction(ring, frame, fractions[i]);
      if (shaped && prev && !discrete && i > 0 && !insetStaysIn(shaped, prev)) {
        const fallback = ringForFraction(prev, frame, Math.min(0.9, fractions[i] / Math.max(fractions[i - 1], 0.01)));
        if (fallback) shaped = fallback;
      }
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
      prev = shaped;
    }
    if (onUnderstory && !measured) ok = false;
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
  let foliageGeometry = "none";
  let polygons = [];
  let coarsened = false;
  let foliageDropped = 0;
  if (opts && opts.preparedPolygons) {
    polygons = opts.preparedPolygons;
    coarsened = !!opts.foliageCoarsened;
    foliageDropped = opts.foliageDropped | 0;
    foliageGeometry = opts.foliageGeometry || (polygons.length ? "chm-contour" : "none");
  } else if (opts && opts.omitFoliage) {
    foliageGeometry = "omitted";
  } else if (opts && opts.chmGrid) {
    polygons = chmCrownPolygons(opts.chmGrid, frame, buildingAabbs, opts && opts.canopyHits, opts);
    coarsened = !!polygons.coarsened;
    foliageDropped = polygons.dropped | 0;
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
  return assembleFoliage(polygons, frame, buildingAabbs, affine, opts, {
    coarsened,
    foliageDropped,
    foliageGeometry,
  });
}

let sampledKeepOut = null;

function buildingKeepOutSig(buildings) {
  let verts = 0;
  for (let i = 0; i < buildings.length; i++) verts += buildings[i].ring.length;
  const a = buildings[0].ring[0];
  const b = buildings[buildings.length - 1].ring[0];
  return buildings.length + ":" + verts + ":" + a[0] + ":" + a[1] + ":" + b[0] + ":" + b[1];
}

/**
 * Interior samples of each roof, 4 px apart. The same list is reused for
 * every foliage tile on this worker. A later export with a different roof
 * set misses the cache.
 */
function sampleBuildingKeepOut(buildings) {
  if (!buildings || !buildings.length) return [];
  const sig = buildingKeepOutSig(buildings);
  if (sampledKeepOut && sampledKeepOut.sig === sig) return sampledKeepOut.points;
  const keepOutPx = [];
  for (let i = 0; i < buildings.length; i++) {
    const ring = buildings[i].ring;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let k = 0; k < ring.length; k++) {
      const p = ring[k];
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
    }
    const step = 4;
    for (let y = minY + step * 0.5; y < maxY; y += step) {
      for (let x = minX + step * 0.5; x < maxX; x += step) {
        const c = [x, y];
        if (pointInRing(c, ring)) keepOutPx.push(c);
      }
    }
  }
  sampledKeepOut = { sig, points: keepOutPx };
  return keepOutPx;
}

const STAND_TILE_MAX_M2 = 6000;
const STAND_TILE_M = 50;

function ringBoundsPx(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of ring) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  return { minX, minY, maxX, maxY };
}

/** Sutherland-Hodgman clip of a closed ring to an axis box; closed result or null. */
function clipRingToBox(ring, x0, y0, x1, y1) {
  let pts = ring.slice();
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  const edges = [
    (p) => p[0] >= x0, (p) => p[0] <= x1, (p) => p[1] >= y0, (p) => p[1] <= y1,
  ];
  const cut = [
    (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])],
    (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])],
    (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0],
    (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1],
  ];
  for (let e = 0; e < 4 && pts.length; e++) {
    const inside = edges[e];
    const next = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length];
      const b = pts[i];
      const ia = inside(a);
      const ib = inside(b);
      if (ib) {
        if (!ia) next.push(cut[e](a, b));
        next.push(b);
      } else if (ia) next.push(cut[e](a, b));
    }
    pts = next;
  }
  if (pts.length < 3) return null;
  pts.push([pts[0][0], pts[0][1]]);
  return pts;
}

const ARID_TREE_MAX_M = 15;
const ARID_LONE_MAX_M2 = 200;
const ARID_H_PER_DIAM = 0.6;
const URBAN_TREE_MAX_M = 25;
const URBAN_ROOF_SHARE = 0.2;

/** Height cap for non-palm trees in a desert or dense-city draw, else 0. */
function plausibleTreeCapM(frame, buildingRings) {
  if (!frame || !Number.isFinite(frame.south) || !Number.isFinite(frame.west)) return 0;
  const lat = (frame.south + frame.north) / 2;
  const lon = (frame.west + frame.east) / 2;
  let cap = 0;
  try {
    if (require("./lidar-canopy").aridClimate(lat, lon)) cap = ARID_TREE_MAX_M;
  } catch {
    cap = 0;
  }
  const W = frame.imgW || 0;
  const H = frame.imgH || 0;
  if (W > 0 && H > 0 && buildingRings && buildingRings.length) {
    let roof = 0;
    for (let i = 0; i < buildingRings.length; i++) roof += Math.abs(ringPxArea(buildingRings[i]) || 0);
    if (roof / (W * H) >= URBAN_ROOF_SHARE) cap = cap ? Math.min(cap, URBAN_TREE_MAX_M) : URBAN_TREE_MAX_M;
  }
  return cap;
}

function assembleFoliage(polygonsIn, frame, buildingAabbs, affine, opts, meta) {
  void buildingAabbs;
  const oiAreas = [];
  const clipZones = [];
  const clipTypes = [];
  const materials = [];
  const overlayRings = [];
  const seenClip = new Set();
  let polygons = (polygonsIn || []).slice();
  const coarsened = !!(meta && meta.coarsened);
  const foliageDropped = meta && meta.foliageDropped ? meta.foliageDropped | 0 : 0;
  const foliageGeometry = (meta && meta.foliageGeometry) || "none";
  const bufferM = opts && opts.buildingBufferM > 0 ? opts.buildingBufferM : BUILDING_BUFFER_M;
  const clipSet = createClipSet(
    opts && opts.buildingRings,
    opts && opts.maskRings,
    opts && opts.maskPolygons,
    bufferM / Math.max(frame.mpuX || 1, 0.05)
  );
  const prof = profile.profileOn();
  let tProf = prof ? profile.now() : 0;
  const keepOutPx = sampleBuildingKeepOut(clipSet && clipSet.buildings);
  if (prof) {
    profile.add("keepout-build", profile.msSince(tProf));
    profile.add("keepout-points", keepOutPx.length);
  }
  const pushCanopy = (ringPx, material, shape, context) => {
    const pieces = clipFoliageRing(ringPx, clipSet);
    for (const piece of pieces) {
      oiAreas.push({
        ringPx: piece,
        material,
        kind: "canopy",
        shape: piece.length === ringPx.length ? shape : "polygon",
        context: context === true,
      });
      if (!context) overlayRings.push(piece);
      if (material && !context) materials.push(material);
    }
  };
  const woodRings = opts && (opts.omitFoliage || opts.skipWood) ? [] : (opts && opts.woodRings) || [];
  for (let w = 0; w < woodRings.length; w++) {
    const wood = woodRings[w];
    const ll = wood && (wood.ringLonLat || wood.ring || wood);
    if (!ll || ll.length < 4) continue;
    const ringPx = [];
    for (let i = 0; i < ll.length; i++) {
      const p = llToPx(ll[i][0], ll[i][1], frame);
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
      ringPx.push(p);
    }
    if (ringPx.length >= 3) {
      const a = ringPx[0];
      const b = ringPx[ringPx.length - 1];
      if (a[0] !== b[0] || a[1] !== b[1]) ringPx.push([a[0], a[1]]);
    }
    const heightM = wood && Number(wood.heightM) > 2 ? Number(wood.heightM) : 12;
    const material = materialForVegetation(heightM, "heavy");
    if (material && ringPx.length >= 4) polygons.push({ ringPx, material, kind: "canopy", shape: "polygon" });
  }
  polygons.sort((a, b) => ringPxArea(b.ringPx) - ringPxArea(a.ringPx));
  let ownedPolygons = 0;
  for (let i = 0; i < polygons.length; i++) if (!polygons[i].context) ownedPolygons++;
  if (prof) tProf = profile.now();
  // A lidar-segmented tree partitions measured cells with its neighbours, so
  // it skips the overlap trim: that trim cut neighbouring trees into slivers
  // and dropped them. Each one is clipped to roofs and water on its own.
  const segAreas = [];
  for (const poly of polygons) {
    if (poly.segTree && !poly.context) {
      for (const piece of clipFoliageRing(poly.ringPx, clipSet)) {
        if (!(ringPxArea(piece) > 0)) continue;
        segAreas.push({ ringPx: piece, material: poly.material, kind: "canopy", shape: "polygon", segTree: true });
        if (poly.material) materials.push(poly.material);
      }
      continue;
    }
    pushCanopy(poly.ringPx, poly.material, "polygon", poly.context);
  }
  if (prof) profile.add("clip", profile.msSince(tProf));

  // Clip against roofs, water, and ski runs, then dissolve so two patches do
  // not paint green on green. Clipboard follows the dissolved rings.
  if (prof) tProf = profile.now();
  const dissolved = dissolveFoliageRings(oiAreas, clipSet).concat(segAreas);
  if (prof) profile.add("dissolve", profile.msSince(tProf));
  oiAreas.length = 0;
  overlayRings.length = 0;
  const slopeTop = opts && typeof opts.slopeTop === "function" ? opts.slopeTop : null;
  const heightSample = opts && typeof opts.heightSample === "function" ? opts.heightSample : null;
  let foliageLifted = 0;
  const pending = [];
  const seatsFor = (area) => {
    const one = (ringPx, ground, slopePiece) => [{ ringPx, ground, slopePiece: !!slopePiece }];
    if (!slopeTop || !area.ringPx || area.ringPx.length < 4) return one(area.ringPx, 0, false);
    const ll = area.ringPx.map((p) => pxToLl(p[0], p[1], frame));
    let split = typeof slopeTop.splitCanopy === "function" ? slopeTop.splitCanopy(ll) : null;
    // A traced crown with a jagged edge loses area in the cut, so the whole
    // ring comes back and sits on one sample. The outline that actually ships
    // is shorter. Cut that one, and each piece meets the ground under it.
    if ((!split || split.length < 2) && typeof slopeTop.splitCanopy === "function" && typeof slopeTop.seat === "function") {
      const up = Number(slopeTop(ll)) || 0;
      const down = Number(slopeTop.seat(ll)) || 0;
      if (up - down > 8) {
        // A 24-point outline can still lose the cut. Keep shortening until
        // the pieces cover the stand. The quad that ships does split.
        const caps = [32, 16, 8];
        for (let c = 0; c < caps.length && (!split || split.length < 2); c++) {
          const simple = decimateClosed(ll, caps[c]);
          if (!simple || simple.length < 4 || simple.length >= ll.length) continue;
          const again = slopeTop.splitCanopy(simple);
          if (again && again.length >= 2) split = again;
        }
      }
    }
    // A long unsplit ring used to sit on the uphill sample, so the downhill
    // side floated. Relief over 3 m uses the downhill ground instead.
    if (!split || split.length < 2) return one(area.ringPx, groundOf(ll), false);
    const seats = [];
    for (let i = 0; i < split.length; i++) {
      const px = [];
      for (let k = 0; k < split[i].length; k++) {
        const p = llToPx(split[i][k][0], split[i][k][1], frame);
        if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
        const prev = px[px.length - 1];
        if (prev && prev[0] === p[0] && prev[1] === p[1]) continue;
        px.push(p);
      }
      if (px.length >= 3) {
        const a = px[0];
        const b = px[px.length - 1];
        if (a[0] !== b[0] || a[1] !== b[1]) px.push([a[0], a[1]]);
      }
      if (px.length < 4) continue;
      const ground = typeof slopeTop.seat === "function" ? Number(slopeTop.seat(split[i])) || 0 : Number(slopeTop(split[i])) || 0;
      seats.push({ ringPx: px, ground, slopePiece: true, ll: split[i] });
    }
    if (seats.length >= 2) return mergeSlivers(seats);
    return one(area.ringPx, groundOf(ll), false);
  };
  // A slope cut leaves slivers of a few square metres. Each one used to ship
  // as its own full-height prism, which reads as a thin green column. A
  // sliver joins the neighbour it touches; it sits on that neighbour's ground.
  const mergeSlivers = (seats) => {
    const mpu = (frame.mpuX || 1) * (frame.mpuY || frame.mpuX || 1);
    const list = seats.slice();
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      list.sort((a, b) => ringPxArea(a.ringPx) - ringPxArea(b.ringPx));
      for (let i = 0; i < list.length; i++) {
        const small = list[i];
        if (!small || ringPxArea(small.ringPx) * mpu >= SLIVER_M2) continue;
        let best = -1;
        let bestRing = null;
        for (let j = list.length - 1; j >= 0; j--) {
          if (j === i || !list[j]) continue;
          let u = null;
          try {
            u = polygonClipping.union([closeCrownRing(openCrownRing(small.ringPx))], [closeCrownRing(openCrownRing(list[j].ringPx))]);
          } catch {
            u = null;
          }
          if (u && u.length === 1 && u[0][0] && u[0][0].length >= 4) {
            best = j;
            bestRing = u[0][0];
            break;
          }
        }
        if (best < 0) {
          list[i] = null;
          changed = true;
          continue;
        }
        list[best] = Object.assign({}, list[best], { ringPx: bestRing, ll: null });
        list[i] = null;
        changed = true;
      }
      for (let i = list.length - 1; i >= 0; i--) if (!list[i]) list.splice(i, 1);
      if (!changed) break;
    }
    return list.length ? list : seats;
  };
  const seatNear = (ll) => {
    let lon = 0;
    let lat = 0;
    let n = 0;
    const end = ll.length > 1 && ll[0][0] === ll[ll.length - 1][0] && ll[0][1] === ll[ll.length - 1][1] ? ll.length - 1 : ll.length;
    for (let i = 0; i < end; i++) {
      lon += +ll[i][0];
      lat += +ll[i][1];
      n++;
    }
    if (!n) return 0;
    lon /= n;
    lat /= n;
    const d = 0.00004;
    return (
      Number(
        slopeTop.seat([
          [lon - d, lat - d],
          [lon + d, lat - d],
          [lon + d, lat + d],
          [lon - d, lat + d],
          [lon - d, lat - d],
        ])
      ) || 0
    );
  };
  const groundOf = (ll) => {
    const up = Number(slopeTop(ll)) || 0;
    if (typeof slopeTop.seat !== "function") return up;
    const down = Number(slopeTop.seat(ll)) || 0;
    // A ring that climbs a whole hillside has a datum cell at the edge.
    // Seating the stand on that cell buries the woods. The middle of the
    // ring is the ground the canopy actually covers.
    if (up - down > 12) {
      const mid = seatNear(ll);
      if (mid >= 1) return mid;
    }
    if (up - down > 3) return down;
    return up;
  };
  const palmPx = [];
  const palmLl = (opts && opts.palmPoints) || [];
  for (let i = 0; i < palmLl.length; i++) {
    const q = palmLl[i];
    const lon = Array.isArray(q) ? +q[0] : +(q && q.lon);
    const lat = Array.isArray(q) ? +q[1] : +(q && q.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const p = llToPx(lon, lat, frame);
    if (Number.isFinite(p[0]) && Number.isFinite(p[1])) palmPx.push(p);
  }
  let palmCount = 0;
  let spiresDropped = 0;
  let crownCapped = 0;
  let regionCapped = 0;
  let tiled = 0;
  const regionCapH = plausibleTreeCapM(frame, opts && opts.buildingRings);
  let regionArid = false;
  try {
    regionArid = require("./lidar-canopy").aridClimate((frame.south + frame.north) / 2, (frame.west + frame.east) / 2);
  } catch {
    regionArid = false;
  }
  // One palm row per centre: a round crown in the top 2 to 3 m on a thin stem.
  const palmRows = (centres, ground) => {
    const out = [];
    for (let k = 0; k < centres.length; k++) {
      const cen = centres[k];
      let gap = 0;
      for (let j = 0; j < centres.length; j++) {
        if (j === k) continue;
        const dx = (centres[j].c[0] - cen.c[0]) * (frame.mpuX || 1);
        const dy = (centres[j].c[1] - cen.c[1]) * (frame.mpuY || frame.mpuX || 1);
        const d = Math.sqrt(dx * dx + dy * dy);
        if (!gap || d < gap) gap = d;
      }
      const crownRing = palmCrownRing(cen, frame, clipSet, gap);
      if (!crownRing) continue;
      const crownM = Math.max(2.2, Math.min(3, cen.h * 0.2));
      const base = materialForVegetation(cen.h, "light");
      const parts = base && individualTreeParts(base, ground, crownM);
      if (!parts) continue;
      const stem = circleRingPx(cen.c, PALM_TRUNK_M, frame.mpuX || 1, frame.mpuY || frame.mpuX || 1, TRUNK_SIDES);
      out.push({
        area: { ringPx: crownRing, material: parts.crownMat, kind: "canopy", shape: "polygon" },
        clip: parts.crownClip,
        trunk: { ringPx: stem, material: parts.trunkMat, kind: "trunk", shape: "polygon", clip: parts.trunkClip, palm: true },
        slopePiece: false,
        palm: true,
        ground,
      });
      if (ground >= 1) foliageLifted++;
    }
    return out;
  };
  // A stand wider than one crown ships as tiles about 50 m across, each at
  // the canopy height measured over it, never as one flat sheet.
  const tileSeats = (seats) => {
    const { mpuX, mpuY } = ringMeters(frame);
    const out = [];
    for (let i = 0; i < seats.length; i++) {
      const seat = seats[i];
      const m2 = seat.ringPx ? canopyAreaM2(seat.ringPx, frame) : 0;
      if (!(m2 > STAND_TILE_MAX_M2)) {
        out.push(seat);
        continue;
      }
      const b = ringBoundsPx(seat.ringPx);
      const sx = STAND_TILE_M / mpuX;
      const sy = STAND_TILE_M / (mpuY || mpuX);
      let made = 0;
      for (let y = b.minY; y < b.maxY; y += sy) {
        for (let x = b.minX; x < b.maxX; x += sx) {
          const box = clipRingToBox(seat.ringPx, x, y, x + sx, y + sy);
          if (!box || box.length < 4) continue;
          // A box cut of a notched outline can bridge the notch; the roof
          // and water clip runs again so a tile never covers what the
          // outline went around.
          const parts = clipSet ? clipFoliageRing(box, clipSet) || [] : [box];
          for (let q = 0; q < parts.length; q++) {
            const ring = parts[q];
            if (!ring || ring.length < 4 || canopyAreaM2(ring, frame) < SLIVER_M2) continue;
            const ll = ring.map((p) => pxToLl(p[0], p[1], frame));
            out.push({ ringPx: ring, ground: seat.ground, slopePiece: seat.slopePiece, ll, tile: true });
            made++;
          }
        }
      }
      if (!made) out.push(seat);
      else tiled++;
    }
    return out;
  };
  if (prof) tProf = profile.now();
  for (const area of dissolved) {
    // A neighbor crown is here so a shared edge is cut the same way. Its
    // pieces belong to the tile that owns that crown.
    if (area.context) continue;
    const seats = tileSeats(seatsFor(area));
    for (let s = 0; s < seats.length; s++) {
      const seat = seats[s];
      const rowArea = {
        ringPx: seat.ringPx,
        material: area.material,
        kind: area.kind || "canopy",
        shape: seats.length > 1 ? "polygon" : area.shape || "polygon",
      };
      if ((seat.slopePiece || seat.tile) && heightSample && seat.ll && seat.ll.length >= 3) {
        let lon = 0;
        let lat = 0;
        const n = seat.ll.length > 1 && seat.ll[0][0] === seat.ll[seat.ll.length - 1][0] ? seat.ll.length - 1 : seat.ll.length;
        for (let i = 0; i < n; i++) {
          lon += seat.ll[i][0];
          lat += seat.ll[i][1];
        }
        const localH = Number(heightSample(lon / n, lat / n));
        if (localH >= 3 && localH < 80 && rowArea.material) {
          const tier = String(rowArea.material.name || "").indexOf("Light") >= 0 ? "light" : "heavy";
          const localMat = materialForVegetation(localH, tier);
          if (localMat) rowArea.material = localMat;
        }
      }
      let clip = null;
      let trunk = null;
      let form = "";
      const ground = seat.ground;
      const height = rowArea.material && Number(rowArea.material.top_height);
      // A canopy outline a few metres across that measures over 40 m is a
      // sign, a mast, or a tower edge in the height model. A real tree that
      // tall has a crown far wider than this.
      if (height >= SPIRE_MIN_H && canopyAreaM2(rowArea.ringPx, frame) <= SPIRE_MAX_M2) {
        spiresDropped++;
        continue;
      }
      if (rowArea.material) {
        const palms = palmCentres(rowArea.ringPx, frame, height, palmPx, heightSample);
        const made = palms ? palmRows(palms, ground) : null;
        if (made && made.length) {
          for (let k = 0; k < made.length; k++) pending.push(made[k]);
          palmCount += made.length;
          continue;
        }
      }
      // Plausible height. Outside a palm, a desert tree is rarely above
      // 15 m and a street tree in a dense city rarely above 25 m. A taller
      // reading there is a wall, mast or stale return mixed into the crown.
      let capH = regionCapH;
      // A lone desert broadleaf (palo verde, mesquite, acacia) is about as
      // tall as it is wide.
      if (regionArid && rowArea.ringPx) {
        const m2 = canopyAreaM2(rowArea.ringPx, frame);
        if (m2 > 0 && m2 <= ARID_LONE_MAX_M2) {
          const lone = Math.max(CROWN_CAP_MIN_H, ARID_H_PER_DIAM * 2 * Math.sqrt(m2 / Math.PI));
          capH = capH > 0 ? Math.min(capH, lone) : lone;
        }
      }
      if (capH > 0 && rowArea.material && height > capH) {
        const tier = String(rowArea.material.name || "").indexOf("Light") >= 0 ? "light" : "heavy";
        const capMat = materialForVegetation(capH, tier);
        if (capMat) {
          rowArea.material = capMat;
          regionCapped++;
        }
      }
      const segTree = area.segTree === true && seats.length === 1 && segTreeFits(rowArea.ringPx, frame, height);
      // A lidar tree whose crown at 60% of its height is a few metres across
      // and far shorter than it is tall is a palm: a stem and a small crown.
      if (segTree && heightSample && height >= PALM_MIN_H) {
        const top = heightContourRing(rowArea.ringPx, frame, heightSample, height * 0.6);
        const topM2 = top ? canopyAreaM2(top, frame) : 0;
        const diam = 2 * Math.sqrt(topM2 / Math.PI);
        const cen = top && ringCentroidPx(top);
        const tip = top ? heightContourRing(rowArea.ringPx, frame, heightSample, height * 0.85) : null;
        const tipM2 = tip ? canopyAreaM2(tip, frame) : 0;
        const flatTop = topM2 > 0 && tipM2 >= topM2 * PALM_TOP_SHARE;
        if (cen && flatTop && diam > 0 && diam <= PALM_MAX_DIAM_M && height / diam >= PALM_MIN_RATIO) {
          const made = palmRows([{ c: cen, h: height, diam }], ground);
          if (made && made.length) {
            for (let k = 0; k < made.length; k++) pending.push(made[k]);
            palmCount += made.length;
            continue;
          }
        }
      }
      if (segTree || (!seat.slopePiece && looksLikeIndividualTree(rowArea.ringPx, frame, height))) {
        // A lone broadleaf crown is never much taller than twice its width;
        // a taller reading is a wall or pole return mixed into the crown.
        if (segTree && rowArea.material) {
          const f0 = crownForm(rowArea.ringPx, frame, height, heightSample);
          const diamM = 2 * Math.sqrt(canopyAreaM2(rowArea.ringPx, frame) / Math.PI);
          const capH = Math.max(CROWN_CAP_MIN_H, BROADLEAF_H_PER_DIAM * diamM);
          if (f0 === "broadleaf" && height > capH) {
            const tier = String(rowArea.material.name || "").indexOf("Light") >= 0 ? "light" : "heavy";
            const capMat = materialForVegetation(capH, tier);
            if (capMat) {
              rowArea.material = capMat;
              crownCapped++;
            }
          }
        }
        const parts = individualTreeParts(rowArea.material, ground);
        const stem = parts && trunkRingPx(rowArea.ringPx, frame);
        if (parts && stem) {
          rowArea.material = parts.crownMat;
          clip = parts.crownClip;
          trunk = {
            ringPx: stem,
            material: parts.trunkMat,
            kind: "trunk",
            shape: "polygon",
            clip: parts.trunkClip,
          };
          if (segTree) form = crownForm(rowArea.ringPx, frame, height, heightSample);
          if (ground >= 1) foliageLifted++;
        }
      }
      if (!clip && ground >= 1 && rowArea.material) {
        const lifted = liftFoliagePair(rowArea.material, ground);
        if (lifted) {
          rowArea.material = lifted.material;
          clip = { typeId: lifted.typeId, clipType: lifted.clipType };
          foliageLifted++;
        }
      }
      pending.push({ area: rowArea, clip, trunk, slopePiece: seat.slopePiece, ground, form, tile: !!seat.tile });
    }
  }
  if (prof) profile.add("seat", profile.msSince(tProf));
  let canopyCount = 0;
  if (prof) tProf = profile.now();
  const plans = layerCounts(pending, frame);
  for (let r = 0; r < pending.length; r++) {
    const row = pending[r];
    const area = row.area;
    const wideSlope = row.slopePiece && canopyAreaM2(area && area.ringPx, frame) >= 4000;
    // A short skirt on a ring that climbs more than the skirt is a sheet
    // through the hill. Keep the full bands until the stand is split.
    let relief = 0;
    if (slopeTop && typeof slopeTop.seat === "function" && area.ringPx && area.ringPx.length >= 4) {
      const ll = [];
      for (let i = 0; i < area.ringPx.length; i++) {
        const q = pxToLl(area.ringPx[i][0], area.ringPx[i][1], frame);
        if (q && Number.isFinite(q[0]) && Number.isFinite(q[1])) ll.push(q);
      }
      if (ll.length >= 3) relief = (Number(slopeTop(ll)) || 0) - (Number(slopeTop.seat(ll)) || 0);
    }
    row.skirt = !(relief > 8);
    let stand = plans[r].stand ? standLayerParts(area.material) : null;
    if (stand) {
      stand = stand.map((p) => ({
        ringPx: area.ringPx,
        material: p.material,
        clip: p.clip,
        scale: 1,
      }));
      // The crown over the understory follows the measured height too, so a
      // woods has a rounded, uneven top instead of one flat lid.
      if (heightSample && stand.length === 2) {
        const crownThick = crownThicknessM(stand[1].material);
        const nTop = Math.min(plans[r].n - 1, crownThick >= 3 * MIN_CROWN_BAND_M + 0.3 ? 3 : crownThick >= 2 * MIN_CROWN_BAND_M + 0.2 ? 2 : 1);
        const upper =
          nTop >= 2
            ? crownStack({ area: { ringPx: area.ringPx, material: stand[1].material }, trunk: null, ground: row.ground, skirt: false }, frame, nTop, heightSample, true)
            : null;
        if (upper && upper.length >= 2) stand = [stand[0]].concat(upper);
      }
    }
    const stack = stand || crownStack(row, frame, plans[r].n, heightSample);
    // A crown on a stem is meant to sit above the ground; dropping it would
    // put the crown at the foot of its own trunk.
    const parts = (row.trunk ? (s0) => s0 : (s0) => dropStack(s0, slopeTop, frame))(
      stack || [
        {
          ringPx: area.ringPx,
          material: area.material,
          clip: row.clip || clipboardForCanopy(area.material),
          scale: 1,
        },
      ]
    );
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      // An upper band traced on the height grid of a tile can spill past the
      // tile's roof notch; it is clipped again like the tile itself.
      if (row.tile && i > 0 && clipSet && part.ringPx) {
        const cut = clipFoliageRing(part.ringPx, clipSet) || [];
        let best = null;
        for (let q = 0; q < cut.length; q++) if (!best || ringPxArea(cut[q]) > ringPxArea(best)) best = cut[q];
        if (!best || best.length < 4) continue;
        part.ringPx = best;
      }
      oiAreas.push({
        ringPx: part.ringPx,
        material: part.material,
        kind: row.slopePiece && i === 0 ? "slope" : i === 0 ? "canopy" : "layer",
        shape: area.shape || "polygon",
        keepOutPx,
        keepOutRings: clipSet && clipSet.buildings ? clipSet.buildings.map((b) => b.ring) : [],
      });
      if (part.ringPx && !(part.scale < 0.999)) overlayRings.push(part.ringPx);
      if (part.material) materials.push(part.material);
      pushFoliageClip(part.clip, part.ringPx, frame, affine, seenClip, clipTypes, clipZones);
    }
    canopyCount++;
    if (prof && r === pending.length - 1) profile.add("stack", profile.msSince(tProf));
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
    palms: palmCount,
    spiresDropped,
    crownCapped,
    regionCapped,
    standsTiled: tiled,
    foliageLifted,
    foliageGeometry,
    foliageCoarsened: coarsened,
    foliageDropped,
    polygons: ownedPolygons,
    overlayPoints: [],
    overlayRings,
  };
}

module.exports = {
  isPalmTags,
  palmCentres,
  heightContourRing,
  MAX_TREES,
  maxTreesForBbox,
  pointInAabb,
  treeHitsBuilding,
  normalizeTreePoints,
  treePairsFromPoints,
  canopyPolygonsFromHits,
  blockerFromRings,
  polygonsFromCrowns,
  assembleFoliage,
};

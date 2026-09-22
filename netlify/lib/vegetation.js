"use strict";

const { llToPx, pxToClipboard, applyAffine } = require("./geo-frame");
const { clipZone } = require("./hamina-clipboard");
const { measuredFoliageMaterial, measuredTrunkMaterial, materialForVegetation } = require("./materials");

const { MAX_TREES, MAX_TREES_LARGE, maxTreesForBbox, pickStratified, canopyHeightM } = require("./tree-source");
const { BUILDING_BUFFER_M, createClipSet, clipFoliageRing } = require("./poly-clip");
const TRUNK_R_M = 0.5;

function blobRingPx(cx, cy, rx, ry, n, jitter, seed) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    const rr = 1 + jitter * Math.sin(i * 1.7 + seed);
    pts.push([cx + rx * rr * Math.cos(a), cy + ry * rr * Math.sin(a)]);
  }
  pts.push(pts[0]);
  return pts;
}

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

function pointInLonLatRing(lon, lat, ring) {
  if (!ring || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
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
 * height band. A single cell stays a point (circle). Circles are not used
 * for a multi-cell patch.
 */
function canopyPolygonsFromHits(hits, frame, buildingAabbs, heightSample) {
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
      if (!(heightM > 2)) heightM = canopyHeightM(pct, h.lon, h.lat);
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

function crownRadiusM(heightM, pct) {
  const h = heightM > 2 ? heightM : 9;
  const dense = pct != null && Number.isFinite(+pct) ? 0.85 + 0.3 * Math.min(1, +pct / 100) : 1;
  return Math.max(3, Math.min(11, h * 0.28 * dense));
}

/**
 * Imagery vegetation points (lon/lat) → canopy rings.
 * Multi-cell NLCD patches become canopy polygons. Circles are only for
 * point-like trees (a single cell, a median, RGB, or OSM).
 * OpenIntent uses stock Foliage - Heavy / Light, or a measured-height custom.
 * Clipboard still carries a trunk zone. OSM rings are never generated here.
 */
function treePairsFromPoints(treePoints, frame, buildingAabbs, affine, opts) {
  const pts = normalizeTreePoints(treePoints);
  const pad = 2 / Math.max(frame.mpuX, 0.01);
  const candidates = [];
  for (const p of pts) {
    const [x, y] = llToPx(p.lon, p.lat, frame);
    if (x < 0 || y < 0 || x > frame.imgW || y > frame.imgH) continue;
    if (buildingAabbs && pointInAabb(x, y, buildingAabbs, pad)) continue;
    candidates.push({
      lon: p.lon,
      lat: p.lat,
      x,
      y,
      pct: p.pct != null && Number.isFinite(+p.pct) ? +p.pct : null,
      heightM: p.heightM != null && Number.isFinite(+p.heightM) ? +p.heightM : null,
      score: Number.isFinite(+p.pct) ? +p.pct / 100 : Number.isFinite(+p.score) ? +p.score : 0.5,
      seed: x * 0.13 + y * 0.07,
    });
  }
  // Points are already jittered + NMS'd by the canopy placer. Do not snap
  // them back onto a pixel lattice (that re-creates the orchard grid).
  // Callers already NMS. Keep an intentional median supplement instead of
  // clipping back to the NLCD-only budget. Still stop at the large-map cap.
  const maxTrees = Math.min(MAX_TREES_LARGE, Math.max(maxTreesForBbox(frame), candidates.length));
  const bins = Math.max(8, Math.min(16, Math.round(Math.sqrt(maxTrees / 3.5))));
  const picked = pickStratified(
    candidates,
    maxTrees,
    (c) => [c.x, c.y],
    0,
    0,
    frame.imgW,
    frame.imgH,
    bins,
    bins
  );

  const oiAreas = [];
  const clipZones = [];
  const clipTypes = [];
  const materials = [];
  const overlayRings = [];
  const seenClip = new Set();
  const polygons = canopyPolygonsFromHits(
    opts && opts.canopyHits,
    frame,
    buildingAabbs,
    opts && opts.heightSample
  );
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
  for (let n = 0; n < picked.length; n++) {
    const p = picked[n];
    const measuredH = p.heightM > 2 ? p.heightM : 0;
    const clipHeight =
      measuredH > 2 ? measuredH : p.pct != null ? canopyHeightM(p.pct, p.lon, p.lat) : 0;
    const foliage = clipHeight ? measuredFoliageMaterial(clipHeight) : null;
    const trunk = clipHeight ? measuredTrunkMaterial(clipHeight) : null;
    const heavy =
      measuredH > 2 ? measuredH >= 12 : p.pct != null ? p.pct >= 50 : n % 12 !== 0;
    const canopyStockId = heavy ? "foliage-heavy" : "foliage-light";
    const canopyId = foliage ? foliage.typeId : canopyStockId;
    const trunkId = trunk ? trunk.typeId : "tree-trunk";
    const canopyMat = materialForVegetation(measuredH, heavy ? "heavy" : "light");
    const radiusM = crownRadiusM(measuredH || clipHeight, p.pct);
    const rCanopy = radiusM / frame.mpuX;
    const rTrunk = TRUNK_R_M / frame.mpuX;
    const ryCanopy = radiusM / frame.mpuY;
    const ryTrunk = TRUNK_R_M / frame.mpuY;
    const canopyPx = blobRingPx(p.x, p.y, rCanopy, ryCanopy, 10, 0.08, p.seed);
    const trunkPx = blobRingPx(p.x, p.y, rTrunk, ryTrunk, 6, 0.06, p.seed + 1);
    const hint = { lon: p.lon, lat: p.lat };
    const canopyM = toClipRing(canopyPx, frame, affine, hint);
    const trunkM = toClipRing(trunkPx, frame, affine, hint);
    const canopyZ = clipZone(canopyId, canopyM);
    const trunkZ = clipZone(trunkId, trunkM);
    if (canopyZ) clipZones.push(canopyZ);
    if (trunkZ) clipZones.push(trunkZ);
    if (foliage && !seenClip.has(foliage.clipType.id)) {
      seenClip.add(foliage.clipType.id);
      clipTypes.push(foliage.clipType);
    }
    if (trunk && !seenClip.has(trunk.clipType.id)) {
      seenClip.add(trunk.clipType.id);
      clipTypes.push(trunk.clipType);
    }
    const covered = polygons.some((poly) => pointInLonLatRing(p.lon, p.lat, poly.ringLonLat));
    if (covered || !canopyMat) continue;
    pushCanopy(canopyPx, canopyMat, "circle");
  }
  const overlayPoints = picked.map((p) => [p.x, p.y]);
  return {
    oiAreas,
    clipZones,
    clipTypes,
    materials,
    count: picked.length,
    polygons: polygons.length,
    overlayPoints,
    overlayRings,
  };
}

module.exports = {
  MAX_TREES,
  maxTreesForBbox,
  blobRingPx,
  pointInAabb,
  treeHitsBuilding,
  normalizeTreePoints,
  treePairsFromPoints,
  canopyPolygonsFromHits,
};

"use strict";

const { llToPx, pxToClipboard, applyAffine } = require("./geo-frame");
const { clipZone } = require("./hamina-clipboard");
const { measuredFoliageMaterial, materialForVegetation } = require("./materials");

const { MAX_TREES, maxTreesForBbox, canopyHeightM } = require("./tree-source");
const { BUILDING_BUFFER_M, createClipSet, clipFoliageRing, dissolveFoliageRings } = require("./poly-clip");

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

/** Clipboard type for a canopy polygon. Stock picker ids, or a measured foliage-m-* type. No trunks. */
function clipboardForCanopy(material) {
  if (!material || !material.name) return null;
  if (material.name === "Foliage - Heavy") return { typeId: "foliage-heavy" };
  if (material.name === "Foliage - Light") return { typeId: "foliage-light" };
  const measured = measuredFoliageMaterial(material.top_height);
  if (!measured) return null;
  return { typeId: measured.typeId, clipType: measured.clipType };
}

/**
 * Connected NLCD canopy → foliage rings.
 * Multi-cell patches become canopy polygons. Individual tree points, median
 * dots, and crown circles are not emitted. OpenIntent uses stock Foliage -
 * Heavy / Light, or a measured-height custom. Clipboard gets the same canopy
 * polygons and no trunks. OSM rings are never generated here.
 * `treePoints` is accepted so callers can keep passing placed points; they
 * do not become attenuation areas.
 */
function treePairsFromPoints(treePoints, frame, buildingAabbs, affine, opts) {
  void treePoints;
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
  // Clip against roofs and water, then dissolve so two patches do not paint
  // green on green. Clipboard follows the dissolved rings, not tree points.
  const dissolved = dissolveFoliageRings(oiAreas, clipSet);
  oiAreas.length = 0;
  overlayRings.length = 0;
  for (const area of dissolved) {
    oiAreas.push(area);
    if (area.ringPx) overlayRings.push(area.ringPx);
    const clip = clipboardForCanopy(area.material);
    if (!clip) continue;
    if (clip.clipType && !seenClip.has(clip.clipType.id)) {
      seenClip.add(clip.clipType.id);
      clipTypes.push(clip.clipType);
    }
    const zone = clipZone(clip.typeId, toClipRing(area.ringPx, frame, affine, null));
    if (zone) clipZones.push(zone);
  }
  return {
    oiAreas,
    clipZones,
    clipTypes,
    materials,
    count: oiAreas.length,
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

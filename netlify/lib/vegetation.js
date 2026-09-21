"use strict";

const { llToPx, pxToClipboard, applyAffine } = require("./geo-frame");
const { clipZone } = require("./hamina-clipboard");

const { MAX_TREES, pickStratified } = require("./tree-source");
const CANOPY_R_M = 5.2;
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
      out.push({ lon, lat, pct, score });
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
  return ringPx.map(([x, y]) => pxToClipboard(x, y, frame));
}

/**
 * Imagery vegetation points (lon/lat) → trunk + canopy pairs.
 * OSM rings are never generated here.
 */
function treePairsFromPoints(treePoints, frame, buildingAabbs, affine) {
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
      score: Number.isFinite(+p.pct) ? +p.pct / 100 : Number.isFinite(+p.score) ? +p.score : 0.5,
      seed: x * 0.13 + y * 0.07,
    });
  }
  // Points are already jittered + NMS'd by the canopy placer. Do not snap
  // them back onto a pixel lattice (that re-creates the orchard grid).
  const picked = pickStratified(
    candidates,
    MAX_TREES,
    (c) => [c.x, c.y],
    0,
    0,
    frame.imgW,
    frame.imgH
  );

  const oiAreas = [];
  const clipZones = [];
  for (let n = 0; n < picked.length; n++) {
    const p = picked[n];
    const heavy = n % 12 !== 0;
    const canopyId = heavy ? "foliage-heavy" : "foliage-light";
    const rCanopy = (CANOPY_R_M + (n % 4) * 0.4) / frame.mpuX;
    const rTrunk = TRUNK_R_M / frame.mpuX;
    const ryCanopy = (CANOPY_R_M + (n % 4) * 0.4) / frame.mpuY;
    const ryTrunk = TRUNK_R_M / frame.mpuY;
    const canopyPx = blobRingPx(p.x, p.y, rCanopy, ryCanopy, 8, 0.12, p.seed);
    const trunkPx = blobRingPx(p.x, p.y, rTrunk, ryTrunk, 6, 0.06, p.seed + 1);
    const hint = { lon: p.lon, lat: p.lat };
    const canopyM = toClipRing(canopyPx, frame, affine, hint);
    const trunkM = toClipRing(trunkPx, frame, affine, hint);
    const canopyZ = clipZone(canopyId, canopyM);
    const trunkZ = clipZone("tree-trunk", trunkM);
    if (canopyZ) clipZones.push(canopyZ);
    if (trunkZ) clipZones.push(trunkZ);
    oiAreas.push({ ringPx: canopyPx, typeId: canopyId });
    oiAreas.push({ ringPx: trunkPx, typeId: "tree-trunk" });
  }
  return { oiAreas, clipZones, count: picked.length };
}

module.exports = {
  MAX_TREES,
  blobRingPx,
  pointInAabb,
  normalizeTreePoints,
  treePairsFromPoints,
};

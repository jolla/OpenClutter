"use strict";

const { llToPx, pxToClipboard, applyAffine } = require("./geo-frame");
const { clipZone, TYPE_BY_ID, oiMaterialFromType } = require("./hamina-clipboard");
const { measuredFoliageMaterial, measuredTrunkMaterial } = require("./materials");

const { MAX_TREES, MAX_TREES_LARGE, maxTreesForBbox, pickStratified, canopyHeightM } = require("./tree-source");
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
  const seenClip = new Set();
  for (let n = 0; n < picked.length; n++) {
    const p = picked[n];
    const measuredH =
      p.heightM > 2 ? p.heightM : p.pct != null ? canopyHeightM(p.pct, p.lon, p.lat) : 0;
    const foliage = measuredH ? measuredFoliageMaterial(measuredH) : null;
    const trunk = measuredH ? measuredTrunkMaterial(measuredH) : null;
    const heavy = n % 12 !== 0;
    const canopyId = foliage ? foliage.typeId : heavy ? "foliage-heavy" : "foliage-light";
    const trunkId = trunk ? trunk.typeId : "tree-trunk";
    const canopyMat = foliage ? foliage.material : oiMaterialFromType(TYPE_BY_ID[canopyId]);
    const trunkMat = trunk ? trunk.material : oiMaterialFromType(TYPE_BY_ID["tree-trunk"]);
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
    const trunkZ = clipZone(trunkId, trunkM);
    if (canopyZ) clipZones.push(canopyZ);
    if (trunkZ) clipZones.push(trunkZ);
    if (foliage && !seenClip.has(foliage.clipType.id)) {
      seenClip.add(foliage.clipType.id);
      clipTypes.push(foliage.clipType);
      materials.push(foliage.material);
    }
    if (trunk && !seenClip.has(trunk.clipType.id)) {
      seenClip.add(trunk.clipType.id);
      clipTypes.push(trunk.clipType);
      materials.push(trunk.material);
    }
    oiAreas.push({ ringPx: canopyPx, typeId: canopyId, material: canopyMat, kind: "canopy" });
    oiAreas.push({ ringPx: trunkPx, typeId: trunkId, material: trunkMat, kind: "trunk" });
  }
  return { oiAreas, clipZones, clipTypes, materials, count: picked.length };
}

module.exports = {
  MAX_TREES,
  maxTreesForBbox,
  blobRingPx,
  pointInAabb,
  treeHitsBuilding,
  normalizeTreePoints,
  treePairsFromPoints,
};

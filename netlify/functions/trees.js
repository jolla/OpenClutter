/**
 * Server-side JPEG vegetation (jpeg-js). Kept for offline/experiments.
 * Do NOT require this from clutter.js — decode 504s on Netlify hobby.
 * Default trees: NLCD/USFS canopy (browser or clutter.js) with imagery RGB
 * fallback via public/tree-detect.js detectTreesFromImageData.
 */
const { detectTreesFromImageData, isVeg, MAX_TREES } = require("../lib/tree-source");

function tryDecode(buf) {
  try {
    const jpeg = require("jpeg-js");
    return jpeg.decode(buf, { useTArray: true, maxResolutionInMP: 20 });
  } catch {
    return null;
  }
}

function blob(cx, cy, r, n, jitter, seed) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    const rr = r * (1 + jitter * Math.sin(i * 1.7 + seed));
    pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
  }
  pts.push(pts[0]);
  return pts;
}

function mat(name, color, top, bottom, db) {
  const m = {
    name,
    display_color: color,
    top_height: top,
    rf_properties: { attenuation_per_m: db },
  };
  if (bottom != null) m.bottom_height = bottom;
  return m;
}

const CANOPY = mat("Tree_Canopy", "#415915", 12, 3.5, 2);
const TRUNK = mat("Tree_Trunk", "#7F4A1E", 3.5, null, 10);

function toArea(ringPx, imgW, imgH, material, xyz) {
  const coords = ringPx.map(([x, y]) =>
    xyz(Math.min(imgW, Math.max(0, x)), Math.min(imgH, Math.max(0, y)))
  );
  if (coords.length < 4) return null;
  return { area: { coordinates: coords }, area_material: material };
}

function treesFromJpeg(imgBuf, imgW, imgH, mpu, xyz) {
  const raw = tryDecode(imgBuf);
  if (!raw || !raw.data) return { areas: [], clipboardZones: [], clipboardTypes: [] };
  const w = raw.width, h = raw.height, data = raw.data;
  const sx = imgW / w;
  const sy = imgH / h;
  const step = Math.max(6, Math.round(8 / mpu));
  const picked = detectTreesFromImageData(data, w, h, null, { maxTrees: MAX_TREES, step });
  const out = [];
  const zones = [];
  const typeCanopy = {
    id: "3bfb96f1-2fd9-41ac-ba7e-cfa8a377ffb0",
    name: "Tree_Canopy",
    color: "#415915",
    shortcutKey: "d",
    topEdge: 12,
    bottomEdge: 3.5,
    attenuationDbPerMeter: 2,
    ituRModelEnabled: true,
    transparencyEnabled: false,
  };
  const typeTrunk = {
    id: "5749a1d6-1774-4a23-86de-538dbeabf3ee",
    name: "Tree_Trunk",
    color: "#7F4A1E",
    shortcutKey: "z",
    topEdge: 3.5,
    bottomEdge: null,
    attenuationDbPerMeter: 10,
    ituRModelEnabled: true,
    transparencyEnabled: false,
  };
  picked.forEach((p, n) => {
    const hit = { x: p.x * sx, yUp: imgH - p.y * sy, seed: p.x * 0.13 + p.y * 0.07 };
    const rCanopy = (4.8 + (n % 4) * 0.5) / mpu;
    const rTrunk = 0.5 / mpu;
    const canopy = toArea(blob(hit.x, hit.yUp, rCanopy, 10, 0.22, hit.seed), imgW, imgH, CANOPY, xyz);
    const trunk = toArea(blob(hit.x, hit.yUp, rTrunk, 8, 0.08, hit.seed + 1), imgW, imgH, TRUNK, xyz);
    if (canopy) out.push(canopy);
    if (trunk) out.push(trunk);
    const ringM = (ring) => ring.map(([px, py]) => [px * mpu, py * mpu]);
    zones.push({
      typeId: typeTrunk.id,
      area: { type: "Polygon", coordinates: [ringM(blob(hit.x, hit.yUp, rTrunk, 8, 0.08, hit.seed + 1))] },
    });
    zones.push({
      typeId: typeCanopy.id,
      area: { type: "Polygon", coordinates: [ringM(blob(hit.x, hit.yUp, rCanopy, 10, 0.22, hit.seed))] },
    });
  });
  return { areas: out, clipboardZones: zones, clipboardTypes: [typeCanopy, typeTrunk] };
}

module.exports = { treesFromJpeg, CANOPY, TRUNK, isVeg };

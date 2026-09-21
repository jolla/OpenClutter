/**
 * Server-side JPEG vegetation (jpeg-js). Kept for offline/experiments.
 * Do NOT require this from clutter.js — decode 504s on Netlify hobby.
 * Default trees: browser detectTrees() → lon/lat → shared geo frame.
 */
function tryDecode(buf) {
  try {
    const jpeg = require("jpeg-js");
    return jpeg.decode(buf, { useTArray: true, maxResolutionInMP: 20 });
  } catch {
    return null;
  }
}

function isVeg(r, g, b) {
  const s = r + g + b;
  if (s < 70 || s > 420) return false;
  if (b > 125 && b > g + 8) return false;
  if (r > 185 && g > 170) return false;
  const olive = g >= r - 18 && g > b + 4 && r > 38 && r < 160 && g > 42 && g < 145 && b < 110;
  const dusty = r >= g - 8 && r > b + 10 && r > 45 && r < 140 && g > 40 && g < 120 && b < 90 && g > r * 0.55;
  return olive || dusty;
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
  const hits = [];
  for (let yTop = step; yTop < h - step; yTop += step) {
    for (let x = step; x < w - step; x += step) {
      const i = (yTop * w + x) * 4;
      if (!isVeg(data[i], data[i + 1], data[i + 2])) continue;
      let ok = 0, n = 0;
      for (let dy = -4; dy <= 4; dy += 4) {
        for (let dx = -4; dx <= 4; dx += 4) {
          const yy = yTop + dy, xx = x + dx;
          if (yy < 0 || xx < 0 || yy >= h || xx >= w) continue;
          n++;
          if (isVeg(data[(yy * w + xx) * 4], data[(yy * w + xx) * 4 + 1], data[(yy * w + xx) * 4 + 2])) ok++;
        }
      }
      if (n && ok / n < 0.4) continue;
      hits.push({ x: x * sx, yUp: imgH - yTop * sy, seed: x * 0.13 + yTop * 0.07 });
    }
  }
  const cell = Math.max(12, Math.round(14 / mpu));
  const seen = new Set();
  const picked = [];
  for (const h0 of hits) {
    const k = Math.floor(h0.x / cell) + ":" + Math.floor(h0.yUp / cell);
    if (seen.has(k)) continue;
    seen.add(k);
    picked.push(h0);
    if (picked.length >= 180) break;
  }
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
    const rCanopy = (4.8 + (n % 4) * 0.5) / mpu;
    const rTrunk = 0.5 / mpu;
    const canopy = toArea(blob(p.x, p.yUp, rCanopy, 10, 0.22, p.seed), imgW, imgH, CANOPY, xyz);
    const trunk = toArea(blob(p.x, p.yUp, rTrunk, 8, 0.08, p.seed + 1), imgW, imgH, TRUNK, xyz);
    if (canopy) out.push(canopy);
    if (trunk) out.push(trunk);
    const ringM = (ring) => ring.map(([px, py]) => [px * mpu, py * mpu]);
    zones.push({
      typeId: typeTrunk.id,
      area: { type: "Polygon", coordinates: [ringM(blob(p.x, p.yUp, rTrunk, 8, 0.08, p.seed + 1))] },
    });
    zones.push({
      typeId: typeCanopy.id,
      area: { type: "Polygon", coordinates: [ringM(blob(p.x, p.yUp, rCanopy, 10, 0.22, p.seed))] },
    });
  });
  return { areas: out, clipboardZones: zones, clipboardTypes: [typeCanopy, typeTrunk] };
}

module.exports = { treesFromJpeg, CANOPY, TRUNK };

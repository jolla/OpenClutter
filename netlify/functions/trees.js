function tryDecode(buf) {
  try {
    const jpeg = require("jpeg-js");
    return jpeg.decode(buf, { useTArray: true, maxResolutionInMP: 20 });
  } catch {
    return null;
  }
}

function isVeg(r, g, b) {
  if (b > 130 && b > g && b > r) return false;
  if (r > 190 && g > 180 && b > 160) return false;
  const olive = r > 50 && r < 175 && g > 48 && g < 155 && b < 115 && g >= r - 20 && g > b + 6;
  const green = g > r + 6 && g > b + 6 && g > 42 && g < 145 && r < 125;
  return olive || green;
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
  const step = Math.max(10, Math.round(16 / mpu));
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
  let n = 0;
  for (let yTop = step; yTop < h - step && n < 120; yTop += step) {
    for (let x = step; x < w - step; x += step) {
      const i = (yTop * w + x) * 4;
      if (!isVeg(data[i], data[i + 1], data[i + 2])) continue;
      let hits = 0, samples = 0;
      for (let dy = -3; dy <= 3; dy += 3) {
        for (let dx = -3; dx <= 3; dx += 3) {
          const j = ((yTop + dy) * w + (x + dx)) * 4;
          if (j < 0 || j >= data.length) continue;
          samples++;
          if (isVeg(data[j], data[j + 1], data[j + 2])) hits++;
        }
      }
      if (samples && hits / samples < 0.45) continue;
      const yUp = imgH - yTop;
      const seed = x * 0.13 + yTop * 0.07;
      const rCanopy = (5.5 + (n % 4) * 0.6) / mpu;
      const rTrunk = 0.55 / mpu;
      const canopy = toArea(blob(x, yUp, rCanopy, 10, 0.22, seed), imgW, imgH, CANOPY, xyz);
      const trunk = toArea(blob(x, yUp, rTrunk, 8, 0.08, seed + 1), imgW, imgH, TRUNK, xyz);
      if (canopy) out.push(canopy);
      if (trunk) out.push(trunk);
      const ringM = (ring) => ring.map(([px, py]) => [px * mpu, py * mpu]);
      zones.push({
        typeId: typeTrunk.id,
        area: { type: "Polygon", coordinates: [ringM(blob(x, yUp, rTrunk, 8, 0.08, seed + 1))] },
      });
      zones.push({
        typeId: typeCanopy.id,
        area: { type: "Polygon", coordinates: [ringM(blob(x, yUp, rCanopy, 10, 0.22, seed))] },
      });
      n++;
    }
  }
  return { areas: out, clipboardZones: zones, clipboardTypes: [typeCanopy, typeTrunk] };
}

module.exports = { treesFromJpeg, CANOPY, TRUNK };

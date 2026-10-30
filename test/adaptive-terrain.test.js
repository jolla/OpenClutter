"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { geoFrame, llToClipboard } = require("../netlify/lib/geo-frame");
const terrain = require("../netlify/lib/terrain");
const exportMode = require("../netlify/lib/export-mode");
const { glo30FineGrid } = require("../netlify/lib/copernicus-dem");

// A benched open pit: 2 km box, 180 m deep, flat rim plain and a flat floor.
const BOX = { west: 121.49, south: -30.79, east: 121.511, north: -30.772 };
function pitZ(lon, lat) {
  const cx = (BOX.west + BOX.east) / 2;
  const cy = (BOX.south + BOX.north) / 2;
  const dx = (lon - cx) * 95600;
  const dy = (lat - cy) * 110900;
  const r = Math.hypot(dx * 0.8, dy);
  const rim = 650;
  const floorR = 160;
  if (r >= rim) return 400 + (lon - cx) * 2000;
  if (r <= floorR) return 220;
  const t = (r - floorR) / (rim - floorR);
  // 15 m benches on a 180 m wall.
  const depth = 180 * (1 - t);
  return 400 - (180 - Math.round(depth / 15) * 15 * 0.6 - (180 - depth) * 0.4) + (lon - cx) * 2000 * t;
}
function coarseSamples(side) {
  const out = [];
  for (let r = 0; r < side; r++) {
    const lat = BOX.south + ((r + 0.5) / side) * (BOX.north - BOX.south);
    for (let c = 0; c < side; c++) {
      const lon = BOX.west + ((c + 0.5) / side) * (BOX.east - BOX.west);
      out.push({ lon, lat, z: pitZ(lon, lat) });
    }
  }
  return out;
}
function fineGrid(n) {
  const z = new Float32Array(n * n);
  for (let r = 0; r < n; r++) {
    const lat = BOX.south + (r / (n - 1)) * (BOX.north - BOX.south);
    for (let c = 0; c < n; c++) {
      const lon = BOX.west + (c / (n - 1)) * (BOX.east - BOX.west);
      z[r * n + c] = pitZ(lon, lat);
    }
  }
  return Object.assign({ cols: n, rows: n, z }, BOX);
}
function meshRms(t, frame) {
  const floors = [];
  for (const f of t.clipboard.slopedFloors) floors.push({ ring: f.area.coordinates[0], sloped: true });
  for (const f of t.clipboard.raisedFloorZones) floors.push({ ring: f.area.coordinates[0], h: f.height });
  const inside = (ring, x, y) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const yi = ring[i][1];
      const yj = ring[j][1];
      if (yi > y !== yj > y && x < ((ring[j][0] - ring[i][0]) * (y - yi)) / (yj - yi || 1e-20) + ring[i][0]) hit = !hit;
    }
    return hit;
  };
  let sq = 0;
  let n = 0;
  for (let j = 0; j < 40; j++) {
    for (let i = 0; i < 40; i++) {
      const lon = BOX.west + ((i + 0.37) / 40) * (BOX.east - BOX.west);
      const lat = BOX.south + ((j + 0.41) / 40) * (BOX.north - BOX.south);
      const [x, y] = llToClipboard(lon, lat, frame);
      let z = null;
      for (const f of floors) {
        if (!inside(f.ring, x, y)) continue;
        let v = f.h;
        if (f.sloped) {
          // Ramp height by distance from the low edge toward the high edge.
          const r = f.ring;
          const ax = (r[0][0] + r[1][0]) / 2;
          const ay = (r[0][1] + r[1][1]) / 2;
          const bx = (r[2][0] + r[3][0]) / 2;
          const by = (r[2][1] + r[3][1]) / 2;
          const den = (bx - ax) ** 2 + (by - ay) ** 2;
          const tt = den > 0 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / den)) : 0;
          v = r[0][2] + (r[2][2] - r[0][2]) * tt;
        }
        if (z == null || v > z) z = v;
      }
      if (z == null) continue;
      const e = z - (pitZ(lon, lat) - t.datumZ);
      sq += e * e;
      n++;
    }
  }
  return { rms: Math.sqrt(sq / n), cover: n / 1600 };
}

test("adaptive terrain is off by default, on for /dev hosts, never for production", () => {
  assert.strictEqual(exportMode.isAdaptiveTerrain(), false);
  assert.strictEqual(exportMode.adaptiveTerrainWanted(false, { adaptiveTerrain: true }), false);
  assert.strictEqual(exportMode.adaptiveTerrainWanted(false, {}), false);
  assert.strictEqual(exportMode.adaptiveTerrainWanted(true, {}), true);
  assert.strictEqual(exportMode.adaptiveTerrainWanted(true, null), true);
  assert.strictEqual(exportMode.adaptiveTerrainWanted(true, { adaptiveTerrain: false }), false);
  assert.strictEqual(exportMode.adaptiveTerrainWanted(true, { adaptiveTerrain: "0" }), false);
});

test("with the switch off a fine grid on the samples changes nothing", () => {
  const frame = geoFrame(BOX, { maxSpanM: 20000 });
  const plain = coarseSamples(24);
  const withFine = terrain.attachFineGrid(coarseSamples(24), fineGrid(60));
  exportMode.setAdaptiveTerrain(false);
  const a = terrain.terrainFromSamples(plain, frame, { terrainResolution: "auto", kind: "surface" });
  const b = terrain.terrainFromSamples(withFine, frame, { terrainResolution: "auto", kind: "surface" });
  const strip = (clip) => JSON.stringify(Object.assign({}, clip, { header: Object.assign({}, clip.header, { id: "" }) }));
  assert.strictEqual(strip(b.clipboard), strip(a.clipboard));
  assert.strictEqual(b.adaptive, undefined);
  assert.strictEqual(JSON.stringify(withFine), JSON.stringify(plain), "fine grid is not serialized");
});

test("adaptive mesh stays inside the paste caps and follows a benched pit closer", () => {
  const frame = geoFrame(BOX, { maxSpanM: 20000 });
  exportMode.setAdaptiveTerrain(false);
  const base = terrain.terrainFromSamples(coarseSamples(24), frame, { terrainResolution: "auto", kind: "surface" });
  exportMode.setAdaptiveTerrain(true);
  try {
    const fine = terrain.attachFineGrid(coarseSamples(24), fineGrid(70));
    const ad = terrain.terrainFromSamples(fine, frame, { terrainResolution: "auto", kind: "surface" });
    assert.strictEqual(ad.adaptive, true);
    const floors = ad.sloped + ad.raised;
    assert.ok(floors <= terrain.TERRAIN_PASTE_MAX_FLOORS, "floors " + floors);
    assert.ok(JSON.stringify(ad.clipboard).length <= terrain.TERRAIN_PASTE_MAX_BYTES);
    for (const f of ad.clipboard.slopedFloors) assert.ok(terrain.planarSlopedRamp(f.area.coordinates[0]));
    for (const f of ad.clipboard.raisedFloorZones) assert.ok(f.height >= 0);
    const eb = meshRms(base, frame);
    const ea = meshRms(ad, frame);
    assert.ok(ea.cover >= 0.995, "cover " + ea.cover);
    assert.ok(ea.rms < eb.rms, "adaptive " + ea.rms.toFixed(2) + " vs default " + eb.rms.toFixed(2));
  } finally {
    exportMode.setAdaptiveTerrain(false);
  }
});

test("GLO-30 fine grid runs edge to edge at the raster posting", () => {
  const res = 1 / 3600;
  const frame = { west: 121.5, south: -30.8, east: 121.51, north: -30.79 };
  const w = 50;
  const h = 50;
  const data = new Float32Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) data[r * w + c] = 300 + c;
  const tile = { data, width: w, height: h, left: 0, top: 0, origin: [121.499, -30.789], res: [res, -res], nodata: null };
  const g = glo30FineGrid([tile], frame, 320);
  assert.strictEqual(g.cols, 37);
  assert.strictEqual(g.rows, 37);
  // West edge is 0.001 deg (3.6 px) east of the origin.
  assert.ok(Math.abs(g.z[0] - 303.6) < 0.05, String(g.z[0]));
  assert.strictEqual(glo30FineGrid([tile], frame, 10).cols, 10);
});

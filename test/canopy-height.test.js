"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { sampleChmGrid, applyChmToTrees, chmUrl, CHM_ZOOM, crownsFromChm, peakPool, selectCrownsForExport, mercator, lonLatFromMercator, fetchChmGrid } = require("../netlify/lib/canopy-height");
const { quadkeysForBbox } = require("../netlify/lib/ms-global");
const { treePairsFromPoints } = require("../netlify/lib/vegetation");
const { geoFrame, llToPx } = require("../netlify/lib/geo-frame");
const { buildClutter, footprintsToClutter, oiPixelCoords } = require("../netlify/lib/pipeline");
const { terrainFromSamples } = require("../netlify/lib/terrain");
const { intersectionAreaPx } = require("../netlify/lib/poly-clip");
const { canopyHeightM } = require("../netlify/lib/tree-source");

function pointInRing(pt, ring) {
  const pts =
    ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring.slice();
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0];
    const yi = pts[i][1];
    const xj = pts[j][0];
    const yj = pts[j][1];
    const hit = yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi || 1e-20) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

function isAxisRect(ring) {
  const open =
    ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring.slice();
  if (open.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const a = open[i];
    const b = open[(i + 1) % 4];
    if (Math.abs(a[0] - b[0]) > 1e-6 && Math.abs(a[1] - b[1]) > 1e-6) return false;
  }
  return true;
}

function bboxAspect(ring) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const w = maxX - minX;
  const h = maxY - minY;
  return Math.max(w, h) / Math.max(Math.min(w, h), 1e-9);
}

/** ~4.2 m CHM pixels over a small block, north at row 0. */
function syntheticChm() {
  const w = 64;
  const h = 48;
  const values = new Uint8Array(w * h);
  const mLon = 111320 * Math.cos((43 * Math.PI) / 180);
  const dLon = (w * 4.2) / mLon;
  const dLat = (h * 4.2) / 110540;
  return {
    w,
    h,
    values,
    grid: { west: -88, south: 43, east: -88 + dLon, north: 43 + dLat, width: w, height: h, values },
  };
}

function paintPeak(values, w, cx, cy, rx, ry, top) {
  const h = values.length / w;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r <= 1) {
        const hgt = Math.max(3, Math.round(top * (1 - 0.5 * r)));
        if (hgt > values[y * w + x]) values[y * w + x] = hgt;
      }
    }
  }
}

describe("canopy height grid", () => {
  it("samples a CHM grid in lon/lat with north at row 0 and ignores sub-2 m", () => {
    const values = Buffer.alloc(4);
    values[0] = 12;
    values[1] = 1;
    values[2] = 0;
    values[3] = 9;
    const grid = { west: 0, south: 0, east: 1, north: 1, width: 2, height: 2, values };
    assert.equal(sampleChmGrid(grid, 0, 1), 12);
    assert.equal(sampleChmGrid(grid, 1, 1), 0);
    assert.equal(sampleChmGrid(grid, 1, 0), 9);
    assert.equal(sampleChmGrid(grid, 2, 2), 0);
    const applied = applyChmToTrees(
      [
        { lon: 0, lat: 1, pct: 40 },
        { lon: 1, lat: 1, pct: 40 },
      ],
      (lon, lat) => sampleChmGrid(grid, lon, lat)
    );
    assert.equal(applied.applied, 1);
    assert.equal(applied.trees[0].heightM, 12);
    assert.equal(applied.trees[0].heightSource, "chm");
    assert.equal(applied.trees[1].heightM, undefined);
  });

  it("does not turn a lone CHM point or a median dot into a crown circle", () => {
    const frame = geoFrame({ west: -87.93, south: 42.89, east: -87.91, north: 42.91, name: "C" });
    const lon = frame.west + (frame.east - frame.west) * 0.2;
    const lat = frame.south + (frame.north - frame.south) * 0.2;
    const pairs = treePairsFromPoints([{ lon, lat, pct: 70, heightM: 14.2, median: true }], frame, []);
    assert.equal(pairs.oiAreas.length, 0);
    assert.equal(pairs.overlayPoints.length, 0);
    assert.equal(pairs.clipZones.length, 0);
    assert.equal(pairs.oiAreas.some((a) => a.shape === "circle"), false);
    assert.equal(
      pairs.clipZones.some((z) => z.typeId === "tree-trunk" || String(z.typeId).indexOf("trunk") === 0),
      false
    );
  });

  it("traces a multi-cell NLCD patch as one canopy polygon at the measured height", () => {
    const frame = geoFrame({ west: -87.93, south: 42.89, east: -87.91, north: 42.91, name: "P" });
    const cellLon = 30 / (111320 * Math.cos((42.9 * Math.PI) / 180));
    const cellLat = 30 / 110540;
    const lon0 = frame.west + (frame.east - frame.west) * 0.35;
    const lat0 = frame.south + (frame.north - frame.south) * 0.35;
    const hits = [];
    for (let iy = 0; iy < 2; iy++) {
      for (let ix = 0; ix < 3; ix++) {
        hits.push({ lon: lon0 + ix * cellLon, lat: lat0 + iy * cellLat, pct: 80 });
      }
    }
    const inside = { lon: lon0 + cellLon, lat: lat0 + cellLat * 0.4, pct: 80, heightM: 14.2 };
    const pairs = treePairsFromPoints([inside], frame, [], null, {
      canopyHits: hits,
      heightSample: () => 14.2,
    });
    const canopies = pairs.oiAreas.filter((a) => a.kind === "canopy");
    const layers = pairs.oiAreas.filter((a) => a.kind === "layer");
    assert.equal(canopies.length, 1);
    assert.equal(layers.length, 1);
    assert.equal(canopies[0].shape, "polygon");
    assert.equal(canopies[0].material.name, "Foliage - Heavy 7.1");
    assert.equal(canopies[0].material.top_height, 7.1);
    assert.equal(layers[0].material.top_height, 14.2);
    assert.equal(layers[0].material.rf_properties.attenuation_per_m, 1.5);
    assert.ok(canopies[0].ringPx.length >= 5);
    assert.ok(canopies[0].ringPx.length <= 41);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of canopies[0].ringPx) {
      minX = Math.min(minX, p[0]);
      maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    }
    const aspect = Math.max(maxX - minX, maxY - minY) / Math.min(maxX - minX, maxY - minY);
    assert.ok(aspect > 1.3, "patch outline follows the 3×2 cells, not a circle");
    let layerShort = Infinity;
    let minLX = Infinity;
    let maxLX = -Infinity;
    let minLY = Infinity;
    let maxLY = -Infinity;
    for (const p of layers[0].ringPx) {
      minLX = Math.min(minLX, p[0]);
      maxLX = Math.max(maxLX, p[0]);
      minLY = Math.min(minLY, p[1]);
      maxLY = Math.max(maxLY, p[1]);
    }
    layerShort = Math.min(maxLX - minLX, maxLY - minLY);
    assert.ok(layerShort < Math.min(maxX - minX, maxY - minY), "upper band steps in");
    assert.equal(pairs.oiAreas.some((a) => a.kind === "trunk"), false);
    assert.ok(pairs.clipTypes.some((t) => t.id === "foliage-m-7_1"));
  });

  it("draws separate CHM crowns with measured shape and height", () => {
    const g = syntheticChm();
    paintPeak(g.values, g.w, 14, 16, 4.2, 1.7, 16);
    paintPeak(g.values, g.w, 46, 18, 1.6, 4.4, 9);
    for (let x = 30; x <= 38; x++) {
      for (let y = 34; y <= 36; y++) g.values[y * g.w + x] = 11;
    }
    g.values[4 * g.w + 4] = 2;
    g.values[5 * g.w + 4] = 4;
    const frame = geoFrame({
      west: g.grid.west,
      south: g.grid.south,
      east: g.grid.east,
      north: g.grid.north,
      name: "Crowns",
    });
    const pairs = treePairsFromPoints([], frame, [], null, { chmGrid: g.grid });
    assert.equal(pairs.foliageGeometry, "chm-contour");
    assert.equal(pairs.oiAreas.some((a) => a.shape === "circle" || a.kind === "trunk"), false);
    assert.equal(pairs.overlayPoints.length, 0);
    const heavy = pairs.oiAreas.filter((a) => a.material.top_height >= 14);
    assert.equal(heavy.length, 1);
    assert.equal(heavy[0].material.top_height, 16);
    assert.equal(heavy[0].material.rf_properties.attenuation_per_m, 1.5);
    assert.ok(bboxAspect(heavy[0].ringPx) > 1.6, "wide crown is not a circle");
    const tall = pairs.oiAreas.find((a) => a.material.top_height === 9);
    assert.ok(tall, "tall crown is kept");
    assert.ok(bboxAspect(tall.ringPx) > 1.6, "tall crown keeps its long axis");
    const flat = pairs.oiAreas.filter((a) => a.material.top_height === 11);
    assert.equal(flat.length, 1, "a flat clump is one outline, not a scatter");
    assert.ok(bboxAspect(flat[0].ringPx) > 1.8);
    assert.equal(
      pairs.oiAreas.some((a) => a.material.top_height <= 4),
      false,
      "sub-5 m spikes are not trees"
    );
    assert.ok(pairs.oiAreas.every((a) => a.ringPx.length >= 4 && a.ringPx.length <= 40));
  });

  it("keeps an L-shaped crown and drops a short spike off the NLCD field", () => {
    const g = syntheticChm();
    for (let x = 20; x <= 22; x++) g.values[18 * g.w + x] = 14;
    for (let y = 18; y <= 20; y++) g.values[y * g.w + 20] = 14;
    g.values[18 * g.w + 20] = 18;
    paintPeak(g.values, g.w, 50, 8, 1.6, 1.6, 7);
    const frame = geoFrame({
      west: g.grid.west,
      south: g.grid.south,
      east: g.grid.east,
      north: g.grid.north,
      name: "L",
    });
    const bare = treePairsFromPoints([], frame, [], null, { chmGrid: g.grid });
    assert.ok(bare.oiAreas.some((a) => a.material.top_height === 7));
    const hits = [{ lon: g.grid.west + (g.grid.east - g.grid.west) * 0.35, lat: g.grid.south + (g.grid.north - g.grid.south) * 0.62, pct: 80 }];
    for (let i = 0; i < 6; i++) {
      hits.push({
        lon: hits[0].lon + i * 0.00002,
        lat: hits[0].lat,
        pct: 70,
      });
    }
    const filtered = treePairsFromPoints([], frame, [], null, { chmGrid: g.grid, canopyHits: hits });
    assert.equal(filtered.foliageGeometry, "chm-contour");
    assert.ok(
      filtered.oiAreas.some((a) => a.material.top_height === 7),
      "a measured crown stays when it is not on a roof, road, pavement, or water"
    );
    const ell = filtered.oiAreas.find((a) => a.material.top_height === 18);
    assert.ok(ell, "the L stays");
    assert.ok(ell.ringPx.length >= 6);
    assert.equal(isAxisRect(ell.ringPx), false, "the L is a traced outline, not a grid box");
    const px = ell.ringPx;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of px) {
      minX = Math.min(minX, p[0]);
      maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    }
    const gap = [minX + (maxX - minX) * 0.85, minY + (maxY - minY) * 0.15];
    assert.equal(pointInRing(gap, px), false, "the missing quadrant of the L is empty");
  });

  it("uses CHM crowns instead of one NLCD blob when both describe the same woods", () => {
    const frame = geoFrame({ west: -87.93, south: 42.89, east: -87.91, north: 42.91, name: "Both" });
    const cellLon = 30 / (111320 * Math.cos((42.9 * Math.PI) / 180));
    const cellLat = 30 / 110540;
    const lon0 = frame.west + (frame.east - frame.west) * 0.4;
    const lat0 = frame.south + (frame.north - frame.south) * 0.4;
    const hits = [];
    for (let iy = 0; iy < 3; iy++) {
      for (let ix = 0; ix < 4; ix++) hits.push({ lon: lon0 + ix * cellLon, lat: lat0 + iy * cellLat, pct: 80 });
    }
    const nlcd = treePairsFromPoints([], frame, [], null, { canopyHits: hits, heightSample: () => 14 });
    assert.equal(nlcd.foliageGeometry, "nlcd-polygon");
    assert.equal(nlcd.oiAreas.filter((a) => a.kind === "canopy").length, 1);
    assert.equal(nlcd.oiAreas.length, 2);
    const mLon = 111320 * Math.cos((42.9 * Math.PI) / 180);
    const w = 36;
    const h = 36;
    const values = new Uint8Array(w * h);
    const dLon = (w * 5) / mLon;
    const dLat = (h * 5) / 110540;
    const grid = {
      west: lon0 - dLon * 0.15,
      south: lat0 - dLat * 0.15,
      east: lon0 - dLon * 0.15 + dLon,
      north: lat0 - dLat * 0.15 + dLat,
      width: w,
      height: h,
      values,
    };
    function pix(lon, lat) {
      const x = Math.round(((lon - grid.west) / (grid.east - grid.west)) * (w - 1));
      const y = Math.round(((grid.north - lat) / (grid.north - grid.south)) * (h - 1));
      return [x, y];
    }
    const [x1, y1] = pix(lon0 + cellLon, lat0 + cellLat);
    const [x2, y2] = pix(lon0 + cellLon * 2.2, lat0 + cellLat * 1.2);
    paintPeak(values, w, x1, y1, 2.2, 1.2, 15);
    paintPeak(values, w, x2, y2, 1.2, 2.4, 8);
    const both = treePairsFromPoints([], frame, [], null, { canopyHits: hits, chmGrid: grid, heightSample: () => 14 });
    assert.equal(both.foliageGeometry, "chm-contour");
    assert.ok(both.oiAreas.length >= 2, "two crowns, not one NLCD polygon");
    const tops = both.oiAreas.map((a) => a.material.top_height).sort((a, b) => a - b);
    assert.ok(tops.includes(15));
    assert.ok(tops.includes(8));
    assert.equal(both.oiAreas.every((a) => a.shape === "polygon"), true);
  });

  it("keeps a tall single-cell crown the 12 m² floor used to drop, and does not invent empty ground", () => {
    const w = 24;
    const h = 24;
    const values = new Uint8Array(w * h);
    const mLon = 111320 * Math.cos((60.57 * Math.PI) / 180);
    const cell = 2.2;
    const dLon = (w * cell) / mLon;
    const dLat = (h * cell) / 110540;
    const grid = {
      west: 27.18,
      south: 60.57,
      east: 27.18 + dLon,
      north: 60.57 + dLat,
      width: w,
      height: h,
      values,
    };
    values[8 * w + 6] = 8;
    values[16 * w + 14] = 4;
    const frame = frameForGrid(grid, "Street");
    const pairs = treePairsFromPoints([], frame, [], null, { chmGrid: grid });
    const kept = pairs.oiAreas.filter((a) => a.kind === "canopy");
    assert.equal(kept.length, 1, "crowns " + kept.map((a) => a.material && a.material.top_height).join(","));
    assert.equal(kept[0].material.top_height, 8);
    const [lon, lat] = cellLonLat(grid, 6, 8);
    const [x, y] = llToPx(lon, lat, frame);
    assert.equal(pointInRing([x, y], kept[0].ringPx), true);
    assert.equal(
      kept.some((a) => a.material.top_height <= 4),
      false,
      "a lone 4 m cell is not a tree"
    );
    const empty = new Uint8Array(w * h);
    const bare = treePairsFromPoints([], frame, [], null, {
      chmGrid: Object.assign({}, grid, { values: empty }),
      canopyHits: [
        { lon, lat, pct: 80 },
        { lon: lon + 0.0002, lat, pct: 70 },
        { lon: lon + 0.0004, lat, pct: 60 },
        { lon, lat: lat + 0.0002, pct: 90 },
      ],
    });
    assert.equal(bare.oiAreas.length, 0, "percent without a measured height does not invent canopy");
  });

  it("traces Oak Creek and Long Meadow canopy as simplified outlines, not grid squares", () => {
    for (const id of ["oak-creek-commercial", "long-meadow"]) {
      const grid = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", id, "chm-grid.json"), "utf8"));
      const crowns = crownsFromChm(grid);
      assert.ok(crowns.length >= 40, id + " outlines " + crowns.length);
      const heights = new Set(crowns.map((c) => c.heightM));
      assert.ok(heights.size >= 8, id + " heights " + heights.size);
      assert.ok(crowns.every((c) => c.heightM >= 3 && c.heightM <= 40));
      assert.ok(crowns.every((c) => c.ringLonLat.length >= 4 && c.ringLonLat.length <= 40));
      const traced = crowns.filter((c) => !isAxisRect(c.ringLonLat));
      assert.ok(traced.length >= 8, id + " non-rectangular outlines " + traced.length);
      assert.ok(
        traced.some((c) => c.ringLonLat.length >= 6),
        id + " keeps a canopy edge with a bend"
      );
      const areas = crowns.map((c) => c.areaM2).sort((a, b) => b - a);
      assert.ok(areas[0] > 900, id + " keeps canopy the old per-crown cap dropped, largest " + areas[0]);
    }
  });

  it("keeps a diagonal canopy as one non-rectangular outline", () => {
    const g = syntheticChm();
    for (let i = 0; i < 7; i++) {
      g.values[(10 + i) * g.w + (8 + i)] = 13;
      g.values[(10 + i) * g.w + (9 + i)] = 11;
      g.values[(11 + i) * g.w + (8 + i)] = 9;
    }
    const crowns = crownsFromChm(g.grid);
    assert.equal(crowns.length, 1);
    assert.equal(crowns[0].heightM, 13);
    assert.equal(isAxisRect(crowns[0].ringLonLat), false);
    assert.ok(crowns[0].ringLonLat.length >= 6);
    assert.ok(crowns[0].areaM2 > 200, "the whole band is kept, area " + crowns[0].areaM2);
  });

  it("keeps canopy in the notch of a building box when it is not on the roof", () => {
    const g = syntheticChm();
    paintPeak(g.values, g.w, 30, 20, 2.2, 1.6, 14);
    const frame = frameForGrid(g.grid, "Notch");
    const [lon, lat] = cellLonLat(g.grid, 30, 20);
    const [x, y] = llToPx(lon, lat, frame);
    const ring = [
      [x - 80, y + 70],
      [x + 70, y + 70],
      [x + 70, y + 28],
      [x - 28, y + 28],
      [x - 28, y - 70],
      [x - 80, y - 70],
      [x - 80, y + 70],
    ];
    const pairs = treePairsFromPoints([], frame, [
      { minX: x - 80, minY: y - 70, maxX: x + 70, maxY: y + 70 },
    ], null, {
      chmGrid: g.grid,
      buildingRings: [ring],
    });
    const kept = pairs.oiAreas.find((a) => a.material && a.material.top_height === 14);
    assert.ok(kept, "canopy in the notch is exported");
    assert.equal(pointInRing([x, y], kept.ringPx), true);
  });

  it("lifts a CHM crown by the slope under it", () => {
    const frame = geoFrame({ west: -89.7, south: 44.91, east: -89.684, north: 44.926, name: "Granite Peak" });
    const samples = [];
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 6; c++) {
        const lon = frame.west + ((c + 0.5) / 6) * (frame.east - frame.west);
        const lat = frame.south + ((r + 0.5) / 6) * (frame.north - frame.south);
        const t = (lat - frame.south) / (frame.north - frame.south);
        samples.push({ lon, lat, z: t < 0.35 ? 300 : 300 + ((t - 0.35) / 0.65) * 180 });
      }
    }
    const terrain = terrainFromSamples(samples, frame);
    const w = 24;
    const h = 24;
    const values = new Uint8Array(w * h);
    const mLon = 111320 * Math.cos((44.92 * Math.PI) / 180);
    const dLon = (w * 6) / mLon;
    const dLat = (h * 6) / 110540;
    const lon = frame.west + (frame.east - frame.west) * 0.55;
    const lat = frame.south + (frame.north - frame.south) * 0.72;
    const grid = { west: lon - dLon / 2, south: lat - dLat / 2, east: lon + dLon / 2, north: lat + dLat / 2, width: w, height: h, values };
    paintPeak(values, w, 12, 12, 2.4, 1.5, 14);
    const built = buildClutter({
      frame,
      footprintsGeojson: { features: [] },
      treePoints: [],
      name: "Granite Peak",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      terrain,
      chmGrid: grid,
      includeFoliage: true,
      treesSource: "nlcd-canopy",
    });
    assert.equal(built.stats.foliageGeometry, "chm-contour");
    assert.equal(built.stats.includeFoliage, true);
    assert.ok(built.stats.foliageLifted >= 1);
    const foliage = built.openintent.floorplans[0].attenuation_areas.filter((a) =>
      String(a.area_material.name).indexOf("Foliage - Heavy") === 0
    );
    assert.ok(foliage.length >= 2);
    const base = Math.min(...foliage.map((a) => a.area_material.bottom_height || 0));
    const tip = Math.max(...foliage.map((a) => a.area_material.top_height));
    assert.ok(base >= 20);
    assert.equal(tip, Math.round((base + 14) * 10) / 10);
    assert.equal(built.stats.openIntentTreeAreas >= 1, true);
    assert.equal(
      built.clipboard.attenuatingZones.some((z) => String(z.typeId).indexOf("trunk") === 0),
      false
    );
  });

  it("points Oak Creek at the zoom-10 CHM quadkey", () => {
    const keys = quadkeysForBbox(-87.9226, 42.8904, -87.9118, 42.9033, CHM_ZOOM);
    assert.deepEqual(keys, ["0302222101"]);
    assert.match(chmUrl(keys[0]), /0302222101\.tif$/);
  });
});

function cellLonLat(grid, x, y) {
  const dLon = grid.east - grid.west;
  const dLat = grid.north - grid.south;
  return [
    grid.west + ((x + 0.5) / grid.width) * dLon,
    grid.north - ((y + 0.5) / grid.height) * dLat,
  ];
}

function frameForGrid(grid, name) {
  return geoFrame({
    west: grid.west,
    south: grid.south,
    east: grid.east,
    north: grid.north,
    name,
  });
}

describe("canopy height replaces the color guess", () => {
  it("does not draw canopy over a known building footprint", () => {
    const g = syntheticChm();
    paintPeak(g.values, g.w, 16, 18, 3.2, 2.4, 16);
    paintPeak(g.values, g.w, 50, 30, 2.8, 2.2, 11);
    const frame = frameForGrid(g.grid, "Roof");
    const [cx, cy] = cellLonLat(g.grid, 16, 18);
    const dLon = (g.grid.east - g.grid.west) / g.w;
    const dLat = (g.grid.north - g.grid.south) / g.h;
    const ring = [
      [cx - dLon * 5, cy - dLat * 4],
      [cx + dLon * 5, cy - dLat * 4],
      [cx + dLon * 5, cy + dLat * 4],
      [cx - dLon * 5, cy + dLat * 4],
      [cx - dLon * 5, cy - dLat * 4],
    ];
    const fp = footprintsToClutter(
      [{ type: "Feature", properties: { height: 8 }, geometry: { type: "Polygon", coordinates: [ring] } }],
      frame
    );
    const built = buildClutter({
      frame,
      footprintsGeojson: {
        features: [{ type: "Feature", properties: { height: 8 }, geometry: { type: "Polygon", coordinates: [ring] } }],
      },
      treePoints: [],
      name: "Roof",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      chmGrid: g.grid,
      includeFoliage: true,
      treesSource: "nlcd-canopy",
    });
    assert.ok(built.stats.openIntentBuildingAreas >= 1);
    const foliage = built.openintent.floorplans[0].attenuation_areas.filter((a) =>
      String(a.area_material.name).indexOf("Foliage") === 0
    );
    assert.ok(foliage.length >= 1, "canopy beside the roof is kept");
    const rings = foliage.map((a) =>
      oiPixelCoords(a.area.coordinates).map((c) => [c.coordinate_xyz.x, c.coordinate_xyz.y])
    );
    const [bx, by] = llToPx(cx, cy, frame);
    assert.equal(
      rings.some((px) => pointInRing([bx, by], px)),
      false
    );
    let overlap = 0;
    for (const px of rings) overlap += intersectionAreaPx(px, fp.overlayRings[0]);
    assert.ok(overlap * frame.mpuX * frame.mpuY < 1, "overlap " + overlap);
    assert.ok(foliage.some((a) => a.area_material.top_height === 11));
  });

  it("leaves canopy off a road pavement polygon", () => {
    const g = syntheticChm();
    paintPeak(g.values, g.w, 14, 16, 2.6, 2.2, 15);
    paintPeak(g.values, g.w, 48, 32, 2.4, 3.1, 9);
    const frame = frameForGrid(g.grid, "Road");
    const [lon, lat] = cellLonLat(g.grid, 14, 16);
    const [x, y] = llToPx(lon, lat, frame);
    const road = [
      [x - 28, y - 18],
      [x + 28, y - 18],
      [x + 28, y + 18],
      [x - 28, y + 18],
      [x - 28, y - 18],
    ];
    const pairs = treePairsFromPoints([], frame, [], null, {
      chmGrid: g.grid,
      maskPolygons: [[road]],
    });
    const foliage = pairs.oiAreas.filter((a) => a.kind === "canopy");
    assert.ok(foliage.length >= 1, "canopy off the road is kept");
    assert.equal(
      foliage.some((a) => pointInRing([x, y], a.ringPx)),
      false,
      "road center is inside canopy"
    );
    let overlap = 0;
    for (const area of foliage) overlap += intersectionAreaPx(area.ringPx, road);
    assert.ok(overlap < 1, "road overlap px " + overlap);
    assert.ok(pairs.oiAreas.some((a) => a.material.top_height === 9));
    assert.equal(
      pairs.oiAreas.some((a) => a.material.top_height === 15),
      false,
      "the crown centered on the road is not exported"
    );
  });

  it("takes canopy height from the CHM sample, not a percent bucket", () => {
    const g = syntheticChm();
    paintPeak(g.values, g.w, 20, 20, 3, 2, 22);
    const frame = frameForGrid(g.grid, "Height");
    const [lon, lat] = cellLonLat(g.grid, 20, 20);
    const hits = [];
    for (let i = 0; i < 6; i++) hits.push({ lon: lon + i * 0.00002, lat, pct: 80 });
    const bucket = canopyHeightM(80, lon, lat);
    assert.notEqual(bucket, 22);
    const pairs = treePairsFromPoints([], frame, [], null, { chmGrid: g.grid, canopyHits: hits });
    const area = pairs.oiAreas.find((a) => a.material && a.material.top_height === 22);
    assert.ok(area, "measured 22 m crown is present");
    assert.equal(area.material.rf_properties.attenuation_per_m, 1.5);
    assert.equal(area.material.top_height, 22);
    assert.notEqual(area.material.top_height, bucket);
    assert.equal(area.shape, "polygon");
  });

  it("soft-omits foliage when canopy height times out and still exports buildings", () => {
    const frame = geoFrame({ west: -87.93, south: 42.89, east: -87.91, north: 42.91, name: "Timeout" });
    const cellLon = 30 / (111320 * Math.cos((42.9 * Math.PI) / 180));
    const cellLat = 30 / 110540;
    const lon0 = frame.west + (frame.east - frame.west) * 0.4;
    const lat0 = frame.south + (frame.north - frame.south) * 0.45;
    const hits = [];
    for (let iy = 0; iy < 2; iy++) {
      for (let ix = 0; ix < 3; ix++) hits.push({ lon: lon0 + ix * cellLon, lat: lat0 + iy * cellLat, pct: 80 });
    }
    const dLon = (frame.east - frame.west) * 0.04;
    const dLat = (frame.north - frame.south) * 0.04;
    const bLon = frame.west + (frame.east - frame.west) * 0.15;
    const bLat = frame.south + (frame.north - frame.south) * 0.15;
    const building = {
      type: "Feature",
      properties: { height: 8 },
      geometry: {
        type: "Polygon",
        coordinates: [[
          [bLon, bLat],
          [bLon + dLon, bLat],
          [bLon + dLon, bLat + dLat],
          [bLon, bLat + dLat],
          [bLon, bLat],
        ]],
      },
    };
    const withCanopy = buildClutter({
      frame,
      footprintsGeojson: { features: [building] },
      treePoints: [],
      name: "Timeout",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      canopyHits: hits,
      heightSample: () => 14.2,
      includeFoliage: true,
      treesSource: "nlcd-canopy",
    });
    assert.ok(withCanopy.stats.openIntentTreeAreas >= 1);
    const omitted = buildClutter({
      frame,
      footprintsGeojson: { features: [building] },
      treePoints: [],
      name: "Timeout",
      imgBuf: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      canopyHits: hits,
      heightSample: () => 14.2,
      includeFoliage: true,
      omitFoliage: true,
      treesSource: "nlcd-canopy",
    });
    assert.equal(omitted.stats.includeFoliage, true);
    assert.equal(omitted.stats.foliageOmitted, "canopy-height-timeout");
    assert.equal(omitted.stats.openIntentTreeAreas, 0);
    assert.ok(omitted.stats.openIntentBuildingAreas >= 1);
    assert.equal(omitted.stats.buildingsKept, withCanopy.stats.buildingsKept);
    assert.match(omitted.stats.summary, /Foliage omitted \(canopy height timed out\)/);
    assert.match(omitted.stats.summary, /Buildings /);
    const areas = omitted.openintent.floorplans[0].attenuation_areas;
    assert.equal(areas.some((a) => String(a.area_material.name).indexOf("Foliage") === 0), false);
    assert.ok(areas.some((a) => String(a.area_material.name).indexOf("Building") === 0));
    assert.ok(omitted.zip && omitted.zip.length > 50);
  });

  it("does not start a canopy read after the export has aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const grid = await fetchChmGrid(
      { west: -87.93, south: 42.89, east: -87.91, north: 42.91 },
      { signal: ctrl.signal }
    );
    assert.equal(grid, null);
  });

  it("reads canopy-tile coordinates back to the same lon/lat", () => {
    const [x, y] = mercator(-87.9226, 42.8904);
    const [lon, lat] = lonLatFromMercator(x, y);
    assert.ok(Math.abs(lon + 87.9226) < 1e-9);
    assert.ok(Math.abs(lat - 42.8904) < 1e-9);
  });

  it("keeps a narrow measured crown and does not turn a spike or low grass into one", () => {
    const srcW = 12;
    const srcH = 12;
    const dstW = 4;
    const dstH = 4;
    const src = new Uint8Array(srcW * srcH);
    for (let y = 3; y <= 5; y++) {
      for (let x = 3; x <= 5; x++) src[y * srcW + x] = 9;
    }
    src[1 * srcW + 10] = 12;
    for (let y = 9; y <= 11; y++) {
      for (let x = 3; x <= 5; x++) src[y * srcW + x] = 2;
    }
    for (let y = 9; y <= 11; y++) {
      for (let x = 9; x <= 11; x++) src[y * srcW + x] = 4;
    }
    const values = peakPool(src, srcW, srcH, dstW, dstH);
    assert.equal(values[1 * dstW + 1], 9);
    assert.equal(values[0 * dstW + 3], 0, "one native spike is not a cell");
    assert.equal(values[3 * dstW + 1], 0, "grass under 3 m is not canopy");
    assert.equal(values[3 * dstW + 3], 4);
    const cell = 2.2;
    const mLon = 111320 * Math.cos((42.9 * Math.PI) / 180);
    const grid = {
      west: -87.9,
      south: 42.9,
      east: -87.9 + (dstW * cell) / mLon,
      north: 42.9 + (dstH * cell) / 110540,
      width: dstW,
      height: dstH,
      values,
    };
    const crowns = crownsFromChm(grid);
    assert.equal(crowns.length, 1, "crowns " + crowns.map((c) => c.heightM + ":" + c.areaM2).join(","));
    assert.equal(crowns[0].heightM, 9);
    assert.equal(
      crowns.some((c) => c.heightM <= 4),
      false,
      "a lone 4 m cell is not a tree"
    );
  });

  it("uses foliage budget above 480 for compact crowns and leaves the 480 largest in place", () => {
    const traced = [[0, 0], [3, 0], [3.4, 1], [1, 2], [0, 1.2]];
    const box = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const crowns = [];
    for (let i = 0; i < 500; i++) {
      crowns.push({ areaM2: 200 + i, heightM: 11, ringLonLat: traced });
    }
    for (let i = 0; i < 250; i++) {
      crowns.push({ areaM2: 22, heightM: 5 + (i % 20), ringLonLat: box });
    }
    crowns.push({ areaM2: 18, heightM: 3, ringLonLat: box });
    const at480 = selectCrownsForExport(crowns, 480);
    assert.equal(at480.length, 480);
    assert.equal(at480.every((c) => c.areaM2 >= 200), true);
    const at720 = selectCrownsForExport(crowns, 720);
    assert.equal(at720.length, 720);
    assert.equal(at720.filter((c) => c.areaM2 >= 200).length, 480);
    const compact = at720.filter((c) => c.areaM2 === 22);
    assert.equal(compact.length, 240);
    assert.equal(at720.some((c) => c.heightM === 3), false, "a short speck does not take a tree slot");
    assert.equal(compact[0].heightM >= compact[compact.length - 1].heightM, true);
  });

  it("does not turn NLCD hits into squares when canopy height was required", () => {
    const frame = geoFrame({ west: -87.93, south: 42.89, east: -87.91, north: 42.91, name: "Req" });
    const cellLon = 30 / (111320 * Math.cos((42.9 * Math.PI) / 180));
    const cellLat = 30 / 110540;
    const lon0 = frame.west + (frame.east - frame.west) * 0.4;
    const lat0 = frame.south + (frame.north - frame.south) * 0.4;
    const hits = [];
    for (let iy = 0; iy < 3; iy++) {
      for (let ix = 0; ix < 4; ix++) hits.push({ lon: lon0 + ix * cellLon, lat: lat0 + iy * cellLat, pct: 80 });
    }
    const squares = treePairsFromPoints([], frame, [], null, { canopyHits: hits, heightSample: () => 14 });
    assert.equal(squares.foliageGeometry, "nlcd-polygon");
    assert.ok(squares.oiAreas.length >= 1);
    const required = treePairsFromPoints([], frame, [], null, {
      canopyHits: hits,
      heightSample: () => 14,
      chmRequired: true,
    });
    assert.equal(required.oiAreas.length, 0);
    assert.equal(required.foliageGeometry, "none");
  });

  it("keeps canopy peaks from strips read before the abort", async () => {
    const frame = { west: -87.93, south: 42.89, east: -87.929, north: 42.891 };
    const [xW, yS] = mercator(frame.west, frame.south);
    const [xE, yN] = mercator(frame.east, frame.north);
    const width = 80;
    const height = 600;
    const origin = [Math.min(xW, xE), Math.max(yS, yN)];
    const res = [(Math.max(xW, xE) - origin[0]) / width, (Math.min(yS, yN) - origin[1]) / height];
    const ctrl = new AbortController();
    let strips = 0;
    const image = {
      getWidth: () => width,
      getHeight: () => height,
      getOrigin: () => origin,
      getResolution: () => res,
      readRasters: async ({ window }) => {
        strips++;
        const cols = window[2] - window[0];
        const rows = window[3] - window[1];
        const data = new Uint8Array(cols * rows);
        if (window[1] < 256) {
          for (let y = 0; y < rows; y++) {
            for (let x = 8; x < 48; x++) data[y * cols + x] = 14;
          }
        }
        ctrl.abort();
        return data;
      },
    };
    const grid = await fetchChmGrid(frame, {
      signal: ctrl.signal,
      loader: { fromUrl: async () => ({ getImage: async () => image }) },
    });
    assert.ok(grid && grid.nonzero > 0, "peaks already read stay on the grid");
    assert.equal(strips, 1, "the abort stops the next strip");
  });

  it("keeps a southern crown from the full-site overview when native strips do not run", async () => {
    const frame = { west: -87.93, south: 42.89, east: -87.928, north: 42.892 };
    const [xW, yS] = mercator(frame.west, frame.south);
    const [xE, yN] = mercator(frame.east, frame.north);
    const origin = [Math.min(xW, xE), Math.max(yS, yN)];
    const spanX = Math.max(xW, xE) - origin[0];
    const spanY = Math.min(yS, yN) - origin[1];
    let nativeReads = 0;
    const full = {
      getWidth: () => 80,
      getHeight: () => 1600,
      getOrigin: () => origin,
      getResolution: () => [spanX / 80, spanY / 1600],
      readRasters: async () => {
        nativeReads++;
        return new Uint8Array(80 * 256);
      },
    };
    const ctrl = new AbortController();
    const overview = {
      getWidth: () => 48,
      getHeight: () => 48,
      getOrigin: () => origin,
      getResolution: () => [spanX / 48, spanY / 48],
      readRasters: async () => {
        const data = new Uint8Array(48 * 48);
        for (let y = 0; y < 48; y++) {
          for (let x = 0; x < 48; x++) {
            if (Math.hypot(x - 24, y - 40) <= 6) data[y * 48 + x] = 14;
          }
        }
        ctrl.abort();
        return data;
      },
    };
    const grid = await fetchChmGrid(frame, {
      signal: ctrl.signal,
      loader: {
        fromUrl: async () => ({
          getImageCount: async () => 2,
          getImage: async (index) => (index ? overview : full),
        }),
      },
    });
    assert.equal(nativeReads, 0);
    assert.ok(grid && grid.nonzero > 10, "the overview still covers the draw");
    const midLon = (frame.west + frame.east) / 2;
    const southLat = frame.north - (40.5 / 48) * (frame.north - frame.south);
    const northLat = frame.north - (4 / 48) * (frame.north - frame.south);
    assert.ok(sampleChmGrid(grid, midLon, southLat) >= 5, "south " + sampleChmGrid(grid, midLon, southLat));
    assert.equal(sampleChmGrid(grid, midLon, northLat), 0);
    const crowns = crownsFromChm(grid);
    assert.equal(crowns.length, 1);
    assert.ok(crowns[0].ringLonLat.length >= 6, "ring verts " + crowns[0].ringLonLat.length);
  });

  it("keeps a fairway-sized crown when the largest masses fill the first 480", () => {
    const traced = [[0, 0], [3, 0], [3.4, 1], [1, 2], [0, 1.2]];
    const crowns = [];
    for (let i = 0; i < 500; i++) crowns.push({ areaM2: 400 + i, heightM: 14, ringLonLat: traced });
    crowns.push({ areaM2: 120, heightM: 16, ringLonLat: traced });
    const kept = selectCrownsForExport(crowns, 720);
    assert.ok(kept.some((c) => c.areaM2 === 120 && c.heightM === 16));
  });
});

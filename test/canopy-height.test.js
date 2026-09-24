"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { sampleChmGrid, applyChmToTrees, chmUrl, CHM_ZOOM, crownsFromChm } = require("../netlify/lib/canopy-height");
const { quadkeysForBbox } = require("../netlify/lib/ms-global");
const { treePairsFromPoints } = require("../netlify/lib/vegetation");
const { geoFrame } = require("../netlify/lib/geo-frame");
const { buildClutter } = require("../netlify/lib/pipeline");
const { terrainFromSamples } = require("../netlify/lib/terrain");

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
    assert.equal(canopies.length, 1);
    assert.equal(canopies[0].shape, "polygon");
    assert.equal(canopies[0].material.name, "Foliage - Heavy 14.2");
    assert.equal(canopies[0].material.top_height, 14.2);
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
    assert.equal(pairs.oiAreas.some((a) => a.kind === "trunk"), false);
    assert.ok(pairs.clipTypes.some((t) => t.id === "foliage-m-14_2"));
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
    assert.equal(pairs.foliageGeometry, "chm-crown");
    assert.equal(pairs.oiAreas.some((a) => a.shape === "circle" || a.kind === "trunk"), false);
    assert.equal(pairs.overlayPoints.length, 0);
    const heavy = pairs.oiAreas.filter((a) => a.material.top_height >= 14);
    assert.equal(heavy.length, 1);
    assert.equal(heavy[0].material.name, "Foliage - Heavy 16.0");
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
    assert.equal(filtered.foliageGeometry, "chm-crown");
    assert.equal(
      filtered.oiAreas.some((a) => a.material.top_height === 7),
      false,
      "a short crown far from NLCD canopy is not painted on pavement"
    );
    const ell = filtered.oiAreas.find((a) => a.material.top_height === 18);
    assert.ok(ell, "the L stays");
    assert.ok(ell.ringPx.length >= 6);
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
    assert.equal(nlcd.oiAreas.length, 1);
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
    assert.equal(both.foliageGeometry, "chm-crown");
    assert.ok(both.oiAreas.length >= 2, "two crowns, not one NLCD polygon");
    const tops = both.oiAreas.map((a) => a.material.top_height).sort((a, b) => a - b);
    assert.ok(tops.includes(15));
    assert.ok(tops.includes(8));
    assert.equal(both.oiAreas.every((a) => a.shape === "polygon"), true);
  });

  it("splits Oak Creek and Long Meadow CHM into many measured crowns", () => {
    for (const id of ["oak-creek-commercial", "long-meadow"]) {
      const grid = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", id, "chm-grid.json"), "utf8"));
      const crowns = crownsFromChm(grid);
      assert.ok(crowns.length >= 80, id + " crowns " + crowns.length);
      const heights = new Set(crowns.map((c) => c.heightM));
      assert.ok(heights.size >= 8, id + " heights " + heights.size);
      assert.ok(crowns.every((c) => c.heightM >= 4 && c.heightM <= 40));
      assert.ok(crowns.every((c) => c.areaM2 < 800 && c.ringLonLat.length >= 4 && c.ringLonLat.length <= 40));
      const areas = crowns.map((c) => c.areaM2).sort((a, b) => a - b);
      assert.ok(areas[areas.length >> 1] < 400, id + " median area is a crown, not a woods blob");
      assert.ok(
        crowns.some((c) => bboxAspect(c.ringLonLat) > 1.4),
        id + " includes a non-circular outline"
      );
    }
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
    assert.equal(built.stats.foliageGeometry, "chm-crown");
    assert.equal(built.stats.includeFoliage, true);
    assert.ok(built.stats.foliageLifted >= 1);
    const area = built.openintent.floorplans[0].attenuation_areas.find((a) =>
      String(a.area_material.name).indexOf("Foliage - Heavy 14") === 0
    );
    assert.ok(area);
    assert.ok(area.area_material.bottom_height >= 20);
    assert.equal(
      area.area_material.top_height,
      Math.round((area.area_material.bottom_height + 14) * 10) / 10
    );
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

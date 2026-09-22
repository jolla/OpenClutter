"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { sampleChmGrid, applyChmToTrees, chmUrl, CHM_ZOOM } = require("../netlify/lib/canopy-height");
const { quadkeysForBbox } = require("../netlify/lib/ms-global");
const { treePairsFromPoints } = require("../netlify/lib/vegetation");
const { geoFrame } = require("../netlify/lib/geo-frame");

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

  it("uses the CHM height as foliage top_height and still places from the point", () => {
    const frame = geoFrame({ west: -87.93, south: 42.89, east: -87.91, north: 42.91, name: "C" });
    const lon = frame.west + (frame.east - frame.west) * 0.2;
    const lat = frame.south + (frame.north - frame.south) * 0.2;
    const pairs = treePairsFromPoints([{ lon, lat, pct: 70, heightM: 14.2 }], frame, []);
    const canopy = pairs.oiAreas.find((a) => a.kind === "canopy");
    assert.equal(canopy.shape, "circle");
    assert.equal(canopy.material.name, "Tree Foliage 14.2");
    assert.equal(canopy.material.top_height, 14.2);
    assert.ok(canopy.material.rf_properties.attenuation_per_m > 0.5);
    assert.ok(canopy.material.rf_properties.attenuation_per_m < 3);
    assert.notEqual(canopy.material.display_color, "#9AA5AC");
    assert.notEqual(canopy.material.display_color, "#9A4159");
    assert.equal("bottom_height" in canopy.material, false);
    assert.equal("itu_material_type" in canopy.material, false);
    assert.ok(pairs.clipTypes.some((t) => t.id === "foliage-m-14_2" && t.topEdge === 14.2));
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
    assert.equal(canopies[0].material.name, "Tree Foliage 14.2");
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

  it("points Oak Creek at the zoom-10 CHM quadkey", () => {
    const keys = quadkeysForBbox(-87.9226, 42.8904, -87.9118, 42.9033, CHM_ZOOM);
    assert.deepEqual(keys, ["0302222101"]);
    assert.match(chmUrl(keys[0]), /0302222101\.tif$/);
  });
});

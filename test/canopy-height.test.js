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
    // 14.2 m buckets to the gold Five Floor object. Exact metres stay on the clipboard type.
    assert.equal(canopy.material.name, "Building - Five Floor");
    assert.equal(canopy.material.top_height, 15.240185320653499);
    assert.equal("bottom_height" in canopy.material, false);
    assert.ok(pairs.clipTypes.some((t) => t.id === "foliage-m-14_2" && t.topEdge === 14.2));
  });

  it("points Oak Creek at the zoom-10 CHM quadkey", () => {
    const keys = quadkeysForBbox(-87.9226, 42.8904, -87.9118, 42.9033, CHM_ZOOM);
    assert.deepEqual(keys, ["0302222101"]);
    assert.match(chmUrl(keys[0]), /0302222101\.tif$/);
  });
});

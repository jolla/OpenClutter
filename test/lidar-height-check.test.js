"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { checkSourceHeights } = require("../netlify/lib/usgs-lidar");
const exportMode = require("../netlify/lib/export-mode");

function feature(height, heightSource) {
  const ring = [
    [-100.0001, 35.0001],
    [-100.0, 35.0001],
    [-100.0, 35.0],
    [-100.0001, 35.0],
    [-100.0001, 35.0001],
  ];
  return { type: "Feature", properties: { height, heightSource }, geometry: { type: "Polygon", coordinates: [ring] } };
}

describe("lidar height check", () => {
  const grid = {};
  it("lowers a model height the lidar contradicts and fills a missing one", () => {
    const list = [feature(22, "overture"), feature(0, ""), feature(4, "overture"), feature(20, "osm"), feature(8, "ms-global")];
    const out = checkSourceHeights(list, grid, () => 3.6);
    const h = out.features.map((f) => [f.properties.height, f.properties.heightSource]);
    assert.deepEqual(h, [
      [3.6, "lidar-check"],
      [3.6, "lidar-check"],
      [4, "overture"],
      [20, "osm"],
      [3.6, "lidar-check"],
    ]);
    assert.equal(out.fixed, 3);
  });

  it("keeps the source height when the lidar sees ground or agrees", () => {
    const list = [feature(22, "overture"), feature(10, "overture")];
    assert.equal(checkSourceHeights(list, grid, () => null).fixed, 0);
    assert.equal(checkSourceHeights([list[1]], grid, () => 8).fixed, 0);
    assert.equal(checkSourceHeights(list, null, () => 3).fixed, 0);
  });

  it("keeps a tower the flight predates on /dev (Block 185, Austin: 181 m read 6.6 m in 2017)", () => {
    exportMode.setStaleTowers(false);
    assert.equal(checkSourceHeights([feature(181.05, "overture")], grid, () => 6.6).fixed, 1);
    exportMode.setStaleTowers(true);
    const out = checkSourceHeights([feature(181.05, "overture"), feature(118.57, "overture")], grid, (g, ring) => 6.6);
    assert.equal(out.fixed, 0);
    assert.deepEqual(out.features.map((f) => [f.properties.height, f.properties.heightSource]), [
      [181.05, "overture"],
      [118.57, "overture"],
    ]);
    exportMode.setStaleTowers(false);
  });

  it("still lowers a tall model height the lidar half agrees with, and a short one it contradicts", () => {
    exportMode.setStaleTowers(true);
    // 50 m read at 25 m (0.5, above the tower guard) and 24.6 m read at 6.4 m.
    const tall = checkSourceHeights([feature(50, "overture")], grid, () => 25);
    assert.deepEqual([tall.fixed, tall.features[0].properties.height], [1, 25]);
    const tower = checkSourceHeights([feature(45, "overture")], grid, () => 20);
    assert.equal(tower.fixed, 0);
    const short = checkSourceHeights([feature(24.6, "ms-global")], grid, () => 6.4);
    assert.deepEqual([short.fixed, short.features[0].properties.height], [1, 6.4]);
    exportMode.setStaleTowers(false);
  });
});

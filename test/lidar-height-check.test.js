"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { checkSourceHeights } = require("../netlify/lib/usgs-lidar");

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
});

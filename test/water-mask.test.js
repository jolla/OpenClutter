"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { createWaterTest, clearWaterCanopy, dropWaterPoints } = require("../netlify/lib/water-mask");
const { WATER, TREE } = require("../netlify/lib/worldcover");

// West half is water, east half land, split at lon 0.
const cover = { sample: (lon) => (lon < 0 ? WATER : TREE) };

describe("water mask", () => {
  it("clears canopy on open water and keeps the shoreline and land", () => {
    const test = createWaterTest({ worldcover: cover });
    assert.equal(test(-0.002, 0), true);
    assert.equal(test(-0.00005, 0), false, "a crown beside the bank stays");
    assert.equal(test(0.002, 0), false);
    const grid = { west: -0.002, east: 0.002, south: -0.001, north: 0.001, width: 4, height: 2, values: new Uint8Array(8).fill(9) };
    const cleared = clearWaterCanopy(grid, test);
    assert.equal(cleared, 4);
    assert.deepEqual(Array.from(grid.values), [0, 0, 9, 9, 0, 0, 9, 9]);
  });

  it("keeps an island inside an OSM water polygon", () => {
    const outer = [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]];
    const island = [[0.004, 0.004], [0.006, 0.004], [0.006, 0.006], [0.004, 0.006], [0.004, 0.004]];
    const test = createWaterTest({ waterPolygons: [[outer, island]] });
    assert.equal(test(0.002, 0.002), true);
    assert.equal(test(0.005, 0.005), false);
    const r = dropWaterPoints([{ lon: 0.002, lat: 0.002 }, { lon: 0.005, lat: 0.005 }, { lon: 0.02, lat: 0.02 }], test);
    assert.equal(r.dropped, 1);
    assert.equal(r.points.length, 2);
  });

  it("is off without any water source", () => {
    assert.equal(createWaterTest({}), null);
  });
});

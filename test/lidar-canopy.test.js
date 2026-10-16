"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { gridFromPoints, mercator } = require("../netlify/lib/usgs-lidar");
const { fuseLidarCanopy, keepLidarOpen, leafOffDate, clearInside } = require("../netlify/lib/lidar-canopy");

const frame = { west: -90.001, south: 40.0, east: -89.999, north: 40.0015 };

function cloud(opts) {
  const pts = [];
  const a = mercator(frame.west, frame.south);
  const b = mercator(frame.east, frame.north);
  for (let x = a[0]; x < b[0]; x += 0.7) {
    for (let y = a[1]; y < b[1]; y += 0.7) {
      pts.push({ x, y, z: 100, cls: 2, ret: 1, nret: 1 });
      const inTree = x < a[0] + 40 && y < a[1] + 40;
      const inRoof = x > b[0] - 40 && y > b[1] - 40;
      if (inTree) {
        pts.push({ x, y, z: 112, cls: opts.cls, ret: 1, nret: 2 });
        pts.push({ x, y, z: 106, cls: opts.cls, ret: 2, nret: 2 });
      }
      // A trailer roof: a hard single return 4 m up.
      if (inRoof) pts.push({ x, y, z: 104, cls: 1, ret: 1, nret: 1 });
    }
  }
  return gridFromPoints(pts, frame, { spacingM: 2 });
}

function metaEverywhere() {
  const width = 80;
  const height = 70;
  const values = new Uint8Array(width * height).fill(9);
  return Object.assign({}, frame, { width, height, values, nonzero: width * height });
}

function share(grid, sx, sy) {
  let n = 0;
  let tall = 0;
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (sx(x / grid.width) && sy(y / grid.height)) {
        n++;
        if (grid.values[y * grid.width + x] >= 3) tall++;
      }
    }
  }
  return tall / n;
}

for (const cls of [5, 1]) {
  test("lidar keeps the crown and clears open ground and the trailer (class " + cls + ")", () => {
    const lidar = { grid: cloud({ cls }), collected: "2019-07-01", frame };
    const out = fuseLidarCanopy(metaEverywhere(), lidar, { frame });
    assert.ok(out, "fused");
    // South-west corner is the tree; north-east (top-right) is the trailer.
    const tree = share(out.grid, (u) => u < 0.15, (v) => v > 0.85);
    const open = share(out.grid, (u) => u > 0.4 && u < 0.6, (v) => v > 0.4 && v < 0.6);
    const roof = share(out.grid, (u) => u > 0.9, (v) => v < 0.1);
    assert.ok(tree > 0.8, "tree " + tree);
    assert.ok(open < 0.05, "open " + open);
    assert.ok(roof < 0.05, "roof " + roof);
  });
}

test("no cloud keeps the Meta grid as it was", () => {
  const out = fuseLidarCanopy(metaEverywhere(), { skipped: "outside-3dep" }, { frame });
  assert.equal(out, null);
});

test("leaf-off months north of 31 degrees", () => {
  assert.equal(leafOffDate("2018-03-02", 43), true);
  assert.equal(leafOffDate("2018-07-02", 43), false);
  assert.equal(leafOffDate("2018-01-02", 28), false);
});

test("gap fill cannot add canopy where lidar measured open ground", () => {
  const g = { width: 2, height: 1, values: new Uint8Array([0, 0]) };
  const decided = new Uint8Array([1, 0]);
  g.values[0] = 8;
  g.values[1] = 8;
  assert.equal(keepLidarOpen(g, decided, new Uint8Array([0, 0])), 1);
  assert.deepEqual(Array.from(g.values), [0, 8]);
});

test("vehicle footprints clear canopy cells", () => {
  const g = Object.assign({}, frame, { width: 10, height: 10, values: new Uint8Array(100).fill(6) });
  const ring = [[frame.west, frame.south], [frame.east, frame.south], [frame.east, frame.north], [frame.west, frame.north], [frame.west, frame.south]];
  assert.equal(clearInside(g, [{ kind: "trailer", coords: ring }]), 100);
});

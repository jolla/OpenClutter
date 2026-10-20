"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { gridFromPoints, mercator } = require("../netlify/lib/usgs-lidar");
const { fuseLidarCanopy, keepLidarOpen, leafOffDate, aridClimate, clearInside } = require("../netlify/lib/lidar-canopy");

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
        // A crown has relief: tops rise and fall a few metres.
        const top = opts.flat ? 112 : 112 + 3 * Math.sin((x - a[0]) / 3) * Math.cos((y - a[1]) / 3);
        pts.push({ x, y, z: top, cls: opts.cls, ret: 1, nret: 2 });
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

test("a winter flight over the desert is not leaf-off", () => {
  assert.equal(leafOffDate("2023-01-10", 36.13, -115.16), false);
  assert.equal(leafOffDate("2023-01-10", 39.95, -75.16), true);
  assert.equal(aridClimate(33.45, -112.07), true);
  assert.equal(aridClimate(41.88, -87.63), false);
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

test("an unclassified flat 12 m deck is not a crown", () => {
  const lidar = { grid: cloud({ cls: 1, flat: true }), collected: "2019-07-01", frame };
  const out = fuseLidarCanopy(metaEverywhere(), lidar, { frame });
  const deck = share(out.grid, (u) => u < 0.15, (v) => v > 0.85);
  assert.ok(deck < 0.05, "deck " + deck);
});

function lampGrid(cellM, tall) {
  const cells = new Map();
  for (let iy = 0; iy < 14; iy++) {
    for (let ix = 0; ix < 14; ix++) {
      const t = tall[ix + "," + iy];
      cells.set(ix + "," + iy, { ix, iy, n: 8, g: 100, tMax: t ? 100 + t : 100.2, tc: 4, mr: t ? 1 : 0, lr: t ? 1 : 0, vegN: 0, fc: 0 });
    }
  }
  return { cells, counts: {}, kept: 14 * 14 * 8, cellGroundM: cellM };
}

test("a flat lamp bank alone in the open is a pole, not a crown", () => {
  const { lidarCells } = require("../netlify/lib/lidar-canopy");
  const read = lidarCells(lampGrid(1.6, { "6,6": 15.2, "7,6": 15.4, "6,7": 15, "7,7": 15.3 }), { leafOff: true });
  assert.equal(read.lampBlocks, 1);
  for (const k of ["6,6", "7,6", "6,7", "7,7"]) assert.equal(read.cells.get(k).h, 0);
  assert.equal([...read.cells.values()].filter((c) => c.pole).length, 1);
});

test("a narrow conifer cone stays a crown", () => {
  const { lidarCells } = require("../netlify/lib/lidar-canopy");
  const read = lidarCells(lampGrid(1.6, { "6,6": 18, "7,6": 15.5, "6,7": 15.8, "7,7": 14.9 }), { leafOff: true });
  assert.equal(read.lampBlocks, 0);
  assert.ok(read.cells.get("6,6").h > 10 || read.cells.get("6,6").pole);
});

test("coarse lidar cells cannot read a lamp bank", () => {
  const { lidarCells } = require("../netlify/lib/lidar-canopy");
  const read = lidarCells(lampGrid(5.4, { "6,6": 15.2, "7,6": 15.4 }), { leafOff: true });
  assert.equal(read.lampBlocks, 0);
});

"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const L = require("../netlify/lib/usgs-lidar");
const exportMode = require("../netlify/lib/export-mode");
const { dropTreeFootprints } = require("../netlify/lib/tree-roofs");

// 100 m x 100 m frame; the west half of the photo is green, the east half grey.
const frame = { west: -100.001, east: -100.0, south: 35.0, north: 35.0008 };
const W = 100;
const H = 100;
const toPx = (lon, lat) => [((lon - frame.west) / (frame.east - frame.west)) * W, ((lat - frame.south) / (frame.north - frame.south)) * H];

function photo() {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = (y * W + x) * 4;
      const green = x < W / 2;
      data[k] = green ? 40 : 128;
      data[k + 1] = green ? 120 : 128;
      data[k + 2] = green ? 40 : 128;
      data[k + 3] = 255;
    }
  }
  return { data, width: W, height: H };
}

/** Lidar grid over the frame; returnsAt(lon, lat) gives { b, v, u } counts per 1 m cell. */
function grid(returnsAt) {
  const [x0, y0] = L.mercator(frame.west, frame.south);
  const [x1, y1] = L.mercator(frame.east, frame.north);
  const g = { originX: x0, originY: y0, cell: 1, cells: new Map() };
  for (let iy = 0; iy < Math.ceil(y1 - y0); iy++) {
    for (let ix = 0; ix < Math.ceil(x1 - x0); ix++) {
      const c = L.cellCenter(g, { ix, iy });
      const r = returnsAt(c[0], c[1]);
      g.cells.set(ix + "," + iy, {
        ix, iy, g: 100, b: r.b ? [125] : [], bc: r.b, u: r.u ? [124] : [], uc: r.u, v: r.v ? [126] : [], vc: r.v,
        uMin: 124, uMax: 124,
      });
    }
  }
  return g;
}

function box(w, s, e, n, geomSource) {
  const lon = (f) => frame.west + f * (frame.east - frame.west);
  const lat = (f) => frame.south + f * (frame.north - frame.south);
  const ring = [[lon(w), lat(s)], [lon(e), lat(s)], [lon(e), lat(n)], [lon(w), lat(n)], [lon(w), lat(s)]];
  return { type: "Feature", properties: { geomSource, height: 24.6 }, geometry: { type: "Polygon", coordinates: [ring] } };
}

const trees = grid(() => ({ b: 0, v: 3, u: 1 }));
const roofs = grid(() => ({ b: 4, v: 1, u: 0 }));

describe("trees read as roofs", () => {
  afterEach(() => exportMode.setTreeRoofs(false));

  it("counts lidar returns by kind inside a ring", () => {
    const ring = box(0.1, 0.1, 0.3, 0.3, "ms-global").geometry.coordinates[0];
    const c = L.returnsInside(trees, ring);
    assert.ok(c.cells > 100);
    assert.equal(c.building, 0);
    assert.equal(c.vegetation, 3 * c.cells);
    assert.equal(L.treesNotRoof(c), true);
    assert.equal(L.treesNotRoof(L.returnsInside(roofs, ring)), false);
  });

  it("gives tree tops no roof height only when the switch is on", () => {
    const ring = box(0.1, 0.1, 0.3, 0.3, "ms-global").geometry.coordinates[0];
    assert.equal(L.heightForRing(trees, ring), 24);
    exportMode.setTreeRoofs(true);
    assert.equal(L.heightForRing(trees, ring), null);
    assert.equal(L.heightForRing(roofs, ring), 25);
  });

  it("leaves out a Microsoft outline only over lidar trees on a green photo", () => {
    const list = [
      box(0.1, 0.1, 0.4, 0.4, "ms-global"), // trees, green: out
      box(0.6, 0.1, 0.9, 0.4, "ms-global"), // trees, grey roof on the photo: kept
      box(0.1, 0.6, 0.4, 0.9, "overture"), // trees, green, but not an ML outline: kept
    ];
    const out = dropTreeFootprints({ features: list, grid: trees, photo: photo(), toPx });
    assert.equal(out.dropped.length, 1);
    assert.equal(out.dropped[0].index, 0);
    assert.deepEqual(out.features, [list[1], list[2]]);
    const kept = dropTreeFootprints({ features: list, grid: roofs, photo: photo(), toPx });
    assert.equal(kept.dropped.length, 0);
  });
});

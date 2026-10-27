"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const exportMode = require("../netlify/lib/export-mode");
const { devRoadsideHoles } = require("../netlify/lib/outdoor-clutter");
const { pxToLl } = require("../netlify/lib/geo-frame");

const FRAME = {
  west: -120.64,
  south: 35.13,
  east: -120.634,
  north: 35.136,
  imgW: 2000,
  imgH: 2000,
  mpuX: 0.27,
  mpuY: 0.33,
};

function squarePx(x, y, sidePx) {
  return [
    [x, y],
    [x + sidePx, y],
    [x + sidePx, y + sidePx],
    [x, y + sidePx],
  ];
}

afterEach(() => {
  exportMode.setShadowTrailers(false);
});

describe("roadside holes on the live path (/dev shadowTrailers)", () => {
  it("keeps only amenity roofs over 320 m2 and converts ringPx Y-up like llToPx", () => {
    // 80 px at 0.27 m is about 21.6 m a side (466 m2); 30 px is about 66 m2.
    const big = { index: 0, ringPx: squarePx(100, 200, 80) };
    const small = { index: 1, ringPx: squarePx(500, 600, 30) };
    const out = devRoadsideHoles([big, small], FRAME);
    assert.equal(out.rings.length, 1);
    assert.equal(out.cents.length, 2);
    assert.deepEqual(out.rings[0][0], pxToLl(100, 200, FRAME));
    // Y-up: a larger pixel y is further north.
    assert.ok(out.rings[0][2][1] > out.rings[0][0][1]);
  });

  it("uses a lon/lat ring when the building has one", () => {
    const ring = [
      [-120.639, 35.131],
      [-120.6385, 35.131],
      [-120.6385, 35.1314],
      [-120.639, 35.1314],
    ];
    const out = devRoadsideHoles([{ index: 0, ring }], FRAME);
    assert.equal(out.rings.length, 1);
    assert.equal(out.rings[0], ring);
  });

  it("scanVehicles sends the same holes and centres to the roadside worker on /dev only", () => {
    const src = require("node:fs").readFileSync(require.resolve("../netlify/lib/detect-parallel.js"), "utf8");
    assert.match(src, /mode\.isShadowTrailers\(\) \? require\("\.\/outdoor-clutter"\)\.devRoadsideHoles\(buildings, frame\) : null/);
    assert.match(src, /holes: holesNear\(devBoxes \|\| holeBoxes, feature\.pad\)/);
    assert.match(src, /cents: devHoles \? devHoles\.cents : undefined/);
  });

  it("the roadside worker task restores building centres onto the holes", () => {
    const track = require("../netlify/lib/vehicle-track");
    const real = track.roadsideVehicles;
    let seen = null;
    track.roadsideVehicles = (ring, frame, plate, holes) => {
      seen = holes;
      return [];
    };
    try {
      const { runTask } = require("../netlify/lib/cpu-tasks");
      runTask("vehicle-job", { op: "roadside", ring: [], frame: FRAME, holes: [[[0, 0]]], cents: [[1, 2]] });
      assert.deepEqual(seen.cents, [[1, 2]]);
      runTask("vehicle-job", { op: "roadside", ring: [], frame: FRAME, holes: [[[0, 0]]] });
      assert.equal(seen.cents, undefined);
    } finally {
      track.roadsideVehicles = real;
    }
  });
});

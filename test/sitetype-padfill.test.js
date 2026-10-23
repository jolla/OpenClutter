"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { outdoorToOi, padFillCentres } = require("../netlify/lib/pipeline");
const { isPadFill, ringCentre } = require("../scripts/sitetype-bench");
const { outdoorMaterial } = require("../netlify/lib/materials");

function box(x, y, w, h) {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

test("outdoorToOi flags pad fills so the bench can score them apart", () => {
  const material = outdoorMaterial("rv", 3.5);
  const items = [
    { ringPx: box(10, 10, 4, 12), material, kind: "rv", thin: true },
    { ringPx: box(40, 10, 4, 12), material, kind: "rv", thin: true, padFill: true },
  ];
  const conv = outdoorToOi(items, 200, 200, 0.5);
  assert.equal(conv.areas.length, 2);
  assert.deepEqual(conv.fills, [false, true]);
  const centres = padFillCentres(conv);
  assert.equal(centres.length, 1);
  const rings = conv.areas.map((a) => a.area.coordinates.map((c) => [c.coordinate_xyz.x, c.coordinate_xyz.y]));
  assert.equal(isPadFill(rings[0], centres), false);
  assert.equal(isPadFill(rings[1], centres), true);
  assert.equal(isPadFill(rings[1], null), false);
  const c = ringCentre(rings[1]);
  assert.ok(Math.abs(c[0] - centres[0][0]) < 0.01 && Math.abs(c[1] - centres[0][1]) < 0.01);
});

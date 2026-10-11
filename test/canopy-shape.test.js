"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { shapeOfAreas } = require("../scripts/canopy-bench");
const { standUnderstoryM } = require("../netlify/lib/materials");

function ring(w, h, x0, y0) {
  return [
    { coordinate_xyz: { x: x0, y: y0 } },
    { coordinate_xyz: { x: x0 + w, y: y0 } },
    { coordinate_xyz: { x: x0 + w, y: y0 + h } },
    { coordinate_xyz: { x: x0, y: y0 + h } },
    { coordinate_xyz: { x: x0, y: y0 } },
  ];
}

function area(name, top, bottom, box) {
  const material = { name, top_height: top };
  if (bottom != null) material.bottom_height = bottom;
  return { area_material: material, area: { coordinates: ring(box[0], box[1], box[2] || 0, box[3] || 0) } };
}

describe("canopy shape score", () => {
  it("counts a raised stand against the 3 m gap", () => {
    const areas = [
      area("Foliage - Understory 3.0 @ 10.0", 13, 10, [40, 25]),
      area("Foliage - Heavy 11.0 @ 13.0", 24, 13, [40, 25]),
    ];
    const shape = shapeOfAreas(areas, 1, 1);
    assert.equal(shape.heights.length, 1);
    assert.ok(Math.abs(shape.heights[0].thick - 14) < 0.05);
    assert.equal(shape.gapErrs.length, 1);
    assert.equal(shape.gapErrs[0], 0);
    assert.equal(standUnderstoryM(14, "heavy"), 3);
  });

  it("treats a stand that sits on the ground as a missing gap", () => {
    const areas = [area("Foliage - Heavy 14.0 @ 10.0", 24, 10, [40, 25])];
    const shape = shapeOfAreas(areas, 1, 1);
    assert.equal(shape.heights.length, 1);
    assert.ok(Math.abs(shape.heights[0].thick - 14) < 0.05);
    assert.equal(shape.gapErrs.length, 1);
    assert.equal(shape.gapErrs[0], 3);
  });

  it("uses 30–40% of height for a tall conifer", () => {
    const expected = standUnderstoryM(30, "heavy");
    assert.ok(expected >= 9 && expected <= 12);
    const areas = [
      area("Foliage - Understory " + expected.toFixed(1) + " @ 2.0", 2 + expected, 2, [50, 40]),
      area("Foliage - Heavy 19.5 @ " + (2 + expected).toFixed(1), 32, 2 + expected, [50, 40]),
    ];
    const shape = shapeOfAreas(areas, 1, 1);
    assert.equal(shape.gapErrs.length, 1);
    assert.equal(shape.gapErrs[0], 0);
    assert.ok(Math.abs(shape.heights[0].thick - 30) < 0.05);
  });

  it("does not score a small crown as a stand gap", () => {
    const areas = [area("Foliage - Light 6.0", 6, null, [4, 4])];
    const shape = shapeOfAreas(areas, 1, 1);
    assert.equal(shape.gapErrs.length, 0);
    assert.equal(shape.heights.length, 1);
    assert.equal(shape.heights[0].thick, 6);
  });
});

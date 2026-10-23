"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { thinTreeOutlines } = require("../netlify/lib/pipeline");

function ring(n, r, wobble) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const rr = r + (i % 2 ? wobble : -wobble);
    out.push({ coordinate_xyz: { x: 100 + rr * Math.cos(t), y: 100 + rr * Math.sin(t), unit: "pixels" } });
  }
  out.push({ coordinate_xyz: Object.assign({}, out[0].coordinate_xyz) });
  return out;
}

describe("tree outline thinning", () => {
  it("drops stair-step vertices from crowns and keeps stems", () => {
    const crown = { area: { coordinates: ring(40, 30, 0.3) }, area_material: { name: "Foliage - Crown 8.0" } };
    const stem = { area: { coordinates: ring(12, 1, 0.3) }, area_material: { name: "Foliage - Trunk 0.4" } };
    const removed = thinTreeOutlines([{ areas: [crown, stem] }], 1);
    assert.ok(removed > 0);
    const c = crown.area.coordinates;
    assert.ok(c.length < 41 && c.length >= 4, "crown " + c.length);
    assert.deepEqual(c[0].coordinate_xyz, c[c.length - 1].coordinate_xyz);
    assert.equal(stem.area.coordinates.length, 13);
  });
});

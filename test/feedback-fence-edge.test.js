"use strict";

// Feedback #17 (Ashburn VA, Russell Branch Parkway): a slanted fence that the
// map edge cuts kept the whole line's span, so the cut piece was stretched
// about 30 m across the road.
const test = require("node:test");
const assert = require("node:assert/strict");
const { outdoorToOi } = require("../netlify/lib/pipeline");
const { outdoorMaterial } = require("../netlify/lib/materials");

function ringOf(area) {
  return area.area.coordinates.map((c) => [c.coordinate_xyz.x, c.coordinate_xyz.y]);
}

// Distance from p to the line through a and b.
function offLine(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / Math.hypot(dx, dy);
}

test("a slanted fence cut by the map edge stays on its line", () => {
  const material = outdoorMaterial("fence", 2.1);
  // The issue #17 piece: one fence segment from below the map to an inside corner.
  const a = [3029, -245];
  const b = [2081, 343];
  const items = [{ ringPx: [a, b, [2082, 344], [3030, -244], a], material, kind: "fence", thin: true }];
  const conv = outdoorToOi(items, 3310, 3020, 0.12667);
  assert.equal(conv.areas.length, 1);
  const ring = ringOf(conv.areas[0]);
  let maxY = -Infinity;
  for (const p of ring) {
    assert.ok(offLine(p, a, b) < 2, "point " + p + " is " + offLine(p, a, b).toFixed(1) + " px off the fence");
    maxY = Math.max(maxY, p[1]);
  }
  assert.ok(maxY < 346, "the inside end stays at the fence corner, got y " + maxY);
});

test("a fence wholly inside the map keeps its shape", () => {
  const material = outdoorMaterial("fence", 2.1);
  const a = [500, 400];
  const b = [900, 700];
  const items = [{ ringPx: [a, b, [901, 699], [501, 399], a], material, kind: "fence", thin: true }];
  const conv = outdoorToOi(items, 3310, 3020, 0.12667);
  assert.equal(conv.areas.length, 1);
  for (const p of ringOf(conv.areas[0])) assert.ok(offLine(p, a, b) < 2);
});

test("a straight fence along the map edge still gets its thin width held", () => {
  const material = outdoorMaterial("fence", 2.1);
  const items = [{ ringPx: [[-50, 100], [400, 100], [400, 101], [-50, 101], [-50, 100]], material, kind: "fence", thin: true }];
  const conv = outdoorToOi(items, 3310, 3020, 0.12667);
  assert.equal(conv.areas.length, 1);
  const ys = ringOf(conv.areas[0]).map((p) => p[1]);
  assert.ok(Math.max(...ys) - Math.min(...ys) < 3);
});

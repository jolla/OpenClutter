"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { fillPads } = require("../netlify/lib/rv-pads");
const { setSiteTypes } = require("../netlify/lib/export-mode");

// 1 px = 1 m frame, 200 x 120 m, plain gray gravel plate.
const frame = { imgW: 200, imgH: 120, mpuX: 1, mpuY: 1 };
function plate(paint) {
  const data = new Uint8ClampedArray(200 * 120 * 4);
  for (let y = 0; y < 120; y++) {
    for (let x = 0; x < 200; x++) {
      const i = (y * 200 + x) * 4;
      const c = paint ? paint(x, 120 - y) : [150, 148, 140];
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }
  return { width: 200, height: 120, data };
}
const zone = [[0, 0], [200, 0], [200, 120], [0, 120], [0, 0]];
const road = [[5, 60], [195, 60]];
// Back-in RVs 10 m long, 3 m wide, across the road on the north side, every 8 m.
function rv(x) {
  return [[x - 1.5, 64], [x + 1.5, 64], [x + 1.5, 74], [x - 1.5, 74], [x - 1.5, 64]];
}
const evidence = [20, 28, 36, 44, 52, 60, 100, 108].map(rv);

describe("worst-case RV pads", () => {
  it("fills empty pads between and beyond RVs along the same road side (production)", () => {
    setSiteTypes(false);
    try {
      const out = fillPads({ frame, zones: [zone], roads: [road], evidence, obstacles: [], plate: plate() });
      assert.ok(out.added >= 8, "added " + out.added);
      for (const r of out.rings) {
        const ys = r.map((p) => p[1]);
        // Never on the road.
        assert.ok(Math.min(...ys) > 62 || Math.max(...ys) < 58);
      }
      // The gap between 60 and 100 gets pads at the learned spacing.
      const xs = out.rings.filter((r) => r[0][1] > 60).map((r) => r.reduce((s, p) => s + p[0], 0) / r.length);
      assert.ok(xs.some((x) => x > 66 && x < 94));
    } finally {
      setSiteTypes(true);
    }
  });

  it("site types fill only the gaps between two RVs on the same side", () => {
    const out = fillPads({ frame, zones: [zone], roads: [road], evidence, obstacles: [], plate: plate() });
    const xs = out.rings.map((r) => r.slice(0, 4).reduce((s, p) => s + p[0], 0) / 4);
    assert.ok(xs.length >= 3, "added " + xs.length);
    // 60 to 100 is the only gap; nothing before 20, past 108, or across the road.
    for (const x of xs) assert.ok(x > 62 && x < 98, "x " + x);
    assert.ok(out.rings.every((r) => r.every((p) => p[1] > 62)));
  });

  it("site types leave a park with few RVs per road length alone", () => {
    const roads = [road, [[5, 20], [195, 20]], [[5, 100], [195, 100]], [[5, 112], [195, 112]]];
    const sparse = fillPads({ frame, zones: [zone], roads, evidence, obstacles: [], plate: plate() });
    assert.equal(sparse.added, 0);
  });

  it("puts no pad on grass, a building, or with too little evidence", () => {
    const green = plate((x, y) => (y > 60 ? [70, 120, 60] : [150, 148, 140]));
    const north = fillPads({ frame, zones: [zone], roads: [road], evidence, obstacles: [], plate: green });
    assert.ok(north.rings.every((r) => r.every((p) => p[1] < 62)));
    const shed = [[0, 62], [200, 62], [200, 120], [0, 120], [0, 62]];
    const blocked = fillPads({ frame, zones: [zone], roads: [road], evidence, obstacles: [shed], plate: plate() });
    assert.ok(blocked.rings.every((r) => r.every((p) => p[1] < 62)));
    const few = fillPads({ frame, zones: [zone], roads: [road], evidence: evidence.slice(0, 3), obstacles: [], plate: plate() });
    assert.equal(few.added, 0);
  });
});

"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { fillPads, roadJunctions, lineTable } = require("../netlify/lib/rv-pads");
const { boxRect, rectOverlapShare } = require("../netlify/lib/vehicle-track");
const { setSiteTypes } = require("../netlify/lib/export-mode");

const frame = { imgW: 200, imgH: 120, mpuX: 1, mpuY: 1 };
function plate() {
  const data = new Uint8ClampedArray(200 * 120 * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 150;
    data[i + 1] = 148;
    data[i + 2] = 140;
    data[i + 3] = 255;
  }
  return { width: 200, height: 120, data };
}
const zone = [[0, 0], [200, 0], [200, 120], [0, 120], [0, 0]];
function rv(x) {
  return [[x - 1.5, 64], [x + 1.5, 64], [x + 1.5, 74], [x - 1.5, 74], [x - 1.5, 64]];
}

describe("road junctions", () => {
  it("finds crossings and T ends", () => {
    const tabs = [[[0, 50], [100, 50]], [[50, 0], [50, 100]], [[80, 50], [80, 90]]].map(lineTable);
    const j = roadJunctions(tabs);
    assert.ok(j.some((p) => Math.hypot(p[0] - 50, p[1] - 50) < 0.5), "crossing");
    assert.ok(j.some((p) => Math.hypot(p[0] - 80, p[1] - 50) < 0.5), "T end");
    assert.ok(!j.some((p) => Math.hypot(p[0] - 80, p[1] - 90) < 5), "free end is no junction");
  });

  it("keeps pad fills clear of junctions on dev", () => {
    setSiteTypes(true);
    try {
      const roads = [[[5, 60], [195, 60]], [[120, 60], [120, 115]]];
      const evidence = [20, 28, 36, 44, 52, 60, 100, 108, 140, 148, 156, 164].map(rv);
      const out = fillPads({ frame, zones: [zone], roads, evidence, obstacles: [], plate: plate() });
      assert.ok(out.added >= 1, "added " + out.added);
      for (const r of out.rings) {
        const cx = r.slice(0, 4).reduce((s, p) => s + p[0], 0) / 4;
        const cy = r.slice(0, 4).reduce((s, p) => s + p[1], 0) / 4;
        assert.ok(Math.hypot(cx - 120, cy - 60) >= 12, "fill at " + cx.toFixed(1) + "," + cy.toFixed(1));
      }
    } finally {
      setSiteTypes(false);
    }
  });
});

describe("roadside box overlap", () => {
  it("measures the share of one box inside another", () => {
    const h = { ux: 1, uy: 0 };
    const a = boxRect(0, 0, h, 10, 3);
    assert.equal(rectOverlapShare(a, boxRect(0, 0, h, 10, 3)), 1);
    assert.equal(rectOverlapShare(a, boxRect(0, 10, h, 10, 3)), 0);
    const half = rectOverlapShare(a, boxRect(5, 0, h, 10, 3));
    assert.ok(half > 0.45 && half < 0.55, "half " + half);
    const tilt = rectOverlapShare(a, boxRect(0, 2, { ux: Math.SQRT1_2, uy: Math.SQRT1_2 }, 10, 3));
    assert.ok(tilt > 0.1 && tilt < 0.9, "tilt " + tilt);
  });
});
